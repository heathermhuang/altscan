import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { PgDialect } from 'drizzle-orm/pg-core'
import { createMaintenanceConnection, schema } from '@altscan/db'
import { gasTiersFrom } from './gas-tiers'
import { gasTiersQuery, queryGasTiers } from './gas-percentiles'

/**
 * The /gas tier query against a REAL Postgres: percentile_disc over the transactions of the newest 20 blocks.
 *
 * Gated on GAS_TIERS_TEST_PG_URL (a disposable database: its name must contain "test"). The tables are TEMP on
 * a single non-recycled connection, so the suite cannot collide with another that shares the database. The DDL
 * mirrors the two columns and the index (tx_block_idx) the query reads.
 */
const ENV = 'GAS_TIERS_TEST_PG_URL'
const PG_URL = process.env[ENV]
const GWEI = 1_000_000_000

const FIXTURE = `
  CREATE TEMP TABLE blocks (number BIGINT PRIMARY KEY, base_fee_per_gas NUMERIC(36,0));
  CREATE TEMP TABLE transactions (hash VARCHAR(66) PRIMARY KEY, block_number BIGINT NOT NULL, gas_price NUMERIC(36,0) NOT NULL);
  CREATE INDEX tx_block_idx ON transactions (block_number);
`

type PlanNode = { 'Node Type': string; 'Index Name'?: string; 'Relation Name'?: string; 'Actual Rows'?: number; 'Actual Loops'?: number; 'Rows Removed by Filter'?: number; Plans?: PlanNode[] }
const walk = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(walk)]

describe.skipIf(!PG_URL)('/gas tier query: against a real Postgres', () => {
  let conn: ReturnType<typeof createMaintenanceConnection>
  let db: ReturnType<typeof drizzle<typeof schema>>

  beforeAll(async () => {
    if (!/test/i.test(new URL(PG_URL as string).pathname)) {
      throw new Error(`${ENV} must name a disposable database (its name must contain "test")`)
    }
    conn = createMaintenanceConnection(PG_URL as string)
    db = drizzle(conn, { schema })
    await conn.unsafe(FIXTURE)
  }, 60_000)

  afterAll(async () => { await conn?.end({ timeout: 5 }) })

  /** Blocks first..last, each with base fee `baseFee(n)` and one transaction per entry of `prices(n)` (wei). */
  async function load(first: number, last: number, baseFee: (n: number) => number | null, prices: (n: number) => number[]) {
    await conn.unsafe('TRUNCATE transactions, blocks')
    const ns = Array.from({ length: last - first + 1 }, (_, i) => first + i)
    await conn.unsafe(`INSERT INTO blocks VALUES ${ns.map(n => `(${n}, ${baseFee(n) ?? 'NULL'})`).join(',')}`)
    const txs = ns.flatMap(n => prices(n).map((p, i) => `('0x${n}-${i}', ${n}, ${p})`))
    if (txs.length > 0) await conn.unsafe(`INSERT INTO transactions VALUES ${txs.join(',')}`)
  }

  it('ETH-like: the base fee of the newest block, plus the 25th/50th/75th percentile tip of the newest 20 blocks only', async () => {
    await load(1, 30, n => n * GWEI, n => [1, 2, 3, 4].map(tip => n * GWEI + tip * GWEI))
    // Blocks 1-10 are older than the window: absurd tips there must not move a percentile.
    await conn.unsafe(`INSERT INTO transactions SELECT '0xold-' || n, n, 9000::numeric * ${GWEI} FROM generate_series(1, 10) n`)
    // A zero-priced system transaction inside the window is not a fee anyone paid.
    await conn.unsafe(`INSERT INTO transactions SELECT '0xsys-' || n || '-' || i, n, 0 FROM generate_series(11, 30) n, generate_series(1, 3) i`)
    const tiers = await queryGasTiers(db)
    expect(tiers).toEqual({ slow: String(1 * GWEI), standard: String(2 * GWEI), fast: String(3 * GWEI), baseFee: String(30 * GWEI) })
  })

  // A block with no recorded base fee has no knowable tip. COALESCE(base, 0) would read its whole price as tip
  // (lib/gas-breakdown.ts: "a confident wrong answer"), so in the tip regime such blocks are out of the sample.
  it('ETH-like: a block with a NULL base fee is left out of the tip sample, not counted as all tip', async () => {
    const nullBase = (n: number) => n === 15 || n === 16
    await load(1, 30, n => (nullBase(n) ? null : n * GWEI), n => (nullBase(n)
      ? Array.from({ length: 4 }, () => 500 * GWEI)
      : [1, 2, 3, 4].map(tip => n * GWEI + tip * GWEI)))
    expect(await queryGasTiers(db)).toEqual({ slow: String(1 * GWEI), standard: String(2 * GWEI), fast: String(3 * GWEI), baseFee: String(30 * GWEI) })
  })

  it('BNB-like: NULL-base blocks stay in the sample (the base fee is not used there)', async () => {
    await load(100, 119, n => (n % 2 === 0 ? null : 0), () => [50_000_000, 60_000_000, 70_000_000, 80_000_000])
    expect(await queryGasTiers(db)).toEqual({ slow: '50000000', standard: '60000000', fast: '70000000', baseFee: null })
  })

  it('is null with fewer than 20 transactions across the window: three identical "percentiles" of one tx say nothing', async () => {
    await load(1, 20, () => 0, n => (n === 20 ? [GWEI] : []))
    expect(await queryGasTiers(db)).toBeNull()
    await load(1, 20, () => 0, n => (n <= 19 ? [GWEI] : []))
    expect(await queryGasTiers(db)).toBeNull()
    await load(1, 20, () => 0, () => [GWEI])
    expect(await queryGasTiers(db)).not.toBeNull()
  })

  it('BNB-like (base fee 0): the percentiles are the gas prices themselves', async () => {
    await load(100, 119, () => 0, () => [50_000_000, 50_000_000, 60_000_000, 100_000_000])
    expect(await queryGasTiers(db)).toEqual({ slow: '50000000', standard: '50000000', fast: '60000000', baseFee: null })
  })

  it('a base fee above the paid price is a tip of 0, as on the tx page, never a negative number', async () => {
    // Per block: one tx priced below the base fee, one paying a 5 Gwei tip.
    await load(1, 20, () => 10 * GWEI, () => [1 * GWEI, 15 * GWEI])
    expect(await queryGasTiers(db)).toEqual({ slow: '0', standard: '0', fast: String(5 * GWEI), baseFee: String(10 * GWEI) })
  })

  it('is null with fewer than 20 blocks, and with no transactions in them', async () => {
    await load(1, 19, () => 0, () => [GWEI])
    expect(await queryGasTiers(db)).toBeNull()
    await load(1, 20, () => 0, () => [])
    expect(await queryGasTiers(db)).toBeNull()
  })

  it('reads the row shape gasTiersFrom expects', async () => {
    await load(1, 20, () => 0, () => [GWEI])
    const [row] = Array.from(await db.execute(gasTiersQuery())) as Record<string, unknown>[]
    expect(Number(row.blocks)).toBe(20)
    expect(Number(row.txs)).toBe(20)
    expect(row.tiers).toEqual([String(GWEI), String(GWEI), String(GWEI)])
    expect(gasTiersFrom({ blocks: Number(row.blocks), txs: Number(row.txs), baseFee: row.base_fee as string, tiers: row.tiers as string[] })).not.toBeNull()
  })

  it('is one bounded, indexed query: the newest 20 blocks via the primary key and their transactions via tx_block_idx', async () => {
    await conn.unsafe('TRUNCATE transactions, blocks')
    await conn.unsafe(`INSERT INTO blocks SELECT n, 0 FROM generate_series(1, 20000) n`)
    await conn.unsafe(`INSERT INTO transactions SELECT '0x' || n || '-' || i, n, 50000000 + i FROM generate_series(1, 20000) n, generate_series(1, 10) i`)
    await conn.unsafe('ANALYZE blocks; ANALYZE transactions')
    const { sql: text, params } = new PgDialect().sqlToQuery(gasTiersQuery())
    const [{ 'QUERY PLAN': [explained] }] = await conn.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, params as never[])
    const nodes = walk(explained.Plan as PlanNode)
    expect(nodes.some(n => n['Node Type'] === 'Seq Scan')).toBe(false)
    const txScans = nodes.filter(n => /Scan$/.test(n['Node Type']) && n['Node Type'] !== 'Bitmap Index Scan' && n['Relation Name'] === 'transactions')
    const txRowsRead = txScans.reduce((n, s) => n + ((s['Actual Rows'] ?? 0) + (s['Rows Removed by Filter'] ?? 0)) * (s['Actual Loops'] ?? 1), 0)
    expect(txRowsRead).toBeLessThanOrEqual(20 * 10)               // the window's own 200 rows, not the table's 200,000
    expect(nodes.map(n => n['Index Name'])).toEqual(expect.arrayContaining(['tx_block_idx']))
  })
})

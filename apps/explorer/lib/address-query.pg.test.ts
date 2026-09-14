import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, gte, lte, type SQL } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { createMaintenanceConnection, schema } from '@altscan/db'
import { selectByAddress } from './address-query'

/**
 * POST /api/v1/query's `filter.address` against a REAL Postgres.
 *
 * `(from_address = $1 OR to_address = $1) ORDER BY block_number LIMIT n` has no
 * index that serves both the filter and the order, so for an address the
 * planner believes is busy it walks the block_number index and filters every
 * row. When the address's rows sit at the far end of that walk — "first 10
 * transfers" of an address that is only busy now — it streams the few early
 * matches and then reads the rest of the table. On BNB that was ~95 statement
 * timeouts an hour (15s), each after k < 10 rows had streamed, and every one of
 * the 8 logged tx pages with k leading holes (postgres.js, #144) followed one of
 * them on the same instance by under 2.1s.
 *
 * Gated on ADDRESS_QUERY_TEST_PG_URL. The tables are TEMP on a single
 * non-recycled connection, so the suite cannot collide with another that shares
 * the database. The DDL mirrors the indexes ensure-schema.ts creates in prod.
 */
const ENV = 'ADDRESS_QUERY_TEST_PG_URL'
const PG_URL = process.env[ENV]

const X = '0x' + '11'.repeat(20)   // busy in the NEWEST partition, 3 rows in the oldest
const Z = '0x' + '22'.repeat(20)   // busy in the OLDEST partition, 3 rows in the newest
const Y = '0x' + '33'.repeat(20)   // spread out: same-second blocks, a self-transfer, two tokens
const T1 = '0x' + 'e1'.repeat(20)
const T2 = '0x' + 'e2'.repeat(20)

// 10,000 blocks of 0.75s, truncated to whole seconds as on BNB, so consecutive
// blocks share a timestamp. token_transfers is 4 partitions of 2,500 blocks.
const TS = `timestamptz '2026-09-12 00:00:00+00' + floor(b * 0.75) * interval '1 second'`
const h = (salt: number, n: number) => `((hashint4(b * 64 + i + ${salt})::bigint + 2147483648) % ${n})`
const noise = (salt: number) =>
  `CASE WHEN ${h(salt, 10)} < 3 THEN '0x' || md5('hot' || ${h(salt + 1, 1000)}) || '00000000'
        ELSE '0x' || md5('a' || ${h(salt + 2, 50000)}) || '00000000' END`
const other = `'0x' || md5('peer' || b) || '00000000'`

const FIXTURE = `
  CREATE TEMP TABLE token_transfers (
    tx_hash VARCHAR(66) NOT NULL, log_index INTEGER NOT NULL DEFAULT 0,
    token_address VARCHAR(42) NOT NULL, from_address VARCHAR(42) NOT NULL, to_address VARCHAR(42) NOT NULL,
    value NUMERIC(78,0) NOT NULL DEFAULT 0, token_id NUMERIC(78,0),
    block_number BIGINT NOT NULL, timestamp TIMESTAMPTZ NOT NULL
  ) PARTITION BY RANGE (block_number);
  CREATE TEMP TABLE token_transfers_p_0    PARTITION OF token_transfers FOR VALUES FROM (0)    TO (2500);
  CREATE TEMP TABLE token_transfers_p_2500 PARTITION OF token_transfers FOR VALUES FROM (2500) TO (5000);
  CREATE TEMP TABLE token_transfers_p_5000 PARTITION OF token_transfers FOR VALUES FROM (5000) TO (7500);
  CREATE TEMP TABLE token_transfers_p_7500 PARTITION OF token_transfers FOR VALUES FROM (7500) TO (10000);

  INSERT INTO token_transfers (tx_hash, log_index, token_address, from_address, to_address, block_number, timestamp)
  SELECT '0x' || md5('t' || b || ':' || i) || md5('u' || b || ':' || i), i,
         '0x' || md5('tok' || ${h(1, 200)}) || '00000000', ${noise(10)}, ${noise(20)}, b, ${TS}
  FROM generate_series(0, 9999) b, generate_series(0, 19) i;

  INSERT INTO token_transfers (tx_hash, log_index, token_address, from_address, to_address, block_number, timestamp)
  SELECT '0x' || md5(addr || b) || md5('v' || b), 99, '${T1}',
         CASE WHEN b % 2 = 0 THEN addr ELSE ${other} END,
         CASE WHEN b % 2 = 1 THEN addr ELSE ${other} END, b, ${TS}
  FROM (SELECT '${X}' AS addr, generate_series(7500, 9999, 3) AS b UNION ALL SELECT '${X}', unnest(ARRAY[10, 20, 31])
        UNION ALL SELECT '${Z}', generate_series(0, 2499, 3) UNION ALL SELECT '${Z}', unnest(ARRAY[9971, 9980, 9990])) s;

  INSERT INTO token_transfers (tx_hash, log_index, token_address, from_address, to_address, block_number, timestamp)
  SELECT '0x' || md5('y' || b) || md5('w' || b), 98, CASE WHEN b % 3 = 0 THEN '${T1}' ELSE '${T2}' END,
         CASE WHEN b % 2 = 0 OR b = 5121 THEN '${Y}' ELSE ${other} END,
         CASE WHEN b % 2 = 1 THEN '${Y}' ELSE ${other} END, b, ${TS}
  FROM (SELECT generate_series(0, 9999, 128) AS b UNION ALL SELECT generate_series(0, 9999, 128) + 1) s;

  CREATE INDEX ON token_transfers (token_address);
  CREATE INDEX ON token_transfers (from_address, timestamp DESC);
  CREATE INDEX ON token_transfers (to_address, timestamp DESC);
  CREATE INDEX ON token_transfers (token_address, timestamp DESC);
  CREATE INDEX ON token_transfers (block_number);
  CREATE INDEX ON token_transfers (tx_hash);
  ANALYZE token_transfers;

  CREATE TEMP TABLE transactions (
    hash VARCHAR(66) PRIMARY KEY, block_number BIGINT NOT NULL,
    from_address VARCHAR(42) NOT NULL, to_address VARCHAR(42),
    value NUMERIC(78,18) NOT NULL DEFAULT 0, gas BIGINT NOT NULL DEFAULT 21000,
    gas_price NUMERIC(36,0) NOT NULL DEFAULT 1, gas_used BIGINT NOT NULL DEFAULT 0,
    input TEXT NOT NULL DEFAULT '0x', status BOOLEAN NOT NULL DEFAULT true, method_id VARCHAR(10),
    tx_index INTEGER NOT NULL, nonce INTEGER, tx_type INTEGER,
    timestamp TIMESTAMPTZ NOT NULL, body_pruned BOOLEAN NOT NULL DEFAULT false
  );

  INSERT INTO transactions (hash, block_number, from_address, to_address, tx_index, timestamp)
  SELECT '0x' || md5('t' || b || ':' || i) || md5('u' || b || ':' || i), b, ${noise(30)}, ${noise(40)}, i, ${TS}
  FROM generate_series(0, 9999) b, generate_series(0, 9) i;

  INSERT INTO transactions (hash, block_number, from_address, to_address, tx_index, timestamp)
  SELECT '0x' || md5(addr || b) || md5('v' || b), b,
         CASE WHEN b % 2 = 0 THEN addr ELSE ${other} END,
         CASE WHEN b % 2 = 1 THEN addr ELSE ${other} END, 99, ${TS}
  FROM (SELECT '${X}' AS addr, generate_series(7500, 9999, 3) AS b UNION ALL SELECT '${X}', unnest(ARRAY[10, 20, 31])
        UNION ALL SELECT '${Z}', generate_series(0, 2499, 3) UNION ALL SELECT '${Z}', unnest(ARRAY[9971, 9980, 9990])) s;

  -- A self-send (5121) and a contract creation (to_address NULL, 6273) among Y's rows.
  INSERT INTO transactions (hash, block_number, from_address, to_address, tx_index, timestamp)
  SELECT '0x' || md5('y' || b) || md5('w' || b), b,
         CASE WHEN b % 2 = 0 OR b = 5121 THEN '${Y}' ELSE ${other} END,
         CASE WHEN b = 6273 THEN NULL WHEN b % 2 = 1 THEN '${Y}' ELSE ${other} END, 98, ${TS}
  FROM (SELECT generate_series(0, 9999, 128) AS b UNION ALL SELECT generate_series(0, 9999, 128) + 1) s;
  UPDATE transactions SET from_address = '${Y}' WHERE block_number = 6273 AND tx_index = 98;

  CREATE INDEX ON transactions (from_address, timestamp DESC);
  CREATE INDEX ON transactions (to_address, timestamp DESC);
  CREATE INDEX ON transactions (block_number);
  CREATE INDEX ON transactions (block_number) WHERE body_pruned = false;
  CREATE INDEX ON transactions (timestamp);
  CREATE INDEX ON transactions (timestamp DESC, value DESC);
  ANALYZE transactions;
`

type PlanNode = {
  'Node Type': string
  'Actual Rows': number
  'Actual Loops': number
  'Rows Removed by Filter'?: number
  'Rows Removed by Index Recheck'?: number
  Plans?: PlanNode[]
}

/** Heap rows the executor visited: returned by a scan, or read and discarded by its filter. */
function rowsRead(node: PlanNode): number {
  const scan = /Scan$/.test(node['Node Type']) && node['Node Type'] !== 'Bitmap Index Scan'
  const own = scan
    ? (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0)) * node['Actual Loops']
    : 0
  return (node.Plans ?? []).reduce((n, child) => n + rowsRead(child), own)
}

describe.skipIf(!PG_URL)('POST /api/v1/query filter.address — against a real Postgres', () => {
  let conn: ReturnType<typeof createMaintenanceConnection>
  let db: ReturnType<typeof drizzle<typeof schema>>

  beforeAll(async () => {
    if (!/test/i.test(new URL(PG_URL as string).pathname)) {
      throw new Error(`${ENV} must name a disposable database (its name must contain "test")`)
    }
    conn = createMaintenanceConnection(PG_URL as string)
    db = drizzle(conn, { schema })
    await conn.unsafe(FIXTURE)
  }, 120_000)

  afterAll(async () => {
    await conn?.end({ timeout: 5 })
  })

  const tables = [
    {
      name: 'token_transfers',
      table: schema.tokenTransfers,
      oracle: `SELECT tx_hash || ':' || log_index AS key, block_number, token_address, from_address
               FROM token_transfers WHERE from_address = $1 OR to_address = $1`,
      key: (r: Record<string, unknown>) => `${r.txHash}:${r.logIndex}`,
      filters: [
        { label: 'no other filter', conditions: [] as SQL[], keep: () => true },
        { label: 'tokenAddress', conditions: [eq(schema.tokenTransfers.tokenAddress, T1)], keep: (r: OracleRow) => r.token_address === T1 },
        { label: 'from', conditions: [eq(schema.tokenTransfers.fromAddress, Y)], keep: (r: OracleRow) => r.from_address === Y },
        {
          label: 'blockFrom/blockTo',
          conditions: [gte(schema.tokenTransfers.blockNumber, 2000), lte(schema.tokenTransfers.blockNumber, 8000)],
          keep: (r: OracleRow) => Number(r.block_number) >= 2000 && Number(r.block_number) <= 8000,
        },
      ],
    },
    {
      name: 'transactions',
      table: schema.transactions,
      oracle: `SELECT hash AS key, block_number, NULL AS token_address, from_address
               FROM transactions WHERE from_address = $1 OR to_address = $1`,
      key: (r: Record<string, unknown>) => String(r.hash),
      filters: [
        { label: 'no other filter', conditions: [] as SQL[], keep: () => true },
        { label: 'from', conditions: [eq(schema.transactions.fromAddress, Y)], keep: (r: OracleRow) => r.from_address === Y },
        {
          label: 'blockFrom/blockTo',
          conditions: [gte(schema.transactions.blockNumber, 2000), lte(schema.transactions.blockNumber, 8000)],
          keep: (r: OracleRow) => Number(r.block_number) >= 2000 && Number(r.block_number) <= 8000,
        },
      ],
    },
  ]
  type OracleRow = { key: string; block_number: string; token_address: string | null; from_address: string }

  describe.each(tables)('$name', ({ table, oracle, key, filters }) => {
    // What prod hit: an address's first page read from the far end of the table.
    it.each([
      ['asc', X],
      ['desc', Z],
    ])('reads O(limit) rows, not the table, in %s order', async (order, address) => {
      const q = selectByAddress(db, table, address, [], { order, limit: 10, offset: 0 })
      const { sql: text, params } = q.toSQL()
      const [{ 'QUERY PLAN': [explained] }] = await conn.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, params as never[])
      expect(await q).toHaveLength(10)
      // At least the 10 rows it returned, so a plan this walker cannot read fails loudly.
      const read = rowsRead(explained.Plan)
      expect(read).toBeGreaterThanOrEqual(10)
      expect(read).toBeLessThan(100)
    })

    it('returns exactly what the OR query returns, for every order, limit, offset and extra filter', async () => {
      const all = (await conn.unsafe(oracle, [Y])) as unknown as OracleRow[]
      // One row per block per address in the fixture, so block order is total.
      expect(new Set(all.map(r => r.block_number)).size).toBe(all.length)
      let compared = 0
      for (const { label, conditions, keep } of filters) {
        for (const order of ['asc', 'desc']) {
          const sorted = all.filter(keep).sort((a, b) =>
            order === 'asc' ? Number(a.block_number) - Number(b.block_number) : Number(b.block_number) - Number(a.block_number))
          for (const limit of [1, 7, 100]) {
            for (const offset of [0, 5, 40]) {
              const rows = await selectByAddress(db, table, Y, conditions, { order, limit, offset })
              const expected = sorted.slice(offset, offset + limit).map(r => r.key)
              expect(rows.map(r => key(r as Record<string, unknown>)), `${label} ${order} limit=${limit} offset=${offset}`).toEqual(expected)
              compared++
            }
          }
        }
      }
      expect(compared).toBe(filters.length * 18)
    })
  })
})

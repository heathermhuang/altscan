import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMaintenanceConnection, getDb } from '@altscan/db'
import { getChainConfig } from '@altscan/chain-config'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
  buildConcurrentIndexList,
  buildPartitionedTtWhaleIndexSql,
  ensureForwardPartitions,
  ensurePartitionedTtWhaleIndex,
  sweepInvalidIndexes,
  ttWhaleIndex,
} from './ensure-schema'

/**
 * The round-5 production indexes against a REAL Postgres: the combined whale partial index
 * `tt_whale_idx` on `token_transfers` (BNB's partitioned shape AND ETH's monolithic one), the
 * `lower()` text_pattern_ops indexes on `tokens`, and the boot sweep that must leave a
 * CONCURRENTLY build in flight alone.
 *
 * ensure-schema.test.ts pins the exact statements; it cannot show that
 *   - the partitioned parent becomes VALID after the last attach (it is invalid by design
 *     until then, and the invalid-index sweep must never be taught to drop it),
 *   - a partition made by the REAL partition creator (ensureForwardPartitions) inherits the
 *     index, so the newest partition — the one every query reads — is never silently bare,
 *   - the steady-state boot issues nothing but catalog reads and rebuilds nothing,
 *   - a run interrupted half-way resumes instead of duplicating, including when a partition
 *     appeared meanwhile (Postgres clones it an index under its OWN name), and a parent left
 *     invalid because retention DROPPED the last uncovered partition is re-validated,
 *   - the value-ordered query for EACH token's arm actually USES the one combined index,
 *     returns what a seq scan returns, and does NOT claim rows below that token's floor,
 *   - the boot sweep does not drop an index whose build is running (a plain DROP would queue
 *     ACCESS EXCLUSIVE behind it and stall every writer) yet still drops a dead one.
 * Lose any of these and nothing errors: the page just gets slow again.
 *
 * The code under test is the production path: ensurePartitionedTtWhaleIndexes /
 * ensureForwardPartitions go through the indexer's own getDb() (DATABASE_URL on bnb), which
 * this suite points at the fixture. Gated on TT_WHALE_INDEX_TEST_PG_URL. The database must
 * be disposable (its name must contain "test") and DEDICATED: the catalog helpers match
 * relations by name across schemas, and the suite creates and drops `token_transfers` and
 * `tokens` in public. Run locally with:
 *
 *   docker run -d --rm --name pg-ttwhale -e POSTGRES_PASSWORD=x \
 *     -e POSTGRES_DB=ttwhale_test -p 127.0.0.1:5467:5432 postgres:16
 *   TT_WHALE_INDEX_TEST_PG_URL=postgres://postgres:x@127.0.0.1:5467/ttwhale_test \
 *     npx vitest run apps/indexer/src/tt-whale-index.pg.test.ts
 */
const ENV = 'TT_WHALE_INDEX_TEST_PG_URL'
const PG_URL = process.env[ENV]
// FAIL CLOSED: this suite creates and DROPs production-named tables.
const DB_NAME = (() => {
  try {
    return PG_URL ? new URL(PG_URL).pathname.replace(/^\//, '') : ''
  } catch {
    return ''
  }
})()
const DISPOSABLE = /test/.test(DB_NAME)
// Route the indexer's chain-aware getDb() (bnb => DATABASE_URL) at the fixture.
if (PG_URL && DISPOSABLE) process.env.DATABASE_URL = PG_URL

type PlanNode = {
  'Node Type': string
  'Index Name'?: string
  'Relation Name'?: string
  'Rows Removed by Filter'?: number
  Plans?: PlanNode[]
}
const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)]
const shape = (nodes: PlanNode[]) =>
  nodes.map(n => n['Node Type'] + (n['Index Name'] ? `(${n['Index Name']})` : n['Relation Name'] ? `[${n['Relation Name']}]` : '')).join(' > ')

const BNB = getChainConfig('bnb').whales
const ETH = getChainConfig('eth').whales
const BNB_SPEC = ttWhaleIndex(BNB)
const ETH_SPEC = ttWhaleIndex(ETH)
const IDX = BNB_SPEC.name

const TT_COLUMNS = `
  tx_hash varchar(66) NOT NULL, log_index integer NOT NULL DEFAULT 0,
  token_address varchar(42) NOT NULL, from_address varchar(42) NOT NULL, to_address varchar(42) NOT NULL,
  value numeric(78,0) NOT NULL DEFAULT 0, token_id numeric(78,0),
  block_number bigint NOT NULL, timestamp timestamptz NOT NULL`

/**
 * 300,000 transfers over blocks [0, 300000). Eight tokens round-robin (the three tracked
 * ones among them, each in its own decimals); every 53rd row is a whale-size transfer
 * (>= 200,000 whole tokens, above every tracked floor) and every other row is 1-49 whole tokens,
 * under every tracked floor (the lowest is 50 WETH). 53 is coprime to 8, so
 * each token gets its share of whales (~700 rows) and the partial indexes hold ~2% of the
 * table — the shape the production indexes are meant to have.
 */
const padSql = (tracked: [string, string, string], decimals: [number, number, number]) => `
  INSERT INTO token_transfers (tx_hash, log_index, token_address, from_address, to_address, value, block_number, timestamp)
  SELECT '0x' || md5(i::text), 0,
         (ARRAY['${tracked[0]}', '0x${'1'.repeat(40)}', '${tracked[1]}', '0x${'2'.repeat(40)}',
                '${tracked[2]}', '0x${'3'.repeat(40)}', '0x${'4'.repeat(40)}', '0x${'5'.repeat(40)}'])[1 + (i % 8)],
         '0x${'a'.repeat(40)}', '0x${'b'.repeat(40)}',
         CASE WHEN i % 53 = 0 THEN (200000 + (i % 7919))::numeric * 10::numeric ^ (ARRAY[${decimals[0]}, 18, ${decimals[1]}, 18, ${decimals[2]}, 18, 18, 18])[1 + (i % 8)]
              ELSE (1 + (i % 49))::numeric * 10::numeric ^ (ARRAY[${decimals[0]}, 18, ${decimals[1]}, 18, ${decimals[2]}, 18, 18, 18])[1 + (i % 8)] END,
         i, now() - (i || ' seconds')::interval
  FROM generate_series(0, 299999) i`

describe.skipIf(!PG_URL)('round-5 indexes — against a real Postgres', () => {
  const conn = createMaintenanceConnection(PG_URL as string)
  const dialect = new PgDialect()

  const rows = async (q: string): Promise<Record<string, unknown>[]> => Array.from(await conn.unsafe(q))

  /** The parent index's state, or null when it does not exist. */
  const parentState = async (name: string) =>
    (await rows(
      `SELECT c.relkind AS kind, i.indisvalid AS valid, pg_get_indexdef(c.oid) AS def
       FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = '${name}'`,
    ))[0] as { kind: string; valid: boolean; def: string } | undefined

  /** table -> attached child index, for every partition that has one. */
  const attached = async (parent: string): Promise<Map<string, { name: string; valid: boolean }>> => {
    const out = new Map<string, { name: string; valid: boolean }>()
    for (const r of await rows(
      `SELECT t.relname AS tbl, ci.relname AS idx, i.indisvalid AS valid
       FROM pg_inherits h
       JOIN pg_class pc ON pc.oid = h.inhparent
       JOIN pg_class ci ON ci.oid = h.inhrelid
       JOIN pg_index i ON i.indexrelid = ci.oid
       JOIN pg_class t ON t.oid = i.indrelid
       WHERE pc.relname = '${parent}'`,
    )) out.set(String(r.tbl), { name: String(r.idx), valid: r.valid === true })
    return out
  }

  const partitionNames = async () =>
    (await rows(
      `SELECT c.relname AS name FROM pg_inherits h JOIN pg_class c ON c.oid = h.inhrelid
       WHERE h.inhparent = 'token_transfers'::regclass ORDER BY 1`,
    )).map(r => String(r.name))

  /** How many partial indexes sit on the partition: more than one means a duplicate. */
  const partialIndexesOn = async (partition: string) =>
    Number((await rows(
      `SELECT count(*)::int AS n FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
       WHERE t.relname = '${partition}' AND i.indpred IS NOT NULL`,
    ))[0].n)

  const indexEntries = async (names: string[]) =>
    Number((await rows(
      `SELECT coalesce(sum(reltuples), 0)::int AS n FROM pg_class WHERE relname IN (${names.map(n => `'${n}'`).join(',')})`,
    ))[0].n)

  const filenodes = async () =>
    Object.fromEntries(
      (await rows(`SELECT relname, relfilenode::text AS fn FROM pg_class WHERE relname LIKE '%whale%' AND relkind IN ('i','I')`))
        .map(r => [String(r.relname), String(r.fn)]),
    )

  async function plan(query: string): Promise<PlanNode[]> {
    const res = await conn.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`)
    return flatten((res[0]['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0].Plan)
  }

  /** The value-ordered whale arm, as a query would write it: the token and the floor as LITERALS. */
  const whaleArm = (token: string, floor: string, extra = '') =>
    `SELECT tx_hash, value, block_number FROM token_transfers
     WHERE token_address = '${token}' AND value > ${floor} ${extra}
     ORDER BY value DESC, tx_hash LIMIT 25`

  /** Same rows, but forced through a sequential scan: the oracle the index must agree with. */
  async function seqScanRows(query: string) {
    await conn.unsafe('SET enable_indexscan = off')
    await conn.unsafe('SET enable_bitmapscan = off')
    await conn.unsafe('SET enable_indexonlyscan = off')
    try {
      return (await rows(query)).map(r => `${r.tx_hash}:${r.value}`)
    } finally {
      await conn.unsafe('RESET enable_indexscan')
      await conn.unsafe('RESET enable_bitmapscan')
      await conn.unsafe('RESET enable_indexonlyscan')
    }
  }

  beforeAll(async () => {
    if (!DISPOSABLE) {
      throw new Error(`${ENV} database "${DB_NAME}" is not disposable — its name must contain "test" (this suite drops production-named tables)`)
    }
    const [{ db: name }] = await conn.unsafe('SELECT current_database() AS db')
    if (!/test/.test(String(name))) throw new Error(`${ENV} connected to "${name}", which is not a disposable database`)
    await conn.unsafe('DROP TABLE IF EXISTS token_transfers CASCADE')
    await conn.unsafe('DROP TABLE IF EXISTS tokens CASCADE')
  }, 60_000)

  afterAll(async () => {
    // beforeAll can throw on a non-disposable URL and afterAll still runs: never DROP then.
    if (DISPOSABLE) {
      await conn.unsafe('DROP TABLE IF EXISTS token_transfers CASCADE')
      await conn.unsafe('DROP TABLE IF EXISTS tokens CASCADE')
    }
    await conn.end({ timeout: 5 })
  })

  // ── BNB: RANGE-partitioned by block_number, with the migration's `legacy` partition ──
  describe('partitioned token_transfers (BNB)', () => {
    const tokens = [BNB.wrapped, ...BNB.stablecoins]
    const tracked: [string, string, string] = [
      BNB.stablecoins[0].address, BNB.stablecoins[1].address, BNB.wrapped.address,
    ]

    beforeAll(async () => {
      await conn.unsafe('DROP TABLE IF EXISTS token_transfers CASCADE')
      await conn.unsafe(`CREATE TABLE token_transfers (${TT_COLUMNS}) PARTITION BY RANGE (block_number)`)
      await conn.unsafe('CREATE TABLE token_transfers_legacy PARTITION OF token_transfers FOR VALUES FROM (0) TO (100000)')
      await conn.unsafe('CREATE TABLE token_transfers_p_100000 PARTITION OF token_transfers FOR VALUES FROM (100000) TO (200000)')
      await conn.unsafe('CREATE TABLE token_transfers_p_200000 PARTITION OF token_transfers FOR VALUES FROM (200000) TO (300000)')
      await conn.unsafe(padSql(tracked, [18, 18, 18]))
      await conn.unsafe('ANALYZE token_transfers')
    }, 120_000)

    it('builds the parent VALID, with exactly one valid, deterministically named child per partition', async () => {
      await ensurePartitionedTtWhaleIndex()
      const partitions = await partitionNames()
      expect(partitions).toEqual(['token_transfers_legacy', 'token_transfers_p_100000', 'token_transfers_p_200000'])
      const parent = await parentState(IDX)
      expect(parent?.kind, 'a partitioned index').toBe('I')
      expect(parent?.valid, 'parent valid after the last attach').toBe(true)
      const children = await attached(IDX)
      expect([...children.keys()].sort()).toEqual(partitions)
      for (const part of partitions) {
        expect(children.get(part), `on ${part}`).toEqual({ name: buildPartitionedTtWhaleIndexSql(BNB_SPEC, part).childName, valid: true })
      }
    }, 120_000)

    it('is ONE index, PARTIAL on every tracked token\'s literal address and floor', async () => {
      const names = (await rows(`SELECT relname FROM pg_class WHERE relname LIKE 'tt\\_whale%' AND relkind = 'I'`)).map(r => r.relname)
      expect(names).toEqual([IDX])
      const def = (await parentState(IDX))!.def.replace(/\s+/g, ' ')
      expect(def).toContain('ON ONLY public.token_transfers USING btree (token_address, value DESC)')
      for (const t of tokens) {
        expect(def, t.symbol).toContain(`(token_address)::text = '${t.address}'::text`)
        expect(def, t.symbol).toContain(`value > '${t.indexFloor}'::numeric`)
      }
    })

    it('holds only whale-size rows (a small share of the table), not every transfer of the tracked tokens', async () => {
      const [total] = await rows('SELECT count(*)::int AS n FROM token_transfers')
      const [tokensRows] = await rows(`SELECT count(*)::int AS n FROM token_transfers WHERE token_address IN (${tracked.map(a => `'${a}'`).join(',')})`)
      const [whales] = await rows(`SELECT count(*)::int AS n FROM token_transfers WHERE ${BNB_SPEC.predicate}`)
      // The index's OWN entry count (a fresh build's reltuples is exact), summed over its partitions.
      const entries = await indexEntries([...(await attached(IDX)).values()].map(c => c.name))
      expect(Number(tokensRows.n)).toBeGreaterThan(100_000)
      expect(entries).toBe(Number(whales.n))
      expect(entries).toBeGreaterThan(1_000)
      expect(entries).toBeLessThan(Number(total.n) / 30)
    })

    // Steady state is the common boot: it must cost a few catalog reads and nothing else.
    it('a second run issues nothing but catalog SELECTs and rebuilds nothing', async () => {
      const before = await filenodes()
      expect(Object.keys(before).length).toBe(4)  // the parent + 3 children
      const spy = vi.spyOn(getDb('DATABASE_URL'), 'execute')
      try {
        await ensurePartitionedTtWhaleIndex()
        const issued = spy.mock.calls.map(([q]) => dialect.sqlToQuery(q as never).sql.replace(/\s+/g, ' ').trim())
        for (const stmt of issued) expect(stmt, 'no DDL on the no-op path').toMatch(/^SELECT /)
        expect(issued.length, issued.join(' | ')).toBe(2)  // is it partitioned + is the parent valid
      } finally {
        spy.mockRestore()
      }
      expect(await filenodes()).toEqual(before)
    })

    // The recipe's whole point: a partition made later gets the index with no pass of ours.
    it('a partition created by the real partition creator inherits the index', async () => {
      const before = new Set(await partitionNames())
      await ensureForwardPartitions()
      const created = (await partitionNames()).filter(p => !before.has(p))
      expect(created.length, 'the creator made forward partitions').toBeGreaterThan(0)
      const children = await attached(IDX)
      for (const part of created) expect(children.get(part), `new partition ${part}`).toMatchObject({ valid: true })
      expect((await parentState(IDX))?.valid, 'stays valid').toBe(true)
      // ...and the next boot has nothing to do for them (it never goes by name).
      await ensurePartitionedTtWhaleIndex()
      for (const part of created) expect(await partialIndexesOn(part), part).toBe(1)
    }, 60_000)

    // The reason it is ONE index: a single-token arm must still use it. Postgres proves
    // "token = a AND value > F" implies that token's arm of the OR; the equality on the leading
    // column supplies the value order, merged across partitions.
    it.each(['wrapped', 'stablecoin 1', 'stablecoin 2'])('the value-ordered whale arm of the %s uses the combined index on every partition, with no sort and no seq scan', async (which) => {
      const t = which === 'wrapped' ? BNB.wrapped : which === 'stablecoin 1' ? BNB.stablecoins[0] : BNB.stablecoins[1]
      const children = new Set([...(await attached(IDX)).values()].map(c => c.name))
      const nodes = await plan(whaleArm(t.address, t.indexFloor))
      const label = `${t.symbol}: ${shape(nodes)}`
      const scans = nodes.filter(n => n['Index Name'] !== undefined)
      expect(scans.length, label).toBeGreaterThanOrEqual(3)
      for (const s of scans) expect(children.has(s['Index Name']!), `${label} — ${s['Index Name']} is a ${IDX} child`).toBe(true)
      expect(nodes.some(n => /Seq Scan/.test(n['Node Type'])), label).toBe(false)
      expect(nodes.some(n => n['Node Type'] === 'Sort'), label).toBe(false)  // ordered by the index, merged
      expect(nodes.some(n => n['Node Type'] === 'Merge Append'), label).toBe(true)
      for (const s of scans) expect(s['Rows Removed by Filter'] ?? 0, label).toBe(0)  // holds nothing it then throws away
    })

    it('returns exactly the rows a sequential scan returns, for every arm', async () => {
      for (const t of tokens) {
        const query = whaleArm(t.address, t.indexFloor)
        const viaIndex = (await rows(query)).map(r => `${r.tx_hash}:${r.value}`)
        expect(viaIndex.length, t.symbol).toBe(25)
        expect(viaIndex, t.symbol).toEqual(await seqScanRows(query))
      }
    })

    // The index only holds each token's rows above THAT token's floor, so a query for anything lower cannot use it.
    it('is NOT used by a query whose threshold is below its token\'s floor, which still returns correct rows', async () => {
      const t = BNB.stablecoins[0]
      const children = new Set([...(await attached(IDX)).values()].map(c => c.name))
      for (const below of [(BigInt(t.indexFloor) / 10n).toString(), '1']) {
        const query = whaleArm(t.address, below)
        const nodes = await plan(query)
        expect(nodes.filter(n => n['Index Name'] && children.has(n['Index Name'])), shape(nodes)).toEqual([])
        expect((await rows(query)).map(r => `${r.tx_hash}:${r.value}`)).toEqual(await seqScanRows(query))
      }
    })

    // A token that is NOT in the predicate is not served either, whatever its threshold.
    it('is NOT used for a token outside the predicate', async () => {
      const children = new Set([...(await attached(IDX)).values()].map(c => c.name))
      const nodes = await plan(whaleArm(`0x${'1'.repeat(40)}`, BNB.stablecoins[0].indexFloor))
      expect(nodes.filter(n => n['Index Name'] && children.has(n['Index Name'])), shape(nodes)).toEqual([])
    })

    // A run killed after some children attached leaves the parent invalid. The next boot must finish
    // it — not rebuild the finished children, and not duplicate on a partition that appeared meanwhile.
    it('resumes an interrupted build and leaves no duplicate on a partition created mid-way', async () => {
      const w = BNB_SPEC
      await conn.unsafe(`DROP INDEX ${w.name}`)  // a partitioned index drops with its children
      expect(await parentState(w.name)).toBeUndefined()

      const partitions = (await partitionNames()).filter(p => !/^token_transfers_p_(?:[3-9]\d{5}|\d{7,})$/.test(p))
      expect(partitions.length).toBe(3)
      // The first two partitions finished; then the process died.
      await conn.unsafe(buildPartitionedTtWhaleIndexSql(w, partitions[0]).parent)
      for (const part of partitions.slice(0, 2)) {
        const sqls = buildPartitionedTtWhaleIndexSql(w, part)
        await conn.unsafe(sqls.child)
        await conn.unsafe(sqls.attach)
      }
      expect((await parentState(w.name))?.valid, 'parent is invalid until the last partition attaches').toBe(false)
      const done = await filenodes()

      // A partition appears while the parent is invalid: Postgres clones it an index under its own name.
      await conn.unsafe('CREATE TABLE token_transfers_p_9000000 PARTITION OF token_transfers FOR VALUES FROM (9000000) TO (9100000)')
      const cloned = (await attached(w.name)).get('token_transfers_p_9000000')
      expect(cloned?.valid).toBe(true)
      expect(cloned?.name).not.toBe(buildPartitionedTtWhaleIndexSql(w, 'token_transfers_p_9000000').childName)

      await ensurePartitionedTtWhaleIndex(w)

      expect((await parentState(w.name))?.valid, 'resumed to valid').toBe(true)
      const after = await filenodes()
      for (const [name, fn] of Object.entries(done)) expect(after[name], `${name} was not rebuilt`).toBe(fn)
      for (const part of await partitionNames()) expect(await partialIndexesOn(part), `exactly one partial index on ${part}`).toBe(1)
    }, 120_000)

    // Retention DROPs the oldest partition. If the build was part-way, the last UNCOVERED partition can be
    // the one dropped: every remaining partition is then indexed, yet Postgres only re-evaluates a parent's
    // validity when a child is ATTACHED — so it would stay invalid for ever. The fix is a repeated ATTACH.
    it('re-validates a parent left invalid because retention dropped the last uncovered partition', async () => {
      const w = BNB_SPEC
      await conn.unsafe(`DROP INDEX ${w.name}`)
      await conn.unsafe('CREATE TABLE token_transfers_p_9200000 PARTITION OF token_transfers FOR VALUES FROM (9200000) TO (9300000)')  // no parent yet: not cloned
      const covered = (await partitionNames()).filter(p => p !== 'token_transfers_p_9200000')
      await conn.unsafe(buildPartitionedTtWhaleIndexSql(w, covered[0]).parent)
      for (const part of covered) {
        const sqls = buildPartitionedTtWhaleIndexSql(w, part)
        await conn.unsafe(sqls.child)
        await conn.unsafe(sqls.attach)
      }
      expect((await parentState(w.name))?.valid, 'every partition but one is covered').toBe(false)
      await conn.unsafe('DROP TABLE token_transfers_p_9200000')  // retention
      expect((await parentState(w.name))?.valid, 'Postgres does NOT re-validate on DROP: this is the trap').toBe(false)
      expect((await attached(w.name)).size).toBe((await partitionNames()).length)

      await ensurePartitionedTtWhaleIndex(w)
      expect((await parentState(w.name))?.valid, 'ensure re-attaches an attached child, which re-validates').toBe(true)
    }, 120_000)
  })

  // ── ETH: a plain, non-partitioned token_transfers ──
  describe('monolithic token_transfers (ETH)', () => {
    const tokens = [ETH.wrapped, ...ETH.stablecoins]
    const tracked: [string, string, string] = [
      ETH.stablecoins[0].address, ETH.stablecoins[1].address, ETH.wrapped.address,
    ]
    // Exactly what ensureSchema's background pass executes, one CONCURRENTLY statement.
    const whaleStatements = () =>
      buildConcurrentIndexList(false, ETH.nativeIndexFloorWei, ETH_SPEC).filter(s => s.includes(' tt_whale_'))

    beforeAll(async () => {
      await conn.unsafe('DROP TABLE IF EXISTS token_transfers CASCADE')
      await conn.unsafe(`CREATE TABLE token_transfers (${TT_COLUMNS})`)
      await conn.unsafe(padSql(tracked, [6, 6, 18]))   // USDT/USDC 6 decimals, WETH 18
      await conn.unsafe('ANALYZE token_transfers')
    }, 120_000)

    it('builds ONE valid ordinary index, and re-running changes nothing', async () => {
      const stmts = whaleStatements()
      expect(stmts).toHaveLength(1)
      await conn.unsafe(stmts[0])
      expect((await parentState(IDX))?.kind).toBe('i')
      expect((await parentState(IDX))?.valid).toBe(true)
      const before = await filenodes()
      await conn.unsafe(stmts[0])   // IF NOT EXISTS: a no-op
      expect(await filenodes()).toEqual(before)
    }, 120_000)

    it('the value-ordered whale arm of EVERY token uses it, orders by the index, and agrees with a seq scan', async () => {
      for (const t of tokens) {
        const query = whaleArm(t.address, t.indexFloor)
        const nodes = await plan(query)
        const label = `${t.symbol}: ${shape(nodes)}`
        expect(nodes.filter(n => n['Index Name']).map(n => n['Index Name']), label).toEqual([IDX])
        expect(nodes.some(n => n['Node Type'] === 'Sort'), label).toBe(false)
        const viaIndex = (await rows(query)).map(r => `${r.tx_hash}:${r.value}`)
        expect(viaIndex.length, t.symbol).toBe(25)
        expect(viaIndex, t.symbol).toEqual(await seqScanRows(query))
      }
    })

    it('is NOT used below a token\'s floor, nor for a token outside the predicate', async () => {
      const t = ETH.stablecoins[0]
      const below = await plan(whaleArm(t.address, (BigInt(t.indexFloor) / 10n).toString()))
      expect(below.filter(n => n['Index Name'] === IDX), shape(below)).toEqual([])
      const other = await plan(whaleArm(`0x${'1'.repeat(40)}`, t.indexFloor))
      expect(other.filter(n => n['Index Name'] === IDX), shape(other)).toEqual([])
    })

    // The write overhead of this index is limited to whale-size rows, and "whale-size" is PER TOKEN: 20,000 inserts that stay
    // under their own token's floor must not add a page — including a WETH row worth 10^12 wei, which is above USDT's floor
    // (10^11) but nowhere near WETH's (5 x 10^19) — while 20,000 above their floor must.
    it('does not grow for sub-floor inserts of any token, and does for whale-size ones', async () => {
      const usdt = ETH.stablecoins[0].address
      const weth = ETH.wrapped.address
      const size = async () => Number((await rows(`SELECT pg_relation_size('${IDX}') AS n`))[0].n)
      const insert = (token: string, value: string, tag: string) => conn.unsafe(
        `INSERT INTO token_transfers (tx_hash, token_address, from_address, to_address, value, block_number, timestamp)
         SELECT '0xe' || '${tag}' || i, '${token}', '0x1', '0x2', ${value} + i, 1, now() FROM generate_series(1, 20000) i`)
      const base = await size()
      expect(base).toBeGreaterThan(0)
      await insert(usdt, '99000000000', 'under')                       // $99k, under USDT's floor
      expect(await size(), '20,000 sub-floor USDT rows').toBe(base)
      await insert(weth, '1000000000000', 'wethunder')                 // 10^12 wei: over USDT's floor, far under WETH's
      expect(await size(), "20,000 WETH rows above USDT's floor but under WETH's").toBe(base)
      await insert(usdt, '101000000000', 'over')                       // $101k
      expect(await size(), '20,000 whale-size USDT rows').toBeGreaterThan(base)
    })
  })

  // ── tokens: exact and prefix search, both chains ──
  describe('tokens lower() text_pattern_ops indexes', () => {
    const statements = () =>
      buildConcurrentIndexList(false, BNB.nativeIndexFloorWei, BNB_SPEC)
        .filter(s => /tokens_lower_(symbol|name)_idx/.test(s))

    beforeAll(async () => {
      await conn.unsafe('DROP TABLE IF EXISTS tokens CASCADE')
      // The production DB's collation is en_US.UTF-8, under which a plain b-tree cannot serve LIKE 'q%'
      // — that is exactly what text_pattern_ops is for. The fixture uses the server default, so assert
      // the suite does not depend on it by also checking the plan on the prefix form below.
      await conn.unsafe(`CREATE TABLE tokens (
        address varchar(42) PRIMARY KEY, name varchar(255) NOT NULL, symbol varchar(50) NOT NULL,
        decimals integer NOT NULL DEFAULT 18, total_supply numeric(78,0) NOT NULL DEFAULT 0,
        holder_count integer NOT NULL DEFAULT 0, logo_url text)`)
      // 200k tokens; symbols/names mixed-case so lower() matters; a handful of real-looking rows.
      await conn.unsafe(`INSERT INTO tokens (address, name, symbol)
        SELECT '0x' || md5(i::text) || substr(md5('a' || i::text), 1, 8),
               'Token ' || md5('n' || i::text), upper(substr(md5('s' || i::text), 1, 6))
        FROM generate_series(1, 200000) i`)
      await conn.unsafe(`INSERT INTO tokens (address, name, symbol) VALUES
        ('0x${'c'.repeat(40)}', 'Tether USD', 'USDT'), ('0x${'d'.repeat(40)}', 'USD Coin', 'USDC'),
        ('0x${'e'.repeat(40)}', 'Wrapped BNB', 'WBNB'), ('0x${'f'.repeat(40)}', 'Tether Gold', 'XAUt')`)
    }, 120_000)

    it('builds both, valid', async () => {
      expect(statements()).toHaveLength(2)
      for (const stmt of statements()) await conn.unsafe(stmt)
      await conn.unsafe('ANALYZE tokens')
      for (const name of ['tokens_lower_symbol_idx', 'tokens_lower_name_idx']) {
        expect((await parentState(name))?.valid, name).toBe(true)
        expect((await parentState(name))?.def, name).toContain('text_pattern_ops')
      }
    })

    it.each([
      ['exact symbol', `SELECT address FROM tokens WHERE lower(symbol) = 'usdt'`, 'tokens_lower_symbol_idx', 1],
      ['prefix symbol', `SELECT address FROM tokens WHERE lower(symbol) LIKE 'usd' || '%' ORDER BY lower(symbol) LIMIT 50`, 'tokens_lower_symbol_idx', 2],
      ['exact name', `SELECT address FROM tokens WHERE lower(name) = 'tether usd'`, 'tokens_lower_name_idx', 1],
      ['prefix name', `SELECT address FROM tokens WHERE lower(name) LIKE 'tether' || '%' ORDER BY lower(name) LIMIT 50`, 'tokens_lower_name_idx', 2],
    ])('%s uses its index', async (label, query, index, expectedRows) => {
      const nodes = await plan(query)
      const used = nodes.filter(n => n['Index Name']).map(n => n['Index Name'])
      expect(used, `${label}: ${shape(nodes)}`).toContain(index)
      expect(nodes.some(n => /Seq Scan/.test(n['Node Type'])), `${label}: ${shape(nodes)}`).toBe(false)
      expect((await rows(query)).length, label).toBeGreaterThanOrEqual(expectedRows)
    })
  })
  // ── the boot sweep ──
  // ensureSchema drops invalid LEAF indexes at boot so a dead CONCURRENTLY build can be redone. An index whose build is
  // RUNNING is invalid too. Measured on PG16: a plain DROP INDEX on it queues ACCESS EXCLUSIVE behind the build, which
  // stalls the boot and every later request on the table (inserts included) for as long as the build runs.
  describe('boot sweep vs an index build in flight', () => {
    const blocker = createMaintenanceConnection(PG_URL as string)   // holds the table the way an in-flight writer does
    const builder = createMaintenanceConnection(PG_URL as string)   // runs the CREATE INDEX CONCURRENTLY
    const reader = createMaintenanceConnection(PG_URL as string)    // a long reader
    const waitFor = async (what: string, fn: () => Promise<boolean>, ms = 15_000) => {
      const t0 = Date.now()
      while (!(await fn())) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
        await new Promise(r => setTimeout(r, 50))
      }
    }
    const indexValid = async (name: string) =>
      (await rows(`SELECT i.indisvalid AS v FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = '${name}'`))[0]?.v as boolean | undefined

    beforeAll(async () => {
      await conn.unsafe('DROP TABLE IF EXISTS sweep_probe CASCADE')
      await conn.unsafe('CREATE TABLE sweep_probe (a integer, v numeric)')
      await conn.unsafe('INSERT INTO sweep_probe SELECT i, i FROM generate_series(1, 5000) i')
    })
    afterAll(async () => {
      if (DISPOSABLE) await conn.unsafe('DROP TABLE IF EXISTS sweep_probe CASCADE')
      await Promise.all([blocker.end({ timeout: 5 }), builder.end({ timeout: 5 }), reader.end({ timeout: 5 })])
    })

    it('leaves an index whose CONCURRENTLY build is in flight alone, and the build completes valid', async () => {
      let release!: () => void
      const held = new Promise<void>(r => { release = r })
      const blocked = blocker.begin(async tx => {
        await tx.unsafe('LOCK TABLE sweep_probe IN ROW EXCLUSIVE MODE')
        await held
      })
      // postgres.js queries are lazy: .execute() sends it now, `await` collects it later.
      const build = builder.unsafe('CREATE INDEX CONCURRENTLY sweep_building_idx ON sweep_probe (a)')
      try {
        await waitFor('the blocker to hold its lock', async () =>
          (await rows(`SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'sweep_probe' AND l.mode = 'RowExclusiveLock' AND l.granted`)).length > 0)
        build.execute()   // creates its (invalid) catalog entry, then waits for the writer above
        await waitFor('the build to show in pg_stat_progress_create_index', async () =>
          (await rows(`SELECT 1 FROM pg_stat_progress_create_index p JOIN pg_class c ON c.oid = p.index_relid WHERE c.relname = 'sweep_building_idx'`)).length > 0)
        expect(await indexValid('sweep_building_idx'), 'mid-build it is invalid, like a dead one').toBe(false)
        // What the sweep USED to select: it includes the index being built.
        const old = (await rows(`SELECT c.relname AS n FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE NOT i.indisvalid AND c.relkind = 'i'`)).map(r => r.n)
        expect(old).toContain('sweep_building_idx')

        const t0 = Date.now()
        const dropped = await sweepInvalidIndexes()
        expect(dropped, 'the sweep leaves it alone').not.toContain('sweep_building_idx')
        expect(Date.now() - t0, 'and does not queue behind the build').toBeLessThan(2_000)
        expect(await indexValid('sweep_building_idx')).toBe(false)   // still there
      } finally {
        release()
        await blocked
        await build.catch(() => {})
      }
      expect(await indexValid('sweep_building_idx'), 'the build finished and is valid').toBe(true)
    }, 60_000)

    it('still drops a DEAD invalid index (a failed build has no progress row)', async () => {
      await conn.unsafe('DROP TABLE IF EXISTS sweep_dead CASCADE')
      await conn.unsafe('CREATE TABLE sweep_dead (a integer)')
      await conn.unsafe('INSERT INTO sweep_dead VALUES (1), (1)')
      await expect(conn.unsafe('CREATE UNIQUE INDEX CONCURRENTLY sweep_dead_idx ON sweep_dead (a)')).rejects.toThrow()
      expect(await indexValid('sweep_dead_idx')).toBe(false)
      expect(await sweepInvalidIndexes()).toContain('sweep_dead_idx')
      expect(await indexValid('sweep_dead_idx')).toBeUndefined()
    })

    it('gives up on a drop it cannot lock within the timeout, logs it, and retries on the next sweep', async () => {
      await conn.unsafe('DROP TABLE IF EXISTS sweep_locked CASCADE')
      await conn.unsafe('CREATE TABLE sweep_locked (a integer)')
      await conn.unsafe('INSERT INTO sweep_locked VALUES (1), (1)')
      await expect(conn.unsafe('CREATE UNIQUE INDEX CONCURRENTLY sweep_locked_idx ON sweep_locked (a)')).rejects.toThrow()
      let release!: () => void
      const held = new Promise<void>(r => { release = r })
      const reading = reader.begin(async tx => {
        await tx.unsafe('LOCK TABLE sweep_locked IN ACCESS SHARE MODE')   // a long reader: blocks the ACCESS EXCLUSIVE a DROP INDEX wants
        await held
      })
      await waitFor('the reader to hold its lock', async () =>
        (await rows(`SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'sweep_locked' AND l.mode = 'AccessShareLock' AND l.granted`)).length > 0)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const t0 = Date.now()
        const dropped = await sweepInvalidIndexes()
        const took = Date.now() - t0
        expect(dropped).not.toContain('sweep_locked_idx')
        expect(took, 'bounded by the 2s lock timeout').toBeGreaterThanOrEqual(1_500)
        expect(took).toBeLessThan(8_000)
        expect(warn.mock.calls.some(c => String(c[0]).includes('sweep_locked_idx'))).toBe(true)
        expect(await indexValid('sweep_locked_idx')).toBe(false)   // skipped, not dropped
      } finally {
        warn.mockRestore()
        release()
        await reading
      }
      expect(await sweepInvalidIndexes()).toContain('sweep_locked_idx')   // next boot gets it
    }, 60_000)
  })

})

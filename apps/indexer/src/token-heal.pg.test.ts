import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { createMaintenanceConnection, schema } from '@altscan/db'
import type { ChainKey } from '@altscan/chain-config'
import { buildConcurrentIndexList, TOKENS_HEAL_IDX } from './ensure-schema'
import { HEAD_LIMIT, healCandidateOrder, healCandidateWhere, healHeadWhere } from './token-heal-query'

/**
 * The token-metadata healer's HEAD and KEYSET queries against a REAL Postgres.
 *
 * token-heal-query.test.ts pins how the SQL renders and ensure-schema.test.ts pins the
 * DDL text; neither can show that Postgres (a) walks the list with no skip and no repeat
 * when thousands of rows share a holder count, or (b) can prove the healer's
 * parameterised WHERE implies the PARTIAL index predicate and so uses the index at all.
 * Lose (b) — rename a placeholder, reorder a column — and the scan quietly becomes a
 * walk of tokens_holder_count_idx behind a heap filter. Nothing errors.
 *
 * The queries are the healer's own builders, run through the same drizzle -> postgres.js
 * path the healer uses (unnamed statements, planned with the bound values). The index is
 * the exact statement ensure-schema.ts runs at boot, and only that one: the full-table
 * index it replaced is not created.
 *
 * Gated on TOKEN_HEAL_TEST_PG_URL. Everything lives in its own schema on ONE
 * non-recycled connection, so the suite cannot collide with another sharing the database.
 * Run locally with:
 *
 *   docker run -d --rm --name pg-tokenheal -e POSTGRES_PASSWORD=x \
 *     -e POSTGRES_DB=heal_test -p 127.0.0.1:5465:5432 postgres:16
 *   TOKEN_HEAL_TEST_PG_URL=postgres://postgres:x@127.0.0.1:5465/heal_test \
 *     npx vitest run apps/indexer/src/token-heal.pg.test.ts
 */
const ENV = 'TOKEN_HEAL_TEST_PG_URL'
const PG_URL = process.env[ENV]
const SCHEMA = 'token_heal_seam_test'
const CHAINS: ChainKey[] = ['bnb', 'eth']

// Independent of the drizzle builders: the same predicates as literal SQL.
const ORACLE_WHERE: Record<ChainKey, string> = {
  bnb: `(name IN ('Unknown','') OR symbol IN ('???','') OR (total_supply = 0 AND type = 'BEP20'))`,
  eth: `((name IN ('Unknown','') OR symbol IN ('???','')) AND (total_supply <> 0 OR holder_count >= 2))`,
}

// 30,000 tokens, deterministic. ~70% sit at 0 holders and ~15% at 1, so almost every
// page boundary is a tie on holder_count and the address has to break it. Candidates
// are dense above the head threshold (more than HEAD_LIMIT per chain) and sparse below:
//   1  placeholder, non-zero supply          both chains
//   2  placeholder, zero supply              BNB; ETH only at >= 2 holders
//   3  real name and symbol, zero supply     BNB only (a BEP20)
//   4  real, zero supply, BEP721             neither
// A placeholder row has a placeholder name, symbol or both, spelled 'Unknown'/'???' or ''.
const N = 30_000
const frac = (salt: string) => `((('x' || substr(md5(i::text || '${salt}'), 1, 7))::bit(28)::int)::float8 / 268435456)`
const FIXTURE = `
  CREATE TYPE token_type AS ENUM ('BEP20', 'BEP721', 'BEP1155');
  CREATE TABLE tokens (
    address       varchar(42) PRIMARY KEY,
    name          varchar(255) NOT NULL,
    symbol        varchar(50) NOT NULL,
    decimals      integer NOT NULL DEFAULT 18,
    type          token_type NOT NULL DEFAULT 'BEP20',
    total_supply  numeric(78,0) NOT NULL DEFAULT '0',
    holder_count  integer NOT NULL DEFAULT 0,
    logo_url      text
  );
  CREATE INDEX tokens_holder_count_idx ON tokens (holder_count DESC);

  INSERT INTO tokens (address, name, symbol, type, total_supply, holder_count)
  SELECT '0x' || md5(i::text) || substr(md5('a' || i::text), 1, 8),
         CASE WHEN cls IN (1, 2) AND f4 < 0.6 THEN CASE WHEN f5 < 0.5 THEN 'Unknown' ELSE '' END ELSE 'Token ' || i END,
         CASE WHEN cls IN (1, 2) AND f4 >= 0.4 THEN CASE WHEN f5 < 0.5 THEN '???' ELSE '' END ELSE 'T' || (i % 1000) END,
         CASE WHEN cls = 4 THEN 'BEP721'::token_type ELSE 'BEP20'::token_type END,
         CASE WHEN cls IN (2, 3, 4) THEN 0 ELSE 1000000 + i END,
         hc
  FROM (
    SELECT i, f3, f4, f5, hc,
           CASE WHEN f3 < (CASE WHEN hc >= 2 THEN 0.08 ELSE 0.01 END) THEN 1
                WHEN f3 < (CASE WHEN hc >= 2 THEN 0.16 ELSE 0.03 END) THEN 2
                WHEN f3 < (CASE WHEN hc >= 2 THEN 0.24 ELSE 0.04 END) THEN 3
                WHEN f3 < (CASE WHEN hc >= 2 THEN 0.28 ELSE 0.05 END) THEN 4
                ELSE 0 END AS cls
    FROM (
      SELECT i, ${frac('c')} AS f3, ${frac('d')} AS f4, ${frac('e')} AS f5,
             CASE WHEN ${frac('a')} < 0.70 THEN 0
                  WHEN ${frac('a')} < 0.85 THEN 1
                  WHEN ${frac('a')} < 0.90 THEN 2
                  WHEN ${frac('a')} < 0.94 THEN 3
                  WHEN ${frac('a')} < 0.98 THEN 5 + floor(${frac('b')} * 10)::int
                  ELSE 100 + floor(${frac('b')} * 50)::int END AS hc
      FROM generate_series(1, ${N}) i
    ) g
  ) s;
  ANALYZE tokens;
`

type Row = { address: string; holderCount: number }
type PlanNode = { 'Node Type': string; 'Index Name'?: string; 'Index Cond'?: string; 'Rows Removed by Filter'?: number; Plans?: PlanNode[] }
const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)]

describe.skipIf(!PG_URL)('token-metadata healer: head + keyset SQL — against a real Postgres', () => {
  let conn: ReturnType<typeof createMaintenanceConnection>
  let db: ReturnType<typeof drizzle<typeof schema>>
  const { tokens } = schema
  const cols = {
    address: tokens.address, name: tokens.name, symbol: tokens.symbol, decimals: tokens.decimals,
    totalSupply: tokens.totalSupply, type: tokens.type, holderCount: tokens.holderCount,
  }
  const keyset = (chain: ChainKey, after: Row | null, limit: number) =>
    db.select(cols).from(tokens).where(healCandidateWhere(chain, after)).orderBy(...healCandidateOrder).limit(limit)
  const head = (chain: ChainKey) =>
    db.select(cols).from(tokens).where(healHeadWhere(chain)).orderBy(...healCandidateOrder).limit(HEAD_LIMIT)
  // The whole list, in order, from literal SQL.
  const oracle = async (chain: ChainKey, extra = ''): Promise<Row[]> =>
    (await conn.unsafe(
      `SELECT address, holder_count FROM tokens WHERE ${ORACLE_WHERE[chain]} ${extra} ORDER BY holder_count DESC, address DESC`,
    )).map(r => ({ address: r.address as string, holderCount: r.holder_count as number }))
  const key = (r: Row) => `${r.holderCount}:${r.address}`

  /** Pages through the list the way the healer does: each page resumes strictly after the last row. */
  async function walk(chain: ChainKey, pageSize: number, start: Row | null = null, maxPages = Infinity): Promise<Row[]> {
    const out: Row[] = []
    let after = start
    for (let pages = 0; pages < maxPages; pages++) {
      const page = await keyset(chain, after, pageSize)
      out.push(...page.map(r => ({ address: r.address, holderCount: r.holderCount })))
      if (page.length < pageSize) break
      const last = page[page.length - 1]
      after = { address: last.address, holderCount: last.holderCount }
    }
    return out
  }

  async function plan(query: { toSQL(): { sql: string; params: unknown[] } }): Promise<PlanNode[]> {
    const q = query.toSQL()
    const res = await conn.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${q.sql}`, q.params as never[])
    return flatten((res[0]['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0].Plan)
  }

  beforeAll(async () => {
    if (!/test/i.test(new URL(PG_URL as string).pathname)) {
      throw new Error(`${ENV} must name a disposable database (its name must contain "test")`)
    }
    conn = createMaintenanceConnection(PG_URL as string)
    const [{ db: name }] = await conn.unsafe('SELECT current_database() AS db')
    if (!/test/i.test(String(name))) throw new Error(`${ENV} connected to "${name}", which is not a disposable database`)
    db = drizzle(conn, { schema })
    await conn.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await conn.unsafe(`CREATE SCHEMA ${SCHEMA}`)
    // Unqualified `tokens` resolves through search_path exactly as in production.
    await conn.unsafe(`SET search_path TO ${SCHEMA}`)
    await conn.unsafe(FIXTURE)
    // The exact statement ensure-schema runs at boot (CONCURRENTLY, so on its own, not in a batch).
    const ddl = buildConcurrentIndexList(false, '1000000000000000000').find(s => s.includes(TOKENS_HEAL_IDX))!
    await conn.unsafe(ddl)
    await conn.unsafe('ANALYZE tokens')
  }, 120_000)

  afterAll(async () => {
    // beforeAll can throw on a non-disposable URL, and afterAll still runs: never DROP then.
    if (conn && /test/i.test(new URL(PG_URL as string).pathname)) {
      await conn.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    }
    await conn?.end({ timeout: 5 })
  })

  it('built a valid index, and the fixture is the tie-heavy shape the walk needs', async () => {
    const [idx] = await conn.unsafe(
      `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = '${TOKENS_HEAL_IDX}'`,
    )
    expect(idx.valid).toBe(true)
    // No full-table sibling: the plans below must be the partial index's, not a fallback.
    const names = (await conn.unsafe(`SELECT indexname FROM pg_indexes WHERE schemaname = '${SCHEMA}' AND tablename = 'tokens'`))
      .map(r => r.indexname)
    expect(names.sort()).toEqual(['tokens_heal_candidates_idx', 'tokens_holder_count_idx', 'tokens_pkey'])
    for (const chain of CHAINS) {
      const list = await oracle(chain)
      const atZero = list.filter(r => r.holderCount === 0).length
      expect(list.length, chain).toBeGreaterThan(900)
      expect(atZero, chain).toBeGreaterThan(200) // a long run of rows tied on holder_count
      expect(list.filter(r => r.holderCount >= 2).length, chain).toBeGreaterThan(HEAD_LIMIT)
    }
  })

  for (const chain of CHAINS) {
    describe(`${chain}`, () => {
      // No skip and no repeat: the walk is one ORDER BY, whatever the page size lands on.
      for (const pageSize of [80, 7]) {
        it(`walks the whole list in order at page size ${pageSize}`, async () => {
          const expected = await oracle(chain)
          const walked = await walk(chain, pageSize)
          expect(walked.length).toBe(expected.length)
          expect(walked.map(key)).toEqual(expected.map(key))
          expect(new Set(walked.map(r => r.address)).size).toBe(walked.length)
        })
      }

      // One row per page puts a page boundary between every pair of tied rows.
      it('resumes correctly one row at a time through the tie regions', async () => {
        for (const holders of [1, 0]) {
          const start = { holderCount: holders, address: '0x' + 'f'.repeat(40) }
          const expected = (await oracle(chain, `AND (holder_count, address) < (${holders}, '${start.address}')`)).slice(0, 400)
          const walked = await walk(chain, 1, start, 400)
          expect(walked.map(key), `from (${holders}, 0xff..)`).toEqual(expected.map(key))
        }
      })

      it('head returns the candidates with at least 2 holders, in list order, capped at HEAD_LIMIT', async () => {
        const rows = (await head(chain)).map(r => ({ address: r.address, holderCount: r.holderCount }))
        const expected = (await oracle(chain, 'AND holder_count >= 2')).slice(0, HEAD_LIMIT)
        expect(rows.length).toBe(HEAD_LIMIT)
        expect(rows.every(r => r.holderCount >= 2)).toBe(true)
        expect(rows.map(key)).toEqual(expected.map(key))
      })

      // Postgres only takes a partial index when it can PROVE the query's WHERE implies
      // the index predicate; with the full-table index gone there is no other index that
      // can serve this ORDER BY, so a failed proof is a sort over a walk of
      // tokens_holder_count_idx, not an error. Each statement is planned with its bound
      // values, as the client's unnamed statements are.
      it('uses the partial index with no sort — first page and cursors in the tie region', async () => {
        const deep = { holderCount: 0, address: '0x8' + '0'.repeat(39) }
        const queries = {
          'first page': keyset(chain, null, 80),
          'cursor at 0 holders': keyset(chain, deep, 80),
          'cursor at 1 holder': keyset(chain, { holderCount: 1, address: deep.address }, 80),
        }
        for (const [label, query] of Object.entries(queries)) {
          const nodes = await plan(query)
          const scans = nodes.filter(n => n['Index Name'] !== undefined)
          const shape = nodes.map(n => n['Node Type'] + (n['Index Name'] ? `(${n['Index Name']})` : '')).join(' > ')
          expect(scans.map(n => n['Index Name']), `${chain} ${label}: ${shape}`).toEqual([TOKENS_HEAL_IDX])
          expect(nodes.some(n => /Sort/.test(n['Node Type'])), `${chain} ${label}: ${shape}`).toBe(false)
          if (label.includes('cursor')) {
            // The row comparison is the scan's start, not a filter after it.
            expect(scans[0]['Index Cond'], `${chain} ${label}`).toMatch(/ROW\(holder_count, \(address\)::text\) < ROW\(/)
          }
          // BNB's predicate IS the index's, so a page reads nothing it then throws away.
          // ETH's is narrower than the union, so it may filter some.
          if (chain === 'bnb') expect(scans[0]['Rows Removed by Filter'] ?? 0, `${chain} ${label}`).toBe(0)
        }
      })

      // The head is a range on the leading column. On a table this small the planner may
      // satisfy it with a bitmap scan and a sort rather than an ordered scan; what has to
      // hold is that it is the partial index it reads, never tokens_holder_count_idx.
      it('reads the head from the partial index', async () => {
        const nodes = await plan(head(chain))
        const shape = nodes.map(n => n['Node Type'] + (n['Index Name'] ? `(${n['Index Name']})` : '')).join(' > ')
        expect(nodes.filter(n => n['Index Name'] !== undefined).map(n => n['Index Name']), `${chain} head: ${shape}`)
          .toEqual([TOKENS_HEAL_IDX])
      })
    })
  }
})

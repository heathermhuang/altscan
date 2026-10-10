import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { createMaintenanceConnection, schema } from '@altscan/db'
import { exactMatchQuery, suggestQuery } from './token-suggest'

/**
 * The two token lookups behind the header typeahead and /search's exact matches, against a REAL Postgres,
 * through the driver the app uses (drizzle on postgres.js).
 *
 * Both are served by expression indexes with text_pattern_ops (tokens_lower_symbol_idx, tokens_lower_name_idx),
 * and that is easy to lose silently: a prefix LIKE with a BOUND parameter only uses such an index when the
 * statement is planned with the parameter's value, and a plan that can't just seq-scans a multi-million-row
 * table (~3.6 s on BNB). So this asserts the plan, not the rows alone: every EXPLAIN here runs the exact
 * text and parameters drizzle produces, over the same unprepared `unsafe(query, params)` call it makes.
 *
 * Gated on TOKEN_SUGGEST_TEST_PG_URL. The table is TEMP on a single non-recycled connection, so the suite
 * cannot collide with another that shares the database; the DDL mirrors ensure-schema.ts's two indexes.
 */
const ENV = 'TOKEN_SUGGEST_TEST_PG_URL'
const PG_URL = process.env[ENV]

const FIXTURE = `
  CREATE TEMP TABLE tokens (
    address VARCHAR(42) PRIMARY KEY, name VARCHAR(255) NOT NULL, symbol VARCHAR(50) NOT NULL,
    decimals INTEGER NOT NULL DEFAULT 18, type TEXT NOT NULL DEFAULT 'BEP20',
    total_supply NUMERIC(78,0) NOT NULL DEFAULT 0, holder_count INTEGER NOT NULL DEFAULT 0, logo_url TEXT
  );
  -- 100,000 filler tokens: 5-letter symbols over 16 letters (so no filler prefix of 3+ letters is common),
  -- names of their own, holder counts that are mostly small.
  INSERT INTO tokens (address, name, symbol, holder_count)
  SELECT '0x' || md5(i::text) || '00000000',
         'Filler ' || translate(substr(md5('n' || i), 1, 6), '0123456789', 'ghijklmnop'),
         upper(translate(substr(md5('s' || i), 1, 5), '0123456789', 'ghijklmnop')),
         (hashint4(i)::bigint + 2147483648) % 500
  FROM generate_series(1, 100000) i;
  -- 40 USDT-named airdrops out-holding everything, one low-holder exact ticker, and symbols with LIKE wildcards.
  INSERT INTO tokens (address, name, symbol, holder_count)
  SELECT '0x' || md5('u' || i) || '00000000', 'Tether USD', 'USDT', 9000000 - i FROM generate_series(1, 40) i;
  INSERT INTO tokens (address, name, symbol, holder_count) VALUES
    ('${'0x' + '0'.repeat(37) + 'abc'}', 'Zq Rare Token', 'ZQ', 3),
    ('${'0x' + '0'.repeat(37) + 'abd'}', 'Rare Name Coin', 'RNC', 2),
    ('${'0x' + '0'.repeat(37) + 'abe'}', '100% Pure', '100%', 7),
    ('${'0x' + '0'.repeat(37) + 'abf'}', 'Under_score', 'A_B', 6),
    ('${'0x' + '0'.repeat(37) + 'ac0'}', 'Azb Not Underscore', 'AZB', 9);

  CREATE INDEX tokens_holder_count_idx ON tokens (holder_count DESC);
  CREATE INDEX tokens_lower_symbol_idx ON tokens (lower(symbol) text_pattern_ops);
  CREATE INDEX tokens_lower_name_idx ON tokens (lower(name) text_pattern_ops);
  ANALYZE tokens;
`

type PlanNode = { 'Node Type': string; 'Index Name'?: string; 'Relation Name'?: string; Plans?: PlanNode[] }
const walk = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(walk)]

describe.skipIf(!PG_URL)('token suggestion + exact-match lookups — against a real Postgres', () => {
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

  /** The plan Postgres picks for the exact statement drizzle sends, as { index names used, any seq scan }. */
  async function planOf(q: { toSQL(): { sql: string; params: unknown[] } }) {
    const { sql: text, params } = q.toSQL()
    const [{ 'QUERY PLAN': [explained] }] = await conn.unsafe(`EXPLAIN (FORMAT JSON) ${text}`, params as never[])
    const nodes = walk(explained.Plan as PlanNode)
    return {
      indexes: [...new Set(nodes.map((n) => n['Index Name']).filter(Boolean))],
      seqScan: nodes.some((n) => n['Node Type'] === 'Seq Scan'),
    }
  }

  describe('suggestQuery', () => {
    it.each(['zq', 'rn', 'abc', 'us'])('reads tokens_lower_symbol_idx, not the table, for the prefix %s', async (prefix) => {
      const plan = await planOf(suggestQuery(db, prefix))
      expect(plan.seqScan).toBe(false)
      expect(plan.indexes).toContain('tokens_lower_symbol_idx')
    })

    it('returns the most-held tokens with that symbol prefix, case-insensitively', async () => {
      const rows = await suggestQuery(db, 'usd')
      expect(rows).toHaveLength(20)
      expect(rows[0]).toMatchObject({ symbol: 'USDT', holderCount: 9000000 - 1 })
      expect(rows.map((r) => r.holderCount)).toEqual([...rows.map((r) => r.holderCount)].sort((a, b) => b - a))
    })

    it('matches the visitor\'s % and _ literally, not as wildcards', async () => {
      expect((await suggestQuery(db, '100%')).map((r) => r.symbol)).toEqual(['100%'])
      expect((await suggestQuery(db, 'a_b')).map((r) => r.symbol)).toEqual(['A_B'])
    })
  })

  describe('exactMatchQuery', () => {
    it.each(['zq', 'rare name coin'])('reads the expression indexes, not the table, for %s', async (q) => {
      const plan = await planOf(exactMatchQuery(db, q, 10))
      expect(plan.seqScan).toBe(false)
      expect(plan.indexes).toEqual(expect.arrayContaining(['tokens_lower_symbol_idx', 'tokens_lower_name_idx']))
    })

    it('finds a low-holder token by its exact symbol and by its exact name, nothing that merely contains them', async () => {
      expect((await exactMatchQuery(db, 'zq', 10)).map((r) => r.symbol)).toEqual(['ZQ'])
      expect((await exactMatchQuery(db, 'rare name coin', 10)).map((r) => r.symbol)).toEqual(['RNC'])
      expect(await exactMatchQuery(db, 'z', 10)).toEqual([])
    })
  })
})

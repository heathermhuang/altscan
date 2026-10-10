import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { createMaintenanceConnection, schema, unwrapDbError } from '@altscan/db'
import { PgDialect } from 'drizzle-orm/pg-core'
import { sql, type SQL } from 'drizzle-orm'
import { exactMatchQuery, suggestQuery, suggestRows, SUGGEST_TIMEOUT_MS, withStatementTimeout } from './token-suggest'
import { withTimeout } from './with-timeout'

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
  -- 60 USDT-named airdrops out-holding everything, one low-holder exact ticker, and symbols with LIKE wildcards.
  INSERT INTO tokens (address, name, symbol, holder_count)
  SELECT '0x' || md5('u' || i) || '00000000', 'Tether USD', 'USDT', 9000000 - i FROM generate_series(1, 60) i;
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

type PlanNode = {
  'Node Type': string; 'Index Name'?: string; 'Relation Name'?: string; 'Actual Rows'?: number; 'Actual Loops'?: number
  'Rows Removed by Filter'?: number; Plans?: PlanNode[]
}
const walk = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(walk)]

describe.skipIf(!PG_URL)('token suggestion + exact-match lookups — against a real Postgres', () => {
  let conn: ReturnType<typeof createMaintenanceConnection>
  let observer: ReturnType<typeof createMaintenanceConnection> // a second session, to look at the first from outside
  let db: ReturnType<typeof drizzle<typeof schema>>

  beforeAll(async () => {
    if (!/test/i.test(new URL(PG_URL as string).pathname)) {
      throw new Error(`${ENV} must name a disposable database (its name must contain "test")`)
    }
    conn = createMaintenanceConnection(PG_URL as string)
    observer = createMaintenanceConnection(PG_URL as string)
    db = drizzle(conn, { schema })
    await conn.unsafe(FIXTURE)
  }, 120_000)

  afterAll(async () => {
    await conn?.end({ timeout: 5 })
    await observer?.end({ timeout: 5 })
  })

  const toText = (q: SQL | { toSQL(): { sql: string; params: unknown[] } }) =>
    'toSQL' in q ? q.toSQL() : new PgDialect().sqlToQuery(q)

  /**
   * The plan Postgres picks for the exact statement drizzle sends: the index names used, whether it seq-scans,
   * and how many tokens rows it read (returned, or read and thrown away by a filter).
   */
  async function planOf(q: SQL | { toSQL(): { sql: string; params: unknown[] } }) {
    const { sql: text, params } = toText(q)
    const [{ 'QUERY PLAN': [explained] }] = await conn.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, params as never[])
    const nodes = walk(explained.Plan as PlanNode)
    const scans = nodes.filter((n) => /Scan$/.test(n['Node Type']) && n['Node Type'] !== 'Bitmap Index Scan' && n['Relation Name'] === 'tokens')
    return {
      indexes: [...new Set(nodes.map((n) => n['Index Name']).filter(Boolean))],
      seqScan: nodes.some((n) => n['Node Type'] === 'Seq Scan'),
      rowsRead: scans.reduce((n, s) => n + ((s['Actual Rows'] ?? 0) + (s['Rows Removed by Filter'] ?? 0)) * (s['Actual Loops'] ?? 1), 0),
    }
  }

  // The prefix LIKE is only index-able with the pattern known at plan time. A NAMED prepared statement is
  // planned generically after five executions, and then walks tokens_holder_count_idx filtering every row
  // (measured on 1.5M rows: ~500k rows removed per worker for a one-row answer). drizzle's postgres-js
  // calls `unsafe(query, params)`, which is unprepared, so every execution is planned with its values. (Inside
  // the typeahead's transaction postgres.js prepares its own COMMIT, which is why this looks at what is prepared,
  // not how many.)
  it('runs the lookups unprepared: executing them leaves no named prepared statement of theirs behind', async () => {
    const prepared = async () => (await conn.unsafe('SELECT statement FROM pg_prepared_statements')).map((r) => String(r.statement))
    const before = await prepared()
    for (let i = 0; i < 8; i++) { await suggestRows(db, 'zq'); await exactMatchQuery(db, 'zq', 10) }
    const added = (await prepared()).filter((q) => !before.includes(q))
    expect(added.filter((q) => /tokens|statement_timeout/i.test(q))).toEqual([])
    expect(added.filter((q) => q.trim().toLowerCase() !== 'commit')).toEqual([])
  })

  // withTimeout only stops WAITING; the query kept running on the server, holding a pooled connection. The wrapper
  // has the database cancel it. Observed from a second session: nothing here calls cancel or closes a connection.
  describe('withStatementTimeout: the server cancels a slow typeahead query', () => {
    const SLEEP = sql`SELECT pg_sleep(30)`
    const backends = async (where: string) => Number((await observer.unsafe(
      `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND ${where}`,
    ))[0].n)
    const sleeping = () => backends(`state = 'active' AND query LIKE '%pg_sleep(30)%'`)
    const stuckOpen = () => backends(`state LIKE 'idle in transaction%'`)
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

    it('rejects with 57014 at the timeout, and the backend is gone', async () => {
      const t0 = Date.now()
      const run = withStatementTimeout(db, SUGGEST_TIMEOUT_MS, (tx) => tx.execute(SLEEP)).then(() => null, (e: unknown) => e)
      await pause(300)
      expect(await sleeping()).toBe(1) // it is running: this is not a query that returned early
      const err = await run
      expect((unwrapDbError(err) as { code?: string }).code).toBe('57014')
      expect(Date.now() - t0).toBeLessThan(SUGGEST_TIMEOUT_MS + 200)
      expect(await sleeping()).toBe(0)
      expect(await stuckOpen()).toBe(0) // rolled back, not left idle in transaction
    }, 15_000)

    it('keeps cancelling after the caller has stopped waiting (the route abandons it at the same mark)', async () => {
      const t0 = Date.now()
      const run = withStatementTimeout(db, SUGGEST_TIMEOUT_MS, (tx) => tx.execute(SLEEP)).then(() => null, (e: unknown) => e)
      await expect(withTimeout(run, 500)).rejects.toThrow('query timeout') // the route's wait is over at 0.5 s...
      expect(await sleeping()).toBe(1) // ...and the query is still running, as before this fix: it is bounded now, not gone
      await run
      expect(Date.now() - t0).toBeLessThan(SUGGEST_TIMEOUT_MS + 200)
      expect(await sleeping()).toBe(0) // ...until the server stops it
      expect(await stuckOpen()).toBe(0)
    }, 15_000)

    it('leaves the connection usable, and the next query is not under the timeout', async () => {
      expect((await suggestRows(db, 'zq')).map((r) => r.symbol)).toEqual(['ZQ'])
      const [{ t }] = await conn.unsafe(`SHOW statement_timeout`)
      expect(t ?? (await conn.unsafe(`SHOW statement_timeout`))[0].statement_timeout).not.toBe(`${SUGGEST_TIMEOUT_MS}ms`)
    })
  })

  describe('suggestQuery', () => {
    it.each(['zq', 'rn', 'abc', 'us'])('reads both indexes, never the table, for the prefix %s', async (prefix) => {
      const plan = await planOf(suggestQuery(prefix))
      expect(plan.seqScan).toBe(false)
      expect(plan.indexes).toEqual(expect.arrayContaining(['tokens_lower_symbol_idx', 'tokens_holder_count_idx']))
    })

    // The point of the two arms: whatever the planner guesses for a prefix, it never walks the table. The plain
    // `LIKE p ORDER BY holder_count DESC LIMIT 50` walks the WHOLE holder_count index for a prefix the planner
    // over-estimates (100,065 rows read for under 50 results, in this 100,065-row fixture; ~2% of three-letter
    // prefixes do it, which ones depends on ANALYZE's random sample). The two arms read 5,000 rows by holders plus
    // at most a few hundred by symbol (the planner may fetch and sort a prefix it expects few matches for: up to
    // ~450 here), so the bound is 10% of the table. This sweeps every two-letter prefix and one three-letter prefix
    // in thirteen.
    it('reads under 10% of the table for every one of 572 prefixes', async () => {
      const L = 'abcdefghijklmnop'
      const prefixes = [...L].flatMap((a) => [...L].map((b) => a + b))
      let i = 0
      for (const a of L) for (const b of L) for (const c of L) if (i++ % 13 === 0) prefixes.push(a + b + c)
      const worst = { prefix: '', rows: 0 }
      for (const prefix of prefixes) {
        const { rowsRead } = await planOf(suggestQuery(prefix))
        if (rowsRead > worst.rows) { worst.prefix = prefix; worst.rows = rowsRead }
      }
      expect(prefixes).toHaveLength(572)
      expect(worst.rows).toBeLessThan(10_000)
    }, 60_000)

    it('returns the most-held tokens with that symbol prefix, case-insensitively', async () => {
      const rows = await suggestRows(db, 'usd')
      expect(rows).toHaveLength(50)
      expect(rows[0]).toMatchObject({ symbol: 'USDT', holderCount: 9000000 - 1 })
      expect(rows.map((r) => r.holderCount)).toEqual([...rows.map((r) => r.holderCount)].sort((a, b) => b - a))
    })

    it('finds a rare low-holder ticker (by symbol) and a well-held one (by holders) alike', async () => {
      expect((await suggestRows(db, 'zq')).map((r) => r.symbol)).toEqual(['ZQ'])
      expect((await suggestRows(db, 'rnc')).map((r) => r.symbol)).toEqual(['RNC'])
    })

    it('matches the visitor\'s % and _ literally, not as wildcards', async () => {
      expect((await suggestRows(db, '100%')).map((r) => r.symbol)).toEqual(['100%'])
      expect((await suggestRows(db, 'a_b')).map((r) => r.symbol)).toEqual(['A_B'])
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

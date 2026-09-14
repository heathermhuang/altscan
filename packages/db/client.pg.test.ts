import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inArray, sql } from 'drizzle-orm'
import { pgTable, varchar } from 'drizzle-orm/pg-core'
import { getDb } from './client'

/**
 * getDb() against a REAL Postgres: a query that fails AFTER rows have streamed
 * must not corrupt the next result on the same connection.
 *
 * postgres.js 3.4.8 keeps a per-connection row counter that only CommandComplete
 * resets. A query that errors after sending k DataRows (a statement_timeout, or
 * any runtime error mid-scan) therefore leaves the counter at k, and the NEXT
 * query on that connection writes its rows from index k: a sparse array with k
 * leading holes. Iterating it yields `undefined`, which is the
 * "Cannot read properties of undefined (reading 'address')" that bnbscan-web
 * logged under [tx/token-lookup] every ~1.5h. patches/postgres@3.4.8.patch
 * resets the counter at ReadyForQuery.
 *
 * Gated on DB_CLIENT_TEST_PG_URL. The table is TEMP (session-local), so this
 * suite cannot collide with another that shares the database.
 */
const ENV = 'DB_CLIENT_TEST_PG_URL'
const PG_URL = process.env[ENV]

const probe = pgTable('sparse_probe_tokens', {
  address: varchar('address', { length: 42 }).primaryKey(),
  symbol: varchar('symbol', { length: 32 }).notNull(),
})

describe.skipIf(!PG_URL)('getDb() — a query that fails mid-result must not corrupt the next one', () => {
  let db: ReturnType<typeof getDb>

  beforeAll(async () => {
    if (!/test/i.test(new URL(PG_URL as string).pathname)) {
      throw new Error(`${ENV} must name a disposable database (its name must contain "test")`)
    }
    // One connection, so the query after the failure is guaranteed to reuse it —
    // in production that is merely likely (DB_POOL_SIZE=3 on the web services).
    process.env.DB_POOL_SIZE = '1'
    process.env.DB_STATEMENT_TIMEOUT_MS = '1000'
    db = getDb(ENV)
    await db.execute(sql`CREATE TEMP TABLE sparse_probe_tokens (address varchar(42) PRIMARY KEY, symbol varchar(32) NOT NULL)`)
    await db.execute(sql`INSERT INTO sparse_probe_tokens VALUES ('0xaa', 'AAA'), ('0xbb', 'BBB')`)
  })

  afterAll(async () => {
    const g = globalThis as { __db_sql?: Map<string, { end: (o: { timeout: number }) => Promise<void> }> }
    await g.__db_sql?.get(ENV)?.end({ timeout: 5 })
  })

  // Both queries return three rows before failing on the fourth.
  it.each([
    ['a runtime error', sql`SELECT g, g / (CASE WHEN g <= 3 THEN 1 ELSE 0 END) FROM generate_series(1, 10) g`, /division by zero/],
    ['a statement_timeout', sql`SELECT g, pg_sleep(CASE WHEN g <= 3 THEN 0 ELSE 5 END) FROM generate_series(1, 10) g`, /statement timeout/],
  ])('after %s that arrives once rows have streamed', async (_label, failing, message) => {
    await expect(db.execute(failing)).rejects.toThrow(message)

    const rows = await db.select({ address: probe.address, symbol: probe.symbol })
      .from(probe)
      .where(inArray(probe.address, ['0xaa', '0xbb']))

    // Unpatched: length 5 with 2 populated slots.
    expect(Object.keys(rows)).toHaveLength(rows.length)
    expect(rows).toHaveLength(2)
    // What tx/[hash]/page.tsx does with the result.
    const lookup = new Map<string, string>()
    for (const tok of rows) lookup.set(tok.address, tok.symbol)
    expect(lookup.size).toBe(2)
  })
})

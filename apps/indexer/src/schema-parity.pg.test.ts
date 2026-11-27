import { beforeAll, describe, expect, it } from 'vitest'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import { is, sql } from 'drizzle-orm'

/**
 * packages/db/schema.ts is the declared source of truth for the database, but the database is
 * built by hand-written DDL in ensure-schema.ts. Nothing checked that the two agree: three
 * tables (webhook_deliveries, indexer_cursor, poison_blocks) existed only in the DDL until this
 * suite found them. It runs the real ensureSchema() on an empty database, twice (the boot must
 * be idempotent), and compares, in both directions: every table, every column, nullability,
 * and every enum's values.
 *
 * Gated on SCHEMA_PARITY_TEST_PG_URL. The database must be disposable (its name contains
 * "test") and DEDICATED: the suite drops and recreates the public schema. Locally:
 *
 *   SCHEMA_PARITY_TEST_PG_URL=postgres://postgres:x@127.0.0.1:5432/schema_parity_test \
 *     npx vitest run apps/indexer/src/schema-parity.pg.test.ts
 */
const ENV = 'SCHEMA_PARITY_TEST_PG_URL'
const PG_URL = process.env[ENV]
const DB_NAME = (() => {
  try { return PG_URL ? new URL(PG_URL).pathname.replace(/^\//, '') : '' } catch { return '' }
})()
const DISPOSABLE = /test/.test(DB_NAME)
// Route the indexer's chain-aware getDb() (bnb => DATABASE_URL) at the fixture.
if (PG_URL && DISPOSABLE) process.env.DATABASE_URL = PG_URL

type Row = Record<string, string>

describe.skipIf(!PG_URL)('schema.ts describes what ensureSchema() builds — real Postgres', () => {
  let q: (s: ReturnType<typeof sql>) => Promise<Row[]>
  let schema: typeof import('@altscan/db')['schema']

  beforeAll(async () => {
    if (!DISPOSABLE) throw new Error(`${ENV} must name a disposable database (its name must contain "test"), got "${DB_NAME}"`)
    const db = await import('./db')
    schema = db.schema
    q = async (s) => Array.from(await db.getDb().execute(s)) as Row[]
    await q(sql`DROP SCHEMA public CASCADE`)
    await q(sql`CREATE SCHEMA public`)
    const { ensureSchema } = await import('./ensure-schema')
    await ensureSchema()
    await ensureSchema()   // a second boot against a built database must be a no-op, not an error
  }, 300_000)

  const declaredTables = () => (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable)).map((t) => getTableConfig(t))

  it('every table ensureSchema creates is declared in schema.ts, and the reverse', async () => {
    // Partitions are the parent's storage, not tables of their own.
    const built = (await q(sql`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
    `)).map((r) => r.relname).sort()
    expect(built).toEqual(declaredTables().map((t) => t.name).sort())
  })

  it('every table has the same columns and nullability on both sides', async () => {
    const drift: string[] = []
    for (const t of declaredTables()) {
      const rows = await q(sql`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${t.name}`)
      const built = new Map(rows.map((r) => [r.column_name, r.is_nullable === 'NO']))
      for (const c of t.columns) {
        if (!built.has(c.name)) drift.push(`${t.name}.${c.name}: declared, not built`)
        else if (built.get(c.name) !== c.notNull) drift.push(`${t.name}.${c.name}: notNull declared ${c.notNull}, built ${built.get(c.name)}`)
        built.delete(c.name)
      }
      for (const name of built.keys()) drift.push(`${t.name}.${name}: built, not declared`)
    }
    expect(drift).toEqual([])
  })

  it('every enum has the same values on both sides', async () => {
    for (const e of [schema.tokenTypeEnum, schema.validatorStatusEnum, schema.verifySourceEnum]) {
      const rows = await q(sql`
        SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = ${e.enumName} ORDER BY e.enumsortorder
      `)
      expect(rows.map((r) => r.enumlabel), e.enumName).toEqual([...e.enumValues])
    }
  })
})

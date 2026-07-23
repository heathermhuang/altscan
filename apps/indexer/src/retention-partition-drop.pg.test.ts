import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMaintenanceConnection, getDb } from '@altscan/db'
import { sql } from 'drizzle-orm'
import { listTokenTransferPartitions } from './ensure-schema'
import { partitionIdent, identSql } from './retention-cleanup'

/**
 * Behavioral proof for the O2 P1 fix (codex round 3) against a REAL Postgres:
 * a token_transfers partition is DISCOVERED by OID (pg_inherits) but DROP/DELETEd
 * by name. A bare, unqualified name re-resolves through `search_path`, so a
 * same-named relation in another schema could be dropped instead. The fix carries
 * each partition's discovered schema (nspname) and renders the DROP/DELETE
 * SCHEMA-QUALIFIED. This suite runs the exact production path — discover →
 * partitionIdent(name, schema) → identSql → db.execute — and proves the drop is
 * surgical: it removes the discovered partition and CANNOT touch a same-named
 * table in another schema. The unit test (retention-guard.test.ts) pins the SQL
 * rendering; only a real DB can prove discovery returns the schema and the
 * qualified statement actually resolves the way we claim.
 *
 * Gated on BACKFILL_TEST_PG_URL (same throwaway container as the worker suite;
 * disjoint tables). Run locally with:
 *
 *   docker run -d --rm --name pg-workertest -e POSTGRES_PASSWORD=x \
 *     -e POSTGRES_DB=worker_test -p 127.0.0.1:5441:5432 postgres:16
 *   BACKFILL_TEST_PG_URL=postgres://postgres:x@127.0.0.1:5441/worker_test \
 *     npx vitest run apps/indexer/src/retention-partition-drop.pg.test.ts
 */
const PG_URL = process.env.BACKFILL_TEST_PG_URL
// FAIL CLOSED: this suite creates and DROPs production-named tables. Refuse any
// database whose name does not contain "test" so a mistyped URL can't lose data.
const DB_NAME = (() => {
  try {
    return PG_URL ? new URL(PG_URL).pathname.replace(/^\//, '') : ''
  } catch {
    return ''
  }
})()
const DISPOSABLE = /test/.test(DB_NAME)
// Route the real getDb() at the fixture via its env-var indirection.
if (PG_URL && DISPOSABLE) process.env.RETENTION_PART_TEST_DB = PG_URL

const DECOY_SCHEMA = 'retention_p1_decoy'

describe.skipIf(!PG_URL)('partition DROP is schema-qualified — real Postgres', () => {
  const raw = createMaintenanceConnection(PG_URL as string)
  const db = getDb('RETENTION_PART_TEST_DB')

  beforeAll(async () => {
    if (!DISPOSABLE) {
      throw new Error(
        `refusing to run: BACKFILL_TEST_PG_URL database "${DB_NAME}" is not disposable — ` +
          `the name must contain "test" (this suite drops production-named tables)`,
      )
    }
    await raw.unsafe(`DROP TABLE IF EXISTS token_transfers CASCADE`)
    await raw.unsafe(`DROP SCHEMA IF EXISTS ${DECOY_SCHEMA} CASCADE`)
    // Real partitioned parent in the default (public) schema, mirroring prod.
    await raw.unsafe(`
      CREATE TABLE token_transfers (block_number bigint, data text)
      PARTITION BY RANGE (block_number)`)
    await raw.unsafe(`
      CREATE TABLE token_transfers_p0 PARTITION OF token_transfers
      FOR VALUES FROM (0) TO (1000)`)
    await raw.unsafe(`
      CREATE TABLE token_transfers_p1 PARTITION OF token_transfers
      FOR VALUES FROM (1000) TO (2000)`)
    await raw.unsafe(`INSERT INTO token_transfers SELECT g, 'x' FROM generate_series(0, 1999) g`)
    // DECOY: a same-named table in another schema. If the DROP were unqualified
    // and this schema sat earlier on search_path, THIS is what would be dropped.
    await raw.unsafe(`CREATE SCHEMA ${DECOY_SCHEMA}`)
    await raw.unsafe(`CREATE TABLE ${DECOY_SCHEMA}.token_transfers_p0 (sentinel int)`)
    await raw.unsafe(`INSERT INTO ${DECOY_SCHEMA}.token_transfers_p0 VALUES (42)`)
  })

  afterAll(async () => {
    await raw.unsafe(`DROP TABLE IF EXISTS token_transfers CASCADE`)
    await raw.unsafe(`DROP SCHEMA IF EXISTS ${DECOY_SCHEMA} CASCADE`)
    await raw.end({ timeout: 5 })
  })

  const regclass = async (qualified: string): Promise<string | null> => {
    const [row] = await raw.unsafe(`SELECT to_regclass('${qualified}')::text AS r`)
    return (row as unknown as { r: string | null }).r
  }

  it('discovers each partition WITH its schema (nspname), not just a bare name', async () => {
    const parts = await listTokenTransferPartitions(db)
    const byName = new Map(parts.map(p => [p.name, p]))
    expect(byName.get('token_transfers_p0')).toMatchObject({ schema: 'public', lo: 0, hi: 1000 })
    expect(byName.get('token_transfers_p1')).toMatchObject({ schema: 'public', lo: 1000, hi: 2000 })
  })

  it('drops the discovered partition and CANNOT touch a same-named table in another schema', async () => {
    // Pre-state: both the real partition and the decoy exist.
    expect(await regclass('public.token_transfers_p0')).toBe('token_transfers_p0')
    expect(await regclass(`${DECOY_SCHEMA}.token_transfers_p0`)).toBe(`${DECOY_SCHEMA}.token_transfers_p0`)

    // Exact production path: discover → partitionIdent(name, schema) → identSql → db.execute.
    const target = (await listTokenTransferPartitions(db)).find(p => p.name === 'token_transfers_p0')!
    const partId = partitionIdent(target.name, target.schema)
    await db.execute(sql`DROP TABLE IF EXISTS ${identSql(partId)}`)

    // The real partition is gone; the decoy (and the sibling p1) are untouched.
    expect(await regclass('public.token_transfers_p0')).toBeNull()
    expect(await regclass(`${DECOY_SCHEMA}.token_transfers_p0`)).toBe(`${DECOY_SCHEMA}.token_transfers_p0`)
    expect(await regclass('public.token_transfers_p1')).toBe('token_transfers_p1')
    const [decoyRow] = await raw.unsafe(`SELECT sentinel FROM ${DECOY_SCHEMA}.token_transfers_p0`)
    expect((decoyRow as unknown as { sentinel: number }).sentinel).toBe(42)
  })
})

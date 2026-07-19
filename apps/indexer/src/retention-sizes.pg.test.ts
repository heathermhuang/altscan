import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMaintenanceConnection } from '@altscan/db'
import { sizeReportSql } from './retention-cleanup'

/**
 * Behavioral proof for the partition-aware size query, against a REAL
 * Postgres — the token-pin tests in retention-sizes.test.ts cannot catch a
 * wrong join direction or aggregation that still contains the right keywords.
 *
 * Gated on SIZES_TEST_PG_URL because CI has no Postgres. Run locally with:
 *
 *   docker run -d --rm --name pg-sizetest -e POSTGRES_PASSWORD=x \
 *     -p 127.0.0.1:5439:5432 postgres:16
 *   SIZES_TEST_PG_URL=postgres://postgres:x@127.0.0.1:5439/postgres \
 *     npx vitest run src/retention-sizes.pg.test.ts
 *
 * The scenario mirrors prod BNB, where the old per-table
 * pg_total_relation_size('token_transfers') reported 0 bytes while the
 * partitions held ~44.5GB.
 */
const PG_URL = process.env.SIZES_TEST_PG_URL

describe.skipIf(!PG_URL)('sizeReportSql — behavior against real Postgres', () => {
  const sql = createMaintenanceConnection(PG_URL as string)
  const SCHEMA = 'sizes_seam_test'

  beforeAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await sql.unsafe(`CREATE SCHEMA ${SCHEMA}`)
    // to_regclass resolves through search_path exactly like production's
    // unqualified names; pointing it at the throwaway schema isolates the test.
    await sql.unsafe(`SET search_path TO ${SCHEMA}`)
    await sql.unsafe(`
      CREATE TABLE token_transfers (block_number bigint, data text)
      PARTITION BY RANGE (block_number)`)
    await sql.unsafe(`
      CREATE TABLE token_transfers_p0 PARTITION OF token_transfers
      FOR VALUES FROM (0) TO (1000)`)
    await sql.unsafe(`
      CREATE TABLE token_transfers_p1 PARTITION OF token_transfers
      FOR VALUES FROM (1000) TO (2000)`)
    await sql.unsafe(`
      INSERT INTO token_transfers
      SELECT g, repeat('x', 300) FROM generate_series(0, 1999) g`)
    await sql.unsafe(`CREATE TABLE transactions (block_number bigint, data text)`)
    await sql.unsafe(`
      INSERT INTO transactions
      SELECT g, repeat('y', 300) FROM generate_series(0, 499) g`)
    // Deliberately NO blocks table — the missing-relation case.
  })

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await sql.end({ timeout: 5 })
  })

  async function newSizes(tables: string[]): Promise<Map<string, number>> {
    const rows = await sql.unsafe(sizeReportSql(tables))
    const m = new Map<string, number>()
    for (const r of rows as unknown as { root: string; bytes: string }[]) {
      m.set(r.root, Number(r.bytes))
    }
    return m
  }

  it('sums a partitioned parent to exactly its partition tree (the old query said 0)', async () => {
    const [truth] = await sql.unsafe(`
      SELECT pg_total_relation_size('token_transfers')::bigint AS parent_only,
             (pg_total_relation_size('token_transfers')
              + pg_total_relation_size('token_transfers_p0')
              + pg_total_relation_size('token_transfers_p1'))::bigint AS tree
    `)
    expect(Number(truth.parent_only)).toBe(0)

    const sizes = await newSizes(['token_transfers'])
    expect(sizes.get('token_transfers')).toBe(Number(truth.tree))
    expect(sizes.get('token_transfers')!).toBeGreaterThan(0)
  })

  it('reports a plain table byte-identical to pg_total_relation_size', async () => {
    const [truth] = await sql.unsafe(
      `SELECT pg_total_relation_size('transactions')::bigint AS b`,
    )
    const sizes = await newSizes(['transactions'])
    expect(sizes.get('transactions')).toBe(Number(truth.b))
  })

  it('omits a missing table instead of throwing mid-report', async () => {
    const sizes = await newSizes(['transactions', 'blocks'])
    expect(sizes.has('blocks')).toBe(false)
    expect(sizes.has('transactions')).toBe(true)
  })

  it('does not double-count when the same root is passed twice', async () => {
    const once = await newSizes(['token_transfers'])
    const twice = await newSizes(['token_transfers', 'token_transfers'])
    expect(twice.get('token_transfers')).toBe(once.get('token_transfers'))
  })
})

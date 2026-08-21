import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql as sqlTag } from 'drizzle-orm'

/**
 * INTERVENTION proof, against a real Postgres, that the boundary-partition
 * DELETE is actually gone from the EXECUTOR.
 *
 * The unit suite (retention-boundary-partition.test.ts) pins the pure plan, but
 * a plan cannot prove what the executor does — someone could reintroduce a
 * DELETE inside pruneTokenTransfersPartitioned and every unit test would still
 * pass. So this runs the real function against real partitions and asserts on
 * actual row counts:
 *
 *   - the wholly-old partition is GONE (dropped)
 *   - the straddling partition still HOLDS every one of its below-cutoff rows
 *   - the future partition is untouched
 *
 * Gated on BOUNDARY_TEST_PG_URL. Run with a throwaway database:
 *
 *   createdb boundary_prune_test
 *   BOUNDARY_TEST_PG_URL=postgres://localhost:5432/boundary_prune_test \
 *     npx vitest run apps/indexer/src/retention-boundary-partition.pg.test.ts
 */
const PG_URL = process.env.BOUNDARY_TEST_PG_URL
// FAIL CLOSED: this suite CREATEs and DROPs production-named tables. Refuse any
// database whose name does not contain "test" so a mistyped URL cannot lose data.
const DB_NAME = (() => {
  try {
    return PG_URL ? new URL(PG_URL).pathname.replace(/^\//, '') : ''
  } catch {
    return ''
  }
})()
const DISPOSABLE = /test/.test(DB_NAME)
// ⚠ The executor does NOT read DATABASE_URL unconditionally: getMaintenanceDb()
// resolves getChainConfig().dbEnvVar, which is DATABASE_URL only for CHAIN=bnb
// and ETH_DATABASE_URL for CHAIN=eth. Setting DATABASE_URL alone would leave a
// CHAIN=eth run pointed at a DIFFERENT database while this file's disposable-name
// guard happily validated BOUNDARY_TEST_PG_URL — and this suite issues DROP TABLE.
// So pin the chain too, and verify the real connection below before pruning.
if (PG_URL && DISPOSABLE) {
  process.env.CHAIN = 'bnb'
  process.env.DATABASE_URL = PG_URL
  process.env.ETH_DATABASE_URL = PG_URL
}

describe.skipIf(!PG_URL)('boundary partition is RETAINED, not deleted — real Postgres', () => {
  let prune: (cutoff: number) => Promise<number>
  let raw: { unsafe: (q: string) => Promise<unknown> ; end: () => Promise<void> }

  const CUTOFF = 150

  beforeAll(async () => {
    if (!DISPOSABLE) {
      throw new Error(
        `refusing to run: BOUNDARY_TEST_PG_URL database "${DB_NAME}" is not disposable — ` +
          `the name must contain "test" (this suite drops production-named tables)`,
      )
    }
    const { createMaintenanceConnection } = await import('@altscan/db')
    raw = createMaintenanceConnection(PG_URL as string) as unknown as typeof raw
    await raw.unsafe(`DROP TABLE IF EXISTS token_transfers CASCADE`)
    await raw.unsafe(`
      CREATE TABLE token_transfers (block_number bigint NOT NULL, data text)
      PARTITION BY RANGE (block_number)`)
    // Three partitions: wholly-old, straddling the cutoff, wholly-future.
    await raw.unsafe(`CREATE TABLE token_transfers_p_0   PARTITION OF token_transfers FOR VALUES FROM (0)   TO (100)`)
    await raw.unsafe(`CREATE TABLE token_transfers_p_100 PARTITION OF token_transfers FOR VALUES FROM (100) TO (200)`)
    await raw.unsafe(`CREATE TABLE token_transfers_p_200 PARTITION OF token_transfers FOR VALUES FROM (200) TO (300)`)
    // 10 rows per partition, spread across each range. In p_100, blocks 100-149
    // are BELOW the cutoff of 150 and are exactly what the old code deleted.
    await raw.unsafe(`
      INSERT INTO token_transfers (block_number, data)
      SELECT g, 'row-' || g FROM generate_series(0, 299, 10) AS g`)

    const mod = await import('./retention-cleanup')
    prune = mod.pruneTokenTransfersPartitioned

    // FAIL CLOSED on the connection the EXECUTOR actually uses, not the one this
    // file opened. A name guard on BOUNDARY_TEST_PG_URL proves nothing about
    // where getMaintenanceDb() lands; only asking that pool itself does.
    const { getMaintenanceDb } = await import('./db')
    const who = Array.from(await getMaintenanceDb().execute(
      sqlTag`SELECT current_database() AS db`)) as Array<Record<string, unknown>>
    const execDb = String(who[0]?.db ?? '')
    if (execDb !== DB_NAME || !/test/.test(execDb)) {
      throw new Error(
        `refusing to run: the executor's pool is connected to "${execDb}", not the ` +
          `disposable "${DB_NAME}" — this suite issues DROP TABLE`,
      )
    }
  })

  afterAll(async () => {
    await raw?.unsafe(`DROP TABLE IF EXISTS token_transfers CASCADE`).catch(() => {})
    await raw?.end().catch(() => {})
  })

  it('drops the wholly-old partition and RETAINS every below-cutoff row in the straddler', async () => {
    const before = await raw.unsafe(
      `SELECT count(*)::int AS n FROM token_transfers WHERE block_number >= 100 AND block_number < ${CUTOFF}`)
    const belowCutoffInStraddler = (before as Array<{ n: number }>)[0].n
    // 100,110,120,130,140 — the rows the removed DELETE used to destroy.
    expect(belowCutoffInStraddler).toBe(5)

    const dropped = await prune(CUTOFF)
    expect(dropped).toBe(1)

    // The wholly-old partition is gone from the catalog.
    const parts = (await raw.unsafe(`
      SELECT c.relname AS name FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'token_transfers'::regclass ORDER BY 1`)) as Array<{ name: string }>
    expect(parts.map(p => p.name)).toEqual(['token_transfers_p_100', 'token_transfers_p_200'])

    // THE POINT: the straddler kept its below-cutoff rows. Under the old code
    // this was 0.
    const after = (await raw.unsafe(
      `SELECT count(*)::int AS n FROM token_transfers WHERE block_number < ${CUTOFF}`)) as Array<{ n: number }>
    expect(after[0].n).toBe(5)

    // And the future partition is untouched.
    const future = (await raw.unsafe(
      `SELECT count(*)::int AS n FROM token_transfers WHERE block_number >= 200`)) as Array<{ n: number }>
    expect(future[0].n).toBe(10)
  })

  it('is idempotent — a second run at the same cutoff deletes nothing more', async () => {
    const dropped = await prune(CUTOFF)
    expect(dropped).toBe(0)
    const after = (await raw.unsafe(
      `SELECT count(*)::int AS n FROM token_transfers WHERE block_number < ${CUTOFF}`)) as Array<{ n: number }>
    expect(after[0].n).toBe(5)
  })
})

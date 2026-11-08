import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMaintenanceConnection, getDb } from '@altscan/db'
import { ensureForwardPartitions, listTokenTransferPartitions, skipPartitionRefusal, coveredUpTo } from './ensure-schema'
import { indexerConfig } from './config-instance'

/**
 * token_transfers partitions cover a MAX_LAG skip's landing range before the skip is
 * taken, against a REAL Postgres. A skip past the last partition bound otherwise stalls
 * the transfer writer on "no partition of relation … found for row" (audit lead A6), and
 * only the catalog can say what is covered: a lock timeout stops the ladder early, and
 * CREATE TABLE IF NOT EXISTS silently skips a name that is already taken.
 *
 * Every call passes the fixture's db explicitly, so nothing here can reach the database
 * apps/indexer/.env points at. Gated on PARTITION_COVERAGE_TEST_PG_URL; the database must
 * be disposable (its name must contain "test") and dedicated: the suite creates and drops
 * `token_transfers` and `blocks` in public. Run locally with:
 *
 *   docker run -d --rm --name pg-partcov -e POSTGRES_PASSWORD=x \
 *     -e POSTGRES_DB=partition_cov_test -p 127.0.0.1:5468:5432 postgres:16
 *   PARTITION_COVERAGE_TEST_PG_URL=postgres://postgres:x@127.0.0.1:5468/partition_cov_test \
 *     npx vitest run apps/indexer/src/partition-coverage.pg.test.ts
 */
const ENV = 'PARTITION_COVERAGE_TEST_PG_URL'
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
if (PG_URL && DISPOSABLE) process.env.PARTITION_COVERAGE_TEST_DB = PG_URL

describe.skipIf(!PG_URL)('token_transfers partitions cover a skip before it is taken — real Postgres', () => {
  const conn = createMaintenanceConnection(PG_URL as string)
  const db = getDb('PARTITION_COVERAGE_TEST_DB')
  const { blocks: WIDTH, ahead: AHEAD } = indexerConfig.partitions
  const parts = () => listTokenTransferPartitions(db)
  let clock = Date.UTC(2026, 10, 8)

  beforeAll(async () => {
    if (!DISPOSABLE) {
      throw new Error(`${ENV} database "${DB_NAME}" is not disposable — its name must contain "test" (this suite drops production-named tables)`)
    }
    const [{ db: name }] = await conn.unsafe('SELECT current_database() AS db')
    if (!/test/.test(String(name))) throw new Error(`${ENV} connected to "${name}", which is not a disposable database`)
  }, 60_000)

  beforeEach(async () => {
    await conn.unsafe('DROP TABLE IF EXISTS token_transfers CASCADE')
    await conn.unsafe(`DROP TABLE IF EXISTS token_transfers_p_${WIDTH}`)   // the name-taken test's decoy, not a partition
    await conn.unsafe('DROP TABLE IF EXISTS blocks CASCADE')
    await conn.unsafe('CREATE TABLE token_transfers (block_number bigint NOT NULL, tx_hash text) PARTITION BY RANGE (block_number)')
    await conn.unsafe('CREATE TABLE blocks (number bigint PRIMARY KEY)')
    // skipPartitionRefusal makes partitions at most once a minute; each test starts an hour on.
    clock += 3_600_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(clock)
  })

  afterEach(() => { vi.useRealTimers() })

  afterAll(async () => {
    if (DISPOSABLE) {
      await conn.unsafe('DROP TABLE IF EXISTS token_transfers CASCADE')
      await conn.unsafe(`DROP TABLE IF EXISTS token_transfers_p_${WIDTH}`)
      await conn.unsafe('DROP TABLE IF EXISTS blocks CASCADE')
    }
    await conn.end({ timeout: 5 })
  })

  const partition = (lo: number, hi: number) =>
    conn.unsafe(`CREATE TABLE token_transfers_p_${lo} PARTITION OF token_transfers FOR VALUES FROM (${lo}) TO (${hi})`)

  it('a skip past the highest bound is covered first, contiguously', async () => {
    await partition(0, WIDTH)
    await conn.unsafe(`INSERT INTO blocks VALUES (${WIDTH - 10})`)
    const from = 5 * WIDTH + 3
    const through = from + 199

    expect(await skipPartitionRefusal(from, through, db)).toBeNull()
    const after = await parts()
    expect(coveredUpTo(after, 0), 'no hole between the old bound and the landing block').toBeGreaterThan(from + AHEAD * WIDTH)
    expect(after.every(p => p.hi - p.lo === WIDTH)).toBe(true)
  }, 60_000)

  it('makes nothing when the range is already covered', async () => {
    await partition(0, WIDTH)
    await partition(WIDTH, 2 * WIDTH)
    expect(await skipPartitionRefusal(10, WIDTH + 5, db)).toBeNull()
    expect((await parts()).length).toBe(2)
  })

  it('after every partition is dropped, the ladder is re-seeded at the cursor, not at genesis', async () => {
    const cursor = 10 * WIDTH + 5
    await conn.unsafe(`INSERT INTO blocks VALUES (${cursor})`)
    const covered = await ensureForwardPartitions({ db })
    const after = await parts()
    expect(after[0].lo).toBe(10 * WIDTH)
    expect(covered).toBeGreaterThan(cursor + (AHEAD - 1) * WIDTH)
    expect(coveredUpTo(after, after[0].lo)).toBe(covered)
  }, 60_000)

  it('with nothing to anchor on, makes nothing', async () => {
    expect(await ensureForwardPartitions({ db })).toBe(0)
    expect(await parts()).toEqual([])
  })

  it('a name already taken, which CREATE TABLE IF NOT EXISTS skips silently, is caught by the read-back', async () => {
    await partition(0, WIDTH)
    await conn.unsafe(`CREATE TABLE token_transfers_p_${WIDTH} (block_number bigint)`)   // a plain table, not a partition
    const refusal = await skipPartitionRefusal(WIDTH + 5, WIDTH + 205, db)
    expect(refusal).toMatch(new RegExp(`^ALERT no token_transfers partition for block ${WIDTH + 5}`))
    expect(coveredUpTo(await parts(), 0)).toBe(WIDTH)
  }, 60_000)

  it('a lock timeout refuses the skip, and the next attempt waits a minute', async () => {
    await partition(0, WIDTH)
    const holder = createMaintenanceConnection(PG_URL as string)
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    const holding = holder.begin(async tx => {
      await tx.unsafe('LOCK TABLE token_transfers IN ACCESS SHARE MODE')   // a long reader
      await held
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await vi.waitFor(async () => {
        const [{ n }] = await conn.unsafe(`SELECT count(*)::int AS n FROM pg_locks WHERE relation = 'token_transfers'::regclass AND mode = 'AccessShareLock' AND granted`)
        expect(n).toBeGreaterThan(0)
      }, { timeout: 10_000, interval: 50 })

      const from = 3 * WIDTH
      expect(await skipPartitionRefusal(from, from + 200, db)).toMatch(/^ALERT no token_transfers partition for block/)
      expect(coveredUpTo(await parts(), 0)).toBe(WIDTH)

      release()
      await holding
      // Within the minute it does not try again, so the lock queue is not hit every pass.
      expect(await skipPartitionRefusal(from, from + 200, db)).toMatch(/do not cover .* yet$/)
      expect((await parts()).length).toBe(1)

      vi.setSystemTime(Date.now() + 61_000)
      expect(await skipPartitionRefusal(from, from + 200, db)).toBeNull()
      expect(coveredUpTo(await parts(), 0)).toBeGreaterThan(from + 200)
    } finally {
      warn.mockRestore()
      release()
      await holding.catch(() => {})
      await holder.end({ timeout: 5 })
    }
  }, 60_000)

  it('an unpartitioned token_transfers never refuses', async () => {
    await conn.unsafe('DROP TABLE token_transfers CASCADE')
    await conn.unsafe('CREATE TABLE token_transfers (block_number bigint NOT NULL)')
    expect(await skipPartitionRefusal(1, 1_000_000, db)).toBeNull()
    expect(await ensureForwardPartitions({ db })).toBeNull()
  })
})

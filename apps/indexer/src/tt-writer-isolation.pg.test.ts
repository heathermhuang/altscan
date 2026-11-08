import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { createMaintenanceConnection } from '@altscan/db'
import { getDb } from './db'

/**
 * The transfer writer isolates a block whose own write fails, against a REAL Postgres,
 * because the classification reads real SQLSTATEs and only a server says what a bad row,
 * a missing partition or a failed watermark persist look like.
 *
 * One bad block used to fail the whole coalesced drain, forever: the queue grew behind
 * it, backpressure parked the block workers, and W froze. Now the drain falls back to
 * writing each block alone; W stays below the failing block; a data error that repeats
 * becomes a 1-block index gap and a quarantine batch; nothing else moves W.
 *
 * The writer goes through the indexer's own getDb() (DATABASE_URL on bnb), which this
 * suite points at the fixture and then CHECKS: it refuses to run unless that very pool
 * is connected to a database whose name contains "test" (apps/indexer/.env supplies a
 * DATABASE_URL under vitest; see tt-writer-profile.test.ts). The database must be
 * dedicated: the suite creates and drops token_transfers, blocks, index_gaps and
 * indexer_cursor in public. Each test gets a fresh writer module. Run locally with:
 *
 *   docker run -d --rm --name pg-ttiso -e POSTGRES_PASSWORD=x \
 *     -e POSTGRES_DB=tt_isolation_test -p 127.0.0.1:5469:5432 postgres:16
 *   TT_WRITER_ISOLATION_TEST_PG_URL=postgres://postgres:x@127.0.0.1:5469/tt_isolation_test \
 *     npx vitest run apps/indexer/src/tt-writer-isolation.pg.test.ts
 */
const ENV = 'TT_WRITER_ISOLATION_TEST_PG_URL'
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

const PARTITION_END = 1_000_000
const ADDR = '0x' + '11'.repeat(20)
const row = (n: number, over: Record<string, unknown> = {}) => ({
  txHash: '0x' + n.toString(16).padStart(64, '0'), logIndex: 0, tokenAddress: ADDR, fromAddress: ADDR,
  toAddress: ADDR, value: '1', tokenId: null, blockNumber: n, timestamp: new Date(0), tokenType: 'BEP20' as const,
  ...over,
}) as any
const BAD_VALUE = { value: 'not-a-number' }   // 22P02, class 22: the block's own data

describe.skipIf(!PG_URL)('transfer writer isolates a failing block — real Postgres', () => {
  const conn = createMaintenanceConnection(PG_URL as string)
  type Writer = typeof import('./block-processor')
  let w: Writer
  let errors: string[]
  const W = () => w.getTransferQueueDepth().durableBlock
  const durable = async () => Number((await conn.unsafe('SELECT transfers_durable_block AS w FROM indexer_cursor WHERE id = 1'))[0].w)
  const rowsAt = async (n: number) => Number((await conn.unsafe(`SELECT count(*)::int AS c FROM token_transfers WHERE block_number = ${n}`))[0].c)
  const gaps = (n: number) => conn.unsafe(`SELECT from_block::int AS f, to_block::int AS t, reason FROM index_gaps WHERE from_block = ${n}`)
  const waitFor = (fn: () => unknown, timeout = 20_000) => vi.waitFor(fn, { timeout, interval: 50 })
  const settleFor = (ms: number) => new Promise(r => setTimeout(r, ms))

  /** A fresh writer, as after a restart, seeded at W = `seed` like index.ts does. */
  async function boot(seed: number) {
    await conn.unsafe(`UPDATE indexer_cursor SET transfers_durable_block = ${seed} WHERE id = 1`)
    vi.resetModules()
    w = await import('./block-processor')
    w.initTransferWriter(seed)
  }

  beforeAll(async () => {
    if (!DISPOSABLE) {
      throw new Error(`${ENV} database "${DB_NAME}" is not disposable — its name must contain "test" (this suite drops production-named tables)`)
    }
    // The writer's own pool, not just ours: a pool cached before the redirect would point elsewhere.
    const [{ db: name }] = Array.from(await getDb().execute(sql`SELECT current_database() AS db`)) as Array<{ db: string }>
    if (!/test/.test(String(name))) throw new Error(`the writer's pool is connected to "${name}", which is not a disposable database`)
    await conn.unsafe('DROP TABLE IF EXISTS token_transfers, blocks, index_gaps, indexer_cursor CASCADE')
    await conn.unsafe(`CREATE TABLE token_transfers (
      tx_hash varchar(66) NOT NULL, log_index integer NOT NULL, token_address varchar(42) NOT NULL,
      from_address varchar(42) NOT NULL, to_address varchar(42) NOT NULL,
      value numeric(78,0) NOT NULL DEFAULT 0, token_id numeric(78,0),
      block_number bigint NOT NULL, timestamp timestamptz NOT NULL
    ) PARTITION BY RANGE (block_number)`)
    await conn.unsafe(`CREATE TABLE token_transfers_p_0 PARTITION OF token_transfers FOR VALUES FROM (0) TO (${PARTITION_END})`)
    await conn.unsafe('CREATE TABLE blocks (number bigint PRIMARY KEY)')
    await conn.unsafe(`CREATE TABLE index_gaps (
      from_block bigint PRIMARY KEY, to_block bigint NOT NULL, reason text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), healed_at timestamptz, heal_cursor bigint,
      CONSTRAINT index_gaps_range CHECK (to_block >= from_block))`)
    await conn.unsafe('CREATE TABLE indexer_cursor (id integer PRIMARY KEY, transfers_durable_block bigint NOT NULL)')
    await conn.unsafe('INSERT INTO indexer_cursor VALUES (1, 0)')
  }, 60_000)

  beforeEach(() => {
    errors = []
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')) })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(async () => {
    // Leave no block retrying into the next test.
    await w?.rollbackTransferWriterTo(0)
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    if (DISPOSABLE) await conn.unsafe('DROP TABLE IF EXISTS token_transfers, blocks, index_gaps, indexer_cursor CASCADE')
    await conn.end({ timeout: 5 })
  })

  it('one bad row: the blocks after it commit, W stays below it, and only it stays queued', async () => {
    await boot(999)
    w.enqueueTransferWrite(1000, [row(1000)])
    w.enqueueTransferWrite(1001, [row(1001, BAD_VALUE)])
    w.enqueueTransferWrite(1002, [row(1002)])
    w.enqueueTransferWrite(1003, [row(1003)])
    await waitFor(async () => {
      expect(await rowsAt(1003)).toBe(1)
      expect(w.getTransferQueueDepth().blocks).toBe(1)
    })
    expect(await rowsAt(1002)).toBe(1)
    expect(await rowsAt(1001)).toBe(0)
    expect(W()).toBe(1000)
    expect(await durable()).toBe(1000)
    expect(errors.some(e => e.includes('ALERT block 1001 rejected: 22P02'))).toBe(true)

    // After TT_BLOCK_REJECT_AFTER data failures it becomes a gap, and only then W passes it.
    await waitFor(() => expect(W()).toBe(1003))
    expect(await durable()).toBe(1003)
    expect(await gaps(1001)).toEqual([{ f: 1001, t: 1001, reason: 'tt_rejected(22P02)' }])
    expect(await rowsAt(1001)).toBe(0)
    expect(errors.filter(e => e.includes('ALERT block 1001 rejected: 22P02'))).toHaveLength(w.TT_BLOCK_REJECT_AFTER)
  }, 30_000)

  it('a gap row already starting at the block keeps its reason and range', async () => {
    await conn.unsafe(`INSERT INTO index_gaps (from_block, to_block, reason) VALUES (2001, 2005, 'max_lag_skip(1000)')`)
    await boot(2000)
    w.enqueueTransferWrite(2001, [row(2001, BAD_VALUE)])
    w.enqueueTransferWrite(2002, [row(2002)])
    await waitFor(() => expect(W()).toBe(2002))
    expect(await gaps(2001)).toEqual([{ f: 2001, t: 2005, reason: 'max_lag_skip(1000)' }])
  }, 30_000)

  it('if its gap row cannot be written, the block is not stepped over', async () => {
    await boot(3000)
    await conn.unsafe('ALTER TABLE index_gaps RENAME TO index_gaps_off')
    try {
      w.enqueueTransferWrite(3001, [row(3001, BAD_VALUE)])
      w.enqueueTransferWrite(3002, [row(3002)])
      await waitFor(() => expect(errors.some(e => e.includes('ALERT block 3001: could not record its gap'))).toBe(true))
      await settleFor(300)
      expect(W()).toBe(3000)
      expect(await durable()).toBe(3000)
    } finally {
      await conn.unsafe('ALTER TABLE index_gaps_off RENAME TO index_gaps')
    }
    await waitFor(() => expect(W()).toBe(3002), 40_000)
    expect(await gaps(3001)).toEqual([{ f: 3001, t: 3001, reason: 'tt_rejected(22P02)' }])
  }, 60_000)

  it('a restart before the fold replays the block, which fails again and finds its gap row there', async () => {
    // The previous process recorded the gap and died before W passed the block.
    await conn.unsafe(`INSERT INTO index_gaps (from_block, to_block, reason) VALUES (4001, 4001, 'tt_rejected(22P02)')`)
    await boot(4000)
    w.enqueueTransferWrite(4001, [row(4001, BAD_VALUE)])
    w.enqueueTransferWrite(4002, [row(4002)])
    await waitFor(() => expect(W()).toBe(4002))
    expect(await gaps(4001)).toHaveLength(1)
  }, 30_000)

  it('a missing partition is made and the block retried, and it is never rejected however long that takes', async () => {
    const n = PARTITION_END + 7
    await boot(n - 1)
    const holder = createMaintenanceConnection(PG_URL as string)
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    const holding = holder.begin(async tx => {
      await tx.unsafe('LOCK TABLE token_transfers IN ACCESS SHARE MODE')   // a long reader: the CREATE times out
      await held
    })
    try {
      await settleFor(200)
      w.enqueueTransferWrite(n, [row(n)])
      // Past the rejection count, partitions still impossible to make.
      await waitFor(() => expect(errors.filter(e => e.includes(`ALERT block ${n} has no token_transfers partition (23514)`)).length)
        .toBeGreaterThan(w.TT_BLOCK_REJECT_AFTER), 40_000)
      expect(await gaps(n)).toEqual([])
      expect(W()).toBe(n - 1)
    } finally {
      release()
      await holding
      await holder.end({ timeout: 5 })
    }
    await waitFor(() => expect(W()).toBe(n), 40_000)
    expect(await rowsAt(n)).toBe(1)
    expect(await gaps(n)).toEqual([])
  }, 90_000)

  it('an unrecognised SQLSTATE never moves W', async () => {
    await boot(5000)
    w.enqueueTransferWrite(5001, [row(5001, { fromAddress: null })])   // 23502: class 23, not a missing partition
    w.enqueueTransferWrite(5002, [row(5002)])
    await waitFor(() => expect(errors.filter(e => e.includes('ALERT block 5001 write failed with unrecognised 23502')).length)
      .toBeGreaterThan(w.TT_BLOCK_REJECT_AFTER), 40_000)
    expect(await rowsAt(5002)).toBe(1)
    expect(W()).toBe(5000)
    expect(await durable()).toBe(5000)
    expect(await gaps(5001)).toEqual([])
  }, 60_000)

  it('a failed W persist leaves W where it was and counts toward no rejection', async () => {
    await boot(6000)
    await conn.unsafe('ALTER TABLE indexer_cursor RENAME TO indexer_cursor_off')
    try {
      w.enqueueTransferWrite(6001, [row(6001)])
      await waitFor(async () => expect(await rowsAt(6001)).toBe(1))
      await settleFor(1_500)
      expect(W()).toBe(6000)
    } finally {
      await conn.unsafe('ALTER TABLE indexer_cursor_off RENAME TO indexer_cursor')
    }
    await waitFor(() => expect(W()).toBe(6001))
    expect(await durable()).toBe(6001)
    expect(await gaps(6001)).toEqual([])
    expect(errors.some(e => e.includes('ALERT block 6001'))).toBe(false)
  }, 30_000)

  it('a reorg rollback below a held block clears it, and its replacement lands', async () => {
    await boot(7000)
    w.enqueueTransferWrite(7001, [row(7001)])
    w.enqueueTransferWrite(7002, [row(7002, BAD_VALUE)])
    w.enqueueTransferWrite(7003, [row(7003)])
    await waitFor(async () => {
      expect(W()).toBe(7001)
      expect(await rowsAt(7003)).toBe(1)
    })
    await w.rollbackTransferWriterTo(7001)
    expect(w.getTransferQueueDepth().blocks).toBe(0)
    w.enqueueTransferWrite(7002, [row(7002)])
    w.enqueueTransferWrite(7003, [row(7003)])
    await waitFor(() => expect(W()).toBe(7003))
    expect(await rowsAt(7002)).toBe(1)
    expect(await gaps(7002)).toEqual([])
  }, 30_000)
})

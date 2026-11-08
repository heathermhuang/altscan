import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The transfer watermark W stepping over a range a MAX_LAG skip abandoned.
 *
 * './db' is replaced by a fake: no test here can reach a database (apps/indexer/.env
 * supplies DATABASE_URL under vitest, which is why poison-block-queue.test.ts never
 * seeds the writer). Writes succeed unless gated; the watermark UPDATE is recorded, or
 * refused while `failPersist` is set. Each test gets a fresh writer module.
 */
const fake = vi.hoisted(() => ({
  persisted: [] as number[],
  persistAttempts: 0,
  transactions: 0,
  failPersist: false,
  gate: null as Promise<void> | null,
}))

vi.mock('./db', async importOriginal => {
  const actual = await importOriginal<typeof import('./db')>()
  const { PgDialect } = await import('drizzle-orm/pg-core')
  const dialect = new PgDialect()
  const tx = {
    execute: async () => [],
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => [] }) }),
  }
  const db = {
    transaction: async (cb: (t: typeof tx) => Promise<unknown>) => {
      fake.transactions++
      await fake.gate
      return cb(tx)
    },
    execute: async (q: any) => {
      const { sql, params } = dialect.sqlToQuery(q)
      if (sql.includes('transfers_durable_block')) {
        fake.persistAttempts++
        if (fake.failPersist) throw new Error('indexer_cursor update refused')
        fake.persisted.push(Number(params[0]))
      }
      return []
    },
  }
  return { ...actual, getDb: () => db, getWriterDb: () => db }
})

type Writer = typeof import('./block-processor')
let w: Writer
const W = () => w.getTransferQueueDepth().durableBlock
const enqueue = (...ns: number[]) => { for (const n of ns) w.enqueueTransferWrite(n, []) }

beforeEach(async () => {
  Object.assign(fake, { persisted: [], persistAttempts: 0, transactions: 0, failPersist: false, gate: null })
  vi.resetModules()
  w = await import('./block-processor')
  w.initTransferWriter(1000)
})

describe('a MAX_LAG skip lets W step over the abandoned range', () => {
  it('only once the blocks still queued below the old cursor have committed', async () => {
    let release!: () => void
    fake.gate = new Promise<void>(res => { release = res })
    enqueue(1001, 1002, 1003)                   // processed, not yet written
    w.setDurableFloor({ after: 1003, to: 5000 }) // the skip: cursor was 1003
    await new Promise(res => setTimeout(res, 10))
    expect(W()).toBe(1000)
    expect(fake.persisted).toEqual([])

    release()
    await w.flushTransferWriter()
    expect(W()).toBe(5000)
    expect(fake.persisted.at(-1)).toBe(5000)
    expect(fake.persisted.every(b => b <= 1003 || b === 5000)).toBe(true)
  })

  it('at once when nothing is queued, without opening a write', async () => {
    w.setDurableFloor({ after: 1000, to: 5000 })
    await vi.waitFor(() => expect(W()).toBe(5000))
    expect(fake.persisted).toEqual([5000])
    expect(fake.transactions).toBe(0)
  })

  it('persists before it advances: a refused persist leaves W where it was, and is retried', async () => {
    fake.failPersist = true
    w.setDurableFloor({ after: 1000, to: 5000 })
    await vi.waitFor(() => expect(fake.persistAttempts).toBeGreaterThanOrEqual(2), { timeout: 2_000 })
    expect(W()).toBe(1000)

    fake.failPersist = false
    await vi.waitFor(() => expect(W()).toBe(5000), { timeout: 2_000 })
    expect(fake.persisted).toEqual([5000])
  })

  it('carries on through blocks above the range that committed first', async () => {
    w.setDurableFloor({ after: 1002, to: 5000 })
    enqueue(5001, 5002)
    await w.flushTransferWriter()
    expect(W()).toBe(1000)

    enqueue(1001, 1002)
    await w.flushTransferWriter()
    expect(W()).toBe(5002)
  })

  it('steps over two skips in order', async () => {
    w.setDurableFloor({ after: 1001, to: 3000 })
    w.setDurableFloor({ after: 3001, to: 6000 })
    enqueue(3001)
    await w.flushTransferWriter()
    expect(W()).toBe(1000)
    enqueue(1001)
    await w.flushTransferWriter()
    expect(W()).toBe(6000)
  })

  it('a reorg into the range shortens it to the fork, and one below the old cursor cancels it', async () => {
    w.setDurableFloor({ after: 1001, to: 5000 })
    await w.rollbackTransferWriterTo(2000)
    enqueue(1001)
    await w.flushTransferWriter()
    expect(W()).toBe(2000)

    w.setDurableFloor({ after: 2001, to: 6000 })
    await w.rollbackTransferWriterTo(2000)
    enqueue(2001)
    await w.flushTransferWriter()
    expect(W()).toBe(2001)
  })
})

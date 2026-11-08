import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * The transfer writer's failure classification and its W-lag alarm. The real SQLSTATE
 * shapes and the isolation itself are proven against Postgres in
 * tt-writer-isolation.pg.test.ts; this file covers what needs no server.
 *
 * './db' is replaced by a fake, so no test here can reach a database: a block listed in
 * `fail` fails its INSERT with the error given, everything else succeeds.
 */
const fake = vi.hoisted(() => ({ fail: new Map<number, unknown>(), tries: new Map<number, number>() }))

vi.mock('./db', async importOriginal => {
  const actual = await importOriginal<typeof import('./db')>()
  const tx = {
    execute: async () => [],
    insert: () => ({
      values: (rows: Array<{ blockNumber: number }>) => ({
        onConflictDoNothing: async () => {
          for (const r of rows) fake.tries.set(r.blockNumber, (fake.tries.get(r.blockNumber) ?? 0) + 1)
          for (const r of rows) if (fake.fail.has(r.blockNumber)) throw fake.fail.get(r.blockNumber)
          return []
        },
      }),
    }),
  }
  const db = {
    transaction: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    execute: async () => [],
  }
  return { ...actual, getDb: () => db, getWriterDb: () => db }
})

/** The shape postgres.js gives a server error. */
const pgError = (code: string, message = 'boom') => Object.assign(new Error(message), { name: 'PostgresError', code })
const row = (n: number) => ({
  txHash: `0x${n}`, logIndex: 0, tokenAddress: '0xt', fromAddress: '0xf', toAddress: '0xto',
  value: '1', tokenId: null, blockNumber: n, timestamp: new Date(0), tokenType: 'BEP20' as const,
})

type Writer = typeof import('./block-processor')
let w: Writer

beforeEach(async () => {
  fake.fail.clear()
  fake.tries.clear()
  vi.resetModules()
  w = await import('./block-processor')
})

describe('classifyWriteFailure', () => {
  it('reads the SQLSTATE class of a server error', () => {
    expect(w.classifyWriteFailure(pgError('22P02'))).toEqual({ kind: 'data', sqlstate: '22P02' })
    expect(w.classifyWriteFailure(pgError('22001'))).toEqual({ kind: 'data', sqlstate: '22001' })
    expect(w.classifyWriteFailure(pgError('08006'))).toEqual({ kind: 'infra', sqlstate: '08006' })
    expect(w.classifyWriteFailure(pgError('40P01'))).toEqual({ kind: 'infra', sqlstate: '40P01' })
    expect(w.classifyWriteFailure(pgError('57014'))).toEqual({ kind: 'infra', sqlstate: '57014' })
  })

  it('tells a missing partition from any other check violation', () => {
    expect(w.classifyWriteFailure(pgError('23514', 'no partition of relation "token_transfers" found for row')))
      .toEqual({ kind: 'missing-partition', sqlstate: '23514' })
    expect(w.classifyWriteFailure(pgError('23514', 'new row violates check constraint "x"')))
      .toEqual({ kind: 'unknown', sqlstate: '23514' })
  })

  it('treats any other SQLSTATE as unknown', () => {
    expect(w.classifyWriteFailure(pgError('23502'))).toEqual({ kind: 'unknown', sqlstate: '23502' })
    expect(w.classifyWriteFailure(pgError('42P01'))).toEqual({ kind: 'unknown', sqlstate: '42P01' })
  })

  it('a socket or connection error from the driver is infrastructure; any other is unknown', () => {
    const driver = (code: string) => Object.assign(new Error(code), { code })
    expect(w.classifyWriteFailure(driver('ECONNRESET')).kind).toBe('infra')
    expect(w.classifyWriteFailure(driver('CONNECT_TIMEOUT')).kind).toBe('infra')
    expect(w.classifyWriteFailure(driver('CONNECTION_CLOSED')).kind).toBe('infra')
    expect(w.classifyWriteFailure(driver('UNDEFINED_VALUE')).kind).toBe('unknown')
    expect(w.classifyWriteFailure(new TypeError('x is undefined')).kind).toBe('unknown')
  })

  it('looks through the wrapper drizzle puts around a query error', async () => {
    const { DrizzleQueryError } = await import('drizzle-orm/errors')
    const wrapped = new DrizzleQueryError('insert into "token_transfers" …', [], pgError('22P02') as any)
    expect(w.classifyWriteFailure(wrapped)).toEqual({ kind: 'data', sqlstate: '22P02' })
  })
})

describe('the W-lag alarm', () => {
  let errors: string[]
  let logs: string[]
  beforeEach(() => {
    errors = []
    logs = []
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')) })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('fires once when W trails the newest queued block by more than the queue bound, and clears when it catches up', async () => {
    w.initTransferWriter(1000)
    fake.fail.set(1001, pgError('23502'))   // unknown: held forever
    for (let n = 1001; n <= 3100; n++) w.enqueueTransferWrite(n, [row(n)])
    await vi.waitFor(() => expect(w.getTransferQueueDepth().blocks).toBe(1))
    expect(w.getTransferQueueDepth().durableBlock).toBe(1000)
    const alarms = errors.filter(e => e.includes('ALERT W trails cursor'))
    expect(alarms).toHaveLength(1)
    expect(alarms[0]).toMatch(/trails cursor by \d+ blocks \(W=1000, newest queued \d+, held at block 1001 by 23502\)/)

    // Retried alone, with a growing backoff, not in a tight loop: four tries take over a second.
    const t0 = Date.now()
    await vi.waitFor(() => expect(fake.tries.get(1001)).toBeGreaterThanOrEqual(5), { timeout: 5_000 })
    expect(Date.now() - t0).toBeGreaterThan(1_000)

    // The block is fixed: W folds through everything written above it.
    fake.fail.clear()
    await w.rollbackTransferWriterTo(1000)
    for (let n = 1001; n <= 3100; n++) w.enqueueTransferWrite(n, [row(n)])
    // The rollback forgot the failure above the fork: its replacement does not wait out a backoff.
    const t1 = Date.now()
    await w.flushTransferWriter()
    expect(Date.now() - t1).toBeLessThan(500)
    expect(w.getTransferQueueDepth().durableBlock).toBe(3100)
    expect(logs.some(l => l.includes('W caught up'))).toBe(true)
    expect(errors.filter(e => e.includes('ALERT W trails cursor'))).toHaveLength(1)
  })
})

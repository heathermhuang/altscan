import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { JsonRpcProvider } from 'ethers'

/**
 * processBlock must refuse an endpoint's answer BEFORE the first write when it
 * cannot be trusted (so rpc-failover retries elsewhere), and must never throw
 * AFTER the first write over the secondary internal_transactions table.
 *
 * The db is a recorder, never a connection: every insert is captured in `inserts`
 * and awaiting one resolves to no rows.
 */
const { inserts, holdInserts } = vi.hoisted(() => ({
  inserts: [] as Array<{ table: unknown; rows: any[] }>,
  /** While set, every insert stays pending until it resolves. */
  holdInserts: { until: null as Promise<void> | null },
}))

vi.mock('./db', async importOriginal => {
  const actual = await importOriginal<typeof import('./db')>()
  const db = {
    insert: (table: unknown) => ({
      values: (rows: any) => {
        inserts.push({ table, rows: Array.isArray(rows) ? rows : [rows] })
        const done: any = {
          onConflictDoNothing: () => done,
          returning: async () => [],
          then: (res: any, rej: any) => Promise.resolve(holdInserts.until).then(() => []).then(res, rej),
        }
        return done
      },
    }),
  }
  return { ...actual, getDb: () => db, getWriterDb: () => db }
})
vi.mock('./webhook-notifier', () => ({ notifyWebhooks: vi.fn(async () => {}) }))

import {
  processBlock, fetchBlockReceipts, traceWithinBudget, tracesInFlight, TRACE_DEADLINE_MS,
  retraceMissedBlocks, forgetTraceMissesFrom, retraceBacklogStats,
  RETRACE_AFTER_BLOCKS, RETRACE_MAX_ATTEMPTS, RETRACE_BACKLOG_MAX, RETRACE_MAX_IN_FLIGHT,
} from './block-processor'
import { schema } from './db'
import { indexerConfig } from './config-instance'

const H = 1_000
const HASH = '0x' + 'a1'.repeat(32)
const TX_HASH = '0x' + 'c3'.repeat(32)
const ADDR = '0x' + '11'.repeat(20)

function blockStub(over: Record<string, unknown> = {}, txs: any[] = []) {
  return {
    number: H,
    hash: HASH,
    parentHash: '0x' + 'b2'.repeat(32),
    timestamp: 1_700_000_000,
    miner: ADDR,
    gasUsed: 21000n,
    gasLimit: 30_000_000n,
    baseFeePerGas: 7n,
    transactions: txs.map(t => t.hash),
    prefetchedTransactions: txs,
    ...over,
  }
}

function txStub(over: Record<string, unknown> = {}) {
  return {
    hash: TX_HASH, from: ADDR, to: ADDR, value: 0n, gasLimit: 21000n,
    gasPrice: 100n, data: '0x', nonce: 1, type: 2, ...over,
  }
}

function providerFor(block: unknown, receipts: unknown = [], traces: unknown = null) {
  return {
    getBlock: vi.fn(async () => block),
    send: vi.fn(async (method: string) => {
      if (method === 'eth_getBlockReceipts') return receipts
      if (method === 'debug_traceBlockByNumber') return traces
      throw new Error(`unexpected ${method}`)
    }),
  } as unknown as JsonRpcProvider
}

beforeEach(() => { inserts.length = 0 })

describe('processBlock — wrong height', () => {
  it('rejects a block answering another height, before any write', async () => {
    const onWritesBegan = vi.fn()
    const provider = providerFor(blockStub({ number: H + 1 }))
    await expect(processBlock(H, provider, true, onWritesBegan)).rejects.toThrow(/for height 1001/)
    expect(onWritesBegan).not.toHaveBeenCalled()
    expect(inserts).toEqual([])
  })

  it('accepts the requested height', async () => {
    const onWritesBegan = vi.fn()
    await processBlock(H, providerFor(blockStub()), true, onWritesBegan)
    expect(onWritesBegan).toHaveBeenCalledTimes(1)
    expect(inserts.map(i => i.table)).toEqual([schema.blocks])
  })
})

describe('traces never hold up the block', () => {
  // The trace used to share the block's acquisition timeout. The trace endpoint is
  // not in the failover pool, so one that stopped answering failed every block on
  // every block endpoint until the poison tracker quarantined them. Nothing cancels
  // an abandoned trace call, so calls a deadline gave up on are capped as well.
  const settlers: Array<(v: unknown) => void> = []
  const hangingProvider = () =>
    ({ send: vi.fn(() => new Promise(res => { settlers.push(res) })) }) as unknown as JsonRpcProvider
  const settleAll = () => settlers.splice(0).forEach(res => res([]))
  afterEach(async () => {
    vi.useRealTimers()
    settleAll()
    await vi.waitFor(() => expect(tracesInFlight()).toBe(0))
  })

  it('the trace deadline sits inside the acquisition timeout', () => {
    expect(TRACE_DEADLINE_MS).toBeGreaterThan(0)
    expect(TRACE_DEADLINE_MS).toBeLessThan(indexerConfig.rpc.fetchTimeoutMs)
  })

  it('returns the traces when the endpoint answers in time', async () => {
    const traces = [{ txHash: TX_HASH, result: {} }]
    const provider = { send: vi.fn(async () => traces) } as unknown as JsonRpcProvider
    await expect(traceWithinBudget(provider, H, { deadlineMs: 1_000, maxInFlight: 4 })).resolves.toBe(traces)
  })

  it('gives up on a trace that does not answer by the deadline', async () => {
    await expect(traceWithinBudget(hangingProvider(), H, { deadlineMs: 10, maxInFlight: 4 })).resolves.toBeNull()
  })

  it('a trace that errors yields null', async () => {
    const provider = { send: vi.fn(async () => { throw new Error('block not found') }) } as unknown as JsonRpcProvider
    await expect(traceWithinBudget(provider, H, { deadlineMs: 1_000, maxInFlight: 4 })).resolves.toBeNull()
  })

  it('starts no trace while abandoned calls hold the cap, and frees a slot when one settles', async () => {
    const provider = hangingProvider()
    const opts = { deadlineMs: 10, maxInFlight: 2 }
    await traceWithinBudget(provider, H, opts)
    await traceWithinBudget(provider, H, opts)
    expect(tracesInFlight()).toBe(2)
    await expect(traceWithinBudget(provider, H, opts)).resolves.toBeNull()
    expect(provider.send).toHaveBeenCalledTimes(2)

    settleAll()
    await vi.waitFor(() => expect(tracesInFlight()).toBe(0))
    const next = traceWithinBudget(provider, H, opts)
    expect(provider.send).toHaveBeenCalledTimes(3)
    settleAll()
    await next
  })

  it('processBlock lands the block when the trace endpoint never answers', async () => {
    vi.useFakeTimers()
    const onWritesBegan = vi.fn()
    const outcome = processBlock(H, providerFor(blockStub()), true, onWritesBegan, hangingProvider())
      .then(() => 'landed', (err: Error) => err.message)
    await vi.advanceTimersByTimeAsync(indexerConfig.rpc.fetchTimeoutMs + 1)
    expect(await outcome).toBe('landed')
    expect(onWritesBegan).toHaveBeenCalledTimes(1)
    expect(inserts.map(i => i.table)).toEqual([schema.blocks])
  })
})

describe('a block whose trace failed is re-traced a few blocks later', () => {
  const MAX_LAG = 500
  const ownTrace = {
    txHash: TX_HASH,
    result: { type: 'CALL', from: ADDR, to: ADDR, value: '0x1', calls: [{ type: 'CALL', from: ADDR, to: ADDR, value: '0x5' }] },
  }
  const hex = (n: number) => '0x' + n.toString(16)
  const tracer = (send: (...a: any[]) => Promise<unknown>) => ({ send: vi.fn(send) }) as unknown as JsonRpcProvider & { send: ReturnType<typeof vi.fn> }
  const notFound = async () => { throw new Error('block not found') }
  // skipLogs, so the block needs no receipts.
  const missBlock = (n: number, trace: JsonRpcProvider) =>
    processBlock(n, providerFor(blockStub({ number: n }, [txStub()])), true, undefined, trace)
  const settle = () => forgetTraceMissesFrom(Number.POSITIVE_INFINITY)
  const itxRows = () => inserts.filter(i => i.table === schema.internalTransactions).flatMap(i => i.rows)
  const held: Array<(v: unknown) => void> = []

  afterEach(async () => {
    held.splice(0).forEach(res => res(null))
    await forgetTraceMissesFrom(0)
    await vi.waitFor(() => expect(tracesInFlight()).toBe(0))
  })

  it('a trace that says not-found and later succeeds ends with the rows stored', async () => {
    const t = tracer(notFound)
    t.send.mockImplementationOnce(notFound).mockResolvedValue([ownTrace])
    const before = retraceBacklogStats()
    await missBlock(H, t)
    expect(itxRows()).toEqual([])
    expect(retraceBacklogStats().pending).toBe(1)

    retraceMissedBlocks(t, H + RETRACE_AFTER_BLOCKS - 1, MAX_LAG)
    await settle()
    expect(t.send).toHaveBeenCalledTimes(1)

    retraceMissedBlocks(t, H + RETRACE_AFTER_BLOCKS, MAX_LAG)
    await settle()
    expect(t.send).toHaveBeenCalledTimes(2)
    expect(itxRows()).toHaveLength(1)
    expect(itxRows()[0]).toMatchObject({ txHash: TX_HASH, blockNumber: H, value: '5' })
    expect(retraceBacklogStats()).toMatchObject({ pending: 0, recovered: before.recovered + 1, dropped: before.dropped })
  })

  it('a block that traced fine is not queued', async () => {
    await missBlock(H, tracer(async () => [ownTrace]))
    expect(retraceBacklogStats().pending).toBe(0)
  })

  it('drops a block once it is further behind the tip than the trace window', async () => {
    const t = tracer(notFound)
    const before = retraceBacklogStats()
    await missBlock(H, t)
    retraceMissedBlocks(t, H + MAX_LAG + 1, MAX_LAG)
    await settle()
    expect(t.send).toHaveBeenCalledTimes(1)
    expect(retraceBacklogStats()).toMatchObject({ pending: 0, dropped: before.dropped + 1 })
  })

  it(`gives up after ${RETRACE_MAX_ATTEMPTS} re-traces, spaced further apart each time`, async () => {
    const t = tracer(notFound)
    const before = retraceBacklogStats()
    await missBlock(H, t)
    for (let k = 0; k < RETRACE_MAX_ATTEMPTS; k++) {
      const due = H + (RETRACE_AFTER_BLOCKS << k)
      retraceMissedBlocks(t, due - 1, MAX_LAG)
      await settle()
      expect(t.send).toHaveBeenCalledTimes(1 + k)
      retraceMissedBlocks(t, due, MAX_LAG)
      await settle()
      expect(t.send).toHaveBeenCalledTimes(2 + k)
    }
    expect(retraceBacklogStats()).toMatchObject({ pending: 0, dropped: before.dropped + 1 })
  })

  it(`holds at most ${RETRACE_BACKLOG_MAX} blocks and drops the one that missed first`, async () => {
    const t = tracer(notFound)
    const before = retraceBacklogStats()
    for (let n = H; n <= H + RETRACE_BACKLOG_MAX; n++) await missBlock(n, t)
    expect(retraceBacklogStats()).toMatchObject({ pending: RETRACE_BACKLOG_MAX, dropped: before.dropped + 1 })

    // At this tip only H and H+1 are due, and H is the one that was dropped.
    t.send.mockClear()
    retraceMissedBlocks(t, H + 1 + RETRACE_AFTER_BLOCKS, MAX_LAG)
    await settle()
    expect(t.send.mock.calls.map(c => c[1][0])).toEqual([hex(H + 1)])
  })

  it('starts no re-trace while the spare half of the cap is in use, and charges it no attempt', async () => {
    const t = tracer(notFound)
    t.send.mockImplementationOnce(notFound).mockResolvedValue([ownTrace])
    await missBlock(H, t)
    const hanging = { send: vi.fn(() => new Promise(res => { held.push(res) })) } as unknown as JsonRpcProvider
    for (let i = 0; i < RETRACE_MAX_IN_FLIGHT; i++) await traceWithinBudget(hanging, H, { deadlineMs: 1, maxInFlight: 1_000 })
    expect(tracesInFlight()).toBe(RETRACE_MAX_IN_FLIGHT)

    retraceMissedBlocks(t, H + RETRACE_AFTER_BLOCKS, MAX_LAG)
    await settle()
    expect(t.send).toHaveBeenCalledTimes(1)

    held.splice(0).forEach(res => res(null))
    await vi.waitFor(() => expect(tracesInFlight()).toBe(0))
    // Same tip: had the refusal counted as an attempt, the block would not be due again yet.
    retraceMissedBlocks(t, H + RETRACE_AFTER_BLOCKS, MAX_LAG)
    await settle()
    expect(t.send).toHaveBeenCalledTimes(2)
    expect(itxRows()).toHaveLength(1)
  })

  it('a block whose re-trace is still inserting is not re-traced again', async () => {
    const t = tracer(notFound)
    t.send.mockImplementationOnce(notFound).mockResolvedValue([ownTrace])
    await missBlock(H, t)
    let release!: () => void
    holdInserts.until = new Promise<void>(res => { release = res })
    try {
      retraceMissedBlocks(t, H + RETRACE_AFTER_BLOCKS, MAX_LAG)
      await vi.waitFor(() => expect(itxRows()).toHaveLength(1)) // the insert has started and is held
      retraceMissedBlocks(t, H + RETRACE_AFTER_BLOCKS, MAX_LAG)
      expect(t.send).toHaveBeenCalledTimes(2)
    } finally {
      holdInserts.until = null
      release()
    }
    await settle()
    expect(itxRows()).toHaveLength(1)
    expect(retraceBacklogStats().pending).toBe(0)
  })

  it('a reorg unwind waits for an open re-trace and keeps its rows out', async () => {
    const t = tracer(notFound)
    let answer!: (v: unknown) => void
    t.send.mockImplementationOnce(notFound).mockImplementationOnce(() => new Promise(res => { answer = res }))
    const before = retraceBacklogStats()
    await missBlock(H, t)
    retraceMissedBlocks(t, H + RETRACE_AFTER_BLOCKS, MAX_LAG)
    expect(t.send).toHaveBeenCalledTimes(2)

    let unwound = false
    const forgetting = forgetTraceMissesFrom(H).then(() => { unwound = true })
    await new Promise(res => setTimeout(res, 5))
    expect(unwound).toBe(false)
    answer([ownTrace])
    await forgetting
    expect(itxRows()).toEqual([])
    expect(retraceBacklogStats()).toEqual({ pending: 0, recovered: before.recovered, dropped: before.dropped })
  })
})

describe('processBlock — internal transactions never throw after the first write', () => {
  const trace = (over: Record<string, unknown>) => ({
    result: { type: 'CALL', from: ADDR, to: ADDR, value: '0x1', calls: [{ type: 'CALL', from: ADDR, to: ADDR, value: '0x5' }] },
    ...over,
  })
  const traceProv = (traces: unknown) => providerFor(null, [], traces)

  it('a trace entry with no txHash does not throw and the block still lands', async () => {
    const onWritesBegan = vi.fn()
    await expect(
      processBlock(H, providerFor(blockStub()), true, onWritesBegan, traceProv([trace({})])),
    ).resolves.toBeUndefined()
    expect(onWritesBegan).toHaveBeenCalledTimes(1)
    expect(inserts.map(i => i.table)).toEqual([schema.blocks])
  })

  it('a malformed frame value does not throw either', async () => {
    const bad = trace({ txHash: TX_HASH })
    ;(bad.result.calls[0] as any).value = '0xzz'
    const blk = blockStub({}, [txStub()])
    await expect(processBlock(H, providerFor(blk), true, undefined, traceProv([bad]))).resolves.toBeUndefined()
    expect(inserts.some(i => i.table === schema.internalTransactions)).toBe(false)
  })

  it('traces for a transaction that is not in the block are not stored', async () => {
    const foreign = trace({ txHash: '0x' + 'ee'.repeat(32) })
    await processBlock(H, providerFor(blockStub()), true, undefined, traceProv([foreign]))
    expect(inserts.some(i => i.table === schema.internalTransactions)).toBe(false)
  })

  it('traces for a transaction in the block ARE stored, under the block number', async () => {
    const own = trace({ txHash: TX_HASH.toUpperCase().replace('0X', '0x') })
    await processBlock(H, providerFor(blockStub({}, [txStub()])), true, undefined, traceProv([own]))
    const itx = inserts.find(i => i.table === schema.internalTransactions)
    expect(itx?.rows).toHaveLength(1)
    expect(itx?.rows[0]).toMatchObject({ txHash: TX_HASH, blockNumber: H, value: '5' })
  })

  it('a call tree nested past trace_address VARCHAR(128) loses only that frame, not the block', async () => {
    // Postgres rejects the whole chunk over one overlong value, so the deep frame must never reach the INSERT.
    let deep: Record<string, unknown> = { type: 'CALL', from: ADDR, to: ADDR, value: '0x7' }
    for (let d = 1; d < 65; d++) deep = { type: 'CALL', from: ADDR, to: ADDR, value: '0x0', calls: [deep] }
    const own = trace({ txHash: TX_HASH })
    ;(own.result.calls as unknown[]).push(deep) // trace address '1' + '.0' x 64 = 129 characters
    await processBlock(H, providerFor(blockStub({}, [txStub()])), true, undefined, traceProv([own]))
    const itx = inserts.find(i => i.table === schema.internalTransactions)
    expect(itx?.rows.map((r: { traceAddress: string; value: string }) => [r.traceAddress, r.value])).toEqual([['0', '5']])
  })
})

describe('processBlock — gas price', () => {
  const receipt = (over: Record<string, unknown> = {}) => ({
    transactionHash: TX_HASH, status: '0x1', gasUsed: '0x5208', logs: [], ...over,
  })

  it('stores the receipt\'s effectiveGasPrice, not the type-2 max fee on the tx', async () => {
    // tx.gasPrice (100) is the max fee; the transaction actually paid 0x2a = 42.
    const blk = blockStub({}, [txStub({ type: 2, gasPrice: 100n })])
    await processBlock(H, providerFor(blk, [receipt({ effectiveGasPrice: '0x2a' })]))
    const row = inserts.find(i => i.table === schema.transactions)?.rows[0]
    expect(row.gasPrice).toBe('42')
  })

  it('falls back to tx.gasPrice when the receipt reports none', async () => {
    const blk = blockStub({}, [txStub({ gasPrice: 100n })])
    await processBlock(H, providerFor(blk, [receipt()]))
    expect(inserts.find(i => i.table === schema.transactions)?.rows[0].gasPrice).toBe('100')
  })

  it('a receipt with no status and no root refuses the block before any write', async () => {
    const onWritesBegan = vi.fn()
    const blk = blockStub({}, [txStub()])
    await expect(processBlock(H, providerFor(blk, [receipt({ status: undefined })]), false, onWritesBegan))
      .rejects.toThrow(/neither status nor root/)
    expect(onWritesBegan).not.toHaveBeenCalled()
    expect(inserts).toEqual([])
  })
})

describe('fetchBlockReceipts — status', () => {
  const rec = (over: Record<string, unknown>) => ({ transactionHash: TX_HASH, gasUsed: '0x1', logs: [], ...over })
  const statusOf = async (r: Record<string, unknown>) =>
    (await fetchBlockReceipts({ send: vi.fn(async () => [rec(r)]) } as unknown as JsonRpcProvider, H))[0].receipt.status

  it("maps '0x1' to success and '0x0' to failure", async () => {
    expect(await statusOf({ status: '0x1' })).toBe(true)
    expect(await statusOf({ status: '0x0' })).toBe(false)
  })

  it('counts a pre-Byzantium root-only receipt as success', async () => {
    expect(await statusOf({ root: '0x' + '9f'.repeat(32) })).toBe(true)
    expect(await statusOf({ status: null, root: '0x' + '9f'.repeat(32) })).toBe(true)
  })

  it('throws, so failover retries, when there is neither a status nor a root', async () => {
    await expect(statusOf({})).rejects.toThrow(/neither status nor root/)
    await expect(statusOf({ status: null, root: '0x' })).rejects.toThrow(/neither status nor root/)
  })

  it('throws on a status it does not recognise instead of calling it a failure', async () => {
    await expect(statusOf({ status: '0x2' })).rejects.toThrow(/unrecognised status/)
    await expect(statusOf({ status: '' })).rejects.toThrow(/unrecognised status/)
  })
})

describe('fetchBlockReceipts — log fields are checked before the first write', () => {
  // One odd endpoint's malformed log used to pass straight through: a NaN or
  // out-of-int4 logIndex, or an oversized topic, only failed at the async
  // transfer writer's INSERT, after the cursor had moved past the block, so the
  // coalesced drain retried forever with W frozen. Throwing here instead hands
  // the block to rpc-failover while nothing has been written.
  const TOPIC = '0x' + 'dd'.repeat(32)
  const log = (over: Record<string, unknown> = {}) =>
    ({ address: ADDR, topics: [TOPIC, TOPIC, TOPIC], data: '0x', logIndex: '0x0', ...over })
  const fetchWith = (l: Record<string, unknown>) => fetchBlockReceipts({
    send: vi.fn(async () => [{ transactionHash: TX_HASH, status: '0x1', gasUsed: '0x1', logs: [l] }]),
  } as unknown as JsonRpcProvider, H)

  it('keeps a well-formed log, lower-casing its address', async () => {
    const upper = '0x' + 'AB'.repeat(20)
    const [r] = await fetchWith(log({ address: upper, logIndex: '0x7fffffff' }))
    expect(r.receipt.logs).toEqual([{ address: upper.toLowerCase(), topics: [TOPIC, TOPIC, TOPIC], data: '0x', index: 0x7fffffff }])
    expect((await fetchWith(log({ topics: [] })))[0].receipt.logs[0].topics).toEqual([])
  })

  it.each([
    ['missing', undefined], ['null', null], ['non-hex', '0xzz'], ['empty', ''], ['bare 0x', '0x'],
    ['unprefixed', '12'], ['a number', 5], ['past int4', '0x80000000'],
  ])('rejects a %s logIndex', async (_, logIndex) => {
    await expect(fetchWith(log({ logIndex }))).rejects.toThrow(/logIndex/)
  })

  it.each([
    ['31 bytes', ['0x' + 'dd'.repeat(31)]], ['33 bytes', ['0x' + 'dd'.repeat(33)]],
    ['non-hex', ['0x' + 'zz'.repeat(32)]], ['not a string', [7]],
    ['more than four', [TOPIC, TOPIC, TOPIC, TOPIC, TOPIC]], ['not an array', TOPIC],
  ])('rejects topics that are %s', async (_, topics) => {
    await expect(fetchWith(log({ topics }))).rejects.toThrow(/topic/)
  })

  it.each([
    ['short', '0x' + '11'.repeat(19)], ['long', '0x' + '11'.repeat(21)],
    ['non-hex', '0x' + 'zz'.repeat(20)], ['missing', undefined],
  ])('rejects a %s address', async (_, address) => {
    await expect(fetchWith(log({ address }))).rejects.toThrow(/address/)
  })

  it('refuses the whole block before any write, so failover can retry it', async () => {
    const onWritesBegan = vi.fn()
    const receipts = [{ transactionHash: TX_HASH, status: '0x1', gasUsed: '0x5208', logs: [log({ logIndex: '0x80000000' })] }]
    await expect(processBlock(H, providerFor(blockStub({}, [txStub()]), receipts), false, onWritesBegan))
      .rejects.toThrow(/logIndex/)
    expect(onWritesBegan).not.toHaveBeenCalled()
    expect(inserts).toEqual([])
  })
})

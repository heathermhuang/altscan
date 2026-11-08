import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { JsonRpcProvider } from 'ethers'

import { AbiCoder, JsonRpcProvider as RealJsonRpcProvider, Network } from 'ethers'
import { getChainConfig } from '@altscan/chain-config'
import { SWAP_V2_TOPIC, V2_FACTORIES } from './dex-swap'

/**
 * processBlock must refuse an endpoint's answer BEFORE the first write when it
 * cannot be trusted (so rpc-failover retries elsewhere), and must never throw
 * AFTER the first write over the secondary internal_transactions table.
 *
 * The db is a recorder, never a connection: every insert is captured in `inserts`
 * and awaiting one resolves to no rows.
 */
const { inserts } = vi.hoisted(() => ({ inserts: [] as Array<{ table: unknown; rows: any[] }> }))

vi.mock('./db', async importOriginal => {
  const actual = await importOriginal<typeof import('./db')>()
  const db = {
    insert: (table: unknown) => ({
      values: (rows: any) => {
        inserts.push({ table, rows: Array.isArray(rows) ? rows : [rows] })
        const done: any = {
          onConflictDoNothing: () => done,
          returning: async () => [],
          then: (res: any, rej: any) => Promise.resolve([]).then(res, rej),
        }
        return done
      },
    }),
  }
  return { ...actual, getDb: () => db, getWriterDb: () => db }
})
vi.mock('./webhook-notifier', () => ({ notifyWebhooks: vi.fn(async () => {}) }))

import { processBlock, fetchBlockReceipts, traceWithinBudget, tracesInFlight, TRACE_DEADLINE_MS } from './block-processor'
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

describe('processBlock — a node refusing a pair read is not the pair answering', () => {
  // The first swap from an unknown pair reads token0/token1/factory and remembers the
  // verdict. ethers reports an eth_call the NODE refused (a rate limit) as CALL_EXCEPTION,
  // the same code as a revert, so a throttle was remembered as "not a pair" and every
  // later swap on a real pair was skipped. pairCache is module-level: one pair per test.
  const coder = AbiCoder.defaultAbiCoder()
  const word = (addr: string) => coder.encode(['address'], [addr])
  const FACTORY = V2_FACTORIES[getChainConfig().key][0]
  const TOKEN_A = '0x' + 'a0'.repeat(20)
  const TOKEN_B = '0x' + 'b0'.repeat(20)

  /** The pair's honest answers: token0, token1, factory, and getPair pointing back at it. */
  const honest = (pair: string) => async (tx: { data: string }) =>
    ({ '0x0dfe1681': word(TOKEN_A), '0xd21220a7': word(TOKEN_B), '0xc45a0155': word(FACTORY.address), '0xe6a43905': word(pair) })[tx.data.slice(0, 10)]!

  /** The error ethers itself builds from this JSON-RPC error body, not a hand-made lookalike. */
  async function ethersCallError(error: { code: number; message: string }): Promise<unknown> {
    const net = Network.from(getChainConfig().chainId)
    class Endpoint extends RealJsonRpcProvider {
      async _send(payload: unknown) {
        return ((Array.isArray(payload) ? payload : [payload]) as Array<{ id: number }>).map(r => ({ id: r.id, error })) as never
      }
    }
    const p = new Endpoint('http://endpoint.invalid', net, { staticNetwork: net, batchMaxCount: 1 })
    return p.call({ to: ADDR, data: '0x0dfe1681' }).then(() => { throw new Error('expected a rejection') }, (e: unknown) => e)
  }

  const swapBlock = (n: number, pair: string, call: (tx: { data: string }) => Promise<string>) => {
    const topic = '0x' + '00'.repeat(12) + ADDR.slice(2)
    const receipt = {
      transactionHash: TX_HASH, status: '0x1', gasUsed: '0x5208',
      logs: [{ address: pair, logIndex: '0x0', topics: [SWAP_V2_TOPIC, topic, topic], data: coder.encode(['uint256', 'uint256', 'uint256', 'uint256'], [100n, 0n, 0n, 99n]) }],
    }
    return Object.assign(providerFor(blockStub({ number: n }, [txStub()]), [receipt]), { call: vi.fn(call) })
  }
  const dexRows = () => inserts.filter(i => i.table === schema.dexTrades).flatMap(i => i.rows)

  it('a rate-limited read remembers nothing, and the next swap reads the pair again', async () => {
    const pair = '0x' + 'd1'.repeat(20)
    const throttled = await ethersCallError({ code: -32005, message: 'method eth_call in batch triggered rate limit' })
    expect((throttled as { code: string }).code).toBe('CALL_EXCEPTION') // why the code alone cannot tell
    await processBlock(H, swapBlock(H, pair, async () => { throw throttled }))
    expect(dexRows()).toEqual([])

    const next = swapBlock(H + 1, pair, honest(pair))
    await processBlock(H + 1, next)
    expect(next.call).toHaveBeenCalled()
    expect(dexRows()).toHaveLength(1)
    expect(dexRows()[0]).toMatchObject({ pairAddress: pair, dex: FACTORY.dex, blockNumber: H + 1, tokenIn: TOKEN_A, tokenOut: TOKEN_B })
  })

  it('a contract that reverts is still remembered as not a pair', async () => {
    const pair = '0x' + 'd2'.repeat(20)
    const reverted = await ethersCallError({ code: 3, message: 'execution reverted' })
    await processBlock(H, swapBlock(H, pair, async () => { throw reverted }))

    const next = swapBlock(H + 1, pair, honest(pair))
    await processBlock(H + 1, next)
    expect(next.call).not.toHaveBeenCalled()
    expect(dexRows()).toEqual([])
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

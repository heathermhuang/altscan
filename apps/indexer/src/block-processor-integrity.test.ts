import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { JsonRpcProvider } from 'ethers'

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

import { processBlock, fetchBlockReceipts } from './block-processor'
import { schema } from './db'

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

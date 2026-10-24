import { beforeEach, describe, expect, it, vi } from 'vitest'

const provider = vi.hoisted(() => ({
  getTransaction: vi.fn(),
  getTransactionReceipt: vi.fn(),
  getBlock: vi.fn(),
}))
vi.mock('./rpc', () => ({ getWebProvider: vi.fn(async () => provider) }))
vi.mock('./cache-registry', () => ({ registerCache: vi.fn() }))
vi.mock('./observability', () => ({ swallow: vi.fn() }))

import { fetchTxFromRpc, fetchTxFactsFromRpc, fetchBlockFromRpc } from './rpc-fallback'
import { swallow } from './observability'

const hashOf = (c: string) => '0x' + c.repeat(64)
const batchRejected = () =>
  new Error('server response 500 (Batch of more than 3 requests are not allowed on free plan)')

beforeEach(() => {
  vi.mocked(swallow).mockClear()
  for (const f of Object.values(provider)) f.mockReset()
})

// Both pages treat null as "missing" and emit noindex metadata for it, and ISR
// caches that render. So a transport failure reported as null turned a real
// transaction into a cached noindex "not found" page.
describe('fetchTxFromRpc — a failed RPC call is not an absence', () => {
  it('rejects when the RPC call fails, instead of reporting the tx as missing', async () => {
    provider.getTransaction.mockRejectedValue(batchRejected())
    provider.getTransactionReceipt.mockRejectedValue(batchRejected())
    await expect(fetchTxFromRpc(hashOf('a'))).rejects.toThrow(/Batch of more than 3/)
    expect(vi.mocked(swallow).mock.calls[0][0]).toBe('rpc/tx')
  })

  it('does not negative-cache a failure — the next call can still succeed', async () => {
    const h = hashOf('b')
    provider.getTransaction.mockRejectedValueOnce(batchRejected())
    provider.getTransactionReceipt.mockRejectedValueOnce(batchRejected())
    await expect(fetchTxFromRpc(h)).rejects.toThrow()

    provider.getTransaction.mockResolvedValue({
      hash: h, blockNumber: null, from: '0xF', to: null, value: 0n,
      gasLimit: 21000n, gasPrice: 1n, data: '0x', index: 0, nonce: 0, type: 0,
    })
    provider.getTransactionReceipt.mockResolvedValue(null)
    await expect(fetchTxFromRpc(h)).resolves.toMatchObject({ hash: h })
  })

  it('still reports a genuinely unknown tx as null', async () => {
    provider.getTransaction.mockResolvedValue(null)
    provider.getTransactionReceipt.mockResolvedValue(null)
    await expect(fetchTxFromRpc(hashOf('c'))).resolves.toBeNull()
  })
})

// No receipt means the outcome is unknown. `status` has to be filled with something, so the page
// needs the flag to avoid reading that filler as "Succeeded".
describe('fetchTxFromRpc — pending', () => {
  const rawTx = (h: string, blockNumber: number | null) => ({
    hash: h, blockNumber, from: '0xF', to: null, value: 0n,
    gasLimit: 21000n, gasPrice: 1n, data: '0x', index: 0, nonce: 0, type: 0,
  })

  it('flags a tx that is not in a block yet', async () => {
    const h = hashOf('d')
    provider.getTransaction.mockResolvedValue(rawTx(h, null))
    provider.getTransactionReceipt.mockResolvedValue(null)
    await expect(fetchTxFromRpc(h)).resolves.toMatchObject({ blockNumber: 0, pending: true })
  })

  it('flags a tx its node knows a block for but has no receipt for yet', async () => {
    const h = hashOf('e')
    provider.getTransaction.mockResolvedValue(rawTx(h, 100))
    provider.getTransactionReceipt.mockResolvedValue(null)
    provider.getBlock.mockResolvedValue({ timestamp: 1_000_000 })
    await expect(fetchTxFromRpc(h)).resolves.toMatchObject({ blockNumber: 100, pending: true })
  })

  it('does not flag a mined tx, and keeps its real status', async () => {
    const h = hashOf('f')
    provider.getTransaction.mockResolvedValue(rawTx(h, 100))
    provider.getTransactionReceipt.mockResolvedValue({ hash: h, gasUsed: 21000n, status: 0 })
    provider.getBlock.mockResolvedValue({ timestamp: 1_000_000 })
    await expect(fetchTxFromRpc(h)).resolves.toMatchObject({ pending: false, status: false, gasUsed: 21000n })
  })
})

// The public API serves these facts to agents, which would read a placeholder as fact; only the
// page's mapping may fill in.
describe('fetchTxFactsFromRpc — unknowns stay null', () => {
  const rawTx = (h: string, blockNumber: number | null) => ({
    hash: h, blockNumber, from: '0xF', to: null, value: 0n,
    gasLimit: 21000n, gasPrice: 1n, data: '0x', index: null, nonce: 0, type: 2,
  })

  it('leaves status, gas used, block, index and time null for a tx not in a block', async () => {
    const h = hashOf('1')
    provider.getTransaction.mockResolvedValue(rawTx(h, null))
    provider.getTransactionReceipt.mockResolvedValue(null)
    await expect(fetchTxFactsFromRpc(h)).resolves.toMatchObject({
      pending: true, status: null, gasUsed: null, blockNumber: null, txIndex: null, timestamp: null,
    })
    await expect(fetchTxFromRpc(h)).resolves.toMatchObject({ pending: true, status: true, gasUsed: 0n, blockNumber: 0 })
  })

  it('keeps a status-less (pre-Byzantium) receipt unknown, not failed, while the page keeps reading false', async () => {
    const h = hashOf('3')
    provider.getTransaction.mockResolvedValue(rawTx(h, 100))
    provider.getTransactionReceipt.mockResolvedValue({ hash: h, gasUsed: 21000n, status: null })
    provider.getBlock.mockResolvedValue({ timestamp: 1_000_000 })
    await expect(fetchTxFactsFromRpc(h)).resolves.toMatchObject({ pending: false, status: null })
    await expect(fetchTxFromRpc(h)).resolves.toMatchObject({ pending: false, status: false })
  })

  it('leaves the time null when the node does not return the block', async () => {
    const h = hashOf('2')
    provider.getTransaction.mockResolvedValue(rawTx(h, 100))
    provider.getTransactionReceipt.mockResolvedValue({ hash: h, gasUsed: 21000n, status: 1 })
    provider.getBlock.mockResolvedValue(null)
    await expect(fetchTxFactsFromRpc(h)).resolves.toMatchObject({ blockNumber: 100, status: true, timestamp: null })
  })
})

// A node, or a proxy in front of one, can answer for a different hash or block than the one asked.
// The page would then print another transaction's sender, value and fee under this URL.
describe('fetchTxFactsFromRpc — the answer must be for the hash asked', () => {
  const rawTx = (h: string) => ({
    hash: h, blockNumber: 100, from: '0xF', to: null, value: 0n,
    gasLimit: 21000n, gasPrice: 1n, data: '0x', index: 0, nonce: 0, type: 2,
  })

  it('treats a transaction with another hash as not found, and does not negative-cache it', async () => {
    const asked = hashOf('4'), other = hashOf('5')
    provider.getTransaction.mockResolvedValue(rawTx(other))
    provider.getTransactionReceipt.mockResolvedValue({ hash: other, gasUsed: 21000n, status: 1 })
    provider.getBlock.mockResolvedValue({ timestamp: 1_000_000 })
    await expect(fetchTxFactsFromRpc(asked)).resolves.toBeNull()
    await expect(fetchTxFromRpc(asked)).resolves.toBeNull()
    expect(vi.mocked(swallow).mock.calls.some(([tag]) => tag === 'rpc/tx-hash-mismatch')).toBe(true)

    // The node was wrong, not the tx absent: a later correct answer is served, not hidden for the null TTL.
    provider.getTransaction.mockResolvedValue(rawTx(asked))
    provider.getTransactionReceipt.mockResolvedValue({ hash: asked, gasUsed: 21000n, status: 1 })
    await expect(fetchTxFactsFromRpc(asked)).resolves.toMatchObject({ hash: asked })
  })

  it('treats a receipt for another hash as not found', async () => {
    const asked = hashOf('6')
    provider.getTransaction.mockResolvedValue(rawTx(asked))
    provider.getTransactionReceipt.mockResolvedValue({ hash: hashOf('7'), gasUsed: 21000n, status: 1 })
    provider.getBlock.mockResolvedValue({ timestamp: 1_000_000 })
    await expect(fetchTxFactsFromRpc(asked)).resolves.toBeNull()
  })

  it('compares hashes ignoring letter case', async () => {
    const lower = '0x' + 'ab'.repeat(32)
    provider.getTransaction.mockResolvedValue(rawTx(lower))
    provider.getTransactionReceipt.mockResolvedValue({ hash: lower, gasUsed: 21000n, status: 1 })
    provider.getBlock.mockResolvedValue({ timestamp: 1_000_000 })
    await expect(fetchTxFactsFromRpc('0x' + 'AB'.repeat(32))).resolves.toMatchObject({ hash: lower })
  })

  it('still serves a pending tx (no receipt to compare)', async () => {
    const h = hashOf('8')
    provider.getTransaction.mockResolvedValue({ ...rawTx(h), blockNumber: null })
    provider.getTransactionReceipt.mockResolvedValue(null)
    await expect(fetchTxFactsFromRpc(h)).resolves.toMatchObject({ hash: h, pending: true })
  })
})

// A type-2 transaction's own gasPrice/maxFeePerGas is a ceiling; what it PAID is the receipt's
// effective gas price. The fee and gas-price rows used the ceiling.
describe('fetchTxFactsFromRpc — the price paid comes from the receipt', () => {
  const rawTx = (h: string) => ({
    hash: h, blockNumber: 100, from: '0xF', to: null, value: 0n,
    gasLimit: 21000n, gasPrice: 100n, maxFeePerGas: 200n, data: '0x', index: 0, nonce: 0, type: 2,
  })

  it("prefers the receipt's effective gas price over the transaction's", async () => {
    const h = hashOf('9')
    provider.getTransaction.mockResolvedValue(rawTx(h))
    provider.getTransactionReceipt.mockResolvedValue({ hash: h, gasUsed: 21000n, status: 1, gasPrice: 50n })
    provider.getBlock.mockResolvedValue({ timestamp: 1_000_000 })
    await expect(fetchTxFactsFromRpc(h)).resolves.toMatchObject({ gasPrice: 50n })
    await expect(fetchTxFromRpc(h)).resolves.toMatchObject({ gasPrice: '50' })
  })

  it("falls back to the transaction's price while there is no receipt", async () => {
    const h = hashOf('0')
    provider.getTransaction.mockResolvedValue({ ...rawTx(h), blockNumber: null })
    provider.getTransactionReceipt.mockResolvedValue(null)
    await expect(fetchTxFactsFromRpc(h)).resolves.toMatchObject({ gasPrice: 100n })
  })

  it('and to the max fee when the transaction carries no gas price', async () => {
    const h = hashOf('1')
    provider.getTransaction.mockResolvedValue({ ...rawTx(h), gasPrice: null, blockNumber: null })
    provider.getTransactionReceipt.mockResolvedValue(null)
    await expect(fetchTxFactsFromRpc(h)).resolves.toMatchObject({ gasPrice: 200n })
  })
})

describe('fetchBlockFromRpc — the answer must be for the block asked', () => {
  const rawBlock = (number: number) => ({
    number, hash: '0xb', parentHash: '0xa', timestamp: 1_000_000, miner: '0xM', gasUsed: 1n, gasLimit: 2n,
    baseFeePerGas: null, transactions: [], prefetchedTransactions: [],
  })

  it('treats another block as not found', async () => {
    provider.getBlock.mockResolvedValue(rawBlock(124))
    await expect(fetchBlockFromRpc(123)).resolves.toBeNull()
  })

  it('serves the block it was asked for', async () => {
    provider.getBlock.mockResolvedValue(rawBlock(125))
    await expect(fetchBlockFromRpc(125)).resolves.toMatchObject({ number: 125 })
  })
})

describe('fetchBlockFromRpc — a failed RPC call is not an absence', () => {
  it('rejects when the RPC call fails', async () => {
    provider.getBlock.mockRejectedValue(batchRejected())
    await expect(fetchBlockFromRpc(123)).rejects.toThrow(/Batch of more than 3/)
    expect(vi.mocked(swallow).mock.calls[0][0]).toBe('rpc/block')
  })

  it('still reports a genuinely unknown block as null', async () => {
    provider.getBlock.mockResolvedValue(null)
    await expect(fetchBlockFromRpc(456)).resolves.toBeNull()
  })
})

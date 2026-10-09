import { beforeEach, describe, expect, it, vi } from 'vitest'

const provider = vi.hoisted(() => ({
  getTransaction: vi.fn(),
  getTransactionReceipt: vi.fn(),
  getBlock: vi.fn(),
}))
vi.mock('./rpc', () => ({ getWebProvider: vi.fn(async () => provider) }))
vi.mock('./cache-registry', () => ({ registerCache: vi.fn() }))
vi.mock('./observability', () => ({ swallow: vi.fn() }))

import { fetchTxFromRpc, fetchBlockFromRpc } from './rpc-fallback'
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
    provider.getTransactionReceipt.mockResolvedValue({ gasUsed: 21000n, status: 0 })
    provider.getBlock.mockResolvedValue({ timestamp: 1_000_000 })
    await expect(fetchTxFromRpc(h)).resolves.toMatchObject({ pending: false, status: false, gasUsed: 21000n })
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

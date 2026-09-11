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

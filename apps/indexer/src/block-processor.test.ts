import { describe, it, expect, vi } from 'vitest'
import type { JsonRpcProvider } from 'ethers'
import {
  fetchBlockReceipts, enqueueTransferWrite, purgeTransferQueueAbove, getTransferQueueDepth,
} from './block-processor'

// Simulate the real failure mode observed on 2026-04-16: three consecutive
// eth_getBlockReceipts 429s from a rate-limited BSC dataseed RPC.
// Pre-fix: after the 3rd failure, a module-level flag flipped and ALL
// subsequent calls silently returned [] for the process lifetime — dropping
// token_transfers, dex_trades, and tx_status forever.
// Post-fix: each failure throws independently so the worker-pool retry path
// catches it. No hidden process-wide state.

function makeStubProvider(responses: Array<'429' | 'ok'>) {
  let call = 0
  const sentArgs: Array<{ method: string; params: unknown[] }> = []
  const provider = {
    send: vi.fn(async (method: string, params: unknown[]) => {
      sentArgs.push({ method, params })
      const r = responses[call++]
      if (r === '429') {
        const err: Error & { code?: number } = new Error(
          'server response 429 Too Many Requests',
        )
        err.code = 429
        throw err
      }
      // Minimal valid eth_getBlockReceipts response — one tx with one log
      return [
        {
          transactionHash: '0xaaaa',
          status: '0x1',
          gasUsed: '0x5208',
          logs: [
            {
              address: '0xCaFEBabE00000000000000000000000000000001',
              topics: [
                '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                '0x0000000000000000000000000000000000000000000000000000000000000000',
                '0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              ],
              data: '0x000000000000000000000000000000000000000000000000016345785d8a0000',
              logIndex: '0x0',
            },
          ],
        },
      ]
    }),
  } as unknown as JsonRpcProvider
  return { provider, sentArgs, getCallCount: () => call }
}

describe('fetchBlockReceipts — post-fix recovery behavior', () => {
  it('throws on each RPC failure independently (no swallowing)', async () => {
    const { provider } = makeStubProvider(['429', '429', '429'])

    await expect(fetchBlockReceipts(provider, 92888107)).rejects.toThrow(/429/)
    await expect(fetchBlockReceipts(provider, 92888108)).rejects.toThrow(/429/)
    await expect(fetchBlockReceipts(provider, 92888109)).rejects.toThrow(/429/)
  })

  it('recovers on the next successful RPC call after prior failures', async () => {
    // Three 429s then a success — exactly the bug-report scenario
    const { provider } = makeStubProvider(['429', '429', '429', 'ok'])

    await expect(fetchBlockReceipts(provider, 92888107)).rejects.toThrow()
    await expect(fetchBlockReceipts(provider, 92888108)).rejects.toThrow()
    await expect(fetchBlockReceipts(provider, 92888109)).rejects.toThrow()

    // POST-FIX: the 4th call must succeed and return receipts.
    // PRE-FIX: this call would silently return [] because the module
    //          flag `blockReceiptsSupported` had flipped to false.
    const result = await fetchBlockReceipts(provider, 92888110)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      txHash: '0xaaaa',
      receipt: {
        status: true,
        gasUsed: 21000n,
        logs: [
          expect.objectContaining({
            address: '0xcafebabe00000000000000000000000000000001', // normalized to lowercase
            index: 0,
          }),
        ],
      },
    })
  })

  it('still calls the RPC after failures (does not short-circuit based on history)', async () => {
    const { provider, sentArgs } = makeStubProvider(['429', '429', '429', 'ok'])

    await fetchBlockReceipts(provider, 1).catch(() => {})
    await fetchBlockReceipts(provider, 2).catch(() => {})
    await fetchBlockReceipts(provider, 3).catch(() => {})
    await fetchBlockReceipts(provider, 4).catch(() => {})

    expect(sentArgs).toHaveLength(4)
    expect(sentArgs.every(a => a.method === 'eth_getBlockReceipts')).toBe(true)
    expect(sentArgs.map(a => a.params[0])).toEqual(['0x1', '0x2', '0x3', '0x4'])
  })

  it('returns [] only for a successful RPC call with empty result, not for a suppressed one', async () => {
    // Stub returns empty array (valid response from an empty block)
    const provider = {
      send: vi.fn(async () => []),
    } as unknown as JsonRpcProvider

    const result = await fetchBlockReceipts(provider, 999)
    expect(result).toEqual([])
  })
})

// A3 reorg support: stale queued decodes above the fork point must be dropped
// before unwindFrom() deletes their rows, or the writer re-inserts orphaned
// transfers. The writer is UNSEEDED in unit tests (initTransferWriter never
// called), so enqueueTransferWrite only mutates the in-memory queue — no DB.
describe('purgeTransferQueueAbove', () => {
  const row = (n: number) => ({
    txHash: `0x${n}`, logIndex: 0, tokenAddress: '0xt', fromAddress: '0xf',
    toAddress: '0xto', value: '1', tokenId: null, blockNumber: n,
    timestamp: new Date(0), tokenType: 'BEP20' as const,
  })
  it('drops queued rows for blocks above the fork point and keeps the rest', () => {
    enqueueTransferWrite(101, [row(101)])
    enqueueTransferWrite(102, [row(102), row(102)])
    enqueueTransferWrite(103, [row(103)])
    expect(getTransferQueueDepth().rows).toBe(4)
    purgeTransferQueueAbove(101)
    const after = getTransferQueueDepth()
    expect(after.blocks).toBe(1)
    expect(after.rows).toBe(1)
    purgeTransferQueueAbove(0)   // cleanup so queue state can't leak into other tests
    expect(getTransferQueueDepth().rows).toBe(0)
  })
})

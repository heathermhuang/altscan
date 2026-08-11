import { describe, it, expect, vi } from 'vitest'
import { processWithFailover } from './rpc-failover'

/**
 * Regression cover for the 2026-08-11 BNB indexing collapse.
 *
 * `BNB_RPC_URL` held three endpoints, one of which (bsc.publicnode.com) answers
 * recent blocks but 403s any archive request. The indexer only asks for old
 * blocks WHEN IT IS BEHIND, so the moment it drifted, every fetch routed to that
 * endpoint failed, one failure aborted the whole 40-block batch, throughput
 * collapsed, and it skipped ~5,100 blocks an hour — permanently.
 *
 * The invariant these tests pin: a block must survive any single endpoint being
 * broken, as long as one healthy endpoint remains.
 */
describe('processWithFailover', () => {
  it('succeeds on the first provider without touching the others', async () => {
    const work = vi.fn().mockResolvedValue(undefined)
    await processWithFailover(100, ['a', 'b', 'c'], 0, work)
    expect(work).toHaveBeenCalledTimes(1)
    expect(work).toHaveBeenCalledWith(100, 'a')
  })

  it('falls over to the next provider when the first fails', async () => {
    const work = vi.fn()
      .mockRejectedValueOnce(new Error('Archive requests require a personal token'))
      .mockResolvedValueOnce(undefined)
    await processWithFailover(100, ['bad', 'good'], 0, work)
    expect(work).toHaveBeenCalledTimes(2)
    expect(work).toHaveBeenNthCalledWith(1, 100, 'bad')
    expect(work).toHaveBeenNthCalledWith(2, 100, 'good')
  })

  it('starts at the given index and wraps around', async () => {
    const work = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined)
    await processWithFailover(100, ['a', 'b', 'c'], 2, work)
    expect(work).toHaveBeenNthCalledWith(1, 100, 'c')
    expect(work).toHaveBeenNthCalledWith(2, 100, 'a')
  })

  it('tries every provider exactly once before giving up', async () => {
    const work = vi.fn().mockRejectedValue(new Error('all down'))
    await expect(processWithFailover(100, ['a', 'b', 'c'], 1, work)).rejects.toThrow('all down')
    expect(work).toHaveBeenCalledTimes(3)
    expect(work.mock.calls.map(c => c[1])).toEqual(['b', 'c', 'a'])
  })

  it('propagates the LAST error when every provider fails', async () => {
    const work = vi.fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('last'))
    await expect(processWithFailover(100, ['a', 'b'], 0, work)).rejects.toThrow('last')
  })

  it('handles a single-provider list (no failover available)', async () => {
    const work = vi.fn().mockRejectedValue(new Error('only one'))
    await expect(processWithFailover(100, ['a'], 0, work)).rejects.toThrow('only one')
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('normalizes an out-of-range start index', async () => {
    const work = vi.fn().mockResolvedValue(undefined)
    await processWithFailover(100, ['a', 'b'], 7, work)
    // 7 % 2 === 1 → starts at 'b'
    expect(work).toHaveBeenCalledWith(100, 'b')
  })

  it('throws a clear error when the provider list is empty', async () => {
    const work = vi.fn()
    await expect(processWithFailover(100, [], 0, work)).rejects.toThrow(/no RPC providers/i)
    expect(work).not.toHaveBeenCalled()
  })

  it('reports each failover attempt so a sick endpoint is visible in logs', async () => {
    const onFailover = vi.fn()
    const work = vi.fn()
      .mockRejectedValueOnce(new Error('403 archive'))
      .mockResolvedValueOnce(undefined)
    await processWithFailover(100, ['bad', 'good'], 0, work, onFailover)
    expect(onFailover).toHaveBeenCalledTimes(1)
    expect(onFailover).toHaveBeenCalledWith(100, 'bad', expect.any(Error))
  })
})

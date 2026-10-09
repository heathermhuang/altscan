import { beforeEach, describe, expect, it, vi } from 'vitest'

// getBlockStrip runs two selects in parallel: blocks (.where().limit()) and transactions
// (.where().orderBy()). The fake tells them apart by the table handed to from().
const { blockQ, txQ, swallow } = vi.hoisted(() => ({ blockQ: vi.fn(), txQ: vi.fn(), swallow: vi.fn() }))
vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  return {
    schema,
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => (table === schema.blocks ? { limit: () => blockQ() } : { orderBy: () => txQ() }),
        }),
      }),
    },
  }
})
vi.mock('@/lib/observability', () => ({ swallow }))

import { getBlockStrip } from './block-strip'

const txRow = (i: number, over: Partial<{ gasUsed: bigint; gasPrice: bigint; status: boolean }> = {}) => ({
  i, gasUsed: 21_000n, gasPrice: 3_000_000_000n, status: true, ...over,
})

beforeEach(() => { blockQ.mockReset(); txQ.mockReset(); swallow.mockReset() })

describe('getBlockStrip', () => {
  it('returns every transaction of a fully indexed block, as plain numbers', async () => {
    blockQ.mockResolvedValue([{ txCount: 3, gasLimit: 140_000_000n }])
    txQ.mockResolvedValue([txRow(0), txRow(1, { gasUsed: 50_000n, status: false }), txRow(2)])
    const strip = await getBlockStrip(100)
    expect(strip).toEqual({
      gasLimit: 140_000_000,
      txs: [
        { i: 0, gas: 21_000, price: 3_000_000_000, ok: true },
        { i: 1, gas: 50_000, price: 3_000_000_000, ok: false },
        { i: 2, gas: 21_000, price: 3_000_000_000, ok: true },
      ],
    })
    // unstable_cache silently voids a write that holds a BigInt: numbers only, all the way down.
    expect(() => JSON.stringify(strip)).not.toThrow()
    for (const t of strip!.txs) {
      expect(typeof t.gas).toBe('number')
      expect(typeof t.price).toBe('number')
    }
    expect(swallow).not.toHaveBeenCalled()
  })

  // The guard: a strip must never draw a partial block as complete (processBlock persists the block
  // and its transactions before the receipt-derived writes, so a half-written block is real).
  it('is null when fewer rows are persisted than the block\'s tx_count', async () => {
    blockQ.mockResolvedValue([{ txCount: 3, gasLimit: 140_000_000n }])
    txQ.mockResolvedValue([txRow(0), txRow(1)])
    await expect(getBlockStrip(100)).resolves.toBeNull()
    expect(swallow).not.toHaveBeenCalled()
  })

  it('is null when there are MORE rows than tx_count too (the counts disagree)', async () => {
    blockQ.mockResolvedValue([{ txCount: 1, gasLimit: 140_000_000n }])
    txQ.mockResolvedValue([txRow(0), txRow(1)])
    await expect(getBlockStrip(100)).resolves.toBeNull()
  })

  it('is null when the block is not indexed', async () => {
    blockQ.mockResolvedValue([])
    txQ.mockResolvedValue([txRow(0)])
    await expect(getBlockStrip(100)).resolves.toBeNull()
  })

  it('is null for a block with no transactions (nothing to draw)', async () => {
    blockQ.mockResolvedValue([{ txCount: 0, gasLimit: 140_000_000n }])
    txQ.mockResolvedValue([])
    await expect(getBlockStrip(100)).resolves.toBeNull()
  })

  it('reads a failed query as "no strip" and logs it under its tag', async () => {
    blockQ.mockResolvedValue([{ txCount: 1, gasLimit: 140_000_000n }])
    txQ.mockRejectedValue(new Error('db down'))
    await expect(getBlockStrip(100)).resolves.toBeNull()
    expect(swallow).toHaveBeenCalledWith('block-strip', expect.any(Error))
  })
})

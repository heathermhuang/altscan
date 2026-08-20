import { describe, expect, it } from 'vitest'
import { makeIndexerYielder } from './retention-cleanup'

/**
 * Fake sleep: records what it was asked to wait for and returns immediately, so a
 * 30-minute yield budget is exercised in microseconds. The yielder must never read
 * a real clock — only the budget it is handed — or these tests would be timing-flaky.
 */
function harness(opts: {
  lags: number[]          // lag readings, consumed one per getLag() call; last value repeats
  thresholdBlocks?: number
  budgetMs?: number
  pollMs?: number
}) {
  const waits: number[] = []
  const yields: number[] = []
  let exhausted = 0
  let i = 0
  const yielder = makeIndexerYielder({
    thresholdBlocks: opts.thresholdBlocks ?? 50,
    budgetMs: opts.budgetMs ?? 30_000,
    pollMs: opts.pollMs ?? 5_000,
    getLag: () => opts.lags[Math.min(i++, opts.lags.length - 1)],
    sleep: async (ms) => { waits.push(ms) },
    onYield: (info) => { yields.push(info.lag) },
    onBudgetExhausted: () => { exhausted++ },
  })
  return { yielder, waits, yields, exhausted: () => exhausted }
}

describe('makeIndexerYielder (retention yields to a behind indexer)', () => {
  it('does not yield when the indexer is at the tip', async () => {
    const h = harness({ lags: [0] })
    await h.yielder()
    expect(h.waits).toEqual([])
  })

  it('does not yield at exactly the threshold — only strictly above it', async () => {
    const h = harness({ lags: [50], thresholdBlocks: 50 })
    await h.yielder()
    expect(h.waits).toEqual([])
  })

  it('yields while the indexer is behind, then proceeds once it catches up', async () => {
    const h = harness({ lags: [900, 400, 10], pollMs: 5_000 })
    await h.yielder()
    expect(h.waits).toEqual([5_000, 5_000])
    expect(h.yields).toEqual([900, 400])
    expect(h.exhausted()).toBe(0)
  })

  it('NEVER yields past the budget — a chronically behind indexer must not stall the prune', async () => {
    // Disk safety: retention is the only thing between this DB and a full disk, and
    // BNB is already at the retention floor. Yielding forever is a worse failure
    // than a 13% throughput cost.
    const h = harness({ lags: [5_000], budgetMs: 12_000, pollMs: 5_000 })
    await h.yielder()
    expect(h.waits).toEqual([5_000, 5_000, 2_000])   // trimmed to the remaining budget
    expect(h.waits.reduce((a, b) => a + b, 0)).toBe(12_000)
    expect(h.exhausted()).toBe(1)
  })

  it('spends ONE budget across the whole run, not one per batch', async () => {
    const h = harness({ lags: [5_000], budgetMs: 10_000, pollMs: 5_000 })
    await h.yielder()          // batch 1 burns the entire budget
    expect(h.waits).toEqual([5_000, 5_000])
    await h.yielder()          // batch 2 must proceed immediately
    await h.yielder()
    expect(h.waits).toEqual([5_000, 5_000])
    expect(h.exhausted()).toBe(1)   // and warns once, not once per batch
  })

  it('is disabled by a non-positive threshold (env kill-switch)', async () => {
    const h = harness({ lags: [99_999], thresholdBlocks: 0 })
    await h.yielder()
    expect(h.waits).toEqual([])
    expect(h.exhausted()).toBe(0)
  })

  it('is disabled by a zero budget — the emergency disk-pressure re-run never yields', async () => {
    const h = harness({ lags: [99_999], budgetMs: 0 })
    await h.yielder()
    expect(h.waits).toEqual([])
    expect(h.exhausted()).toBe(0)
  })

  it('never waits longer than the poll interval, so it notices a recovery promptly', async () => {
    const h = harness({ lags: [900, 0], budgetMs: 10 * 60_000, pollMs: 5_000 })
    await h.yielder()
    expect(Math.max(...h.waits)).toBe(5_000)
  })
})

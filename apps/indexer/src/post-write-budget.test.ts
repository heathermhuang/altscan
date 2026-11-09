import { describe, expect, it } from 'vitest'
import { boundedRead, createLimiter, warmPairs, withinBudget } from './post-write-budget'

describe('createLimiter', () => {
  it('never runs more than max at once, and runs every one', async () => {
    const run = createLimiter(3)
    let active = 0
    let peak = 0
    const done: number[] = []
    await Promise.all(Array.from({ length: 20 }, (_, i) => run(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 2))
      active--
      done.push(i)
    })))
    expect(peak).toBe(3)
    expect(done.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i))
  })

  it('frees the slot when a function throws', async () => {
    const run = createLimiter(1)
    await expect(run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await run(async () => 'next')).toBe('next')
  })
})

describe('withinBudget', () => {
  it('reads the first budget items now, and leaves the rest', () => {
    expect(withinBudget([1, 2, 3, 4, 5], 3)).toEqual({ now: [1, 2, 3], over: [4, 5] })
    expect(withinBudget([1, 2], 3)).toEqual({ now: [1, 2], over: [] })
  })
})

describe('warmPairs', () => {
  it('maps rows to cache entries, lowercased, in token order', () => {
    expect(warmPairs([{ pair_address: '0xPAIR', token0: '0xAAA', token1: '0xBBB', dex: 'PancakeSwap V2' }]))
      .toEqual([['0xpair', { tokens: ['0xaaa', '0xbbb'], dex: 'PancakeSwap V2' }]])
  })

  it('skips a row missing a field, or whose two tokens are the same', () => {
    expect(warmPairs([
      { pair_address: '', token0: '0xa', token1: '0xb', dex: 'x' },
      { pair_address: '0xp', token0: '0xa', token1: '0xa', dex: 'x' },
      { pair_address: '0xq', token0: '0xa', token1: '', dex: 'x' },
    ])).toEqual([])
  })
})

// Codex round one: a timeout inside the limiter freed the slot while the read stayed in flight on the node, so a slow
// endpoint piled reads past the limit (24 in flight under a limit of 8). The slot now stays with the read.
describe('boundedRead', () => {
  it('times the caller out, but keeps the slot until the read settles', async () => {
    const limit = createLimiter(8)
    let inFlight = 0
    let peak = 0
    const slow = () => new Promise<string>((resolve) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      setTimeout(() => { inFlight--; resolve('late') }, 40)
    })
    const results = await Promise.allSettled(Array.from({ length: 24 }, (_, i) => boundedRead(limit, slow, 5, `read ${i}`)))
    expect(results.every((r) => r.status === 'rejected')).toBe(true)   // every caller stopped waiting
    await new Promise((r) => setTimeout(r, 200))                          // let the reads drain
    expect(peak, 'never more than the limit in flight').toBe(8)
    expect(inFlight).toBe(0)
  })

  it('returns the value when the read is in time', async () => {
    expect(await boundedRead(createLimiter(1), async () => 'ok', 1000, 'fast')).toBe('ok')
  })

  it('a read that fails after its caller gave up does not surface as an unhandled rejection', async () => {
    const seen: unknown[] = []
    const onUnhandled = (e: unknown) => { seen.push(e) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const failsLate = () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('late failure')), 20))
      await expect(boundedRead(createLimiter(1), failsLate, 5, 'late')).rejects.toThrow(/timed out/)
      await new Promise((r) => setTimeout(r, 60))
      expect(seen).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

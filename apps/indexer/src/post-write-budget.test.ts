import { describe, expect, it } from 'vitest'
import { createLimiter, warmPairs, withinBudget } from './post-write-budget'

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

import { describe, expect, it } from 'vitest'
import { decodeTape, encodeTape, gasPct, latestTapeCount, meanSeconds, ratePerMin, spreadSeconds, stripFills, stripWeight, tapeWindow, toTapeTuple, type TapeTuple } from '@/lib/tape'

const t = (n: number, s: number, tx = 0, gas = 0): TapeTuple => [n, s, tx, gas]

describe('spreadSeconds', () => {
  it('returns nothing for no tuples or a lone anchor', () => {
    expect(spreadSeconds([])).toEqual([])
    expect(spreadSeconds([t(10, 100)])).toEqual([])
  })

  it('gives a block the gap to the previous second; the oldest only anchors', () => {
    expect(spreadSeconds([t(10, 100), t(11, 112, 5, 40)])).toEqual([{ n: 11, seconds: 12, txs: 5, gas: 40 }])
  })

  it('splits the gap evenly across blocks that share a second', () => {
    const out = spreadSeconds([t(10, 100), t(11, 101), t(12, 101), t(13, 101)])
    expect(out.map(b => b.n)).toEqual([11, 12, 13])
    for (const b of out) expect(b.seconds).toBeCloseTo(1 / 3, 6)
  })

  it('widens the share when the gap is longer than a second', () => {
    const out = spreadSeconds([t(10, 100), t(11, 105), t(12, 105)])
    expect(out.map(b => b.seconds)).toEqual([2.5, 2.5])
  })

  it('sorts by block number, so newest-first input gives oldest-first output', () => {
    const out = spreadSeconds([t(13, 103), t(12, 102), t(11, 101), t(10, 100)])
    expect(out.map(b => b.n)).toEqual([11, 12, 13])
    expect(out.map(b => b.seconds)).toEqual([1, 1, 1])
  })

  it('carries tx count and gas through unchanged', () => {
    const out = spreadSeconds([t(1, 10), t(2, 12, 46, 9), t(3, 13, 0, 100)])
    expect(out.map(b => [b.txs, b.gas])).toEqual([[46, 9], [0, 100]])
  })

  it('conserves time: displayed seconds sum to newest minus oldest second', () => {
    const out = spreadSeconds([t(1, 50), t(2, 51), t(3, 51), t(4, 53), t(5, 53), t(6, 53), t(7, 60)])
    expect(out.reduce((s, b) => s + b.seconds, 0)).toBeCloseTo(10, 9)
  })
})

describe('ratePerMin', () => {
  it('is null for no tuples or a single tuple', () => {
    expect(ratePerMin([])).toBeNull()
    expect(ratePerMin([t(10, 100)])).toBeNull()
  })

  it('is null when no time elapsed', () => {
    expect(ratePerMin([t(10, 100), t(11, 100)])).toBeNull()
  })

  it('measures blocks per minute between the lowest and highest block, in any order', () => {
    // 60 blocks over 30 s = 2 blocks/s = 120/min
    expect(ratePerMin([t(160, 130), t(100, 100), t(130, 115)])).toBe(120)
  })
})

describe('encodeTape / decodeTape', () => {
  it('round-trips tuples in any order', () => {
    const tuples: TapeTuple[] = [[125764193, 1791156461, 41, 18], [125764192, 1791156460, 45, 9], [125764190, 1791156459, 0, 0]]
    expect(decodeTape(encodeTape(tuples))).toEqual(tuples)
    expect(decodeTape(encodeTape([...tuples].reverse()))).toEqual([...tuples].reverse())
  })

  it('stores offsets from the newest block, not absolute values', () => {
    expect(encodeTape([[100, 5000, 3, 50], [99, 4999, 2, 40]])).toBe('100,5000|0,0,3,50;1,1,2,40')
  })

  it('encodes nothing as an empty string', () => {
    expect(encodeTape([])).toBe('')
    expect(decodeTape('')).toEqual([])
  })
})

describe('gasPct', () => {
  it('floors the percentage of the limit', () => {
    expect(gasPct(9n, 100n)).toBe(9)
    expect(gasPct(1n, 3n)).toBe(33)
    expect(gasPct(30_000_000n, 60_000_000n)).toBe(50)
  })

  it('is 0 when the limit is 0, missing, or the inputs are not integers', () => {
    expect(gasPct(5n, 0n)).toBe(0)
    expect(gasPct(5n, null)).toBe(0)
    expect(gasPct(null, 100n)).toBe(0)
    expect(gasPct('1.5', '100')).toBe(0)
  })

  it('accepts strings and numbers, and clamps to 0-100', () => {
    expect(gasPct('25000', '100000')).toBe(25)
    expect(gasPct(25, 100)).toBe(25)
    expect(gasPct(300n, 100n)).toBe(100)
    expect(gasPct(-5n, 100n)).toBe(0)
  })
})

describe('meanSeconds', () => {
  it('is 0 for no blocks', () => {
    expect(meanSeconds([])).toBe(0)
  })

  it('averages the tile intervals, so ghost tiles match the real ones', () => {
    const out = spreadSeconds([t(1, 100), t(2, 101), t(3, 101), t(4, 104)])
    // (0.5 + 0.5 + 3) / 3
    expect(meanSeconds(out)).toBeCloseTo(4 / 3, 9)
  })
})

describe('tapeWindow', () => {
  it('is 40 before / 8 after on a 0.45s chain', () => {
    expect(tapeWindow(0.45)).toEqual({ before: 40, after: 8 })
  })

  it('keeps a few tiles on a 12s chain, where one tile is ~400px', () => {
    expect(tapeWindow(12)).toEqual({ before: 3, after: 1 })
  })

  it('never asks for more than 40 / 8 or fewer than 3 / 1', () => {
    expect(tapeWindow(0.01)).toEqual({ before: 40, after: 8 })
    expect(tapeWindow(600)).toEqual({ before: 3, after: 1 })
  })
})

describe('toTapeTuple', () => {
  it('floors the timestamp to whole seconds and turns gas into a percent', () => {
    const row = { number: 7, timestamp: new Date(1_791_156_461_900), txCount: 41, gasUsed: 30n, gasLimit: 120n }
    expect(toTapeTuple(row)).toEqual([7, 1_791_156_461, 41, 25])
  })

  it('accepts the cached form: ISO string timestamp, decimal-string gas', () => {
    const row = { number: 8, timestamp: '2026-10-05T12:00:00.250Z', txCount: 0, gasUsed: '50', gasLimit: '100' }
    expect(toTapeTuple(row)).toEqual([8, Math.floor(Date.parse('2026-10-05T12:00:00.250Z') / 1000), 0, 50])
  })
})

describe('latestTapeCount', () => {
  it('is ~32s of chain time: 72 on BNB, the 7-block minimum on ETH', () => {
    expect(latestTapeCount(0.45)).toBe(72)
    expect(latestTapeCount(12)).toBe(7)
  })

  it('never exceeds 100 or drops below 7', () => {
    expect(latestTapeCount(0.1)).toBe(100)
    expect(latestTapeCount(60)).toBe(7)
  })
})

describe('stripWeight', () => {
  it('is gas in thousands, never below 1', () => {
    expect(stripWeight(21_000)).toBe(21)
    expect(stripWeight(1_499)).toBe(1)
    expect(stripWeight(0)).toBe(1)
    expect(stripWeight(612_345)).toBe(612)
  })
})

describe('stripFills', () => {
  it('maps the lowest positive price to 30 and the highest to 100, on a log scale', () => {
    const f = stripFills([1e9, 1e10, 1e11])
    expect(f).toEqual([30, 65, 100])
  })
  it('gives a zero price (a system tx) no fill', () => {
    expect(stripFills([0, 5e7, 1e9])).toEqual([0, 30, 100])
  })
  it('fills everything when every positive price is the same', () => {
    expect(stripFills([5e7, 5e7, 0])).toEqual([100, 100, 0])
  })
  it('returns all zeros when no price is positive', () => {
    expect(stripFills([0, 0])).toEqual([0, 0])
    expect(stripFills([])).toEqual([])
  })
})

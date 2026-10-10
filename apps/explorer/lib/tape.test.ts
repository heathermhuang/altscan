import { describe, expect, it } from 'vitest'
import { TAPE_AFTER, TAPE_BEFORE, TAPE_LATEST, avgTilePx, chipFraction, decodeTape, encodeTape, gasPct, ratePerMin, stripFills, stripWeight, tapeBlocks, tapeWeight, toTapeTuple, txShareOfBlock, type StripTx, type TapeTuple } from '@/lib/tape'

const t = (n: number, s: number, tx = 0, gas = 0): TapeTuple => [n, s, tx, gas]

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

describe('tapeBlocks', () => {
  it('draws every block it is given: nothing is held back to anchor a timeline', () => {
    expect(tapeBlocks([])).toEqual([])
    expect(tapeBlocks([t(10, 100, 5, 40)])).toEqual([{ n: 10, txs: 5, gas: 40 }])
  })

  it('sorts by block number, so newest-first input gives oldest-first (left to right) output', () => {
    expect(tapeBlocks([t(13, 103), t(11, 101), t(12, 102)]).map(b => b.n)).toEqual([11, 12, 13])
  })

  it('carries tx count and gas through unchanged and drops the timestamp', () => {
    expect(tapeBlocks([t(1, 10, 46, 9), t(2, 12, 0, 100)])).toEqual([{ n: 1, txs: 46, gas: 9 }, { n: 2, txs: 0, gas: 100 }])
  })
})

describe('tapeWeight (a tile\'s share of the width = its transaction count)', () => {
  it('is the transaction count', () => {
    expect(tapeWeight(1)).toBe(1)
    expect(tapeWeight(57)).toBe(57)
    expect(tapeWeight(253)).toBe(253)
  })

  it('keeps an empty block in the layout (weight 1), so a tape of empty blocks still fills the track', () => {
    expect(tapeWeight(0)).toBe(1)
  })

  it('treats a bad count as empty rather than letting NaN or a negative reach the layout', () => {
    expect(tapeWeight(NaN)).toBe(1)
    expect(tapeWeight(-4)).toBe(1)
    expect(tapeWeight(Infinity)).toBe(1)
  })

  it('rounds a fractional count (the weight is an integer flex-grow)', () => {
    expect(tapeWeight(12.6)).toBe(13)
  })
})

describe('chipFraction (where the ringed tile sits, 0 = left end, 1 = right end)', () => {
  it('is the middle for a lone tile', () => {
    expect(chipFraction([5], 0)).toBe(0.5)
  })

  it('is the tile\'s centre as a share of the total weight', () => {
    // weights 10 | 20 | 10: tile 1 spans 10..30 of 40, centre 20 -> 0.5; tile 0 centre 5 -> 0.125; tile 2 centre 35 -> 0.875
    expect(chipFraction([10, 20, 10], 1)).toBe(0.5)
    expect(chipFraction([10, 20, 10], 0)).toBe(0.125)
    expect(chipFraction([10, 20, 10], 2)).toBe(0.875)
  })

  it('stays inside 0..1 at both ends however heavy the neighbours are', () => {
    const w = [1, 1000, 1, 1000, 1]
    for (let k = 0; k < w.length; k++) {
      const p = chipFraction(w, k)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(1)
    }
    expect(chipFraction([1, 500, 500], 0)).toBeLessThan(0.01)
    expect(chipFraction([500, 500, 1], 2)).toBeGreaterThan(0.99)
  })

  it('falls back to the middle for an index that is not a tile or weights that sum to nothing', () => {
    expect(chipFraction([3, 3], -1)).toBe(0.5)
    expect(chipFraction([3, 3], 2)).toBe(0.5)
    expect(chipFraction([], 0)).toBe(0.5)
    expect(chipFraction([0, 0], 1)).toBe(0.5)
  })
})

describe('tape block counts (fixed per surface, the same on both chains)', () => {
  // The track is the viewport minus the page's 16px side gutters; tiles are separated by 2px.
  const track = (viewport: number) => viewport - 32

  it('a tile is at least 6px on average at 375px, on the latest-blocks tape and the block page\'s', () => {
    expect(avgTilePx(TAPE_LATEST, track(375))).toBeGreaterThanOrEqual(6)
    expect(avgTilePx(TAPE_BEFORE + 1 + TAPE_AFTER, track(375))).toBeGreaterThanOrEqual(6)
  })

  it('the latest-blocks count is as many as that allows to the nearest ten (more would drop under 6px at 375)', () => {
    expect(avgTilePx(TAPE_LATEST + 10, track(375))).toBeLessThan(6)
  })

  it('shows more than 20 tiles wide enough to read at 1440px', () => {
    expect(TAPE_LATEST).toBeGreaterThan(20)
    expect(avgTilePx(TAPE_LATEST, track(1440))).toBeGreaterThan(20)
  })

  it('looks further back than forward on a block page, so the ringed tile sits right of centre', () => {
    expect(TAPE_BEFORE).toBeGreaterThan(TAPE_AFTER)
    expect(TAPE_AFTER).toBeGreaterThan(0)
  })

  it('avgTilePx is the track less the gaps, shared out', () => {
    expect(avgTilePx(10, 100)).toBe(8.2)   // (100 - 9 gaps * 2px) / 10
    expect(avgTilePx(1, 100)).toBe(100)
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

describe('txShareOfBlock', () => {
  const strip: StripTx[] = [
    { i: 0, gas: 50_000, price: 0, ok: true },
    { i: 1, gas: 21_000, price: 5e7, ok: true },
    { i: 5, gas: 140_000, price: 1e9, ok: false },
    { i: 7, gas: 289_000, price: 5e7, ok: true },
  ]

  it('finds a tx by its tx_index, not its position, and gives its share of the strip\'s gas', () => {
    const r = txShareOfBlock(strip, 7)!
    expect(r.pos).toBe(3)
    expect(r.pct).toBeCloseTo(57.8, 6)   // 289,000 of 500,000
  })

  it('counts every tx, failed ones too (they used the gas)', () => {
    const r = txShareOfBlock(strip, 5)!
    expect(r.pos).toBe(2)
    expect(r.pct).toBeCloseTo(28, 6)   // 140,000 of 500,000
  })

  it('is null when the tx is not in the strip', () => {
    expect(txShareOfBlock(strip, 2)).toBeNull()
    expect(txShareOfBlock([], 0)).toBeNull()
  })

  it('has a position but no share when the strip\'s gas sums to zero', () => {
    const zero: StripTx[] = [{ i: 0, gas: 0, price: 0, ok: true }, { i: 1, gas: 0, price: 0, ok: true }]
    expect(txShareOfBlock(zero, 1)).toEqual({ pos: 1, pct: null })
  })
})

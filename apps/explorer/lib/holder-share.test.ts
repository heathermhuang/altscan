import { describe, expect, it } from 'vitest'
import { bpText, holderShares, holderStripTiles, holdersLegend, holdersSummary } from '@/lib/holder-share'
import { legendLines } from '@/components/tape/legend-lines'

const SUPPLY = '1000000000000000000000' // 1,000 tokens of 18 decimals
const tok = (n: number) => (BigInt(n) * 10n ** 18n).toString()

describe('holderShares', () => {
  it('is null when there is no usable supply: a share of nothing is not 0%', () => {
    for (const s of [null, undefined, '', '0', 'x', '-5']) expect(holderShares([tok(1)], s), String(s)).toBeNull()
  })

  it('gives each holder\'s share in basis points, floored: the same figure the table prints', () => {
    const s = holderShares([tok(250), tok(125), '3333333333333333333'], SUPPLY)!
    expect(s.bp).toEqual([2500, 1250, 33])   // 0.33% (0.3333...), floored, not rounded
    expect(bpText(s.bp[2])).toBe('0.33%')
    expect(bpText(2500)).toBe('25.00%')
  })

  it('keeps finer shares for the widths (parts per million), so a 0.004% holder is not zero', () => {
    const s = holderShares([tok(1), '40000000000000000'], SUPPLY)!   // 0.1% and 0.004%
    expect(s.bp).toEqual([10, 0])
    expect(s.ppm).toEqual([1000, 40])
  })

  it('"the rest" is exactly the supply the holders do not hold', () => {
    const s = holderShares([tok(250), tok(125)], SUPPLY)!
    expect(s.restPpm).toBe(625_000)
    expect(s.topBp).toBe(3750)
  })

  it('has no "rest" when the holders add up to more than the supply (a stale supply), rather than a negative one', () => {
    const s = holderShares([tok(700), tok(400)], SUPPLY)!
    expect(s.restPpm).toBe(0)
    expect(s.topBp).toBe(11000)
  })

  it('reads an unparseable balance as no share (null in bp, 0 width), not a throw', () => {
    const s = holderShares([tok(100), 'not-a-number'], SUPPLY)!
    expect(s.bp).toEqual([1000, null])
    expect(s.ppm).toEqual([100_000, 0])
    expect(bpText(null)).toBe('—')
  })
})

describe('holderStripTiles', () => {
  const rows = [
    { addr: '0xAbCdEf0000000000000000000000000000000001', name: 'Binance 8', amount: '250' },
    { addr: '0x0000000000000000000000000000000000000002', name: '0x0000…00002', amount: '125' },
  ]
  const shares = holderShares([tok(250), tok(125)], SUPPLY)!
  const tiles = holderStripTiles(rows, shares, 'USDT')

  it('is one tile per holder, in rank order, then one "others" tile', () => {
    expect(tiles.map(t => t.id)).toEqual([
      '/address/0xabcdef0000000000000000000000000000000001',
      '/address/0x0000000000000000000000000000000000000002',
      'rest',
    ])
    expect(tiles.map(t => t.w)).toEqual([250_000, 125_000, 625_000])
  })

  it('links a holder tile to its address by the same lowercase href the table row carries (that is what pairs them)', () => {
    expect(tiles[0].href).toBe('/address/0xabcdef0000000000000000000000000000000001')
    expect(tiles[2].href).toBeUndefined()
    expect(tiles[2].rest).toBe(true)
  })

  it('reads the rank, name, share and amount on hover, and the rest\'s share', () => {
    expect(tiles[0].read).toBe('#1 Binance 8 · 25.00% of supply · 250 USDT')
    expect(tiles[2].read).toBe('Everyone else · 62.50% of supply')
    expect(tiles[0].name).toBe('Holder 1: Binance 8')
  })

  it('has no fill measure: every holder tile is solid', () => {
    expect(tiles.map(t => t.f)).toEqual([100, 100, 0])
  })

  it('gives a holder under 1 ppm a weight of 1, never 0 (the CSS floor keeps it visible, the flex share must stay positive)', () => {
    const tiny = holderShares([tok(1)], '1000000000000000000000000000')!   // 1e-9 of supply
    expect(holderStripTiles([rows[0]], tiny, 'X')[0].w).toBe(1)
  })

  it('draws no "others" tile when there is nothing left over', () => {
    const all = holderShares([tok(700), tok(400)], SUPPLY)!
    expect(holderStripTiles(rows, all, 'USDT').map(t => t.id)).not.toContain('rest')
  })
})

describe('holders text', () => {
  const shares = holderShares([tok(250), tok(125)], SUPPLY)!

  it('summarises for a screen reader: how many, how much, who is largest', () => {
    expect(holdersSummary(2, shares, 'moralis')).toBe(
      'The top 2 holders hold 37.5% of supply; the largest holds 25.00%. Real on-chain balances.',
    )
    expect(holdersSummary(2, shares, 'local')).toContain('Estimated from the net flow of recent transfers, not real balances.')
  })

  it('states the exact measure in the legend, and which kind of number it is', () => {
    expect(holdersLegend('moralis')).toBe('width = share of supply · others = the rest · real balances')
    expect(holdersLegend('local')).toBe('width = share of supply · others = the rest · estimated from transfers')
  })

  // The legend sits in a two-line slot (.tp-leg, 60px on a phone) and the estimate swaps for the live
  // holders over it; a legend that wraps to a third line in one state moves the table by a line.
  it('keeps both legends inside the two-line slot at 320px (39 mono columns)', () => {
    for (const s of ['moralis', 'local'] as const) expect(legendLines(holdersLegend(s)), s).toBeLessThanOrEqual(2)
  })
})

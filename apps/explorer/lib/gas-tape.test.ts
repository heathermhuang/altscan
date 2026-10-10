import { describe, expect, it } from 'vitest'
import { gasBasis, gasFills, gasLegend, gasStats, gasStripTiles, gasSummary, rowFromBlock, type GasTapeRow } from '@/lib/gas-tape'
import { legendLines } from '@/test-support/legend-lines'

const row = (n: number, txs: number, used: number, fee: number | null): GasTapeRow => ({ n, txs, used, fee })
// newest first, as the query returns them
const eth = [row(103, 150, 60, 800_000_000), row(102, 90, 40, 400_000_000), row(101, 0, 0, 200_000_000)]
const bnb = [row(103, 150, 60, 0), row(102, 90, 40, 0), row(101, 0, 0, null)]

describe('gasBasis: what the fill can honestly be', () => {
  it('is the base fee whenever a block in view has a positive one', () => {
    expect(gasBasis(eth)).toBe('base-fee')
    expect(gasBasis([row(1, 1, 1, null), row(2, 1, 1, 5)])).toBe('base-fee')
  })

  it('falls back to gas used where no block has a base fee (BNB reports 0, an old or unreadable block has none)', () => {
    expect(gasBasis(bnb)).toBe('gas-used')
    expect(gasBasis([])).toBe('gas-used')
  })
})

describe('gasFills', () => {
  it('scales the base fee to the highest in view, so one block\'s fill can be compared with another\'s', () => {
    expect(gasFills(eth, 'base-fee')).toEqual([100, 50, 25])
  })

  it('draws a block with no base fee as empty, not as the lowest fee', () => {
    expect(gasFills([row(2, 1, 1, 1000), row(1, 1, 1, null), row(0, 1, 1, 0)], 'base-fee')).toEqual([100, 0, 0])
  })

  it('a window whose base fees are all equal fills every block', () => {
    expect(gasFills([row(2, 1, 1, 7), row(1, 1, 1, 7)], 'base-fee')).toEqual([100, 100])
  })

  it('under the gas-used fallback the fill is the block\'s gas used, as a percent of its limit', () => {
    expect(gasFills(bnb, 'gas-used')).toEqual([60, 40, 0])
  })
})

describe('gasStripTiles', () => {
  const tiles = gasStripTiles(eth, 'base-fee')

  it('is one tile per block, oldest first (= left to right), linked to the block', () => {
    expect(tiles.map(t => t.href)).toEqual(['/blocks/101', '/blocks/102', '/blocks/103'])
    expect(tiles.every(t => t.id === undefined)).toBe(true)   // the href is unique, so it is the identity
    expect(tiles[0].name).toBe('Block 101')
  })

  it('weights by transactions, at least 1 (an empty block keeps a share), and fills by the base fee', () => {
    expect(tiles.map(t => t.w)).toEqual([1, 90, 150])
    expect(tiles.map(t => t.f)).toEqual([25, 50, 100])
  })

  it('reads transactions and the base fee in Gwei on hover (the name is the block)', () => {
    expect(tiles[2].read).toBe('150 txns · base fee 0.8 Gwei')
    const big = gasStripTiles([row(1_234_567, 3, 9, 1_000_000_000)], 'base-fee')[0]
    expect(big.name).toBe('Block 1,234,567')
    expect(big.read).toBe('3 txns · base fee 1 Gwei')
  })

  it('reads an unknown base fee as unknown, never as 0 Gwei, and draws it empty', () => {
    const t = gasStripTiles([row(103, 5, 10, 800_000_000), row(102, 5, 10, null)], 'base-fee')
    expect(t[0].read).toBe('5 txns · base fee unknown')
    expect(t[0].f).toBe(0)
    expect(t[1].read).toBe('5 txns · base fee 0.8 Gwei')
    expect(t.map(x => x.read).join()).not.toContain('0 Gwei')
  })

  it('does not call a real zero base fee unknown (it is a reading)', () => {
    const t = gasStripTiles([row(103, 5, 10, 800_000_000), row(102, 5, 10, 0)], 'base-fee')
    expect(t[0].read).toBe('5 txns · base fee 0 Gwei')
  })

  it('under the fallback it reads gas used, so the readout never claims a base fee that is not there', () => {
    const t = gasStripTiles(bnb, 'gas-used')
    expect(t[2].read).toBe('150 txns · gas used 60%')
    expect(t.map(x => x.f)).toEqual([0, 40, 60])
  })

  it('draws nothing for no blocks', () => {
    expect(gasStripTiles([], 'gas-used')).toEqual([])
  })
})

describe('gas strip text', () => {
  it('states the exact fill in the legend, and says when it is the fallback', () => {
    expect(gasLegend('base-fee')).toBe('width = transactions · fill = base fee, % of the highest here · newest at right')
    expect(gasLegend('gas-used')).toBe('width = transactions · fill = gas used, % of limit · newest at right')
  })

  it('keeps both legends inside the two-line slot at 320px, so hovering never changes the band\'s height', () => {
    for (const b of ['base-fee', 'gas-used'] as const) {
      const text = gasLegend(b)
      expect(text.length).toBeGreaterThan(40)
      expect(legendLines(text), text).toBeLessThanOrEqual(2)
    }
  })

  it('heads the band with the newest block and the base fee range, or says there is none', () => {
    expect(gasStats(eth, 'base-fee')).toEqual({ main: 'latest #103', side: 'base fee 0.2–0.8 Gwei' })
    expect(gasStats(bnb, 'gas-used')).toEqual({ main: 'latest #103', side: 'no base fee on this chain: fill is gas used' })
  })

  it('says so in the text alternative when the newest block\'s base fee is unknown, not "0 Gwei"', () => {
    const newestUnknown = [row(103, 5, 10, null), row(102, 5, 10, 800_000_000)]
    expect(gasSummary(newestUnknown, 'base-fee')).toContain('the newest, block 103, has no base fee reading.')
    expect(gasSummary(newestUnknown, 'base-fee')).not.toContain('was 0')
  })

  it('summarises for a screen reader with the same numbers the tiles carry', () => {
    expect(gasSummary(eth, 'base-fee')).toBe(
      'Base fee across the latest 3 blocks ran from 0.2 to 0.8 Gwei; the newest, block 103, was 0.8 Gwei. '
      + 'Each tile is a block: width is its transactions, fill is its base fee as a share of the highest in view.',
    )
    expect(gasSummary(bnb, 'gas-used')).toBe(
      'This chain has no base fee, so the fill is gas used: across the latest 3 blocks it ran from 0% to 60% of the gas limit. '
      + 'Each tile is a block: width is its transactions.',
    )
  })
})

describe('rowFromBlock', () => {
  it('turns a block row into plain numbers (no BigInt: the page cache cannot store one)', () => {
    const r = rowFromBlock({
      number: 7, txCount: 12, gasUsed: 15_000_000n, gasLimit: 30_000_000n, baseFeePerGas: '1000000000',
    })
    expect(r).toEqual({ n: 7, txs: 12, used: 50, fee: 1_000_000_000 })
    expect(JSON.stringify(r)).toBeTruthy()
  })

  it('keeps a missing base fee as null and a zero one as 0', () => {
    const base = { number: 1, txCount: 0, gasUsed: 0n, gasLimit: 1n }
    expect(rowFromBlock({ ...base, baseFeePerGas: null }).fee).toBeNull()
    expect(rowFromBlock({ ...base, baseFeePerGas: '0' }).fee).toBe(0)
  })
})

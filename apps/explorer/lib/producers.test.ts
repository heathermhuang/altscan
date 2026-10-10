import { describe, expect, it } from 'vitest'
import { producerLegend, producerStrip, producerSummary, type ProducerInput } from '@/lib/producers'
import { legendLines } from '@/components/tape/legend-lines'

const E18 = 10n ** 18n
const v = (n: number, power: bigint | null, name = `Val ${n}`): ProducerInput => ({
  address: `0xAA${String(n).padStart(38, '0')}`, name, power,
})
// ranked by voting power, as the table is
const vals = [v(1, 400n * E18), v(2, 200n * E18), v(3, 100n * E18), v(4, 50n * E18)]
const counts = (o: Record<number, number>, extra: Record<string, number> = {}) =>
  new Map<string, number>([
    ...Object.entries(o).map(([n, c]) => [v(Number(n), 0n).address.toLowerCase(), c] as [string, number]),
    ...Object.entries(extra),
  ])

describe('producerStrip', () => {
  it('is null when the count query failed (null): an unknown is not a strip of zeros', () => {
    expect(producerStrip(vals, null, 'BNB')).toBeNull()
  })

  it('is null when no listed validator produced a block', () => {
    expect(producerStrip(vals, new Map(), 'BNB')).toBeNull()
  })

  it('draws one tile per validator that produced a block, in the table\'s order, and skips the ones that did not', () => {
    const s = producerStrip(vals, counts({ 1: 30, 3: 10, 4: 0 }), 'BNB')!
    expect(s.tiles.map(t => t.name)).toEqual(['Val 1', 'Val 3'])
    expect(s.producing).toBe(2)
    expect(s.total).toBe(4)
  })

  it('width is the blocks produced', () => {
    const s = producerStrip(vals, counts({ 1: 30, 2: 20, 3: 10 }), 'BNB')!
    expect(s.tiles.map(t => t.w)).toEqual([30, 20, 10])
  })

  it('fill is voting power as a share of the largest tile\'s, so tiles compare', () => {
    const s = producerStrip(vals, counts({ 1: 30, 2: 20, 3: 10, 4: 5 }), 'BNB')!
    expect(s.tiles.map(t => t.f)).toEqual([100, 50, 25, 13])   // 50/400 = 12.5 rounds to 13
    expect(s.fillKnown).toBe(true)
  })

  it('scales to the largest validator IN VIEW: the top-ranked one not producing does not shrink everyone', () => {
    const s = producerStrip(vals, counts({ 2: 20, 3: 10 }), 'BNB')!
    expect(s.tiles.map(t => t.f)).toEqual([100, 50])
  })

  it('has no fill when every voting power is unknown (the ValidatorSet fallback): solid tiles, and it says so', () => {
    const unknown = [v(1, null), v(2, null)]
    const s = producerStrip(unknown, counts({ 1: 3, 2: 1 }), 'BNB')!
    expect(s.fillKnown).toBe(false)
    expect(s.tiles.map(t => t.f)).toEqual([100, 100])
    expect(producerLegend(false)).toBe('width = blocks produced, last 24h · voting power unknown right now')
  })

  it('draws a stake-less validator (power 0) with an empty fill and an unknown one with none either', () => {
    const mixed = [v(1, 100n * E18), v(2, 0n), v(3, null)]
    const s = producerStrip(mixed, counts({ 1: 3, 2: 2, 3: 1 }), 'BNB')!
    expect(s.tiles.map(t => t.f)).toEqual([100, 0, 0])
    expect(s.tiles[2].read).toContain('voting power unknown')
  })

  it('pairs each tile with its table row by the same lowercase /address/ link', () => {
    const s = producerStrip(vals, counts({ 1: 1 }), 'BNB')!
    expect(s.tiles[0].href).toBe(`/address/${v(1, 0n).address.toLowerCase()}`)
    expect(s.tiles[0].id).toBe(s.tiles[0].href)
  })

  it('reads name, blocks, share of the window\'s blocks and voting power on hover', () => {
    const s = producerStrip(vals, counts({ 1: 30, 2: 70 }), 'BNB')!
    expect(s.tiles[0].read).toBe('Val 1 · 30 blocks · 30.0% of the 100 in the window · voting power 400 BNB')
    expect(s.tiles[1].read).toBe('Val 2 · 70 blocks · 70.0% of the 100 in the window · voting power 200 BNB')
  })

  it('counts blocks by miners that are not in the list too: they are in the window, so shares are of ALL its blocks', () => {
    const s = producerStrip(vals, counts({ 1: 30 }, { '0xdead': 70 }), 'BNB')!
    expect(s.windowBlocks).toBe(100)
    expect(s.unlisted).toBe(70)
    expect(s.tiles[0].read).toContain('30.0% of the 100 in the window')
  })

  it('says "1 block", not "1 blocks"', () => {
    expect(producerStrip(vals, counts({ 1: 1, 2: 99 }), 'BNB')!.tiles[0].read).toContain('· 1 block ·')
  })
})

describe('producer text', () => {
  it('states the exact measures in the legend', () => {
    expect(producerLegend(true)).toBe('width = blocks produced, last 24h · fill = voting power vs the largest')
  })

  it('keeps every legend inside the two-line slot at 320px', () => {
    for (const k of [true, false]) {
      const text = producerLegend(k)
      expect(text.length).toBeGreaterThan(40)
      expect(legendLines(text), text).toBeLessThanOrEqual(2)
    }
  })

  it('summarises for a screen reader, including blocks the list cannot attribute', () => {
    const s = producerStrip(vals, counts({ 1: 30, 2: 20 }, { '0xdead': 50 }), 'BNB')!
    expect(producerSummary(s)).toBe(
      '2 of 4 validators produced blocks in the last 24 hours (100 blocks counted); the most was Val 1 with 30. '
      + '50 of the blocks came from addresses that are not in this list. '
      + 'Each tile is a validator in table order: width is its blocks, fill is its voting power against the largest shown.',
    )
  })

  it('leaves the fill out of the summary when voting power is unknown', () => {
    const s = producerStrip([v(1, null)], counts({ 1: 5 }), 'BNB')!
    expect(producerSummary(s)).toContain('Each tile is a validator in table order: width is its blocks. Voting power is unknown right now.')
  })
})

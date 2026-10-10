import { describe, expect, it } from 'vitest'
import { producerLegend, producerStrip, producerSummary, type ProducerInput } from '@/lib/producers'
import { legendLines } from '@/test-support/legend-lines'
import { shortenAddress } from '@/lib/address-display'
import { validatorDisplays, type ValidatorRow } from '@/lib/validator-display'

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
    expect(producerLegend(false)).toBe('width = blocks produced, 24h · voting power unknown right now')
  })

  it('draws a stake-less validator (power 0) with an empty fill and an unknown one with none either', () => {
    const mixed = [v(1, 100n * E18), v(2, 0n), v(3, null)]
    const s = producerStrip(mixed, counts({ 1: 3, 2: 2, 3: 1 }), 'BNB')!
    expect(s.tiles.map(t => t.f)).toEqual([100, 0, 0])
    expect(s.tiles[2].read).toContain('power unknown')
  })

  it('pairs each tile with its table row by the same lowercase /address/ link', () => {
    const s = producerStrip(vals, counts({ 1: 1 }), 'BNB')!
    expect(s.tiles[0].href).toBe(`/address/${v(1, 0n).address.toLowerCase()}`)
    expect(s.tiles[0].id).toBeUndefined()   // the strip keys a linked tile on its href: nothing to send twice
  })

  it('is the name, then blocks, share of the window\'s blocks and voting power (the strip says name · read)', () => {
    const s = producerStrip(vals, counts({ 1: 30, 2: 70 }), 'BNB')!
    expect(s.tiles.map(t => t.name)).toEqual(['Val 1', 'Val 2'])
    expect(s.tiles[0].read).toBe('30 blocks (30.0%) · power 400 BNB')
    expect(s.tiles[1].read).toBe('70 blocks (70.0%) · power 200 BNB')
    expect(s.tiles[0].read).not.toContain('Val 1')   // the name is not sent twice
  })

  // The readout replaces the legend in a two-line slot (60px on a phone, 39 columns at 320px). One that wraps
  // to a third line made the whole band, and the page under it, jump 18px on hover (found by the 320px gate).
  it('keeps the readout inside the two-line slot at 320px even for the longest realistic row', () => {
    const long = [v(1, 123_456_789_012n * E18, 'N'.repeat(60)), v(2, null, 'M'.repeat(60))]
    const s = producerStrip(long, counts({ 1: 191_999, 2: 1 }), 'BNB')!
    for (const t of s.tiles) {
      const said = `${t.name} · ${t.read}`   // what the legend line shows
      expect(legendLines(said), said).toBeLessThanOrEqual(2)
      expect(said.length).toBeGreaterThan(40)
    }
    expect(s.tiles[0].name).toBe(`${'N'.repeat(19)}…`)   // a moniker is anyone's to choose: clipped
  })

  it('counts blocks by miners that are not in the list too: they are in the window, so shares are of ALL its blocks', () => {
    const s = producerStrip(vals, counts({ 1: 30 }, { '0xdead': 70 }), 'BNB')!
    expect(s.windowBlocks).toBe(100)
    expect(s.unlisted).toBe(70)
    expect(s.tiles[0].read).toContain('30 blocks (30.0%)')   // 30 of the window's 100, not of the 30 listed
  })

  it('says "1 block", not "1 blocks"', () => {
    expect(producerStrip(vals, counts({ 1: 1, 2: 99 }), 'BNB')!.tiles[0].read).toContain('1 block (1.0%) ·')
  })
})

describe('producer text', () => {
  it('states the exact measures in the legend', () => {
    expect(producerLegend(true)).toBe('width = blocks produced, 24h · fill = voting power vs the largest shown')
  })

  it('keeps every legend inside the two-line slot at 320px', () => {
    for (const k of [true, false]) {
      const text = producerLegend(k)
      expect(text.length).toBeGreaterThan(40)
      expect(legendLines(text), text).toBeLessThanOrEqual(2)
    }
  })

  // The head stat, the list's name and the legend already say what a tile is and how it is measured, so the
  // text alternative carries only what they do not: the leader, the window's total, and blocks nobody listed.
  it('summarises for a screen reader with the facts the head, the name and the legend do not carry', () => {
    const s = producerStrip(vals, counts({ 1: 30, 2: 20 }, { '0xdead': 50 }), 'BNB')!
    expect(producerSummary(s)).toBe('Most blocks: Val 1, 30 of 100 counted. 50 came from addresses that are not in this list.')
  })

  it('has no clause about blocks nobody listed when every block is attributed, and is short', () => {
    const s = producerStrip(vals, counts({ 1: 30, 2: 20 }), 'BNB')!
    expect(producerSummary(s)).toBe('Most blocks: Val 1, 30 of 50 counted.')
  })
})

// Standby (lib/validator-display.ts) = an active validator that produced nothing in the window while the set did.
// The strip draws exactly the validators with a block, so a tile is never a Standby row and a Standby row has no tile.
describe('producerStrip agrees with the table\'s Standby rule', () => {
  const at = new Date('2026-10-10T00:00:00Z')
  const rows = (n: number): ValidatorRow[] => Array.from({ length: n }, (_, i) => ({
    address: `0xAA${String(i + 1).padStart(38, '0')}`, moniker: `Val ${i + 1}`, votingPower: String(BigInt(100 - i) * E18), status: 'active', updatedAt: at,
  }))
  const inputs = (r: ValidatorRow[]): ProducerInput[] => r.map((x, i) => ({ address: x.address, name: validatorDisplays(r)[i].name, power: BigInt(x.votingPower!) }))

  it('draws no tile for a Standby validator, and every validator without a tile that is active reads Standby', () => {
    const r = rows(5)
    const c = counts({ 1: 30, 2: 20, 4: 10 })        // validators 3 and 5 produced nothing while others did
    const display = validatorDisplays(r, c)
    const strip = producerStrip(inputs(r), c, 'BNB')!
    const drawn = new Set(strip.tiles.map(t => t.href))
    r.forEach((x, i) => {
      const hasTile = drawn.has(`/address/${x.address.toLowerCase()}`)
      expect(display[i].status.label === 'Standby', x.moniker ?? undefined).toBe(!hasTile)
    })
    expect(strip.tiles).toHaveLength(3)
  })

  it('when the counts are unknown (null) or nobody produced, there is no strip and nobody is Standby', () => {
    const r = rows(3)
    expect(producerStrip(inputs(r), null, 'BNB')).toBeNull()
    expect(validatorDisplays(r, null).some(d => d.status.label === 'Standby')).toBe(false)
    expect(producerStrip(inputs(r), new Map(), 'BNB')).toBeNull()
    expect(validatorDisplays(r, new Map()).some(d => d.status.label === 'Standby')).toBe(false)
  })
})

// A moniker is self-chosen, and an advert is not a name (lib/link-in-name.ts): the strip names such a validator by its
// short address, in the tile, the readout and the summary, as headlines do.
describe('producerStrip and a moniker that reads as a web address', () => {
  it('names the validator by its short address instead', () => {
    const bad = [v(1, 5n * E18, 'Stake at claim-bnb.xyz'), v(2, 4n * E18, '@stakewith_us'), v(3, 3n * E18, 'Figment')]
    const s = producerStrip(bad, counts({ 1: 30, 2: 20, 3: 10 }), 'BNB')!
    expect(s.tiles[0].name).toBe(shortenAddress(bad[0].address))
    expect(s.tiles[1].name).toBe(shortenAddress(bad[1].address))
    expect(s.tiles[2].name).toBe('Figment')
    expect(s.top.name).toBe(shortenAddress(bad[0].address))
    expect(JSON.stringify(s)).not.toMatch(/claim-bnb|stakewith/)
  })
})

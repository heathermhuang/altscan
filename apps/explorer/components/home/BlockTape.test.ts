import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BlockTape, readout } from './BlockTape'
import { encodeTape, type TapeTuple } from '@/lib/tape'

const tuples: TapeTuple[] = [[10, 1000, 2, 10], [11, 1001, 3, 20], [12, 1002, 4, 30]]
const draw = (t: TapeTuple[], props: { current?: number; heading?: string } = {}) =>
  renderToStaticMarkup(createElement(BlockTape, { tape: encodeTape(t), chainName: 'BNB Chain', ...props }))
const html = (props: { current?: number; heading?: string } = {}) => draw(tuples, props)

describe('BlockTape labels', () => {
  it('says "latest" with no heading (the homepage)', () => {
    const h = html()
    expect(h).toContain('aria-label="BNB Chain latest indexed blocks, ')
    expect(h).toContain('latest')
  })

  it('a heading alone (a cached page) replaces "latest #N" and does not claim "around this one"', () => {
    const h = html({ heading: 'as of 21:04 UTC' })
    expect(h).toContain('as of 21:04 UTC')
    expect(h).toContain('aria-label="BNB Chain recent indexed blocks, ')
    expect(h).not.toContain('latest')
  })

  it('a current block (the block page) keeps "around this one"', () => {
    expect(html({ current: 11, heading: 'around #11' })).toContain('aria-label="BNB Chain indexed blocks around this one, ')
  })

  it('names the encoding in the list\'s accessible name, in every variant', () => {
    for (const props of [{}, { heading: 'as of 21:04 UTC' }, { current: 11, heading: 'around #11' }]) {
      expect(html(props)).toContain('width is transactions, fill is gas used"')
    }
  })
})

describe('BlockTape legend', () => {
  it('states the new encoding: width = transactions, fill = gas used, newest on the right', () => {
    const h = html()
    expect(h).toContain('width = transactions · fill = gas used · newest on the right')
  })

  it('no longer claims width is block time anywhere', () => {
    for (const props of [{}, { current: 11 }]) expect(html(props).toLowerCase()).not.toContain('block time')
  })

  it('adds the ring to the legend only when a block is ringed', () => {
    expect(html()).not.toContain('ringed')
    expect(html({ current: 11 })).toContain('width = transactions · fill = gas used · ringed = this block · newest at right')
  })

  // The legend sits in `.tp-leg`, two lines tall (min-h 60px) on a phone, and hovering or focusing a tile swaps
  // in a one-line readout. A legend that wraps to 3 lines at 320px (288px of content = 40 mono glyphs of 7.2px)
  // makes the band, and everything below it, jump 18px on that swap. 39 columns leaves a glyph of sub-pixel slack;
  // a trailing "·" that does not fit moves to the next line, as it does in the browser.
  const legendOf = (h: string) => h.match(/<p data-readout[^>]*>([^<]*)<\/p>/)![1]
  const lines = (text: string, cols: number) => {
    let n = 1, used = 0
    for (const word of text.split(' ')) {
      if (used === 0) used = word.length
      else if (used + 1 + word.length <= cols) used += 1 + word.length
      else { n++; used = word.length }
    }
    return n
  }

  it('both legends fit two lines at 320px, so the hover / focus swap to the readout never changes the band\'s height', () => {
    for (const props of [{}, { heading: 'as of 21:04 UTC' }, { current: 11 }]) {
      const text = legendOf(html(props))
      expect(text.length).toBeGreaterThan(40)   // it does wrap, so the check below means something
      expect(lines(text, 39), text).toBeLessThanOrEqual(2)
    }
  })

  it('the wrap model sees the 3-line legend this replaced', () => {
    expect(lines('width = transactions · fill = gas used · ringed = this block · newest on the right', 39)).toBe(3)
  })
})

describe('readout (hover / focus)', () => {
  it('gives the number, transactions and gas, with no per-block time (BNB blocks share whole seconds, so it would be invented)', () => {
    expect(readout({ n: 126146244, txs: 57, gas: 12 })).toBe('#126,146,244 · 57 txns · gas 12%')
    expect(readout({ n: 7, txs: 0, gas: 0 })).toBe('#7 · 0 txns · gas 0%')
  })
})

describe('BlockTape tiles', () => {
  it('draws one tile per block, oldest first, weighted by transactions and filled by gas', () => {
    const h = html()
    expect(h.match(/<li /g)).toHaveLength(3)
    const w = [...h.matchAll(/--w:(\d+);--f:(\d+)%/g)].map(m => [+m[1], +m[2]])
    expect(w).toEqual([[2, 10], [3, 20], [4, 30]])
    expect(h.indexOf('/blocks/10"')).toBeLessThan(h.indexOf('/blocks/12"'))
  })

  it('draws every block it is given, including the oldest (nothing is spent anchoring a timeline)', () => {
    expect(draw([[10, 1000, 2, 10], [11, 1000, 3, 20]]).match(/<li /g)).toHaveLength(2)
    expect(draw([[10, 1000, 2, 10]]).match(/<li /g)).toHaveLength(1)
  })

  it('keeps an empty block in the layout with weight 1', () => {
    expect(draw([[10, 1000, 0, 0], [11, 1001, 9, 5]])).toContain('--w:1;--f:0%')
  })

  it('has no lead-in ghost cells and no fade: every cell is a real block', () => {
    const h = html({ current: 11 })
    expect(h).not.toContain('ghost')
    expect(h).not.toContain('fade')
    expect(h).not.toContain('aria-hidden="true" class="bt-')
  })

  it('has no per-tile label text (a tile is a few px wide); the link is named by its number', () => {
    const h = html()
    expect(h).toContain('aria-label="Block 11"')
    expect(h).not.toContain('<span>#')
  })

  it('uses the shared tape primitives', () => {
    const h = html({ current: 11 })
    for (const c of ['tp-box', 'tp-head', 'tp-dot', 'tp-stats', 'tp-track', 'tp-cur', 'tp-row tp-gap', 'tp-leg']) expect(h).toContain(c)
    expect(h).not.toMatch(/class="bt-(box|head|track|row|leg)/)
  })
})

describe('BlockTape ringed block and its label', () => {
  it('rings one tile, makes it the tab stop, and gives it a label in the track', () => {
    const h = html({ current: 11 })
    expect(h.match(/aria-current="true"/g)).toHaveLength(1)
    expect(h).toContain('class="c"')
    expect(h.match(/tabindex="0"/g)).toHaveLength(1)
    expect(h).toMatch(/<li class="c"[^>]*><a href="\/blocks\/11" tabindex="0" aria-current="true"/)
    expect(h).toMatch(/<span class="tp-chip bt-chip"[^>]*aria-hidden="true">#11<\/span>/)
  })

  it('without a current block the newest tile is the tab stop and there is no label or ring', () => {
    const h = html()
    expect(h).toMatch(/<a href="\/blocks\/12" tabindex="0"/)
    expect(h).not.toContain('tp-chip')
    expect(h).not.toContain('aria-current')
  })

  // Two reference tracks, from the tiles' flexbox (lib/tape.ts layoutTiles): --p-sm at the 343px content of a 375px
  // phone, --p at the 1248px content of a 1440px desktop; the CSS picks one at the sm breakpoint.
  const ps = (h: string) => ({ sm: +h.match(/--p-sm:([\d.]+)/)![1], lg: +h.match(/--p:([\d.]+)/)![1] })

  it('places the label at the tile\'s fraction of the track, at two reference widths, from the tiles\' weights and floors', () => {
    // weights 2 | 3 | 4: the centres by flexbox (2px gaps) are 37.67 / 133.83 / 267.67 of 343 and 138.2 / 485.7 / 971.5 of 1248
    const near = (h: string, sm: number, lg: number) => { expect(ps(h).sm).toBeCloseTo(sm, 3); expect(ps(h).lg).toBeCloseTo(lg, 3) }
    near(html({ current: 10 }), 0.1098, 0.1107)
    near(html({ current: 11 }), 0.3902, 0.3892)
    near(html({ current: 12 }), 0.7804, 0.7784)
  })

  it('puts the label over the tile when floors engage, not at its share of the weight (Codex fixture: 24 one-tx tiles before the ring)', () => {
    const tx = (k: number) => (k <= 24 ? 1 : 100)   // the ringed tile (k = 24) and everything older: 1 tx; the 6 newer: 100
    const tuples: TapeTuple[] = Array.from({ length: 31 }, (_, k) => [1000 + k, 5000 + k, tx(k), 10])
    const h = draw(tuples, { current: 1024 })
    expect(ps(h).sm).toBeCloseTo(97.5 / 343, 3)    // 96px of floored tiles and gaps + half the 3px ringed tile
    expect(ps(h).lg).toBeCloseTo(97.5 / 1248, 3)
    expect(ps(h).sm).toBeGreaterThan(0.25)          // by weight alone it was 0.04
  })

  it('emits the two vars on the ringed label only, nothing per tile', () => {
    const h = html({ current: 11 })
    expect(h.match(/--p-sm:/g)).toHaveLength(1)
    expect(h.match(/--p:/g)).toHaveLength(1)
    expect(h).toMatch(/<span class="tp-chip bt-chip" style="--p-sm:[\d.]+;--p:[\d.]+"/)
  })

  it('keeps both inside 0..1 for a ringed tile at either end of a lopsided tape', () => {
    const first = draw([[1, 1, 1, 0], [2, 2, 500, 0], [3, 3, 500, 0]], { current: 1 })
    const last = draw([[1, 1, 500, 0], [2, 2, 500, 0], [3, 3, 1, 0]], { current: 3 })
    for (const h of [first, last]) for (const v of Object.values(ps(h))) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1) }
    expect(ps(first).sm).toBeLessThan(0.02)
    expect(ps(last).sm).toBeGreaterThan(0.98)
  })

  it('ignores a current block that is not on the tape: no ring, no label', () => {
    const h = html({ current: 99 })
    expect(h).not.toContain('aria-current')
    expect(h).not.toContain('tp-chip')
    expect(h).not.toContain('tp-cur')
  })
})

describe('BlockTape empty', () => {
  it('says so, and draws no tiles', () => {
    const h = renderToStaticMarkup(createElement(BlockTape, { tape: '', chainName: 'BNB Chain' }))
    expect(h).toContain('No indexed blocks yet')
    expect(h).not.toContain('<li')
  })
})

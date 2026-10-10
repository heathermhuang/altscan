import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TileStrip } from './TileStrip'
import type { StripTile } from '@/lib/tape'

const tiles: StripTile[] = [
  { id: '/address/0xa', href: '/address/0xa', w: 30, f: 100, name: 'Alpha', read: 'Alpha · 30' },
  { id: '/address/0xb', href: '/address/0xb', w: 0, f: 0, name: 'Beta', read: 'Beta · not priced', hatch: true },
  { id: '/address/0xc', href: '/address/0xc', w: 10, f: 40, name: 'Gamma', read: 'Gamma · 10' },
  { id: 'rest', w: 60, f: 0, name: 'All other holders', read: 'Everyone else', rest: true },
]
const draw = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(TileStrip, {
    tiles, title: 'Test strip', stats: { main: '3 things', side: 'of 4' },
    label: 'Test strip, width is size', legend: 'width = size', summary: 'Three things and the rest.', ...props,
  } as never))

describe('TileStrip markup', () => {
  it('is drawn from the shared tape primitives, not a second system', () => {
    const h = draw()
    for (const c of ['tp-box', 'tp-head', 'tp-dot', 'tp-stats', 'tp-rate', 'tp-track', 'tp-row tp-gap', 'tp-leg']) expect(h, c).toContain(c)
    expect(h).not.toMatch(/class="(bt|bs|ldg)-/)
  })

  it('is one li per tile, with width and fill as CSS variables and nothing else per tile', () => {
    const h = draw()
    expect(h.match(/<li /g)).toHaveLength(4)
    expect([...h.matchAll(/--w:(\d+);--f:(\d+)%/g)].map(m => [+m[1], +m[2]])).toEqual([[30, 100], [0, 0], [10, 40], [60, 0]])
  })

  it('marks a hatched tile and the remainder tile by class, for the CSS', () => {
    const h = draw()
    expect(h).toMatch(/<li class="h" style="--w:0;--f:0%">/)
    expect(h).toMatch(/<li class="r" style="--w:60;--f:0%">/)
  })

  it('is ONE tab stop: the first linked tile, and never the remainder', () => {
    const h = draw()
    expect(h.match(/tabindex="0"/g)).toHaveLength(1)
    expect(h.match(/tabindex="-1"/g)).toHaveLength(2)
    expect(h).toMatch(/<a href="\/address\/0xa" tabindex="0" aria-label="Alpha">/)
  })

  it('can enter at the newest (last) tile instead', () => {
    expect(draw({ entry: 'last' })).toMatch(/<a href="\/address\/0xc" tabindex="0" aria-label="Gamma">/)
  })

  it('draws the remainder as a named image, not a link', () => {
    const h = draw()
    expect(h).toMatch(/<li class="r"[^>]*><i role="img" aria-label="All other holders"><\/i><\/li>/)
    expect(h.match(/<a /g)).toHaveLength(3)
  })

  it('names the encoding on the list and points it at a text alternative', () => {
    const h = draw()
    expect(h).toContain('role="list"')
    expect(h).toContain('aria-label="Test strip, width is size"')
    const id = h.match(/aria-describedby="([^"]+)"/)![1]
    expect(h).toContain(`<p id="${id}" class="sr-only">Three things and the rest.</p>`)
  })

  it('puts the legend in a polite live region, where the hover / focus readout replaces it', () => {
    expect(draw()).toMatch(/<p data-readout="true" aria-live="polite">width = size<\/p>/)
  })

  it('heads the band with the title and its stats; the second stat is the one phones drop (tp-rate)', () => {
    const h = draw()
    expect(h).toContain('<span class="text-ink truncate">Test strip</span>')
    expect(h).toMatch(/<span class="tp-stats"><span>3 things<\/span><span class="tp-rate">of 4<\/span><\/span>/)
  })

  it('marks the list for the shared tape scripts', () => {
    expect(draw()).toContain('data-tape')
  })

  it('inside a card (bare) it has no band of its own, only a rule under it', () => {
    const h = draw({ bare: true })
    expect(h).not.toContain('tp-box')
    expect(h).toMatch(/^<div class="border-b border-hair">/)
  })

  it('draws nothing for no tiles', () => {
    expect(draw({ tiles: [] })).toBe('')
  })

  it('does not leak the table link id into the markup', () => {
    expect(draw({ rowsId: 'holders-rows' })).not.toContain('holders-rows')
  })
})

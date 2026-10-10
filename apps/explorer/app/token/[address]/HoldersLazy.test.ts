import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { HoldersResult } from '@/lib/holders'
import { HoldersLazy } from './HoldersLazy'

// HoldersLazy swaps the SSR estimate for the live holders after mount. The swap must change
// values, not height (CLS 0.19 on USDT): the note slot above the rows exists in both states with
// the same box, and both notes sit in it, the one not shown `invisible`, so the slot is as tall as
// the longer note at every width.
const holders = (n: number) => Array.from({ length: n }, (_, i) => ({ addr: '0x' + (i + 1).toString(16).padStart(40, '0'), balance: '1000000' }))
const render = (initial: HoldersResult) =>
  renderToStaticMarkup(createElement(HoldersLazy, { address: '0xabc', symbol: 'USDT', decimals: 6, totalSupply: '100000000', initial }))

const local = render({ holders: holders(3), holderCount: null, source: 'local' })
const live = render({ holders: holders(3), holderCount: 42, source: 'moralis' })
const slot = (html: string) => html.match(/<div class="flex items-start gap-2 px-4 py-2 [^"]*">/)?.[0] ?? ''

describe('HoldersLazy note slot', () => {
  it('renders the slot in both states, with the same box and a different tone', () => {
    const box = (s: string) => s.replace(/bg-warn-t border-l-warn|bg-canvas border-l-hair3/, '')
    expect(slot(local)).toContain('bg-warn-t border-l-warn')
    expect(slot(live)).toContain('bg-canvas border-l-hair3')
    expect(box(slot(local))).not.toBe('')
    expect(box(slot(live))).toBe(box(slot(local)))
  })

  it('holds both notes in both states, hiding the one not shown', () => {
    for (const html of [local, live]) {
      expect(html).toContain('most recent 10,000 transfers')
      expect(html).toContain('as reported by Moralis')
      expect(html.match(/ invisible"/g)).toHaveLength(1)
    }
    expect(local).toMatch(/invisible">Real on-chain balances/)
    expect(live).toMatch(/invisible">Estimated from the net flow/)
  })
})

describe('HoldersLazy header count', () => {
  it('labels the provider total as holders (Moralis), not a bare "total"', () => {
    expect(live).toContain('42 holders (Moralis)')
    expect(live).not.toContain('(42 total)')
    // The estimate has no count to label.
    expect(local).not.toMatch(/holders \(Moralis\)/)
  })
})

// The header is one line in both states: the Moralis total takes the place of "Estimated from recent
// transfers" on the right, so the swap does not re-wrap it on a phone (CLS gate, 412 px: 0.0048 vs 0.0010).
describe('HoldersLazy header shape', () => {
  const heading = (html: string) => html.match(/<h2[^>]*>(.*?)<\/h2>/)?.[1]
  it('keeps the title short and puts the count on the right', () => {
    expect(heading(local)).toBe('Top Holders')
    expect(heading(live)).toBe('Top Holders')
    expect(live).toContain('<span class="text-[11px] text-mut">42 holders (Moralis)</span>')
    expect(local).toContain('<span class="text-[11px] text-mut">Estimated from recent transfers</span>')
  })
})

// The top-holders strip sits in the same card as the table, from the same holders and the same shares.
describe('HoldersLazy strip', () => {
  const draw = (initial: HoldersResult, totalSupply: string | null = '100000000') =>
    renderToStaticMarkup(createElement(HoldersLazy, { address: '0xabc', symbol: 'USDT', decimals: 6, totalSupply, initial }))
  const tiles = (html: string) => [...html.matchAll(/<li( class="r")? style="--w:(\d+);--f:(\d+)%">/g)].map(m => ({ rest: !!m[1], w: +m[2], f: +m[3] }))

  it('draws one tile per holder (width = ppm of supply) and one for everyone else, in the card, in both states', () => {
    for (const html of [local, live]) {
      // 3 holders x 1,000,000 of a 100,000,000 supply: 1% each, the other 97% is "others"
      expect(tiles(html)).toEqual([
        { rest: false, w: 10_000, f: 100 }, { rest: false, w: 10_000, f: 100 }, { rest: false, w: 10_000, f: 100 },
        { rest: true, w: 970_000, f: 0 },
      ])
      expect(html).toContain('id="holders-rows"')
    }
  })

  it('names the measure and which kind of balance it is, per state', () => {
    expect(local).toContain('width = share of supply · others = the rest · estimated from transfers')
    expect(live).toContain('width = share of supply · others = the rest · real balances')
  })

  it('has the same box in both states: same primitives, same stats, one tab stop each (the swap must not move the table)', () => {
    const shape = (html: string) => html.replace(/<p id="[^"]*" class="sr-only">[^<]*<\/p>/, '').match(/<div class="border-b border-hair">.*?<div class="tp-leg">/s)![0]
      .replace(/aria-describedby="[^"]*"/, '').replace(/estimated|real balances/g, 'X')
    expect(shape(local)).toBe(shape(live))
    for (const html of [local, live]) expect(html.match(/tabindex="0"/g)).toHaveLength(1)
  })

  it('shows the table the very same share as the strip\'s text alternative states for the largest holder', () => {
    expect(live).toContain('<td class="text-mut">1.00%</td>')
    expect(live).toContain('the largest holds 1.00%.')
  })

  it('draws no strip when the supply is unknown: a share of nothing is not 0%', () => {
    for (const s of [null, '0']) {
      const html = draw({ holders: holders(3), holderCount: null, source: 'local' }, s)
      expect(html).not.toContain('tp-row')
      expect(html).toContain('—')
    }
  })

  // The strip and the table are one list: after the holder-count labelling (lib/holder-labels.ts) nothing changed about
  // which rows both read.
  it('reads exactly the rows the table shows, in the same order, in both states', () => {
    for (const html of [local, live]) {
      const strip = html.match(/<div class="border-b border-hair">.*?<div class="tp-leg">/s)![0]
      const stripHrefs = [...strip.matchAll(/<a href="([^"]+)"/g)].map(m => m[1])
      const table = html.slice(html.indexOf('<tbody>'))
      const rowHrefs = [...table.matchAll(/<tr><td[^>]*>\d+<\/td><td><span class="sm:hidden"><a [^>]*href="([^"]+)"/g)].map(m => m[1])
      expect(stripHrefs).toHaveLength(3)
      expect(stripHrefs).toEqual(rowHrefs)
    }
  })

  // tokens.holder_count is a frozen snapshot and the provider total is cached (lib/holder-labels.ts): the header and the
  // Holders fact label them. The strip is about the rows and their shares of supply, and must not restate either count.
  it('never presents a holder count (indexed or provider) in its name, summary, head or legend', () => {
    for (const html of [local, live]) {
      const strip = html.match(/<div class="border-b border-hair">.*?<div class="tp-leg">.*?<\/div><\/div>/s)![0]
      expect(strip).not.toMatch(/\btotal\b|indexed|Moralis|holders \(|\b42\b|4,200/)
      expect(strip).toMatch(/Top 3 holders/)   // it counts the rows it draws, not the token's holders
    }
    // while the header, outside the strip, carries the labelled provider total
    expect(live).toContain('42 holders (Moralis)')
  })

  it('links each tile to its holder by the same href as the table row (that is how they pair)', () => {
    const addr = '0x' + '1'.padStart(40, '0')
    expect(live).toContain(`<a href="/address/${addr}" tabindex="0"`)
    expect(live.match(new RegExp(`href="/address/${addr}"`, 'g'))!.length).toBeGreaterThanOrEqual(2)
  })
})

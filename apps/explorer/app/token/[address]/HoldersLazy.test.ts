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

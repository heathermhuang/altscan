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

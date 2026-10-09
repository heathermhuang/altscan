import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AddressLedger, AddressLedgerShell } from './AddressLedger'
import type { LedgerRow } from '@/lib/ledger'

const rows: LedgerRow[] = [
  { t: 100, dir: 'in', native: true, spam: false },
  { t: 101, dir: 'out', native: false, spam: false },
  { t: 104, dir: 'out', native: false, spam: true },
]
const html = (r: LedgerRow[]) => renderToStaticMarkup(createElement(AddressLedger, { rows: r, currency: 'BNB' }))

describe('AddressLedger', () => {
  it('draws one tile per row: direction, solid vs outlined, spam, width by gap', () => {
    const h = html(rows)
    expect(h.match(/<i /g)).toHaveLength(3)
    expect(h).toContain('class="in" style="--w:1"')
    expect(h).toContain('class="out o" style="--w:2"')
    expect(h).toContain('class="out o s" style="--w:3"')   // 1 + log2(1 + 3)
  })
  it('states the totals and the span, and is one labelled image', () => {
    const h = html(rows)
    expect(h).toContain('▲ 1 received · ▼ 2 sent')
    expect(h).toContain('over 4 seconds')
    expect(h).toContain('role="img"')
    expect(h).toContain('aria-label="3 transactions over 4 seconds: 1 received, 2 sent"')
    expect(h).toContain('solid = BNB')
  })
  it('draws nothing for fewer than 2 rows', () => {
    expect(html(rows.slice(0, 1))).toBe('')
  })
  it('has a loading shell with the same frame and no tiles', () => {
    const s = renderToStaticMarkup(createElement(AddressLedgerShell, { currency: 'BNB' }))
    expect(s).toContain('class="ldg')
    expect(s).toContain('solid = BNB')
    expect(s).not.toContain('<i ')
  })
})

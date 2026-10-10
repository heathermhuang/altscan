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
const shell = () => renderToStaticMarkup(createElement(AddressLedgerShell, { currency: 'BNB' }))

/** The number of direct children of the card's `.ldg-head` (the head holds no div, so the first </div> closes it). */
function headCells(markup: string): number {
  const head = markup.match(/<div class="tp-head ldg-head">(.*?)<\/div>/s)?.[1] ?? ''
  let depth = 0
  let cells = 0
  for (const [, close, tag, selfClose] of head.matchAll(/<(\/?)([a-z]+)[^>]*?(\/?)>/g)) {
    if (close) { depth--; continue }
    if (depth === 0) cells++
    if (!selfClose && !['br', 'img'].includes(tag)) depth++
  }
  return cells
}

describe('AddressLedger', () => {
  it('draws one tile per row: direction, solid vs outlined, spam, width by gap', () => {
    const h = html(rows)
    expect(h.match(/<i /g)).toHaveLength(3)
    expect(h).toContain('class="in" style="--w:2"')        // the first row has no previous one: gap 1 -> 1 + log2(2)
    expect(h).toContain('class="out o" style="--w:2"')     // gap 1
    expect(h).toContain('class="out o s" style="--w:3"')   // gap 3 -> 1 + log2(1 + 3)
  })
  it('states the totals and the span, and is one labelled image', () => {
    const h = html(rows)
    expect(h).toContain('▲ 1 received · ▼ 2 sent')
    expect(h).toContain('over 4 seconds')
    expect(h).toContain('role="img"')
    expect(h).toContain('aria-label="3 transactions over 4 seconds: 1 received, 2 sent"')
    expect(h).toContain('solid = BNB')
  })
  it('says "in the same second" when every row shares one second, never "over 0 seconds"', () => {
    const same: LedgerRow[] = Array.from({ length: 25 }, () => ({ t: 100, dir: 'in', native: true, spam: false }))
    const h = html(same)
    expect(h).toContain(' · in the same second')
    expect(h).toContain('aria-label="25 transactions in the same second: 25 received, 0 sent"')
    expect(h).not.toContain('over 0 seconds')
    expect(h).not.toContain(' over ')
  })
  it('draws nothing for fewer than 2 rows', () => {
    expect(html([])).toBe('')
    expect(html(rows.slice(0, 1))).toBe('')
  })
  it('draws exactly two tiles for two rows', () => {
    const h = html(rows.slice(0, 2))
    expect(h.match(/<i /g)).toHaveLength(2)
    expect(h).toContain('aria-label="2 transactions over 1 second: 1 received, 1 sent"')
  })
  it('has a loading shell with the same frame and no tiles', () => {
    const s = shell()
    expect(s).toContain('class="ldg')
    expect(s).toContain('solid = BNB')
    expect(s).not.toContain('<i ')
  })
  it('gives the shell a head of the same two cells as the real head, so a stacked phone head is as tall', () => {
    expect(headCells(html(rows))).toBe(2)
    expect(headCells(shell())).toBe(2)
  })
})

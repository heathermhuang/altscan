import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TxnsTable, type TxnRow } from './TxnsTable'

// app/globals.css (.dt-ad) lays each row out under 640px by cell POSITION - hash, age, detail, value -
// from the same cells the desktop table shows. These pin that order, and that no cell carries a
// utility class: utilities sit in a later layer than the .dt-ad rules, so a px-3 or `hidden` on a cell
// would silently beat the phone layout.
const HASH = (n: number) => `0x${String(n).repeat(64)}`
const rows: TxnRow[] = [
  { hash: HASH(1), timestamp: new Date(Date.now() - 3 * 3_600_000), detail: createElement('span', null, 'OUT 0xabc'), value: '1500000000000000000' },
  { hash: HASH(2), timestamp: new Date(Date.now() - 2 * 86_400_000), detail: 'Sent 2 BNB to 0xdef', value: '0', faded: true },
]
const html = (props: Partial<Parameters<typeof TxnsTable>[0]> = {}) =>
  renderToStaticMarkup(createElement(TxnsTable, { caption: 'BNB Chain transactions', rows, currency: 'BNB', detailHeading: 'From / To', ...props }))
const bodyRows = (h: string) => h.match(/<tr\b[^>]*>.*?<\/tr>/gs)!.slice(1) // the first <tr> is the header
const cells = (r: string) => [...r.matchAll(/<td\b([^>]*)>(.*?)<\/td>/gs)].map(m => ({ attrs: m[1], inner: m[2] }))

describe('TxnsTable cell contract', () => {
  it('is a dt-ad table whose headers go visually hidden on a phone', () => {
    const h = html()
    expect(h).toMatch(/<table class="dt dt-a dt-ad">/)
    expect(h).toMatch(/<thead class="max-sm:sr-only">/)
    expect(h).toContain('<caption class="sr-only">BNB Chain transactions</caption>')
  })

  it('renders every column at every width, in the order the phone layout expects', () => {
    const h = html()
    expect([...h.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map(m => m[1])).toEqual(['Tx Hash', 'Age', 'From / To', 'Value'])
    for (const r of bodyRows(h)) expect(cells(r)).toHaveLength(4)
    const [first] = bodyRows(h).map(cells)
    expect(first[0].inner).toContain(`href="/tx/${HASH(1)}"`)
    expect(first[1].inner).toBe('3h ago')
    expect(first[2].inner).toContain('OUT 0xabc')
    expect(first[3].inner).toContain('1.5')
  })

  it('puts the unit in the value cell, or in the heading when asked (then the cell keeps it for phones only)', () => {
    const inCell = cells(bodyRows(html())[0])[3].inner
    expect(inCell).toBe('1.5 BNB')
    const h = html({ unitInHeading: true })
    expect([...h.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map(m => m[1])[3]).toBe('Value (BNB)')
    expect(cells(bodyRows(h)[0])[3].inner).toContain('<span class="sm:hidden"> BNB</span>')
  })

  it('has no value duplicated under the hash (the phone layout draws the value cell itself)', () => {
    const first = cells(bodyRows(html())[0])[0].inner
    expect(first).not.toContain('BNB')
    expect(first).not.toContain('<div')
  })

  it('gives the cells no utility classes but the caller\'s detailClass, and the row none but the spam fade', () => {
    const h = html({ detailClass: 'font-sans text-ink2 max-w-xs truncate' })
    const [a, b] = bodyRows(h)
    for (const r of [a, b]) {
      const c = cells(r)
      expect(c[0].attrs).toBe('')
      expect(c[3].attrs).toBe('')
      expect(c[2].attrs).toContain('font-sans text-ink2 max-w-xs truncate')
      expect(r.match(/<td\b[^>]*class="[^"]*\b(px-|py-|hidden|sm:table-cell)/)).toBeNull()
    }
    expect(a).not.toContain('opacity-50')
    expect(b).toMatch(/^<tr class="opacity-50">/)
  })
})

const css = readFileSync(new URL('../../globals.css', import.meta.url), 'utf8')
// The block "Transaction rows on phones" opens at its comment and closes at the next top-level comment.
const phoneBlock = css.slice(css.indexOf('/* Transaction rows on phones'), css.indexOf('/* Tape primitives'))
const phoneMedia = phoneBlock.slice(phoneBlock.indexOf('@media (max-width: 639.98px)'))

describe('.dt-ad in app/globals.css', () => {
  it('positions each of the four cells', () => {
    for (const n of [1, 2, 3, 4]) expect(phoneMedia, `td:nth-child(${n})`).toMatch(new RegExp(`\\.dt-ad td:nth-child\\(${n}\\)\\s*\\{[^}]*grid-area`))
  })

  it('exists only below 640px, so the desktop table is untouched', () => {
    const before = css.slice(0, css.indexOf(phoneMedia))
    const after = css.slice(css.indexOf(phoneMedia) + phoneMedia.length)
    expect(before + after).not.toContain('.dt-ad')
    // the one place the table is named outside the media query is the comment above it
    expect(phoneBlock.slice(0, phoneBlock.indexOf('@media (max-width: 639.98px)'))).not.toMatch(/\.dt-ad\b[^{]*\{/)
  })
})

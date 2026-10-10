import { readFileSync } from 'node:fs'
import { mediaBlock } from '@/test-support/css-media'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { HOLDER_LABELS } from '@/lib/holder-labels'

const token = (address: string, name: string, symbol: string, holderCount: number, totalSupply: string) =>
  ({ address, symbol, name, type: 'BEP20', decimals: 18, totalSupply, holderCount })

// The second row is a lookalike of USDT (a different address, the same symbol), so its cell carries a badge.
const { rows } = vi.hoisted(() => ({
  rows: [] as unknown[],
}))
vi.mock('@/lib/db', () => {
  const q: Record<string, unknown> = {}
  for (const m of ['from', 'where', 'orderBy', 'limit']) q[m] = () => q
  q.then = (resolve: (r: unknown) => unknown) => resolve(rows)
  return { db: { select: () => q }, schema: { tokens: {} } }
})

async function render() {
  const { default: Page } = await import('./page')
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }))
}
const bodyRows = (h: string) => h.match(/<tr\b[^>]*>.*?<\/tr>/gs)!.slice(1) // the first <tr> is the header
const cells = (r: string) => [...r.matchAll(/<td\b([^>]*)>(.*?)<\/td>/gs)].map(m => ({ attrs: m[1], inner: m[2] }))

// app/globals.css (.dt-tk) lays each row out under 640px by cell POSITION - rank, token, symbol,
// indexed holders, total supply - from the same cells the desktop table shows. These pin that order
// and that no cell carries a utility class (utilities sit in a later layer and would beat the phone layout).
describe('/token list cell contract', () => {
  rows.push(
    token('0x55d398326f99059ff775485246999027b3197955', 'Tether USD', 'USDT', 835871, '4760000000000000000000000000'),
    token('0x1111111111111111111111111111111111111111', 'Tether USD', 'USDT', 12, '1000000000000000000'),
    token('0x2222222222222222222222222222222222222222', 'Unknown', '???', 0, '0'),
    token('0x3333333333333333333333333333333333333333', 'Claim at free-bnb.xyz', 'AIRDROP', 5, '1000000000000000000000'),
  )

  it('is a dt-tk table whose headers go visually hidden on a phone, with every column kept at every width', async () => {
    const h = await render()
    expect(h).toMatch(/<table class="dt dt-tk">/)
    expect(h).toMatch(/<thead class="max-sm:sr-only">/)
    expect([...h.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map(m => m[1])).toEqual(['#', 'Token', 'Symbol', 'Indexed holders', 'Total Supply'])
    for (const r of bodyRows(h)) expect(cells(r)).toHaveLength(5)
  })

  it('keeps the order: rank, token link (and any lookalike badge), symbol, holders, supply', async () => {
    const [first, clone, unknown] = bodyRows(await render()).map(cells)
    expect(first[0].inner).toBe('1')
    expect(first[1].inner).toContain('href="/token/0x55d398326f99059ff775485246999027b3197955"')
    expect(first[1].inner).toContain('Tether USD')
    expect(first[2].inner).toBe('USDT')
    expect(first[3].inner).toBe('835,871')
    expect(first[4].inner).toBe('4.76B')
    expect(clone[1].inner).toContain('lookalike')
    expect(unknown[3].inner).toBe('—')
    expect(unknown[4].inner).toBe('—')
  })

  it('keeps the "link in name" badge in the name cell (the cell the phone grid lets wrap), and no other cell gets one', async () => {
    const rows = bodyRows(await render()).map(cells)
    const advert = rows[3]
    expect(advert[1].inner).toContain('Claim at free-bnb.xyz')
    expect(advert[1].inner).toContain('link in name')
    expect(advert.filter((_, i) => i !== 1).some(c => c.inner.includes('link in name'))).toBe(false)
    expect(rows.slice(0, 3).some(r => r[1].inner.includes('link in name'))).toBe(false)
  })

  it('gives the cells no utility classes, so the phone layout is not beaten by a later layer', async () => {
    for (const r of bodyRows(await render())) {
      for (const c of cells(r)) expect(c.attrs).toMatch(/^( class="text-mut")?$/)
    }
  })

  // Titles do not show on touch and 48 per-row copies cost +679 B gzip, so the explanation is one visible
  // footnote under the table (and the hover title stays on the header, which phones hide).
  it('explains the indexed-holders count once, in a footnote under the table, not in a title on every cell', async () => {
    const h = await render()
    const sentence = HOLDER_LABELS.indexed.title.replace(/'/g, '&#x27;')
    expect(h).toContain(`<th scope="col" title="${sentence}">`)
    for (const r of bodyRows(h)) expect(cells(r)[3].attrs).toBe('')
    const notes = [...h.matchAll(/<p class="mt-3 text-xs text-mut">(.*?)<\/p>/g)]
    expect(notes).toHaveLength(1)
    expect(notes[0][1]).toContain(`${HOLDER_LABELS.indexed.heading}.`)
    expect(notes[0][1]).toContain(sentence)
    expect(h.split(sentence)).toHaveLength(3) // the header's title attribute and the footnote, nowhere else
    expect(h.indexOf(notes[0][0])).toBeGreaterThan(h.indexOf('</table>')) // under the table
  })
})

const css = readFileSync(new URL('../globals.css', import.meta.url), 'utf8')
const phoneMedia = mediaBlock(css, '(max-width: 639.98px)', css.indexOf('/* Transaction rows on phones'))

describe('.dt-tk in app/globals.css', () => {
  it('positions each of the five cells', () => {
    for (const n of [1, 2, 3, 4, 5]) expect(phoneMedia, `td:nth-child(${n})`).toMatch(new RegExp(`\\.dt-tk td:nth-child\\(${n}\\)\\s*\\{[^}]*(grid-area|font-size)`))
    expect(phoneMedia).toMatch(/\.dt-tk td:nth-child\(4\)\s*\{[^}]*grid-area/)
    expect(phoneMedia).toMatch(/\.dt-tk td:nth-child\(5\)\s*\{[^}]*grid-area/)
  })

  it('labels the two figures after them, with the words of the headings (the holder count is never shown bare)', () => {
    expect(phoneMedia).toContain(`.dt-tk td:nth-child(4)::after {\n      content: " ${HOLDER_LABELS.indexed.phrase}";`)
    expect(phoneMedia).toContain('.dt-tk td:nth-child(5)::after {\n      content: " total supply";')
  })

  it('exists only below 640px, so the desktop table is untouched', () => {
    expect(css.replace(phoneMedia, '')).not.toContain('.dt-tk')
  })
})

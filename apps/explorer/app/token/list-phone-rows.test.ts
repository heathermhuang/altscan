import { readFileSync } from 'node:fs'
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

  it('gives the cells no utility classes, so the phone layout is not beaten by a later layer', async () => {
    for (const r of bodyRows(await render())) {
      for (const c of cells(r)) expect(c.attrs).toMatch(/^( class="text-mut")?$/)
    }
  })
})

const css = readFileSync(new URL('../globals.css', import.meta.url), 'utf8')
const phoneBlock = css.slice(css.indexOf('/* Transaction rows on phones'), css.indexOf('/* Tape primitives'))
const phoneMedia = phoneBlock.slice(phoneBlock.indexOf('@media (max-width: 639.98px)'))

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
    const before = css.slice(0, css.indexOf(phoneMedia))
    const after = css.slice(css.indexOf(phoneMedia) + phoneMedia.length)
    expect(before + after).not.toContain('.dt-tk')
  })
})

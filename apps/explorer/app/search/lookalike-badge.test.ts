/**
 * The "lookalike" badge on the two token lists: /token and the /search results table. Both render
 * the same markup, and only for flagged rows. The pages are server components, so this renders
 * them to static HTML with the database stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// What the stubbed query returns. A real chain of drizzle calls ends in an await, so the stub is
// a thenable that every builder method returns.
let rows: Record<string, unknown>[] = []
vi.mock('@/lib/db', () => {
  const query: Record<string, unknown> = {}
  for (const m of ['from', 'where', 'orderBy', 'limit']) query[m] = () => query
  query.then = (resolve: (r: unknown) => unknown) => resolve(rows)
  return { db: { select: () => query }, schema: { tokens: {} } }
})
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/components/ads/AdReserve', () => ({ AdReserve: () => null }))

const CYR_TE = '\u0422' // Cyrillic capital Te, looks like T
const SPAM_ADDR = '0x00000000000000000000000000000000deadbeef'
const CAKE_ADDR = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82'
const BADGE_NOTE = 'Its symbol or name reads as USDT, but this is not the USDT contract (0x55d3…7955). Likely impersonation.'
const BADGE_CLASSES = 'badge badge-bad ml-2'

const token = (address: string, symbol: string, name: string) => ({
  address, symbol, name, type: 'BEP20', decimals: 18, totalSupply: '1000', holderCount: 10,
})

const badgesIn = (html: string) => html.match(/<span class="badge[^>]*>.*?<\/span><\/span>/g) ?? []

async function searchHtml(): Promise<string> {
  const { default: SearchPage } = await import('./page')
  return renderToStaticMarkup(await SearchPage({ searchParams: Promise.resolve({ q: 'usd' }) }))
}

async function tokenListHtml(): Promise<string> {
  const { default: TokenListPage } = await import('../token/page')
  return renderToStaticMarkup(await TokenListPage({ searchParams: Promise.resolve({}) }))
}

beforeEach(() => {
  rows = [
    token(SPAM_ADDR, `USD${CYR_TE}`, 'Tether USD'),
    token(CAKE_ADDR, 'CAKE', 'PancakeSwap Token'),
  ]
})

describe('lookalike badge on the token lists', () => {
  it('/search marks a flagged token with the badge, naming what it imitates', async () => {
    const html = await searchHtml()
    expect(badgesIn(html)).toEqual([
      `<span class="${BADGE_CLASSES}" title="${BADGE_NOTE}">lookalike<span class="sr-only"> of USDT</span></span>`,
    ])
  })

  it('/search gives an unflagged row the bare link, with nothing after it in the cell', async () => {
    const html = await searchHtml()
    const cakeCell = html.match(new RegExp(`<td><a [^>]*href="/token/${CAKE_ADDR}"[^>]*>PancakeSwap Token</a></td>`))
    expect(cakeCell).not.toBeNull()
  })

  it('/search flags a token NAMED like a well-known symbol, whatever its symbol', async () => {
    rows = [token(SPAM_ADDR, 'XYZ', 'USDT'), token(CAKE_ADDR, 'CAKE', 'PancakeSwap Token')]
    expect(badgesIn(await searchHtml())).toHaveLength(1)
  })

  it('/search and /token render the identical badge', async () => {
    expect(badgesIn(await searchHtml())).toEqual(badgesIn(await tokenListHtml()))
    expect(badgesIn(await tokenListHtml())).toHaveLength(1)
  })

  it('/search shows no badge when nothing is flagged', async () => {
    rows = [token(CAKE_ADDR, 'CAKE', 'PancakeSwap Token'), token('0x0000000000000000000000000000000000000001', 'ABC', 'Abc Coin')]
    expect(badgesIn(await searchHtml())).toEqual([])
  })

  it('the /search page is a server component, so lookalike.ts never reaches the browser', () => {
    const src = readFileSync(join(__dirname, 'page.tsx'), 'utf8')
    expect(src).not.toMatch(/^\s*['"]use client['"]/m)
  })
})

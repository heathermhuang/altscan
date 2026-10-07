/**
 * /search with exactly one token match must redirect to that token. redirect() works by throwing a
 * NEXT_REDIRECT error, and the token lookup sits in a try/catch that swallows DB errors — so a
 * redirect() called inside that try was swallowed too, and every single-match search (e.g.
 * ethscan.io/search?q=Kper.network) rendered "No results found". This renders the real server
 * component with the database stubbed and the REAL next/navigation redirect.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// What the stubbed query yields: rows, or an Error to reject with. A real drizzle chain ends in an
// await, so the stub is a thenable that every builder method returns.
let result: Record<string, unknown>[] | Error = []
vi.mock('@/lib/db', () => {
  const query: Record<string, unknown> = {}
  for (const m of ['from', 'where', 'orderBy', 'limit']) query[m] = () => query
  query.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) =>
    result instanceof Error ? reject(result) : resolve(result)
  return { db: { select: () => query }, schema: { tokens: {} } }
})
vi.mock('@/components/ads/AdReserve', () => ({ AdReserve: () => null }))

const KPER_ADDR = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82'
const OTHER_ADDR = '0x0000000000000000000000000000000000000001'
const token = (address: string, symbol: string, name: string) => ({ address, symbol, name, type: 'ERC20' })

async function renderSearch(q: string): Promise<string> {
  const { default: SearchPage } = await import('./page')
  return renderToStaticMarkup(await SearchPage({ searchParams: Promise.resolve({ q }) }))
}

beforeEach(() => {
  result = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('/search token lookup', () => {
  it('a single token match redirects to that token instead of "No results found"', async () => {
    result = [token(KPER_ADDR, 'KPER', 'Kper.network')]
    const err = await renderSearch('Kper.network').then(
      () => { throw new Error('expected redirect, but the page rendered') },
      (e: unknown) => e,
    )
    const digest = (err as { digest?: string }).digest ?? ''
    expect(digest.startsWith('NEXT_REDIRECT')).toBe(true)
    expect(digest.split(';')[2]).toBe(`/token/${KPER_ADDR}`)
  })

  it('several matches render the results table, not a redirect', async () => {
    result = [token(KPER_ADDR, 'KPER', 'Kper.network'), token(OTHER_ADDR, 'KPE', 'Kpe Coin')]
    const html = await renderSearch('kp')
    expect(html).toContain('Search results')
    expect(html).toContain(`href="/token/${KPER_ADDR}"`)
  })

  it('no match renders "No results found"', async () => {
    expect(await renderSearch('nothing-like-this')).toContain('No results found')
  })

  it('a DB error is still swallowed — the page degrades to "No results found"', async () => {
    result = new Error('connection closed')
    expect(await renderSearch('Kper.network')).toContain('No results found')
  })
})

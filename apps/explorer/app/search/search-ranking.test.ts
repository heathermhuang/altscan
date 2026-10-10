/**
 * /search must put the canonical token first, not whichever five rows the database happened to
 * return: the token query had no ORDER BY and LIMIT 5, so the real USDT could be absent while
 * lookalikes showed. Renders the real server component with the database stubbed, in the order the
 * DB would hand rows back (holder count descending), so the page's own ranking is what is under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PgDialect } from 'drizzle-orm/pg-core'

let rows: Record<string, unknown>[] = []
const limits: number[] = []
const orderings: unknown[] = []
// The real schema, so the ORDER BY the page builds has a real column and renders to real SQL.
vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  const query: Record<string, unknown> = {}
  for (const m of ['from', 'where']) query[m] = () => query
  query.orderBy = (o: unknown) => { orderings.push(o); return query }
  query.limit = (n: number) => { limits.push(n); return query }
  query.then = (resolve: (r: unknown) => unknown) => resolve(rows)
  return { db: { select: () => query }, schema }
})
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/components/ads/AdReserve', () => ({ AdReserve: () => null }))

const CANONICAL = '0x55d398326f99059ff775485246999027b3197955'
const addr = (i: number) => `0x${i.toString(16).padStart(40, '0')}`
const token = (address: string, symbol: string, name: string, holderCount: number, type = 'BEP20') =>
  ({ address, symbol, name, type, decimals: 18, totalSupply: '1000', holderCount })

async function searchHtml(q: string, chain?: 'eth'): Promise<string> {
  if (chain) vi.stubEnv('CHAIN', chain)
  vi.resetModules()
  const { default: SearchPage } = await import('./page')
  return renderToStaticMarkup(await SearchPage({ searchParams: Promise.resolve({ q }) }))
}

/** Contract addresses in the results table, in row order. */
const rowOrder = (html: string) =>
  [...html.matchAll(/<tr><td><a [^>]*href="\/token\/(0x[0-9a-f]{40})"/g)].map((m) => m[1])

beforeEach(() => {
  limits.length = 0
  orderings.length = 0
  // Twelve USDT-named airdrops out-hold the real contract, as on the live chain. Canonical is last.
  rows = [
    ...Array.from({ length: 12 }, (_, i) => token(addr(i + 1), 'USDT', 'Tether USD', 9_000_000 - i)),
    token(CANONICAL, 'USDT', 'Tether USD', 5_000_000),
  ]
})
afterEach(() => vi.unstubAllEnvs())

describe('/search token ranking', () => {
  it('shows the canonical contract first although lookalikes have more holders', async () => {
    expect(rowOrder(await searchHtml('usdt'))[0]).toBe(CANONICAL)
  })

  it('finds the canonical contract the same way for a differently-cased query', async () => {
    expect(rowOrder(await searchHtml('USDT'))[0]).toBe(CANONICAL)
  })

  // /search?q=tether in production: tokens NAMED exactly "Tether" (flagged lookalikes) are an exact-name
  // match, while the canonical "Tether USD" is only a name-prefix match, and they out-hold it.
  it('puts the canonical "Tether USD" above lookalikes named exactly "Tether" on BNB', async () => {
    rows = [
      token(addr(1), '\u054D\u0405\u216E\u0422', 'Tether', 9_000_003),
      token(addr(2), '\u054DSDT', 'Tether', 9_000_002),
      token(addr(3), 'USDT', 'Tether', 9_000_001),
      token(CANONICAL, 'USDT', 'Tether USD', 5_000_000),
    ]
    const html = await searchHtml('tether')
    expect(rowOrder(html)).toEqual([CANONICAL, addr(1), addr(2), addr(3)])
    expect(html.match(/lookalike<span/g)).toHaveLength(3)
  })

  it('puts the canonical "Tether USD" above lookalikes named exactly "Tether" on Ethereum', async () => {
    const eth = '0xdac17f958d2ee523a2206206994597c13d831ec7'
    rows = [
      token(addr(1), 'USDT', 'Tether', 9_000_002),
      token(addr(2), '\u054DSDT', 'Tether', 9_000_001),
      token(eth, 'USDT', 'Tether USD', 5_000_000),
    ]
    const html = await searchHtml('tether', 'eth')
    expect(rowOrder(html)).toEqual([eth, addr(1), addr(2)])
    expect(html.match(/lookalike<span/g)).toHaveLength(2)
  })

  it('shows the top 10 of its 50 candidates, and says it is a top 10', async () => {
    rows = Array.from({ length: 50 }, (_, i) => token(addr(i + 1), 'USDT', `Tether ${i}`, 1000 - i))
    const html = await searchHtml('usdt')
    expect(rowOrder(html)).toHaveLength(10)
    expect(html).toContain('Showing the top 10 of 50+ tokens')
    expect(html).not.toContain('Found 50 tokens')
  })

  it('still says "Found N" when every candidate is shown', async () => {
    rows = rows.slice(0, 4)
    expect(await searchHtml('usdt')).toContain('Found 4 tokens')
  })

  // The 50 by-holders candidates, and (search-exact.test.ts) up to 10 rows whose symbol or name equals the query.
  it('asks the database for 50 candidates, ordered, instead of five unordered rows', async () => {
    await searchHtml('usdt')
    expect(limits).toEqual([50, 10])
    expect(orderings).toHaveLength(1)
  })

  // Plain DESC matches tokens_holder_count_idx (holder_count DESC), so Postgres walks the index and stops
  // at the limit. NULLS LAST cannot use it: a seq scan + sort on every search, ~3.6 s on BNB (4.66M tokens).
  // holder_count is NOT NULL, so the order is identical either way.
  it('orders by holder_count DESC with no NULLS LAST, so the holder_count index can serve it', async () => {
    await searchHtml('usdt')
    const order = new PgDialect().sqlToQuery(orderings[0] as Parameters<PgDialect['sqlToQuery']>[0]).sql
    expect(order).toContain('"holder_count" desc')
    expect(order).not.toMatch(/nulls last/i)
  })

  it('labels the standard from the chain config: BEP-20 on BNB', async () => {
    const html = await searchHtml('usdt')
    expect(html).toContain('<td class="text-mut">BEP-20</td>')
    expect(html).not.toContain('>BEP20<')
  })

  it('labels the standard from the chain config: ERC-20 on Ethereum', async () => {
    const html = await searchHtml('usdt', 'eth')
    expect(html).toContain('<td class="text-mut">ERC-20</td>')
    expect(html).not.toContain('BEP')
  })
})

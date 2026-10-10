/**
 * /search must never miss an exact ticker or name. The page asked the database for the 50 most-held
 * tokens CONTAINING the query, so a real token with few holders was absent whenever 50 better-held
 * tokens contained its ticker too ("ZQ" is inside thousands of names). It now also asks for the rows
 * whose lower(symbol) or lower(name) EQUALS the query (served by tokens_lower_symbol_idx /
 * tokens_lower_name_idx), unions the two by address and ranks the union as before.
 * The real server component, with the database stubbed: the by-holders query is the one with an ORDER BY.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PgDialect } from 'drizzle-orm/pg-core'

type Row = Record<string, unknown>
let holderRows: Row[] = []
let exactRows: Row[] | Error = []
const exact: { where: unknown; limit: number }[] = []
vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  return {
    schema,
    db: {
      select: () => {
        const q: Record<string, unknown> = {}
        let byHolders = false
        let where: unknown
        let limit = 0
        q.from = () => q
        q.where = (w: unknown) => { where = w; return q }
        q.orderBy = () => { byHolders = true; return q }
        q.limit = (n: number) => { limit = n; return q }
        q.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => {
          if (byHolders) return resolve(holderRows)
          exact.push({ where, limit })
          return exactRows instanceof Error ? reject(exactRows) : resolve(exactRows)
        }
        return q
      },
    },
  }
})
vi.mock('@/components/ads/AdReserve', () => ({ AdReserve: () => null }))

const addr = (i: number) => `0x${i.toString(16).padStart(40, '0')}`
const token = (address: string, symbol: string, name: string, holderCount: number) =>
  ({ address, symbol, name, type: 'BEP20', decimals: 18, totalSupply: '1000', holderCount })

async function searchHtml(q: string): Promise<string> {
  const { default: SearchPage } = await import('./page')
  return renderToStaticMarkup(await SearchPage({ searchParams: Promise.resolve({ q }) }))
}
const rowOrder = (html: string) =>
  [...html.matchAll(/<tr><td><a [^>]*href="\/token\/(0x[0-9a-f]{40})"/g)].map((m) => m[1])

const RARE = addr(0xabc)

beforeEach(() => {
  exact.length = 0
  exactRows = []
  // Fifty tokens that merely CONTAIN "zq", all better held than the exact match.
  holderRows = Array.from({ length: 50 }, (_, i) => token(addr(i + 1), `AZQ${i}`, `Zq Coin ${i}`, 10_000 - i))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('/search exact matches', () => {
  it('shows a low-holder exact ticker that the 50 most-held containing tokens leave out', async () => {
    exactRows = [token(RARE, 'ZQ', 'Zq Rare', 3)]
    const order = rowOrder(await searchHtml('zq'))
    expect(order[0]).toBe(RARE)
    expect(order).toHaveLength(10)
  })

  it('without the exact lookup that token is nowhere on the page (the bug this guards)', async () => {
    exactRows = []
    expect(rowOrder(await searchHtml('zq'))).not.toContain(RARE)
  })

  it('finds an exact NAME the same way, ranked after an exact symbol', async () => {
    const bySymbol = addr(0xdef)
    exactRows = [token(RARE, 'RR', 'Zq', 3), token(bySymbol, 'ZQ', 'Other', 1)]
    const order = rowOrder(await searchHtml('zq'))
    expect(order.slice(0, 2)).toEqual([bySymbol, RARE])
  })

  it('lists a token once when both queries return it', async () => {
    exactRows = [holderRows[0]]
    const html = await searchHtml('zq')
    expect(rowOrder(html).filter((a) => a === holderRows[0].address)).toHaveLength(1)
  })

  it('a lookalike that matches exactly still ranks after every real token', async () => {
    const fake = addr(0xbad)
    holderRows = Array.from({ length: 50 }, (_, i) => token(addr(i + 1), `TT${i}`, `Tether ${i}`, 10_000 - i))
    exactRows = [token(fake, 'USDT', 'Tether', 9_999_999)] // flagged: USDT, but not the USDT contract
    const html = await searchHtml('tether')
    expect(rowOrder(html)).not.toContain(fake) // real tokens fill the ten rows first
    expect(html).toContain('Showing the top 10 of 51+ tokens matching')
  })

  it('asks for the rows EQUAL to the lowercased query, LIMIT 10', async () => {
    await searchHtml('ZQ')
    expect(exact).toHaveLength(1)
    expect(exact[0].limit).toBe(10)
    const { sql, params } = new PgDialect().sqlToQuery(exact[0].where as Parameters<PgDialect['sqlToQuery']>[0])
    expect(sql).toBe('(lower("tokens"."symbol") = $1 or lower("tokens"."name") = $2)')
    expect(params).toEqual(['zq', 'zq'])
  })

  it('a single exact match with no other candidate redirects to that token', async () => {
    holderRows = []
    exactRows = [token(RARE, 'ZQ', 'Zq Rare', 3)]
    const err = await searchHtml('zq').then(() => null, (e: unknown) => e)
    const digest = (err as { digest?: string } | null)?.digest ?? ''
    expect(digest.split(';')[2]).toBe(`/token/${RARE}`)
  })

  it('an exact-lookup failure degrades to the by-holders results instead of "No results found"', async () => {
    exactRows = new Error('index missing')
    const html = await searchHtml('zq')
    expect(html).toContain('Search results')
    expect(rowOrder(html)).toHaveLength(10)
  })
})

describe('/search normalises the query before routing', () => {
  const redirectOf = async (q: string) => {
    const err = await searchHtml(q).then(() => null, (e: unknown) => e)
    return ((err as { digest?: string } | null)?.digest ?? '').split(';')[2]
  }
  const TX = 'aB'.repeat(32)
  const ADDR = 'Cd'.repeat(20)

  it.each([
    ['#126779120', '/blocks/126779120'],
    ['126,779,120', '/blocks/126779120'],
    ['126 779 120', '/blocks/126779120'],
    [`0X${TX}`, `/tx/0x${TX}`],
    [TX, `/tx/0x${TX}`],
    [`0X${ADDR}`, `/address/0x${ADDR}`],
    [ADDR, `/address/0x${ADDR}`],
  ])('%s -> %s', async (q, to) => {
    expect(await redirectOf(q)).toBe(to)
  })

  // normaliseSearchQuery ran BEFORE the 200-character cap, and its digit regex was quadratic: a 16 KB ?q= held the
  // event loop ~150 ms per request on this dynamic, unlimited page.
  it('answers a 16,000-character adversarial q fast, capped to 200 characters like the old page', async () => {
    await searchHtml('warm up')
    const t = performance.now()
    const to = await redirectOf('1'.repeat(16_000) + '1')
    expect(performance.now() - t).toBeLessThan(50)
    expect(to).toBe(`/blocks/${'1'.repeat(200)}`)
    const t2 = performance.now()
    await searchHtml('1'.repeat(100) + 'x' + '1'.repeat(16_000)) // a token search, with a long tail to drop
    expect(performance.now() - t2).toBeLessThan(50)
  })

  it('searches tokens for the text after a leading # (and says so on the page)', async () => {
    holderRows = []
    exactRows = []
    const html = await searchHtml('#nothing-like-this')
    expect(html).toContain('No match for')
    expect(html).toContain('>nothing-like-this<')
  })
})

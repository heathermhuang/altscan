import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// A name or symbol that reads as a URL or handle is an advert (lib/link-in-name). On the /token list its text
// still shows, with a neutral "link in name" badge, and it is never a link of its own.
const token = (address: string, symbol: string, name: string, holderCount: number) =>
  ({ address, symbol, name, type: 'BEP20', decimals: 18, totalSupply: '1000000000000000000000', holderCount })
const addr = (i: number) => '0x' + i.toString(16).padStart(40, '0')

vi.mock('@/lib/db', () => {
  const rows = [
    token(addr(1), 'USDT.z', 'Tether USD Bridged', 500),          // a ticker with a dot: fine
    token(addr(2), 'CLAIM', 'Visit claim-bnb.xyz to claim', 400), // URL in the name
    token(addr(3), 'www.free.io', 'Free Token', 300),             // URL in the symbol
    token(addr(4), 'FOMO', '@FOMO', 200),                         // handle
    token(addr(5), 'CAKE', 'PancakeSwap Token', 100),
  ]
  const q: Record<string, unknown> = {}
  for (const m of ['from', 'where', 'orderBy', 'limit']) q[m] = () => q
  q.then = (resolve: (r: unknown) => unknown) => resolve(rows)
  return { db: { select: () => q }, schema: { tokens: {} } }
})

const BADGE = /<span class="badge ml-2" title="[^"]*web address[^"]*">link in name<\/span>/g

async function html() {
  const { default: Page } = await import('./page')
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }))
}

describe('/token list: link in name', () => {
  it('badges exactly the rows whose name or symbol looks like a URL or handle', async () => {
    const out = await html()
    expect(out.match(BADGE)).toHaveLength(3)
    const rowOf = (a: string) => out.match(new RegExp(`<tr><td[^>]*>\\d+</td><td>(?:(?!</tr>).)*${a}(?:(?!</tr>).)*</tr>`))?.[0] ?? ''
    expect(rowOf(addr(1))).not.toContain('link in name')
    expect(rowOf(addr(2))).toContain('link in name')
    expect(rowOf(addr(3))).toContain('link in name')
    expect(rowOf(addr(4))).toContain('link in name')
    expect(rowOf(addr(5))).not.toContain('link in name')
  })

  it('still shows the text, and the only links are the explorer\'s own token pages', async () => {
    const out = await html()
    expect(out).toContain('Visit claim-bnb.xyz to claim')
    expect(out).toContain('www.free.io')
    const hrefs = [...out.matchAll(/href="([^"]*)"/g)].map(m => m[1])
    expect(hrefs.length).toBeGreaterThan(0)
    expect(hrefs.filter(h => !h.startsWith('/'))).toEqual([])
    expect(hrefs.join(' ')).not.toMatch(/claim|xyz|free\.io|FOMO/)
  })
})

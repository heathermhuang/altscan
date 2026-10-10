import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// /search results: the same neutral "link in name" badge on a name or symbol that reads as a URL or handle.
const token = (address: string, symbol: string, name: string, holderCount: number) =>
  ({ address, symbol, name, type: 'BEP20', decimals: 18, totalSupply: '1000', holderCount })
const addr = (i: number) => '0x' + i.toString(16).padStart(40, '0')

vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  const rows = [
    token(addr(1), 'BTC.b', 'Bitcoin Bridged', 900),
    token(addr(2), 'BTC', 'Bitcoin: claim at btc-airdrop.xyz', 800),
    token(addr(3), 'BTCX', '@btc_airdrop', 700),
  ]
  const q: Record<string, unknown> = {}
  for (const m of ['from', 'where', 'orderBy', 'limit']) q[m] = () => q
  q.then = (resolve: (r: unknown) => unknown) => resolve(rows)
  return { db: { select: () => q }, schema }
})
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/components/ads/AdReserve', () => ({ AdReserve: () => null }))

describe('/search: link in name', () => {
  it('badges the rows whose name or symbol looks like a URL or handle, and only those', async () => {
    const { default: SearchPage } = await import('./page')
    const out = renderToStaticMarkup(await SearchPage({ searchParams: Promise.resolve({ q: 'btc' }) }))
    expect(out.match(/>link in name<\/span>/g)).toHaveLength(2)
    const rowOf = (a: string) => out.match(new RegExp(`<tr><td>(?:(?!</tr>).)*${a}(?:(?!</tr>).)*</tr>`))?.[0] ?? ''
    expect(rowOf(addr(1))).not.toContain('link in name')
    expect(rowOf(addr(2))).toContain('link in name')
    expect(rowOf(addr(3))).toContain('link in name')
    expect(out).toContain('btc-airdrop.xyz')
    expect([...out.matchAll(/href="([^"]*)"/g)].map(m => m[1]).filter(h => !h.startsWith('/'))).toEqual([])
  })
})

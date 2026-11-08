import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// /search prints a token's name and symbol as given: direction controls stripped, the text isolated in <bdi>.
vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  const rows = [{ address: '0x' + '1'.repeat(40), symbol: '\u202ETDSU\u202C', name: 'Spoof\u202E coin', type: 'BEP20', decimals: 18, totalSupply: '1000', holderCount: 9 },
    // Two rows: a single match redirects to its token page.
    { address: '0x' + '2'.repeat(40), symbol: 'TDSUX', name: 'Other', type: 'BEP20', decimals: 18, totalSupply: '1000', holderCount: 8 },
  ]
  const q: Record<string, unknown> = {}
  for (const m of ['from', 'where', 'orderBy', 'limit', 'as']) q[m] = () => q
  q.then = (resolve: (r: unknown) => unknown) => resolve(rows)
  return { db: { select: () => q }, schema }
})
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/components/ads/AdReserve', () => ({ AdReserve: () => null }))

describe('/search: direction controls', () => {
  it('prints the name and symbol in the stored order', async () => {
    const { default: SearchPage } = await import('./page')
    const out = renderToStaticMarkup(await SearchPage({ searchParams: Promise.resolve({ q: 'tdsu' }) }))
    expect(out).toContain('<bdi>TDSU</bdi>')
    expect(out).toContain('<bdi>Spoof coin</bdi>')
    expect(out).not.toMatch(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/)
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// The token page header: a name or symbol that reads as a URL or handle shows as text, with a neutral
// "link in name" badge beside the h1 (not inside it), and never as a link.
const ADDR = '0x5a110fc00474038f6c02e89c707d638602ea44b5'
let row: Record<string, unknown> = {}
const tokenRow = (symbol: string, name: string) => ({
  address: ADDR, name, symbol, type: 'BEP20', decimals: 18,
  totalSupply: '1000000000000000000000', holderCount: 1234, logoUrl: null,
})

vi.mock('@/lib/db', () => {
  const query: Record<string, unknown> = {}
  for (const m of ['from', 'where', 'limit']) query[m] = () => query
  query.then = (resolve: (r: unknown) => unknown) => resolve([row])
  return { db: { select: () => query }, schema: { tokens: {}, tokenTransfers: {} } }
})
vi.mock('@/lib/token-transfers-query', () => ({
  TOKEN_TRANSFERS_MAX_ROWS: 10_000,
  selectTokenTransfers: async () => [],
  countTokenTransfers: async () => [{ value: 0 }],
}))
vi.mock('@/lib/market-data', () => ({ getTokenMarketData: async () => null }))
vi.mock('@/lib/holders', () => ({ getTokenHolders: async () => ({ holders: [] }), EMPTY_HOLDERS: { holders: [] } }))
vi.mock('@/lib/token-risk', () => ({ analyzeTokenRisk: async () => [] }))
vi.mock('@/lib/rpc', () => ({ getWebProvider: () => ({}) }))
vi.mock('@/components/ads/AdReserve', () => ({ AdReserve: () => null }))
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound') } }))

beforeEach(() => vi.resetModules())

const header = async () => {
  const page = await import('./page')
  const html = renderToStaticMarkup(await page.default({ params: Promise.resolve({ address: ADDR }), searchParams: Promise.resolve({}) }))
  return { html, h1: html.match(/<h1[^>]*>(.*?)<\/h1>/)?.[1] ?? '' }
}

describe('token page: link in name', () => {
  it('a URL in the name gets the badge beside the heading, and the text stays text', async () => {
    row = tokenRow('CLAIM', 'Visit claim-bnb.xyz to claim')
    const { html, h1 } = await header()
    expect(html.match(/>link in name<\/span>/g)).toHaveLength(1)
    expect(h1).toContain('claim-bnb.xyz')
    expect(h1).not.toContain('link in name')
    expect(h1).not.toContain('<a ')
  })

  it('a handle in the symbol gets it too', async () => {
    row = tokenRow('@airdrop_bot', 'Airdrop')
    expect((await header()).html.match(/>link in name<\/span>/g)).toHaveLength(1)
  })

  it('a ticker with a dot does not', async () => {
    row = tokenRow('USDT.z', 'Tether USD Bridged')
    expect((await header()).html).not.toContain('link in name')
  })
})

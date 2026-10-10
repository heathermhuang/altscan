/**
 * The token page names the token's standard from the chain config, not the raw `tokens.type` enum
 * ('BEP20' on BOTH chains): the header badge and the page/OpenGraph descriptions. Renders the real
 * server component and generateMetadata with the data sources stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const ADDR = '0x5a110fc00474038f6c02e89c707d638602ea44b5'
const row = {
  address: ADDR, name: 'Astherus USDF', symbol: 'USDF', type: 'BEP20', decimals: 18,
  totalSupply: '1000000000000000000000', holderCount: 1234, logoUrl: null,
}

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

async function load(chain?: 'eth') {
  if (chain) vi.stubEnv('CHAIN', chain)
  vi.resetModules()
  return import('./page')
}
const params = Promise.resolve({ address: ADDR })

afterEach(() => vi.unstubAllEnvs())
beforeEach(() => vi.resetModules())

const badgeHtml = async (page: typeof import('./page')) =>
  renderToStaticMarkup(await page.default({ params, searchParams: Promise.resolve({}) }))

describe('token page standard label', () => {
  it('BNB: the header badge says BEP-20, never the raw enum', async () => {
    const html = await badgeHtml(await load())
    expect(html).toContain('<span class="badge">BEP-20</span>')
    expect(html).not.toContain('>BEP20<')
  })

  it('BNB: the page and OpenGraph descriptions say BEP-20', async () => {
    const meta = await (await load()).generateMetadata({ params })
    expect(meta.description).toContain('BEP-20 token on')
    expect(meta.openGraph?.description).toBe('BEP-20')
  })

  it('Ethereum: the header badge says ERC-20, not BEP20', async () => {
    const html = await badgeHtml(await load('eth'))
    expect(html).toContain('<span class="badge">ERC-20</span>')
    expect(html).not.toMatch(/BEP/)
  })

  it('Ethereum: the page and OpenGraph descriptions say ERC-20', async () => {
    const meta = await (await load('eth')).generateMetadata({ params })
    expect(meta.description).toContain('ERC-20 token on')
    expect(meta.openGraph?.description).toBe('ERC-20')
  })
})

/**
 * The token page's Market strip: Price, 24h volume and liquidity come from ONE DEX pair (DexScreener's
 * deepest pool with the token as base), market cap / FDV from the whole token. The pair is named, and the
 * two pair figures say so. The real server component, data stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const ADDR = '0x55d398326f99059ff775485246999027b3197955'
const row = {
  address: ADDR, name: 'Tether USD', symbol: 'USDT', type: 'BEP20', decimals: 18,
  totalSupply: '1000000000000000000000', holderCount: 835871, logoUrl: null,
}
let market: Record<string, unknown> | null = null

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
vi.mock('@/lib/market-data', () => ({ getTokenMarketData: async () => market }))
vi.mock('@/lib/holders', () => ({ getTokenHolders: async () => ({ holders: [] }), EMPTY_HOLDERS: { holders: [] } }))
vi.mock('@/lib/token-risk', () => ({ analyzeTokenRisk: async () => [] }))
vi.mock('@/lib/rpc', () => ({ getWebProvider: () => ({}) }))
vi.mock('@/components/ads/AdReserve', () => ({ AdReserve: () => null }))
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound') } }))

const params = Promise.resolve({ address: ADDR })
const html = async () => {
  const page = await import('./page')
  return renderToStaticMarkup(await page.default({ params, searchParams: Promise.resolve({}) }))
}
const base = {
  priceUsd: 1.0002, priceChange24h: 0.01, volume24h: 250_000_000, liquidityUsd: 110_000_000, fdv: 1_600_000_000,
  marketCap: null, circulatingSupply: null, dexUrl: 'https://dexscreener.com/bsc/0xabc',
  pairLabel: 'USDT/USDC pair on PancakeSwap', source: 'dexscreener',
}
beforeEach(() => vi.resetModules())

describe('token page market strip', () => {
  it('names the pair on the link and labels the two pair figures', async () => {
    market = base
    const out = await html()
    expect(out).toContain('USDT/USDC pair on PancakeSwap ↗')
    expect(out).toContain('<dt class="k">24h Volume (pair)</dt>')
    expect(out).toContain('<dt class="k">Liquidity (pair)</dt>')
    expect(out).not.toContain('<dt class="k">24h Volume</dt>')
    expect(out).not.toContain('<dt class="k">Liquidity</dt>')
  })

  it('says in the note which figures are the pair\'s and which the token\'s', async () => {
    market = base
    expect(await html()).toContain('Price, 24h volume and liquidity are for the USDT/USDC pair on PancakeSwap; market cap and FDV are for the whole token.')
  })

  it('still names the pair when there is no link to it', async () => {
    market = { ...base, dexUrl: null }
    const out = await html()
    expect(out).toContain('<span class="text-xs text-mut">USDT/USDC pair on PancakeSwap</span>')
    expect(out).not.toContain('↗</a>USDT')
  })
})

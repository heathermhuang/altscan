import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// What the token page tells a reader must be what is known. The real page, with the database, the node and the ad slot
// stubbed (the same harness as token-text.test.ts).
const OTHER = '0x' + '2'.repeat(40)
const BNB_USDT = '0x55d398326f99059ff775485246999027b3197955'
type Row = Record<string, unknown>
const h = vi.hoisted(() => ({
  addr: '',
  row: {} as Record<string, unknown>,
  indexed: true,
  adContext: '' as string,
}))
const tokenRow = (address: string, symbol: string, name: string) => ({
  address, name, symbol, type: 'BEP20', decimals: 18,
  totalSupply: '1000000000000000000000', holderCount: 1234, logoUrl: null,
})

vi.mock('@/lib/db', () => {
  const query: Record<string, unknown> = {}
  for (const m of ['from', 'where', 'limit']) query[m] = () => query
  query.then = (resolve: (r: unknown) => unknown) => resolve(h.indexed ? [h.row] : [])
  return { db: { select: () => query }, schema: { tokens: {}, tokenTransfers: {} } }
})
vi.mock('@/lib/token-transfers-query', () => ({
  TOKEN_TRANSFERS_MAX_ROWS: 10_000,
  selectTokenTransfers: async () => [] as Row[],
  countTokenTransfers: async () => [{ value: 0 }],
}))
vi.mock('@/lib/market-data', () => ({ getTokenMarketData: async () => null }))
vi.mock('@/lib/holders', () => ({ getTokenHolders: async () => ({ holders: [], holderCount: null, source: 'local' }), EMPTY_HOLDERS: { holders: [] } }))
vi.mock('@/lib/token-risk', () => ({ analyzeTokenRisk: async () => [] }))
vi.mock('@/lib/rpc', () => ({ getWebProvider: () => ({}) }))
vi.mock('@/components/ads/AdReserve', () => ({ AdReserve: (p: { context: string }) => { h.adContext = p.context; return null } }))
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound') } }))

const render = async (address = h.addr) => {
  const page = await import('./page')
  return renderToStaticMarkup(await page.default({ params: Promise.resolve({ address }), searchParams: Promise.resolve({}) }))
}

beforeEach(() => {
  vi.resetModules()
  h.indexed = true
  h.adContext = ''
})

// The stablecoin CTA used to match "usdt", "dai", ... anywhere in a token's symbol or name, so anyone could earn it by
// naming a token "BabyUSDT" or "Daisy". It is now the chain's configured stablecoin contracts only.
describe('token page: the stablecoin referral context', () => {
  const contextFor = async (address: string, symbol: string, name: string) => {
    h.row = tokenRow(address, symbol, name)
    await render(address)
    return h.adContext
  }

  it('is "stablecoin" for the real USDT contract', async () => {
    expect(await contextFor(BNB_USDT, 'USDT', 'Tether USD')).toBe('stablecoin')
  })

  it('is "token_research" for a token that only has a stablecoin\'s word in its name', async () => {
    expect(await contextFor(OTHER, 'BabyUSDT', 'Baby Tether')).toBe('token_research')
    expect(await contextFor(OTHER, 'USDT2', 'USDT 2.0')).toBe('token_research')
    expect(await contextFor(OTHER, 'DAISY', 'Daisy')).toBe('token_research')
  })

  it('is "token_research" for a lookalike USDT', async () => {
    expect(await contextFor(OTHER, 'USDT', 'Tether USD')).toBe('token_research')
  })
})

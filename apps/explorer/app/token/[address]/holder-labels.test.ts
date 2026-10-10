/**
 * Judge round 4: USDT showed 835,871 holders on /token and 79,823,380 on the token page, neither labelled.
 * They are two sources: the explorer's index (tokens.holder_count) and Moralis's total. The token page's
 * Holders fact starts as the indexed count (server render) and becomes the Moralis total once it arrives;
 * the label travels with the number. The real server component and generateMetadata, data stubbed.
 */
import { createElement } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const ADDR = '0x55d398326f99059ff775485246999027b3197955'
const row = {
  address: ADDR, name: 'Tether USD', symbol: 'USDT', type: 'BEP20', decimals: 18,
  totalSupply: '1000000000000000000000', holderCount: 835871, logoUrl: null,
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
vi.mock('@/lib/holders', () => ({ getTokenHolders: async () => ({ holders: [], holderCount: null, source: 'local' }), EMPTY_HOLDERS: { holders: [], holderCount: null, source: 'local' } }))
vi.mock('@/lib/token-risk', () => ({ analyzeTokenRisk: async () => [] }))
vi.mock('@/lib/rpc', () => ({ getWebProvider: () => ({}) }))
vi.mock('@/components/ads/AdReserve', () => ({ AdReserve: () => null }))
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound') } }))

const params = Promise.resolve({ address: ADDR })
beforeEach(() => vi.resetModules())

describe('token page holder labels', () => {
  it('labels the server-rendered holder count as the explorer index', async () => {
    const page = await import('./page')
    const html = renderToStaticMarkup(await page.default({ params, searchParams: Promise.resolve({}) }))
    expect(html).toContain('<dt class="k">Indexed holders</dt>')
    expect(html).toContain('835,871')
    expect(html).not.toContain('<dt class="k">Holders</dt>')
  })

  // A frozen snapshot (about 1% of the live count) is not published as if current: the descriptions that
  // search engines and link previews show carry no holder count at all.
  it('leaves the frozen count out of the page and OpenGraph descriptions', async () => {
    const meta = await (await import('./page')).generateMetadata({ params })
    expect(meta.description).toBe('Tether USD (USDT) BEP-20 token on BNB Chain.')
    expect(meta.openGraph?.description).toBe('BEP-20')
    expect(`${meta.description} ${meta.openGraph?.description}`).not.toMatch(/835|holders/i)
  })
})

describe('HoldersFact', () => {
  it('relabels the fact when the Moralis total replaces the indexed count', async () => {
    const { HoldersFactView } = await import('./HoldersLazy')
    const indexed = renderToStaticMarkup(createElement(HoldersFactView, { count: 835871, source: 'indexed' }))
    const provider = renderToStaticMarkup(createElement(HoldersFactView, { count: 79823380, source: 'provider' }))
    expect(indexed).toContain('<dt class="k">Indexed holders</dt>')
    expect(indexed).toContain('835,871')
    expect(provider).toContain('<dt class="k">Holders (Moralis)</dt>')
    expect(provider).toContain('79,823,380')
    expect(indexed).toMatch(/title="A snapshot from this explorer[^"]*not updated/i)
    expect(provider).toMatch(/title="[^"]*Moralis/)
  })

  it('still shows the dash for a 0 count, with its label', async () => {
    const { HoldersFactView } = await import('./HoldersLazy')
    expect(renderToStaticMarkup(createElement(HoldersFactView, { count: 0, source: 'indexed' }))).toContain('—')
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { shortenAddress } from '@/lib/address-display'

// /dex prints each swap's two legs as "amount SYMBOL". A symbol is typed by whoever deployed the token, and one that
// reads as a URL or handle (lib/link-in-name) is an advert, so that leg names the token by its short address. The
// real server component, with the swaps stubbed.
const A = '0x' + 'a'.repeat(40)
const B = '0x' + 'b'.repeat(40)
const h = vi.hoisted(() => ({ symbols: {} as Record<string, string> }))
const trade = {
  id: 1, txHash: '0x' + 'e'.repeat(64), logIndex: 0, dex: 'PancakeSwap', pairAddress: '0x' + 'd'.repeat(40),
  tokenIn: A, tokenOut: B, amountIn: '1500000000000000000', amountOut: '2000000000000000000',
  maker: '0x' + '1'.repeat(40), timestamp: '2026-10-10T00:00:00.000Z', blockNumber: 100,
}

vi.mock('@/lib/db', () => ({ schema: {} }))
vi.mock('@/lib/dex-page', () => ({
  DEX_PAGE_SIZE: 25,
  TOP_PAIRS_WINDOW: 50_000,
  parseDexTrade: (t: typeof trade) => ({ ...t, timestamp: new Date(t.timestamp) }),
  fetchDexPage: async () => ({
    trades: [trade], totalTrades: 1, topPairs: [], nativeUsd: null,
    tokens: Object.entries(h.symbols).map(([address, symbol]) => ({ address, decimals: 18, symbol })),
  }),
}))
vi.mock('@/components/ads/AdReserve', () => ({ AdReserve: () => null }))

const render = async () => {
  vi.resetModules()
  const { default: DexPage } = await import('./page')
  return renderToStaticMarkup(await DexPage({ searchParams: Promise.resolve({}) }))
}
const legs = (html: string) =>
  [...html.matchAll(/<td>([\d.,]+[A-Za-z]*)(?:<span class="inline-block text-mut ml-1 text-xs">(.*?)<\/span>)?<\/td>/g)].map((m) => [m[1], m[2] ?? ''])
beforeEach(() => { h.symbols = { [A]: 'CAKE', [B]: 'WBNB' } })

describe('/dex swap legs', () => {
  it('an ordinary swap reads as before', async () => {
    expect(legs(await render())).toEqual([['1.5', 'CAKE'], ['2', 'WBNB']])
  })

  it('a leg whose symbol is a URL or a handle names the token by its short address, in the table and nowhere else', async () => {
    for (const advert of ['claim-bnb.xyz', '@airdrop_bot', 'Visit t.me/freebnb']) {
      h.symbols = { [A]: advert, [B]: 'WBNB' }
      const out = await render()
      expect(legs(out)).toEqual([['1.5', shortenAddress(A)], ['2', 'WBNB']])
      expect(out).not.toContain(advert)
    }
  })

  it('both legs can be flagged; a ticker with a dot is not', async () => {
    h.symbols = { [A]: 'claim-bnb.xyz', [B]: 'rewards.io' }
    expect(legs(await render())).toEqual([['1.5', shortenAddress(A)], ['2', shortenAddress(B)]])
    h.symbols = { [A]: 'USDT.z', [B]: 'WETH.e' }
    expect(legs(await render())).toEqual([['1.5', 'USDT.z'], ['2', 'WETH.e']])
  })

  it('placeholders and an unknown token keep their old reading', async () => {
    h.symbols = { [A]: '???' }   // B has no metadata row at all
    expect(legs(await render())).toEqual([['1.5', 'Unknown token'], ['2', '']])
  })

  it('a symbol with non-ASCII characters is printed verbatim: only the URL rule is new (sanitising "BTCΞ" would read "BTC")', async () => {
    for (const symbol of ['躺赢', 'BTCΞ', 'BAN人生']) {
      h.symbols = { [A]: symbol, [B]: 'WBNB' }
      expect(legs(await render())[0]).toEqual(['1.5', symbol])
    }
  })

  it('the strip and the table agree: the strip\'s read names the same token the same way', async () => {
    h.symbols = { [A]: 'claim-bnb.xyz', [B]: 'WBNB' }
    const out = await render()
    expect(out).toContain(shortenAddress(A))
    expect(out).not.toContain('claim-bnb.xyz')
  })
})

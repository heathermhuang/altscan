import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { shortenAddress } from '@/lib/address-display'

// /dex prints each swap's two legs as "amount SYMBOL". A symbol is typed by whoever deployed the token, and one that
// reads as a URL or handle (lib/link-in-name) is an advert, so that leg names the token by its short address. The
// real server component, with the swaps stubbed.
const A = '0x' + 'a'.repeat(40)
const B = '0x' + 'b'.repeat(40)
const h = vi.hoisted(() => ({ symbols: {} as Record<string, string>, decimals: {} as Record<string, number>, fail: false, empty: false }))
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
  fetchDexPage: async () => {
    if (h.fail) throw new Error('query failed')
    return {
      trades: h.empty ? [] : [trade], totalTrades: h.empty ? 0 : 1, topPairs: [], nativeUsd: null,
      tokens: Object.entries(h.symbols).map(([address, symbol]) => ({ address, decimals: h.decimals[address] ?? 18, symbol })),
    }
  },
}))
vi.mock('@/components/ads/AdReserve', () => ({ AdReserve: () => null }))

const render = async () => {
  vi.resetModules()
  const { default: DexPage } = await import('./page')
  return renderToStaticMarkup(await DexPage({ searchParams: Promise.resolve({}) }))
}
const legs = (html: string) =>
  [...html.matchAll(/<td>([\d.,]+[A-Za-z]*|—)(?:<span class="inline-block text-mut ml-1 text-xs">(.*?)<\/span>)?<\/td>/g)].map((m) => [m[1], m[2] ?? ''])
beforeEach(() => { h.symbols = { [A]: 'CAKE', [B]: 'WBNB' }; h.decimals = {}; h.fail = false; h.empty = false })

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

  it('placeholders keep their old reading; a token with no metadata row has no known decimals, so its amount is "—", not scaled by 18', async () => {
    h.symbols = { [A]: '???' }   // B has no metadata row at all
    expect(legs(await render())).toEqual([['1.5', 'Unknown token'], ['—', '']])
  })

  it('scales each leg by its own token\'s decimals', async () => {
    h.decimals = { [A]: 6, [B]: 8 }   // 1.5e18 raw / 1e6 = 1.5 trillion; 2e18 / 1e8 = 20 billion
    expect(legs(await render())).toEqual([['1.5T', 'CAKE'], ['20B', 'WBNB']])
  })

  it('a symbol with non-ASCII characters is printed verbatim: only the URL rule is new (sanitising "BTCΞ" would read "BTC")', async () => {
    for (const symbol of ['躺赢', 'BTCΞ', 'BAN人生']) {
      h.symbols = { [A]: symbol, [B]: 'WBNB' }
      expect(legs(await render())[0]).toEqual(['1.5', symbol])
    }
  })

  // The strip draws the same swap as the table row ("... · A -> B"), from its own code path (dexStripTiles). It must name each
  // token exactly as the table's two legs do, so a regression in either one alone breaks the match.
  it('the strip and the table name each token the same way', async () => {
    const stripPair = (html: string) => html.match(/[^<>"]*· ([^<>"·]*→[^<>"·]*)/)?.[1]?.trim()
    for (const symbols of [
      { [A]: 'claim-bnb.xyz', [B]: 'WBNB' },
      { [A]: 'CAKE', [B]: '@airdrop_bot' },
      { [A]: 'CAKE', [B]: 'WBNB' },
      { [A]: '???', [B]: 'USDT.z' },
    ]) {
      h.symbols = symbols
      const out = await render()
      const [inLeg, outLeg] = legs(out).map((l) => l[1])
      expect(stripPair(out), JSON.stringify(symbols)).toBe(`${inLeg} → ${outLeg}`)
    }
    h.symbols = { [A]: 'claim-bnb.xyz', [B]: 'WBNB' }
    expect(stripPair(await render())).toBe(`${shortenAddress(A)} → WBNB`)
  })
})

describe('/dex empty table', () => {
  it('a failed query says the data is unavailable, never that there are no trades', async () => {
    h.fail = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = await render()
    expect(out).toContain('DEX data is temporarily unavailable')
    expect(out).not.toContain('No DEX trades found')
  })

  it('a successful read with no swaps still says none were found', async () => {
    h.empty = true
    const out = await render()
    expect(out).toContain('No DEX trades found')
    expect(out).not.toContain('temporarily unavailable')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chainConfig } from '@/lib/chain'
import { fetchNativeQuote, fetchNativeUsd, NATIVE_PRICE_BUDGET_MS } from '@/lib/native-price'

const BINANCE = /api\.binance\.(us|com)\/api\/v3\/ticker\/price/
const CRYPTOCOMPARE = /min-api\.cryptocompare\.com/
const COINGECKO = /api\.coingecko\.com/
const COINCAP = /api\.coincap\.io/

type Reply = { ok: boolean; body?: unknown } | Error
let replies: Array<[RegExp, Reply]> = []
let calls: string[] = []
let timeouts: number[] = []

beforeEach(() => {
  replies = []
  calls = []
  timeouts = []
  // Record every per-request timeout the helper asks for; the signal itself never fires.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => { timeouts.push(ms); return new AbortController().signal })
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url)
    const hit = replies.find(([re]) => re.test(url))
    if (!hit || hit[1] instanceof Error) throw hit?.[1] ?? new Error('unreachable')
    return { ok: hit[1].ok, json: async () => hit[1] instanceof Error ? null : hit[1].body }
  })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('fetchNativeUsd', () => {
  it('reads the Binance price first and stops there', async () => {
    replies = [[BINANCE, { ok: true, body: { price: '731.25' } }]]
    expect(await fetchNativeUsd()).toBe(731.25)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain(`symbol=${chainConfig.market.binanceSymbol}`)
  })

  it('falls through Binance (both hosts) to CryptoCompare', async () => {
    replies = [[CRYPTOCOMPARE, { ok: true, body: { USD: 700 } }]]
    expect(await fetchNativeUsd()).toBe(700)
    expect(calls.filter(u => BINANCE.test(u))).toHaveLength(2)
  })

  it('a CoinGecko answer without a positive price falls through to CoinCap instead of ending the search', async () => {
    // The tx page's old inline copy returned `usd ?? null` here and never reached CoinCap; a 0 passed as a price.
    replies = [
      [COINGECKO, { ok: true, body: { [chainConfig.coingeckoId]: { usd: 0 } } }],
      [COINCAP, { ok: true, body: { data: { priceUsd: '705.5' } } }],
    ]
    expect(await fetchNativeUsd()).toBe(705.5)
    expect(calls.some(u => COINCAP.test(u))).toBe(true)
  })

  it('never reports a zero, negative or non-numeric price', async () => {
    replies = [
      [BINANCE, { ok: true, body: { price: '0' } }],
      [CRYPTOCOMPARE, { ok: true, body: { USD: -3 } }],
      [COINGECKO, { ok: true, body: {} }],
      [COINCAP, { ok: true, body: { data: { priceUsd: 'n/a' } } }],
    ]
    expect(await fetchNativeUsd()).toBeNull()
  })

  it('is null when every source is down', async () => {
    expect(await fetchNativeUsd()).toBeNull()
  })

  it('has a budget that lets both Binance hosts time out and one fallback answer', async () => {
    // Pinned against the timeouts the helper really asks for, so shortening or lengthening one without the
    // budget the page waits on (lib/whales.ts) cannot leave the later fallbacks unreachable again.
    await fetchNativeUsd()
    const [binanceUs, binanceCom, firstFallback] = timeouts
    expect(NATIVE_PRICE_BUDGET_MS).toBeGreaterThanOrEqual(binanceUs + binanceCom + firstFallback)
  })
})

// The homepage shows the 24h change beside the price, so it needs each source's 24h endpoint: the
// same sources in the same order with the same guard, returning { usd, change24h }.
describe('fetchNativeQuote', () => {
  const BINANCE_24H = /api\.binance\.(us|com)\/api\/v3\/ticker\/24hr/
  const CC_FULL = /min-api\.cryptocompare\.com\/data\/pricemultifull/
  const cc = chainConfig.market.cryptoCompareSymbol

  it('reads the Binance 24h ticker first and stops there', async () => {
    replies = [[BINANCE_24H, { ok: true, body: { lastPrice: '731.25', priceChangePercent: '-1.5' } }]]
    expect(await fetchNativeQuote()).toEqual({ usd: 731.25, change24h: -1.5 })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain(`symbol=${chainConfig.market.binanceSymbol}`)
  })

  it('tries binance.us before binance.com, then falls through to CryptoCompare', async () => {
    replies = [[CC_FULL, { ok: true, body: { RAW: { [cc]: { USD: { PRICE: 700, CHANGEPCT24HOUR: 2.25 } } } } }]]
    expect(await fetchNativeQuote()).toEqual({ usd: 700, change24h: 2.25 })
    expect(calls.filter(u => BINANCE_24H.test(u)).map(u => new URL(u).host)).toEqual(['api.binance.us', 'api.binance.com'])
  })

  it('falls through CryptoCompare to CoinGecko, whose answer carries the 24h change', async () => {
    replies = [[COINGECKO, { ok: true, body: { [chainConfig.coingeckoId]: { usd: 690, usd_24h_change: -0.75 } } }]]
    expect(await fetchNativeQuote()).toEqual({ usd: 690, change24h: -0.75 })
    expect(calls.find(u => COINGECKO.test(u))).toContain('include_24hr_change=true')
  })

  it('falls through CoinGecko to CoinCap', async () => {
    replies = [[COINCAP, { ok: true, body: { data: { priceUsd: '705.5', changePercent24Hr: '3.1' } } }]]
    expect(await fetchNativeQuote()).toEqual({ usd: 705.5, change24h: 3.1 })
  })

  it('a missing or unparseable 24h change reads 0 rather than NaN or undefined', async () => {
    replies = [[BINANCE_24H, { ok: true, body: { lastPrice: '731.25', priceChangePercent: 'n/a' } }]]
    expect(await fetchNativeQuote()).toEqual({ usd: 731.25, change24h: 0 })
    replies = [[COINGECKO, { ok: true, body: { [chainConfig.coingeckoId]: { usd: 690 } } }]]
    expect(await fetchNativeQuote()).toEqual({ usd: 690, change24h: 0 })
  })

  it('a CoinGecko answer without a positive price falls through to CoinCap, like fetchNativeUsd', async () => {
    replies = [
      [COINGECKO, { ok: true, body: { [chainConfig.coingeckoId]: { usd: 0, usd_24h_change: 5 } } }],
      [COINCAP, { ok: true, body: { data: { priceUsd: '705.5', changePercent24Hr: '1' } } }],
    ]
    expect(await fetchNativeQuote()).toEqual({ usd: 705.5, change24h: 1 })
  })

  it('never reports a zero, negative or non-numeric price, and is null when every source is down', async () => {
    replies = [
      [BINANCE_24H, { ok: true, body: { lastPrice: '0', priceChangePercent: '1' } }],
      [CC_FULL, { ok: true, body: { RAW: { [cc]: { USD: { PRICE: -3 } } } } }],
      [COINGECKO, { ok: true, body: {} }],
      [COINCAP, { ok: true, body: { data: { priceUsd: 'n/a' } } }],
    ]
    expect(await fetchNativeQuote()).toBeNull()
    replies = []
    expect(await fetchNativeQuote()).toBeNull()
  })

  it('asks for the same timeouts as fetchNativeUsd, so NATIVE_PRICE_BUDGET_MS covers it too', async () => {
    await fetchNativeUsd()
    const price = [...timeouts]
    timeouts = []
    await fetchNativeQuote()
    expect(timeouts).toEqual(price)
  })

  it('keeps the homepage cache window: each hit is memoised for 60 s, not the 300 s of fetchNativeUsd', async () => {
    const seen: unknown[] = []
    vi.stubGlobal('fetch', async (_url: string, init?: { next?: { revalidate?: number } }) => { seen.push(init?.next?.revalidate); throw new Error('unreachable') })
    await fetchNativeQuote()
    expect(seen).toHaveLength(5) // both Binance hosts, CryptoCompare, CoinGecko, CoinCap
    expect(new Set(seen)).toEqual(new Set([60]))
  })
})

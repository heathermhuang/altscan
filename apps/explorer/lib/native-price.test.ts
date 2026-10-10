import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chainConfig } from '@/lib/chain'
import { fetchNativeQuote, fetchNativeUsd, NATIVE_PRICE_BUDGET_MS } from '@/lib/native-price'

const BINANCE = /api\.binance\.(us|com)\/api\/v3\/ticker\/24hr/
const CRYPTOCOMPARE = /min-api\.cryptocompare\.com\/data\/pricemultifull/
const COINGECKO = /api\.coingecko\.com/
const COINCAP = /api\.coincap\.io/
const cc = chainConfig.market.cryptoCompareSymbol
const cgId = chainConfig.coingeckoId

type Reply = { ok: boolean; body?: unknown } | Error
let replies: Array<[RegExp, Reply]> = []
let calls: string[] = []
let timeouts: number[] = []
let revalidates: unknown[] = []

beforeEach(() => {
  replies = []
  calls = []
  timeouts = []
  revalidates = []
  // Record every per-request timeout the chain asks for; the signal itself never fires.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => { timeouts.push(ms); return new AbortController().signal })
  vi.stubGlobal('fetch', async (url: string, init?: { next?: { revalidate?: number } }) => {
    calls.push(url)
    revalidates.push(init?.next?.revalidate)
    const hit = replies.find(([re]) => re.test(url))
    if (!hit || hit[1] instanceof Error) throw hit?.[1] ?? new Error('unreachable')
    return { ok: hit[1].ok, json: async () => hit[1] instanceof Error ? null : hit[1].body }
  })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('fetchNativeQuote', () => {
  it('reads the Binance 24h ticker first and stops there', async () => {
    replies = [[BINANCE, { ok: true, body: { lastPrice: '731.25', priceChangePercent: '-1.5' } }]]
    expect(await fetchNativeQuote()).toEqual({ price: 731.25, change24h: -1.5 })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain(`symbol=${chainConfig.market.binanceSymbol}`)
  })

  it('tries binance.us before binance.com, then falls through to CryptoCompare', async () => {
    replies = [[CRYPTOCOMPARE, { ok: true, body: { RAW: { [cc]: { USD: { PRICE: 700, CHANGEPCT24HOUR: 2.25 } } } } }]]
    expect(await fetchNativeQuote()).toEqual({ price: 700, change24h: 2.25 })
    expect(calls.filter(u => BINANCE.test(u)).map(u => new URL(u).host)).toEqual(['api.binance.us', 'api.binance.com'])
  })

  it('falls through CryptoCompare to CoinGecko, whose answer carries the 24h change', async () => {
    replies = [[COINGECKO, { ok: true, body: { [cgId]: { usd: 690, usd_24h_change: -0.75 } } }]]
    expect(await fetchNativeQuote()).toEqual({ price: 690, change24h: -0.75 })
    expect(calls.find(u => COINGECKO.test(u))).toContain('include_24hr_change=true')
  })

  it('falls through CoinGecko to CoinCap', async () => {
    replies = [[COINCAP, { ok: true, body: { data: { priceUsd: '705.5', changePercent24Hr: '3.1' } } }]]
    expect(await fetchNativeQuote()).toEqual({ price: 705.5, change24h: 3.1 })
  })

  it('a CoinGecko answer without a positive price falls through to CoinCap instead of ending the search', async () => {
    // The tx page's old inline copy returned `usd ?? null` here and never reached CoinCap; a 0 passed as a price.
    replies = [
      [COINGECKO, { ok: true, body: { [cgId]: { usd: 0, usd_24h_change: 5 } } }],
      [COINCAP, { ok: true, body: { data: { priceUsd: '705.5', changePercent24Hr: '1' } } }],
    ]
    expect(await fetchNativeQuote()).toEqual({ price: 705.5, change24h: 1 })
    expect(calls.some(u => COINCAP.test(u))).toBe(true)
  })

  it('never reports a zero, negative or non-numeric price, and is null when every source is down', async () => {
    replies = [
      [BINANCE, { ok: true, body: { lastPrice: '0', priceChangePercent: '1' } }],
      [CRYPTOCOMPARE, { ok: true, body: { RAW: { [cc]: { USD: { PRICE: -3 } } } } }],
      [COINGECKO, { ok: true, body: {} }],
      [COINCAP, { ok: true, body: { data: { priceUsd: 'n/a' } } }],
    ]
    expect(await fetchNativeQuote()).toBeNull()
    replies = []
    expect(await fetchNativeQuote()).toBeNull()
  })

  describe('a source that gives a price but no 24h change reports the change as null, never 0', () => {
    it.each([
      ['Binance, field missing', BINANCE, { lastPrice: '731.25' }],
      ['Binance, not a number', BINANCE, { lastPrice: '731.25', priceChangePercent: 'n/a' }],
      ['CryptoCompare, field missing', CRYPTOCOMPARE, { RAW: { [cc]: { USD: { PRICE: 731.25 } } } }],
      ['CoinGecko, field missing', COINGECKO, { [cgId]: { usd: 731.25 } }],
      ['CoinGecko, null', COINGECKO, { [cgId]: { usd: 731.25, usd_24h_change: null } }],
      ['CoinCap, field missing', COINCAP, { data: { priceUsd: '731.25' } }],
      ['CoinCap, not a number', COINCAP, { data: { priceUsd: '731.25', changePercent24Hr: 'n/a' } }],
    ])('%s', async (_label, source, body) => {
      replies = [[source, { ok: true, body }]]
      expect(await fetchNativeQuote()).toEqual({ price: 731.25, change24h: null })
    })

    it('but a reported change of exactly 0 stays 0', async () => {
      replies = [[BINANCE, { ok: true, body: { lastPrice: '731.25', priceChangePercent: '0.000' } }]]
      expect(await fetchNativeQuote()).toEqual({ price: 731.25, change24h: 0 })
    })
  })

  it('memoises each hit for five minutes by default, or for the window the caller passes', async () => {
    await fetchNativeQuote()
    expect(revalidates).toHaveLength(5) // both Binance hosts, CryptoCompare, CoinGecko, CoinCap
    expect(new Set(revalidates)).toEqual(new Set([300]))
    revalidates = []
    await fetchNativeQuote(60)
    expect(new Set(revalidates)).toEqual(new Set([60]))
  })

  it('asks for the two Binance timeouts, then one per fallback', async () => {
    await fetchNativeQuote()
    expect(timeouts).toEqual([3000, 3000, 5000, 5000, 5000])
  })

  it('has a budget that lets both Binance hosts time out and one fallback answer', async () => {
    // Pinned against the timeouts the chain really asks for, so shortening or lengthening one without the
    // budget the page waits on (lib/whales.ts) cannot leave the later fallbacks unreachable again.
    await fetchNativeQuote()
    const [binanceUs, binanceCom, firstFallback] = timeouts
    expect(NATIVE_PRICE_BUDGET_MS).toBeGreaterThanOrEqual(binanceUs + binanceCom + firstFallback)
  })
})

describe('fetchNativeUsd', () => {
  it('is the quote chain\'s price, without the change', async () => {
    replies = [[BINANCE, { ok: true, body: { lastPrice: '731.25', priceChangePercent: '-1.5' } }]]
    expect(await fetchNativeUsd()).toBe(731.25)
    expect(calls).toHaveLength(1)
  })

  it('takes a price from a later source when the change is missing', async () => {
    replies = [[COINGECKO, { ok: true, body: { [cgId]: { usd: 690 } } }]]
    expect(await fetchNativeUsd()).toBe(690)
  })

  it('keeps the five-minute memoisation its callers had', async () => {
    await fetchNativeUsd()
    expect(new Set(revalidates)).toEqual(new Set([300]))
  })

  it('is null when every source is down, or none gives a usable price', async () => {
    expect(await fetchNativeUsd()).toBeNull()
    replies = [[BINANCE, { ok: true, body: { lastPrice: '0' } }], [COINCAP, { ok: true, body: { data: { priceUsd: 'n/a' } } }]]
    expect(await fetchNativeUsd()).toBeNull()
  })
})

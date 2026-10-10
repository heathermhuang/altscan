import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chainConfig } from '@/lib/chain'
import { fetchNativeUsd, NATIVE_PRICE_BUDGET_MS } from '@/lib/native-price'

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

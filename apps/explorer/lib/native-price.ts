/**
 * The native coin's USD price and 24h change: Binance first (binance.us before .com, since Render is
 * US-based), then CryptoCompare, CoinGecko and CoinCap. The one chain behind the homepage
 * (`fetchNativeQuote`), the tx page, the address page and /whales (`fetchNativeUsd`, the price
 * alone). `null` when every source fails; callers label that, they never invent a price.
 *
 * Every source must answer with a price > 0 to count. That is the stricter of the two guards the
 * old inline copies disagreed on: the tx page's CoinGecko step returned `usd ?? null`, so a
 * response without a usable price ended the search there (never trying CoinCap) and a 0 passed as
 * a price. Here such a response falls through to the next source.
 *
 * The change is read from the same response as the price and is `null` when that source gave none
 * (or one that is not a number): a missing change is never reported as 0%.
 *
 * Server-side only; each hit is memoised by Next's fetch cache for `revalidateSeconds` (default five
 * minutes; the homepage passes its own 60).
 */
import { chainConfig } from './chain'
import { swallow } from './observability'

const BINANCE_TIMEOUT_MS = 3000
const FALLBACK_TIMEOUT_MS = 5000

/**
 * How long a caller that wants to bound its wait should allow: both Binance hosts timing out and
 * the first fallback answering. A smaller budget makes every fallback after Binance unreachable
 * whenever Binance hangs (the test pins this against the timeouts above).
 */
export const NATIVE_PRICE_BUDGET_MS = 2 * BINANCE_TIMEOUT_MS + FALLBACK_TIMEOUT_MS

/** The price, and the 24h percentage change when the source gave one (`null` when it did not). */
export type NativeQuote = { price: number; change24h: number | null }

/** A source's 24h change as a finite number, or null. Never a made-up 0. */
function percent(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

export async function fetchNativeQuote(revalidateSeconds = 300): Promise<NativeQuote | null> {
  const binanceSymbol = chainConfig.market.binanceSymbol
  const ccSymbol = chainConfig.market.cryptoCompareSymbol
  const next = { revalidate: revalidateSeconds }

  for (const host of ['https://api.binance.us', 'https://api.binance.com']) {
    try {
      const res = await fetch(
        `${host}/api/v3/ticker/24hr?symbol=${binanceSymbol}`,
        { next, signal: AbortSignal.timeout(BINANCE_TIMEOUT_MS) },
      )
      if (res.ok) {
        const data = await res.json()
        const price = parseFloat(data.lastPrice)
        if (price > 0) return { price, change24h: percent(data.priceChangePercent) }
      }
    } catch { /* try next */ }
  }

  try {
    const res = await fetch(
      `https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${ccSymbol}&tsyms=USD`,
      { next, signal: AbortSignal.timeout(FALLBACK_TIMEOUT_MS) },
    )
    if (res.ok) {
      const raw = (await res.json())?.RAW?.[ccSymbol]?.USD
      if (raw?.PRICE > 0) return { price: raw.PRICE, change24h: percent(raw.CHANGEPCT24HOUR) }
    }
  } catch { /* try next */ }

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${chainConfig.coingeckoId}&vs_currencies=usd&include_24hr_change=true`,
      { next, signal: AbortSignal.timeout(FALLBACK_TIMEOUT_MS) },
    )
    if (res.ok) {
      const coin = (await res.json())[chainConfig.coingeckoId]
      if (coin?.usd > 0) return { price: coin.usd, change24h: percent(coin.usd_24h_change) }
    }
  } catch { /* try next */ }

  try {
    const res = await fetch(
      `https://api.coincap.io/v2/assets/${chainConfig.market.coincapId}`,
      { next, signal: AbortSignal.timeout(FALLBACK_TIMEOUT_MS) },
    )
    if (res.ok) {
      const data = (await res.json())?.data
      const price = parseFloat(data?.priceUsd)
      if (price > 0) return { price, change24h: percent(data?.changePercent24Hr) }
    }
  } catch (e) { swallow('native-price/all-failed', e) }

  return null
}

/** The price alone, for callers that show no change. */
export async function fetchNativeUsd(): Promise<number | null> {
  return (await fetchNativeQuote())?.price ?? null
}

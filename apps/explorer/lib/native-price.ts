/**
 * The native coin's USD price: Binance first (binance.us before .com, since Render is US-based),
 * then CryptoCompare, CoinGecko and CoinCap. The one implementation behind the tx page, the address
 * page and /whales; the homepage reads `fetchNativeQuote`, the same sources and order with each one's
 * 24h change. `null` when every source fails; callers label that, they never invent a price.
 *
 * Every source must answer with a price > 0 to count. That is the stricter of the two guards the
 * old inline copies disagreed on: the tx page's CoinGecko step returned `usd ?? null`, so a
 * response without a usable price ended the search there (never trying CoinCap) and a 0 passed as
 * a price. Here such a response falls through to the next source.
 *
 * Server-side only; each hit is memoised by Next's fetch cache for five minutes (`fetchNativeQuote`:
 * one minute, the homepage's own window).
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

export async function fetchNativeUsd(): Promise<number | null> {
  const binanceSymbol = chainConfig.market.binanceSymbol
  const ccSymbol = chainConfig.market.cryptoCompareSymbol

  for (const host of ['https://api.binance.us', 'https://api.binance.com']) {
    try {
      const res = await fetch(
        `${host}/api/v3/ticker/price?symbol=${binanceSymbol}`,
        { next: { revalidate: 300 }, signal: AbortSignal.timeout(BINANCE_TIMEOUT_MS) },
      )
      if (res.ok) {
        const price = parseFloat((await res.json()).price)
        if (price > 0) return price
      }
    } catch { /* try next */ }
  }

  try {
    const res = await fetch(
      `https://min-api.cryptocompare.com/data/price?fsym=${ccSymbol}&tsyms=USD`,
      { next: { revalidate: 300 }, signal: AbortSignal.timeout(FALLBACK_TIMEOUT_MS) },
    )
    if (res.ok) {
      const data = await res.json()
      if (data?.USD > 0) return data.USD
    }
  } catch { /* try next */ }

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${chainConfig.coingeckoId}&vs_currencies=usd`,
      { next: { revalidate: 300 }, signal: AbortSignal.timeout(FALLBACK_TIMEOUT_MS) },
    )
    if (res.ok) {
      const usd = (await res.json())[chainConfig.coingeckoId]?.usd
      if (usd > 0) return usd
    }
  } catch { /* try next */ }

  try {
    const res = await fetch(
      `https://api.coincap.io/v2/assets/${chainConfig.market.coincapId}`,
      { next: { revalidate: 300 }, signal: AbortSignal.timeout(FALLBACK_TIMEOUT_MS) },
    )
    if (res.ok) {
      const price = parseFloat((await res.json())?.data?.priceUsd)
      if (price > 0) return price
    }
  } catch (e) { swallow('native-price/all-failed', e) }

  return null
}

/**
 * The price with its 24h change, for the homepage's Price and Market Cap cards. The same sources in the
 * same order, timeouts and `> 0` guard as `fetchNativeUsd`, but each source's 24h endpoint, memoised for
 * one minute (the page's `revalidate`). A source that answers without a usable change reads 0, not NaN.
 */
export async function fetchNativeQuote(): Promise<{ usd: number; change24h: number } | null> {
  const binanceSymbol = chainConfig.market.binanceSymbol
  const ccSymbol = chainConfig.market.cryptoCompareSymbol

  for (const host of ['https://api.binance.us', 'https://api.binance.com']) {
    try {
      const res = await fetch(
        `${host}/api/v3/ticker/24hr?symbol=${binanceSymbol}`,
        { next: { revalidate: 60 }, signal: AbortSignal.timeout(BINANCE_TIMEOUT_MS) },
      )
      if (res.ok) {
        const data = await res.json()
        const price = parseFloat(data.lastPrice)
        if (price > 0) return { usd: price, change24h: parseFloat(data.priceChangePercent) || 0 }
      }
    } catch { /* try next */ }
  }

  try {
    const res = await fetch(
      `https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${ccSymbol}&tsyms=USD`,
      { next: { revalidate: 60 }, signal: AbortSignal.timeout(FALLBACK_TIMEOUT_MS) },
    )
    if (res.ok) {
      const raw = (await res.json())?.RAW?.[ccSymbol]?.USD
      if (raw?.PRICE > 0) return { usd: raw.PRICE, change24h: raw.CHANGEPCT24HOUR ?? 0 }
    }
  } catch { /* try next */ }

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${chainConfig.coingeckoId}&vs_currencies=usd&include_24hr_change=true`,
      { next: { revalidate: 60 }, signal: AbortSignal.timeout(FALLBACK_TIMEOUT_MS) },
    )
    if (res.ok) {
      const coin = (await res.json())[chainConfig.coingeckoId]
      if (coin?.usd > 0) return { usd: coin.usd, change24h: coin.usd_24h_change ?? 0 }
    }
  } catch { /* try next */ }

  try {
    const res = await fetch(
      `https://api.coincap.io/v2/assets/${chainConfig.market.coincapId}`,
      { next: { revalidate: 60 }, signal: AbortSignal.timeout(FALLBACK_TIMEOUT_MS) },
    )
    if (res.ok) {
      const data = (await res.json())?.data
      const price = parseFloat(data?.priceUsd)
      if (price > 0) return { usd: price, change24h: parseFloat(data?.changePercent24Hr) || 0 }
    }
  } catch (e) { swallow('native-price/quote-all-failed', e) }

  return null
}

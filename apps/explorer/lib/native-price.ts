/**
 * The native coin's USD price: Binance first (binance.us before .com, since Render is US-based),
 * then CryptoCompare, CoinGecko and CoinCap. The one implementation behind the tx page and /whales
 * (the homepage and address page still inline their own chains). `null` when every source fails;
 * callers label that, they never invent a price.
 *
 * Every source must answer with a price > 0 to count. That is the stricter of the two guards the
 * old inline copies disagreed on: the tx page's CoinGecko step returned `usd ?? null`, so a
 * response without a usable price ended the search there (never trying CoinCap) and a 0 passed as
 * a price. Here such a response falls through to the next source.
 *
 * Server-side only; each hit is memoised by Next's fetch cache for five minutes.
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

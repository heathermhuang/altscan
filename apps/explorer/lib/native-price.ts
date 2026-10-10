/**
 * The native coin's USD price: Binance first (binance.us before .com, since Render is US-based),
 * then CryptoCompare, CoinGecko and CoinCap. The same chain and per-chain symbols the homepage,
 * the tx page and the address page already use, as one function for the pages that have not
 * inlined their own. `null` when every source fails; callers label that, they never invent a price.
 * Server-side only; each hit is memoised by Next's fetch cache for five minutes.
 */
import { chainConfig } from './chain'
import { swallow } from './observability'

export async function fetchNativeUsd(): Promise<number | null> {
  const binanceSymbol = chainConfig.market.binanceSymbol
  const ccSymbol = chainConfig.market.cryptoCompareSymbol

  for (const host of ['https://api.binance.us', 'https://api.binance.com']) {
    try {
      const res = await fetch(
        `${host}/api/v3/ticker/price?symbol=${binanceSymbol}`,
        { next: { revalidate: 300 }, signal: AbortSignal.timeout(3000) },
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
      { next: { revalidate: 300 }, signal: AbortSignal.timeout(5000) },
    )
    if (res.ok) {
      const data = await res.json()
      if (data?.USD > 0) return data.USD
    }
  } catch { /* try next */ }

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${chainConfig.coingeckoId}&vs_currencies=usd`,
      { next: { revalidate: 300 }, signal: AbortSignal.timeout(5000) },
    )
    if (res.ok) {
      const usd = (await res.json())[chainConfig.coingeckoId]?.usd
      if (usd > 0) return usd
    }
  } catch { /* try next */ }

  try {
    const res = await fetch(
      `https://api.coincap.io/v2/assets/${chainConfig.market.coincapId}`,
      { next: { revalidate: 300 }, signal: AbortSignal.timeout(5000) },
    )
    if (res.ok) {
      const price = parseFloat((await res.json())?.data?.priceUsd)
      if (price > 0) return price
    }
  } catch (e) { swallow('native-price/all-failed', e) }

  return null
}

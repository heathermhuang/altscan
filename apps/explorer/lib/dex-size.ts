/**
 * The /dex recent-swaps strip as pure data: one tile per swap on the page, width = its USD size.
 *
 * What a size is, and is not. A swap is sized from ONE of its legs, by contract address (never by symbol,
 * which anyone can choose): a stablecoin the chain config tracks counts $1 per coin (a PEG ASSUMPTION, the
 * same one /whales makes), the wrapped native token counts the native price. Stablecoin first (the pegged
 * price beats a market quote), then the IN leg before the OUT leg. A swap with neither leg, or a native leg
 * with no usable native price, has NO size: it is drawn hatched at a fixed width (flex-grow 0) rather than
 * given one, and every label says so. Width is the size in whole dollars, linear: a $400k swap beside
 * $90 ones leaves those at the CSS floor, which is the truth about their size.
 *
 * Pure: the page passes the cached trades and the cached native price (lib/dex-page.ts).
 */
import type { WhaleConfig } from '@altscan/chain-config'
import { chainConfig } from '@/lib/chain'
import { shortenAddress, shortHash } from '@/lib/address-display'
import { formatCompactUsd } from '@/lib/format'
import { clipText } from '@/lib/clip-text'
import { looksLikeUrlOrHandle } from '@/lib/link-in-name'
import type { StripTile } from '@/lib/tape'

export interface DexSwap {
  id: number
  txHash: string
  tokenIn: string | null
  tokenOut: string | null
  amountIn: string
  amountOut: string
}

type Cfg = Pick<WhaleConfig, 'wrapped' | 'stablecoins'>

/**
 * `amount` base units as dollars, to a millionth of one: the amount is multiplied by the price (in micro-dollars
 * a coin) BEFORE it is divided down by the decimals, so a leg worth less than a hundredth of a coin is still
 * priced (flooring the amount to hundredths first read 0.009 WBNB as $0 and 1.999 WETH as $5,970 instead of $5,997).
 * Null when the amount is not a non-negative integer.
 */
function dollars(amount: string, decimals: number, perCoin: number): number | null {
  if (!/^\d+$/.test(amount)) return null
  const micro = (BigInt(amount) * BigInt(Math.round(perCoin * 1e6))) / 10n ** BigInt(decimals)
  return Number(micro) / 1e6
}

/** The swap's size in USD, or null when it cannot be sized (see the module note). */
export function tradeUsd(t: DexSwap, nativeUsd: number | null, cfg: Cfg = chainConfig.whales): number | null {
  const legs = [
    { token: t.tokenIn?.toLowerCase(), amount: t.amountIn },
    { token: t.tokenOut?.toLowerCase(), amount: t.amountOut },
  ]
  for (const leg of legs) {
    const stable = cfg.stablecoins.find(s => s.address.toLowerCase() === leg.token)
    const usd = stable ? dollars(leg.amount, stable.decimals, 1) : null
    if (usd !== null) return usd
  }
  const native = nativeUsd !== null && Number.isFinite(nativeUsd) && nativeUsd > 0 ? nativeUsd : null
  if (native === null) return null
  for (const leg of legs) {
    if (leg.token === cfg.wrapped.address.toLowerCase()) {
      const usd = dollars(leg.amount, cfg.wrapped.decimals, native)
      if (usd !== null) return usd
    }
  }
  return null
}

/** A symbol is typed by whoever deploys the token: one that reads as a web address or a handle is an advert (lib/link-in-name.ts), so the token is named by its short address. */
const symbolText = (symbolOf: (address: string | null) => string, address: string | null) => {
  const s = symbolOf(address)
  return clipText(looksLikeUrlOrHandle(s) && address ? shortenAddress(address) : s, 14)
}

/** One tile per swap, oldest first (= left to right); `swaps` come newest first, as the page lists them. */
export function dexStripTiles(
  swaps: readonly DexSwap[],
  nativeUsd: number | null,
  symbolOf: (address: string | null) => string,
  cfg: Cfg = chainConfig.whales,
): StripTile[] {
  return [...swaps].reverse().map((t): StripTile => {
    const usd = tradeUsd(t, nativeUsd, cfg)
    const pair = `${symbolText(symbolOf, t.tokenIn)} → ${symbolText(symbolOf, t.tokenOut)}`
    return {
      id: String(t.id),
      href: `/tx/${t.txHash}`,
      w: usd === null ? 0 : Math.max(1, Math.round(usd)),
      f: usd === null ? 0 : 100,
      name: `Swap ${shortHash(t.txHash)}`,
      read: usd === null ? `not priced · ${pair}` : `${formatCompactUsd(usd)} · ${pair}`,
      ...(usd === null ? { hatch: true } : {}),
    }
  })
}

/** The measure, said exactly; two lines at most on a phone (test-support/legend-lines.ts). */
export function dexLegend(currency: string, nativePriced: boolean): string {
  return nativePriced
    ? `width = USD size (stablecoins $1, ${currency} at market) · ▨ not priced`
    : 'width = USD size (stablecoins at $1 only) · ▨ not priced'
}

/** The strip's text alternative (the trades table has every swap). */
export function dexSummary(swaps: readonly DexSwap[], nativeUsd: number | null, currency: string, cfg: Cfg = chainConfig.whales): string {
  const sizes = swaps.map(t => tradeUsd(t, nativeUsd, cfg))
  const priced = sizes.filter((u): u is number => u !== null)
  const n = swaps.length
  const nativePriced = nativeUsd !== null && Number.isFinite(nativeUsd) && nativeUsd > 0
  return `${n} swap${n === 1 ? '' : 's'}${n === 1 ? ':' : ', oldest to newest:'} `
    + (priced.length > 0 ? `${priced.length} sized in USD (the largest ${formatCompactUsd(Math.max(...priced))})` : 'none sized in USD')
    + `, ${n - priced.length} not priced and drawn hatched at a fixed width. `
    + (nativePriced
      ? `Stablecoins are counted at $1 and ${currency} at its market price.`
      : `Stablecoins are counted at $1; ${currency} legs are not priced because the ${currency} price is unavailable.`)
}

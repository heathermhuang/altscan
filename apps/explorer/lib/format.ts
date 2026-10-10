import { formatUnits } from 'ethers'
import { shortenAddress } from './address-display'
import { anyLinkLike } from './link-in-name'

/** Safely convert a numeric string (possibly with decimals) to BigInt */
export function safeBigInt(value: string | number | bigint | null | undefined): bigint {
  if (value == null) return 0n
  if (typeof value === 'bigint') return value
  const str = String(value)
  const intPart = str.split('.')[0] || '0'
  try {
    return BigInt(intPart)
  } catch {
    return 0n
  }
}

/**
 * What a non-zero amount that rounds to nothing at `places` decimals reads: "<0.0001" for
 * four places. The one rule for every fixed-decimal amount, so a dust amount never renders
 * as "0.0000" (or "0"), which says the amount is nothing. Zero itself stays "0".
 */
export function tinyAmount(places: number): string {
  return `<0.${'0'.repeat(places - 1)}1`
}

/**
 * Adaptive-precision native-token amount: rounds to at most `maxDecimals` places
 * and trims trailing zeros, so "1.5" doesn't render as "1.5000". A nonzero
 * amount that rounds away to nothing at this precision renders as "<0.0001"
 * (or "<0.000001" for maxDecimals=6, etc.) instead of an indistinguishable "0" —
 * that's what fixes small transfers rendering identically to zero-value calls.
 *
 * Works entirely in BigInt, never Number: unlike formatGwei below, native-token
 * amounts can exceed 2^53, where Number(formatEther(wei)) silently loses digits.
 *
 * Assumes 1 <= maxDecimals <= 18 (wei's own precision). Every call site passes
 * either the default or 6, so this isn't guarded; maxDecimals=0 would throw
 * from the '0'.repeat(maxDecimals - 1) below.
 */
export function formatNativeToken(wei: bigint | string, maxDecimals = 4): string {
  const value = safeBigInt(wei)
  if (value === 0n) return '0'

  const scale = 10n ** BigInt(18 - maxDecimals)
  const rounded = (value + scale / 2n) / scale // round-half-up, in units of 10^-maxDecimals

  if (rounded === 0n) {
    return tinyAmount(maxDecimals)
  }

  const divisor = 10n ** BigInt(maxDecimals)
  const intPart = rounded / divisor
  const fracRemainder = rounded % divisor
  const combined =
    fracRemainder === 0n
      ? `${intPart}` // exact whole number — no fractional part to show at all
      : `${intPart}.${fracRemainder.toString().padStart(maxDecimals, '0')}`
  // Only trim when a decimal point is present. formatGwei's `/\.?0+$/` below is
  // safe there only because toFixed(decimals>=1) always emits a dot; applied to
  // a dot-less string (as `combined` is above, for a whole number) it would
  // corrupt real digits, e.g. "1000" -> "1".
  return combined.includes('.') ? combined.replace(/0+$/, '').replace(/\.$/, '') : combined
}

/** @deprecated Use formatNativeToken instead */
export const formatBNB = formatNativeToken
export const formatETH = formatNativeToken

export function formatGwei(wei: bigint | string): string {
  const gwei = Number(formatUnits(safeBigInt(wei), 'gwei'))
  if (gwei === 0) return '0'
  // BNB Chain runs sub-Gwei gas (~0.05 Gwei). toFixed(2) collapsed these to "0.00".
  // Use adaptive precision and trim trailing zeros so 0.1 shows as "0.1", not "0.10".
  const decimals = gwei < 0.01 ? 6 : gwei < 1 ? 4 : 2
  return gwei.toFixed(decimals).replace(/\.?0+$/, '')
}

export function formatAddress(addr: string, chars = 6): string {
  return `${addr.slice(0, chars)}...${addr.slice(-4)}`
}

export function formatNumber(n: number | bigint): string {
  if (typeof n === 'bigint') return n.toLocaleString('en-US')
  return Number(n).toLocaleString('en-US')
}

/**
 * A holder count, or "—" when it is 0. Counts are recomputed on an interval (and the token
 * row starts at 0), so a 0 above a populated holder list is a lag artifact, not a reading.
 */
export function formatHolders(n: number | null | undefined): string {
  return n && Number.isFinite(n) ? formatNumber(n) : '—'
}

/** A derived figure, marked as one: "≈ 4,383". "—" when there is nothing to estimate. */
export function formatEstimate(n: number | null | undefined): string {
  return n && Number.isFinite(n) && n > 0 ? `≈ ${formatNumber(n)}` : '—'
}

/**
 * Whether a stored total supply is a real reading. The indexer writes '0' when its
 * totalSupply() call fails (and NFT contracts often have none), so null, '' and 0 all mean
 * "unknown" — never "a supply of zero".
 */
export function hasSupply(raw: string | null | undefined): boolean {
  return safeBigInt(raw) > 0n
}

/** Adaptive USD price: 2dp for ≥$1, 4dp for ≥$0.01, up to 8dp for micro-caps. */
export function formatUsdPrice(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const max = n >= 1 ? 2 : n >= 0.01 ? 4 : 8
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: max })}`
}

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 })
// 999.995T is the first value that would round to "1000T", so it is where the ladder stops.
const COMPACT_CAP = 999_995_000_000_000

/**
 * The one compact number: 8265400000 -> "8.27B", 345600000 -> "345.6M", 12340 -> "12.34K".
 * Up to two decimals, no trailing zeros, and a value that rounds up to the next unit
 * carries into it (999995 -> "1M", never "1000K"). Intl rounds on the decimal reading, so the
 * carry holds at every boundary.
 *
 * T is the last unit. A figure past 999T reads "999T+", the way a capped count elsewhere reads
 * "10,000+": such a supply or market value is a junk or unit-confused token, and "1000000.00T"
 * would only pretend to precision it does not have. A non-zero value that would round to 0.00
 * reads "<0.01" (or ">-0.01" below zero), never "0" or "-0". `prefix` goes in front of the
 * digits, after any sign ("-$5M"). "—" when there is no number.
 */
export function formatCompact(n: number | null | undefined, prefix = ''): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs >= COMPACT_CAP) return `${sign}${prefix}999T+`
  if (abs > 0 && abs < 0.005) return n > 0 ? `<${prefix}0.01` : `>-${prefix}0.01`
  return `${sign}${prefix}${COMPACT.format(abs)}`
}

/** Compact USD for large figures: $1.25B, $345.6M, $12.34K, $999T+. */
export function formatCompactUsd(n: number | null | undefined): string {
  return formatCompact(n, '$')
}

/**
 * A token amount for a dense table, from its raw base units: exact to four places under 1,000
 * (trailing zeros trimmed, dust as "<0.0001"), the compact ladder from 1,000 up. The two rules
 * are formatTokenAmount's tiny-amount floor and formatCompact, not a third pair of thresholds.
 */
export function formatAmountCompact(raw: string | bigint, decimals: number): string {
  const units = safeBigInt(raw)
  if (units >= 1000n * 10n ** BigInt(decimals)) return formatCompact(Number(formatUnits(units, decimals)))
  return formatTokenAmount(units, decimals, 4)
}

/** Signed percentage to 2dp, e.g. "+3.20%" / "-1.50%". */
export function formatPercent(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

export function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 0) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

/**
 * The one absolute-timestamp format: `2026-10-04 23:04:41 UTC`.
 *
 * Built from the getUTC parts, never toLocaleString or toUTCString: those depend on the
 * server's locale and timezone, so the same instant rendered three different
 * ways across the explorer. Relative strings stay with timeAgo.
 */
export function formatUtc(date: Date | string | number): string {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return '—'
  const p2 = (n: number) => String(n).padStart(2, '0')
  const ymd = `${String(d.getUTCFullYear()).padStart(4, '0')}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`
  return `${ymd} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC`
}

export function formatHash(hash: string, chars = 16): string {
  return `${hash.slice(0, chars)}...${hash.slice(-4)}`
}

/**
 * Sanitize token symbol/name to strip homoglyph/confusable Unicode characters.
 *
 * Re-exported from @altscan/explorer-core rather than duplicated. A4b-0 briefly
 * had two byte-identical copies of this \u2014 a bad shape for a security-relevant
 * sanitizer, since a fix landing in one copy leaves the other exploitable. It is
 * a pure string function with no server-only imports, so it bundles fine on the
 * client. Note it now returns '' (not the raw input) when nothing survives.
 *
 * Imported via the `/format` SUBPATH, never the package barrel: the barrel
 * re-exports ./redis-client, so `from '@altscan/explorer-core'` here would drag
 * ioredis into the client bundle of every 'use client' consumer of this file
 * (TxnsLazy, TransfersLazy, HoldersLazy all import it).
 */
export { sanitizeSymbol } from '@altscan/explorer-core/format'

import { sanitizeSymbol as _sanitizeSymbol } from '@altscan/explorer-core/format'

/**
 * `sanitizeSymbol` with an explicit fallback for the all-confusable case.
 *
 * Call sites used to branch on the truthiness of the RAW value
 * (`h.symbol ? sanitizeSymbol(h.symbol) : '—'`), which silently renders blank
 * now that sanitizeSymbol returns '' instead of handing back the raw input. The
 * decision has to be made on the SANITIZED result, so make it once here.
 */
export function sanitizeSymbolOr(raw: string | null | undefined, fallback: string): string {
  return tokenTextOr(raw ? _sanitizeSymbol(raw) : '', fallback)
}

/** What a token slot reads when its symbol/name is unknown. */
export const UNKNOWN_TOKEN = 'Unknown token'

/** `23:04 UTC`: the clock part of formatUtc, for a label that says when a page was rendered. */
export function formatUtcClock(date: Date | string | number): string {
  const full = formatUtc(date)
  return full === '—' ? full : `${full.slice(11, 16)} UTC`
}

// The indexer persists symbol='???' / name='Unknown' when it cannot read them
// (see app/token/[address]/page.tsx), and the page's live RPC lookup names a nameless
// token 'Unknown Token'. Those are "missing", not a real symbol.
const PLACEHOLDER_TOKEN_TEXT: ReadonlySet<string> = new Set(['???', 'Unknown', 'Unknown Token'])

/** `raw` unless it is empty or an indexer placeholder. Does NOT sanitise — for text already shown verbatim. */
export function tokenTextOr(raw: string | null | undefined, fallback: string): string {
  return raw && !PLACEHOLDER_TOKEN_TEXT.has(raw) ? raw : fallback
}

/**
 * Text for a "Token" column: sanitised symbol, else sanitised name. When nothing
 * printable survives, an indexer placeholder reads "Unknown token"; but a real
 * symbol that the sanitiser stripped (all non-ASCII, e.g. CJK) is not unknown, so
 * that shows the short contract address instead of mislabelling it.
 */
export function tokenLabel(symbol: string | null | undefined, name: string | null | undefined, address: string): string {
  const printable = sanitizeSymbolOr(symbol, '') || sanitizeSymbolOr(name, '')
  if (printable) return printable
  return tokenTextOr(symbol, '') || tokenTextOr(name, '') ? shortenAddress(address) : UNKNOWN_TOKEN
}

/**
 * Every text a page prints for a token, decided once. A symbol or name is typed by whoever deployed the contract,
 * and one that reads as a URL or handle is an advert (lib/link-in-name), so:
 *  - `symbol` is the inline unit ("1,000 SYM"): the sanitised symbol ('' when it has none, so the amount prints bare),
 *    or the token's short address when the symbol reads as a URL or handle. An amount never repeats the advert.
 *  - `name` is a name cell's text (`tokenLabel`). It is never replaced: a table keeps the text and badges it.
 *  - `linkLike` is true when the symbol or the name (raw, or as sanitised: a Cyrillic "с" in ".сom" reads as
 *    ".com" once mapped) reads as a URL or handle. It drives the badge, and metadata uses the short address.
 * Nothing here, or at any caller, ever makes the text a link.
 */
export function tokenText(
  symbol: string | null | undefined,
  name: string | null | undefined,
  address: string,
): { symbol: string; name: string; linkLike: boolean } {
  const printable = sanitizeSymbolOr(symbol, '')
  return {
    symbol: anyLinkLike(symbol, printable) ? shortenAddress(address) : printable,
    name: tokenLabel(symbol, name, address),
    // The label is the sanitised symbol or the sanitised name (or an address), so judging both sanitised forms covers it.
    linkLike: anyLinkLike(symbol, printable, name, sanitizeSymbolOr(name, '')),
  }
}

/**
 * A token's symbol as inline text where the page prints it exactly as it always did (the token page, its holders table, a
 * /dex leg): the symbol as given, except a symbol that reads as a URL or handle is the token's short address. Only the URL
 * rule is applied, unlike `tokenText().symbol`, which also sanitises. The symbol side of `tokenText`, without the label.
 */
export function tokenUnit(symbol: string, address: string): string {
  return anyLinkLike(symbol, sanitizeSymbolOr(symbol, '')) ? shortenAddress(address) : symbol
}

/**
 * `units` base units as a decimal string with `places` decimals ("1500000000000000000", 18 -> "1.5"; a whole
 * number keeps a ".0", except at 0 places), exactly ethers' formatUnits. Plain BigInt on purpose: formatUnits drags ethers' units
 * code into every client chunk that imports this module once a client component formats an amount.
 */
export function unitsToDecimal(units: bigint, places: number): string {
  const sign = units < 0n ? '-' : ''
  const digits = (units < 0n ? -units : units).toString().padStart(places + 1, '0')
  if (places === 0) return sign + digits
  const frac = digits.slice(digits.length - places).replace(/0+$/, '')
  return `${sign}${digits.slice(0, digits.length - places)}.${frac || '0'}`
}

/**
 * Exact token amount from a raw base-unit string.
 *
 * The previous inline version was `Number(BigInt(value)) / 10 ** decimals`
 * capped at 4 fraction digits, which is lossy twice over: Number() cannot hold
 * a large token balance exactly, and the cap silently truncated real digits —
 * 232,619.50962301 AMP rendered as "232,619.5096". unitsToDecimal (plain BigInt)
 * is string-based and exact, so the integer part is grouped and the fraction is
 * kept in full, with only trailing zeros trimmed.
 *
 * `maxFractionDigits` (>= 1) is for DISPLAY: it rounds half-up in BigInt to that
 * many places (so 4,787,630.158322188632852549 reads 4,787,630.158322), and a
 * nonzero amount that rounds away reads "<0.000001" rather than "0". Omit it
 * for the exact value, e.g. a `title` attribute.
 */
export function formatTokenAmount(value: string | bigint, decimals: number, maxFractionDigits?: number): string {
  let raw: string
  try {
    let units = safeBigInt(value)
    let places = decimals
    if (maxFractionDigits !== undefined && places > maxFractionDigits) {
      const scale = 10n ** BigInt(places - maxFractionDigits)
      const rounded = (units + scale / 2n) / scale
      if (rounded === 0n && units !== 0n) return tinyAmount(maxFractionDigits)
      units = rounded
      places = maxFractionDigits
    }
    raw = unitsToDecimal(units, places)
  } catch {
    return String(value)
  }
  const [intPart, fracPart = ''] = raw.split('.')
  const grouped = BigInt(intPart).toLocaleString('en-US')
  const frac = fracPart.replace(/0+$/, '')
  return frac ? `${grouped}.${frac}` : grouped
}

/**
 * An amount that arrives already scaled, as a decimal string (a provider's `valueFormatted` or
 * `balanceFormatted`), through `formatTokenAmount` at six places: the helper, rounding and floor every
 * other amount on the address page uses, so a non-zero amount that rounds away reads "<0.000001"
 * instead of "0", and zero stays "0". The string is converted to base units without floating point
 * (so nothing is lost on a large amount), exponent form included ("1e-7", the way JS prints a small
 * number), and without the row's `tokenDecimals`, which the backfill table records as '0' when it has
 * none. Text that is not a non-negative number ("", "n/a", "-1.5") is returned as it came.
 */
export function formatDecimalAmount(valueFormatted: string): string {
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(valueFormatted)
  if (!m) return valueFormatted
  const fraction = m[2] ?? ''
  const exponent = Number(m[3] ?? 0)
  if (!(Math.abs(exponent) <= 400)) return valueFormatted
  const digits = BigInt(m[1] + fraction)
  const places = fraction.length - exponent
  return places >= 0
    ? formatTokenAmount(digits, places, 6)
    : formatTokenAmount(digits * 10n ** BigInt(-places), 0, 6)
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st. */
export function ordinal(n: number): string {
  const t = n % 100
  if (t >= 11 && t <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

/** Thousands separators in the integer part of an already formatted decimal string ("200154.69" → "200,154.69"). */
export function groupDigits(s: string): string {
  return s.replace(/^(\d+)/, d => d.replace(/\B(?=(\d{3})+(?!\d))/g, ','))
}

/** A percentage to one decimal. A non-zero share under 0.1 reads "<0.1", never a false "0.0". */
export function formatShare(pct: number): string {
  return pct > 0 && pct < 0.1 ? '<0.1' : pct.toFixed(1)
}

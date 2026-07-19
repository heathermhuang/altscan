import { formatUnits, formatEther } from 'ethers'

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

export function formatNativeToken(wei: bigint | string, decimals = 4): string {
  return Number(formatEther(safeBigInt(wei))).toFixed(decimals)
}

/** @deprecated Use formatNativeToken instead */
export const formatBNB = formatNativeToken
export const formatETH = formatNativeToken

export function formatGwei(wei: bigint | string): string {
  const gwei = Number(formatUnits(safeBigInt(wei), 'gwei'))
  if (gwei === 0) return '0'
  // BNB Chain runs sub-Gwei gas (~0.1 Gwei). toFixed(2) collapsed these to "0.00".
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

/** Adaptive USD price: 2dp for ≥$1, 4dp for ≥$0.01, up to 8dp for micro-caps. */
export function formatUsdPrice(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const max = n >= 1 ? 2 : n >= 0.01 ? 4 : 8
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: max })}`
}

/** Compact USD for large figures: $1.25B, $345.6M, $12.34K. */
export function formatCompactUsd(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return `$${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n)}`
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
  return (raw ? _sanitizeSymbol(raw) : '') || fallback
}

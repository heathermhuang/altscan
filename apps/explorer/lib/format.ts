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
  return Number(formatUnits(safeBigInt(wei), 'gwei')).toFixed(2)
}

export function formatAddress(addr: string, chars = 6): string {
  return `${addr.slice(0, chars)}...${addr.slice(-4)}`
}

export function formatNumber(n: number | bigint): string {
  if (typeof n === 'bigint') return n.toLocaleString('en-US')
  return Number(n).toLocaleString('en-US')
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
 * Replaces common Cyrillic/Greek lookalikes with ASCII equivalents, then
 * strips anything outside printable ASCII + basic Latin-1.
 */
export function sanitizeSymbol(raw: string): string {
  // Map common homoglyphs to ASCII
  const homoglyphs: Record<string, string> = {
    '\u0410': 'A', '\u0412': 'B', '\u0421': 'C', '\u0415': 'E', '\u041D': 'H',
    '\u041A': 'K', '\u041C': 'M', '\u041E': 'O', '\u0420': 'P', '\u0422': 'T',
    '\u0425': 'X', '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p',
    '\u0441': 'c', '\u0443': 'y', '\u0445': 'x', '\u0455': 's',
    '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0397': 'H', '\u0399': 'I',
    '\u039A': 'K', '\u039C': 'M', '\u039D': 'N', '\u039F': 'O', '\u03A1': 'P',
    '\u03A4': 'T', '\u03A5': 'Y', '\u03A7': 'X', '\u03B5': 'e', '\u03BF': 'o',
    '\u210B': 'H', '\u210C': 'H', '\u210D': 'H', '\u210E': 'h', '\u2110': 'I',
    '\u2112': 'L', '\u2113': 'l', '\u2115': 'N', '\u2119': 'P', '\u211A': 'Q',
    '\u211B': 'R', '\u211C': 'R', '\u211D': 'R',
  }
  let cleaned = ''
  for (const ch of raw) {
    cleaned += homoglyphs[ch] ?? ch
  }
  // Strip non-printable and non-ASCII (keep basic Latin, digits, common symbols)
  return cleaned.replace(/[^\x20-\x7E]/g, '').trim() || raw.trim()
}

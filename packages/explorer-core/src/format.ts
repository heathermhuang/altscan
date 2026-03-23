/** Format a number with commas */
export function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

/** Human-readable time ago */
export function timeAgo(date: Date): string {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

/** Shorten an address or hash for display */
export function formatAddress(addr: string, chars = 8): string {
  if (addr.length <= chars * 2 + 2) return addr
  return `${addr.slice(0, chars)}…${addr.slice(-4)}`
}

/**
 * Format a raw wei BigInt as a native token amount (BNB or ETH).
 * Returns up to 6 significant decimal places, trimming trailing zeros.
 */
export function formatNativeToken(wei: bigint, decimals = 18): string {
  const divisor = 10n ** BigInt(decimals)
  const whole = wei / divisor
  const frac = wei % divisor
  if (frac === 0n) return whole.toLocaleString()
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '')
  return `${whole.toLocaleString()}.${fracStr}`
}

/** Format Gwei from a raw gas price BigInt */
export function formatGwei(wei: bigint): string {
  const gwei = Number(wei) / 1e9
  return gwei < 1 ? gwei.toFixed(4) : gwei.toFixed(2)
}

/** Abbreviate large numbers: 1.23B, 4.56M, etc. */
export function abbreviate(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`
  if (n >= 1e9)  return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6)  return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3)  return `${(n / 1e3).toFixed(2)}K`
  return n.toString()
}

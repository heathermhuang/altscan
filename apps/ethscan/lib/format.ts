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

export function formatETH(wei: bigint | string, decimals = 4): string {
  return Number(formatEther(safeBigInt(wei))).toFixed(decimals)
}

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

import { formatUnits, formatEther } from 'ethers'

export function formatETH(wei: bigint | string, decimals = 4): string {
  return Number(formatEther(BigInt(wei))).toFixed(decimals)
}

// Alias so shared components that call formatBNB still compile
export const formatBNB = formatETH

export function formatGwei(wei: bigint | string): string {
  return Number(formatUnits(BigInt(wei), 'gwei')).toFixed(2)
}

export function formatAddress(addr: string, chars = 6): string {
  return `${addr.slice(0, chars)}...${addr.slice(-4)}`
}

export function formatNumber(n: number | bigint): string {
  return Number(n).toLocaleString('en-US')
}

export function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

export function formatHash(hash: string, chars = 16): string {
  return `${hash.slice(0, chars)}...${hash.slice(-4)}`
}

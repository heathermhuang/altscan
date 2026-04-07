import { db, schema } from '@/lib/db'
import { desc, sql } from 'drizzle-orm'
import { timeAgo, formatAddress, safeBigInt } from '@/lib/format'
import Link from 'next/link'
import { chainConfig } from '@/lib/chain'
import type { Metadata } from 'next'

export const revalidate = 300

export const metadata: Metadata = {
  title: `Whale Tracker`,
  description: `Track large ${chainConfig.currency} transfers on ${chainConfig.name}. Monitor whale movements and high-value transactions on ${chainConfig.brandDomain}.`,
  alternates: { canonical: '/whales' },
}

type WhaleTx = {
  hash: string
  fromAddress: string
  toAddress: string | null
  value: string
  blockNumber: number
  timestamp: Date
  transferType: 'native' | 'token'
  tokenSymbol?: string
}

const PERIOD_LABELS: Record<string, string> = {
  '1h': 'Last 1h',
  '24h': 'Last 24h',
  '7d': 'Last 7d',
  all: 'All Time',
}

// WBNB and WETH contract addresses
const WRAPPED_TOKENS: Record<string, { address: string; symbol: string; decimals: number }> = {
  bnb: { address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', symbol: 'WBNB', decimals: 18 },
  eth: { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', decimals: 18 },
}

// Well-known stablecoins to track large moves (6 decimals for USDT/USDC)
const STABLECOINS: Record<string, Array<{ address: string; symbol: string; decimals: number }>> = {
  bnb: [
    { address: '0x55d398326f99059ff775485246999027b3197955', symbol: 'USDT', decimals: 18 },
    { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', symbol: 'USDC', decimals: 18 },
  ],
  eth: [
    { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT', decimals: 6 },
    { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6 },
  ],
}

export default async function WhalesPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>
}) {
  const { period: periodParam } = await searchParams
  const period = ['1h', '24h', '7d', 'all'].includes(periodParam ?? '') ? (periodParam as string) : '24h'

  const cutoff =
    period === '1h'
      ? sql`NOW() - INTERVAL '1 hour'`
      : period === '24h'
      ? sql`NOW() - INTERVAL '24 hours'`
      : period === '7d'
      ? sql`NOW() - INTERVAL '7 days'`
      : sql`NOW() - INTERVAL '30 days'`  // "all" capped to 30d

  // Minimum whale threshold in wei: 10 BNB / 1 ETH for native, equivalent for wrapped
  const minNativeWei = chainConfig.key === 'bnb' ? '10000000000000000000' : '1000000000000000000'

  // Wrapped token config
  const wrapped = WRAPPED_TOKENS[chainConfig.key]
  const stables = STABLECOINS[chainConfig.key] ?? []

  // Build token addresses and thresholds for token_transfers query
  // WBNB/WETH: same threshold as native (10 BNB / 1 ETH in 18-decimal wei)
  // Stablecoins: $10,000 minimum
  const tokenFilters = [
    { address: wrapped.address, minValue: minNativeWei, symbol: wrapped.symbol, decimals: wrapped.decimals },
    ...stables.map(s => ({
      address: s.address,
      // $10,000 threshold
      minValue: (10000n * (10n ** BigInt(s.decimals))).toString(),
      symbol: s.symbol,
      decimals: s.decimals,
    })),
  ]

  let whales: WhaleTx[] = []

  try {
    // Query 1: Native value transfers
    const nativePromise = db.execute(sql`
      SELECT hash, from_address as "fromAddress", to_address as "toAddress",
             value, block_number as "blockNumber", timestamp,
             'native' as "transferType", ${chainConfig.currency} as "tokenSymbol"
      FROM transactions
      WHERE timestamp >= ${cutoff}
        AND value > ${minNativeWei}
      ORDER BY CAST(value AS numeric) DESC
      LIMIT 25
    `)

    // Query 2: Large token transfers (WBNB/WETH + stablecoins)
    const tokenAddresses = tokenFilters.map(t => t.address)
    const tokenPromise = tokenAddresses.length > 0 ? db.execute(sql`
      SELECT tt.tx_hash as hash, tt.from_address as "fromAddress", tt.to_address as "toAddress",
             tt.value, tt.block_number as "blockNumber", tt.timestamp,
             'token' as "transferType",
             COALESCE(tk.symbol, 'TOKEN') as "tokenSymbol"
      FROM token_transfers tt
      LEFT JOIN tokens tk ON tk.address = tt.token_address
      WHERE tt.timestamp >= ${cutoff}
        AND tt.token_address = ANY(${tokenAddresses})
        AND (
          ${sql.join(
            tokenFilters.map(t =>
              sql`(tt.token_address = ${t.address} AND CAST(tt.value AS numeric) > ${t.minValue})`
            ),
            sql` OR `
          )}
        )
      ORDER BY tt.timestamp DESC
      LIMIT 25
    `) : Promise.resolve([])

    const [nativeResult, tokenResult] = await Promise.race([
      Promise.all([nativePromise, tokenPromise]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ])

    const nativeWhales = Array.from(nativeResult).map(parseRow)
    const tokenWhales = Array.from(tokenResult).map(parseRow)

    // Merge and sort by value descending (normalize to ETH/BNB equivalent)
    whales = [...nativeWhales, ...tokenWhales]
      .sort((a, b) => {
        // Sort native and wrapped by value desc, stablecoins by value desc
        const aVal = safeBigInt(a.value)
        const bVal = safeBigInt(b.value)
        return bVal > aVal ? 1 : bVal < aVal ? -1 : 0
      })
      .slice(0, 50)
  } catch { /* DB not connected or timeout */ }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1">Whale Tracker</h1>
        <p className="text-gray-500 text-sm">Large native and token transfers on {chainConfig.name}</p>
      </div>

      {/* Period filter */}
      <div className="flex gap-2 mb-6">
        {Object.entries(PERIOD_LABELS).map(([key, label]) => (
          <Link
            key={key}
            href={`/whales?period=${key}`}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
              period === key
                ? `${chainConfig.theme.headerBg} ${chainConfig.theme.border} ${chainConfig.theme.headerText}`
                : `bg-white border-gray-200 text-gray-600 ${chainConfig.theme.border.replace('border-', 'hover:border-')} ${chainConfig.theme.linkHover}`
            }`}
          >
            {label}
          </Link>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-2 text-gray-500">Age</th>
              <th className="text-left px-4 py-2 text-gray-500">Tx Hash</th>
              <th className="text-left px-4 py-2 text-gray-500">From</th>
              <th className="text-left px-4 py-2 text-gray-500">To</th>
              <th className="text-right px-4 py-2 text-gray-500">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {whales.map((w) => {
              const isStable = w.tokenSymbol === 'USDT' || w.tokenSymbol === 'USDC'
              const decimals = isStable
                ? (stables.find(s => s.symbol === w.tokenSymbol)?.decimals ?? 18)
                : 18
              const displayAmount = formatTokenAmount(w.value, decimals)
              const symbol = w.tokenSymbol ?? chainConfig.currency

              return (
                <tr key={`${w.hash}-${w.transferType}`} className="hover:bg-gray-50">
                  <td className="px-4 py-2 text-gray-500 whitespace-nowrap">
                    {timeAgo(w.timestamp)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link href={`/tx/${w.hash}`} className={`${chainConfig.theme.linkText} hover:underline`}>
                      {w.hash.slice(0, 14)}…
                    </Link>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link href={`/address/${w.fromAddress}`} className={`${chainConfig.theme.linkText} hover:underline`}>
                      {formatAddress(w.fromAddress)}
                    </Link>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {w.toAddress ? (
                      <Link href={`/address/${w.toAddress}`} className={`${chainConfig.theme.linkText} hover:underline`}>
                        {formatAddress(w.toAddress)}
                      </Link>
                    ) : (
                      <span className="text-gray-400 italic">Contract Create</span>
                    )}
                  </td>
                  <td className="px-4 py-2 font-semibold text-right">
                    {displayAmount}{' '}
                    <span className="text-gray-500 font-normal text-xs">{symbol}</span>
                  </td>
                </tr>
              )
            })}
            {whales.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                  No large transfers found for this time period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function parseRow(row: unknown): WhaleTx {
  const r = row as Record<string, unknown>
  return {
    hash: String(r.hash),
    fromAddress: String(r.fromAddress),
    toAddress: r.toAddress ? String(r.toAddress) : null,
    value: String(r.value),
    blockNumber: Number(r.blockNumber),
    timestamp: new Date(r.timestamp as string),
    transferType: r.transferType === 'token' ? 'token' : 'native',
    tokenSymbol: r.tokenSymbol ? String(r.tokenSymbol) : undefined,
  }
}

function formatTokenAmount(value: string, decimals: number): string {
  try {
    const divisor = 10n ** BigInt(decimals)
    const raw = safeBigInt(value)
    const whole = raw / divisor
    const frac = raw % divisor
    const fracStr = frac.toString().padStart(decimals, '0').slice(0, 2).replace(/0+$/, '')
    return fracStr ? `${whole.toLocaleString()}.${fracStr}` : whole.toLocaleString()
  } catch {
    return '—'
  }
}

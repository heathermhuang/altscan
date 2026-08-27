import { schema } from '@/lib/db'
import { fetchWhales, type WhalePeriod } from '@/lib/whales'
import { desc } from 'drizzle-orm'
import { timeAgo, formatAddress, safeBigInt } from '@/lib/format'
import Link from 'next/link'
import { chainConfig } from '@/lib/chain'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'
import { AdSlot } from '@/components/ads/AdSlot'
import type { Metadata } from 'next'

export const revalidate = 300

export const metadata: Metadata = {
  title: `Whale Tracker`,
  description: `Track large ${chainConfig.currency} transfers on ${chainConfig.name}. Monitor whale movements and high-value transactions on ${chainConfig.brandDomain}.`,
  alternates: { canonical: '/whales' },
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
  const period = (['1h', '24h', '7d', 'all'].includes(periodParam ?? '')
    ? periodParam
    : '24h') as WhalePeriod

  // Minimum whale threshold in wei: 1 BNB / 0.5 ETH for native
  const minNativeWei = chainConfig.key === 'bnb' ? '1000000000000000000' : '500000000000000000'

  // Wrapped token config
  const wrapped = WRAPPED_TOKENS[chainConfig.key]
  const stables = STABLECOINS[chainConfig.key] ?? []

  // Build token addresses and thresholds for token_transfers query
  // WBNB/WETH: same threshold as native (1 BNB / 0.5 ETH in 18-decimal wei)
  // Stablecoins: $1,000 minimum
  const tokenFilters = [
    { address: wrapped.address, minValue: minNativeWei, symbol: wrapped.symbol, decimals: wrapped.decimals },
    ...stables.map(s => ({
      address: s.address,
      // $1,000 threshold
      minValue: (1000n * (10n ** BigInt(s.decimals))).toString(),
      symbol: s.symbol,
      decimals: s.decimals,
    })),
  ]

  const { rows: whales, degraded } = await fetchWhales(period, minNativeWei, tokenFilters)

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <BreadcrumbJsonLd items={[{ name: 'Whale Tracker' }]} />
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1">Whale Tracker</h1>
        <p className="text-gray-500 text-sm">
          Large transfers on {chainConfig.name} — native ({chainConfig.key === 'bnb' ? '≥1 BNB' : '≥0.5 ETH'}), {chainConfig.key === 'bnb' ? 'WBNB' : 'WETH'}, and stablecoins (≥$1,000)
        </p>
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

      <AdSlot
        context="whales"
        placement="whales_before_table"
        variant="compact"
        className="mb-6"
      />

      {degraded && whales.length > 0 && (
        <p className="mb-3 text-xs text-gray-500">
          Showing partial results — one data source is unavailable.
        </p>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Large transfers on {chainConfig.name} — {PERIOD_LABELS[period]}</caption>
          <thead className="bg-gray-50 border-b">
            <tr>
              <th scope="col" className="text-left px-4 py-2 text-gray-500">Age</th>
              <th scope="col" className="text-left px-4 py-2 text-gray-500">Tx Hash</th>
              <th scope="col" className="text-left px-4 py-2 text-gray-500">From</th>
              <th scope="col" className="text-left px-4 py-2 text-gray-500">To</th>
              <th scope="col" className="text-right px-4 py-2 text-gray-500">Amount</th>
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
                <td colSpan={5} className="px-4 py-8 text-center">
                  {degraded ? (
                    <>
                      <p className="text-gray-500">Couldn&rsquo;t load whale transfers right now.</p>
                      <p className="text-gray-400 text-xs mt-1">This is a problem on our side, not an empty market. Try again shortly.</p>
                    </>
                  ) : (
                    <p className="text-gray-400">No large transfers found for this time period.</p>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
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

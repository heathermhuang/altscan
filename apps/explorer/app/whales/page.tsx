import { fetchWhales, type WhalePeriod } from '@/lib/whales'
import { timeAgo, safeBigInt } from '@/lib/format'
import Link from 'next/link'
import { chainConfig } from '@/lib/chain'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'
import { AdSlot } from '@/components/ads/AdSlot'
import type { Metadata } from 'next'
import { AddressLink } from '@/components/ui/AddressLink'
import { swallow } from '@/lib/observability'

export const revalidate = 300

export const metadata: Metadata = {
  title: `Whale Tracker`,
  description: `Track large ${chainConfig.currency} transfers on ${chainConfig.name}. Monitor whale movements and high-value transactions on ${chainConfig.brandDomain}.`,
  alternates: { canonical: '/whales' },
}

// '7d' is deliberately absent. Neither chain retains seven days of
// `transactions` — measured 2026-08-27, BNB spans 2.23 days and ETH 4.05 — so
// "Last 7d" and "All Time" were returning byte-identical results while both
// claimed a window the data does not cover. One honest option replaces them.
// '7d' is still accepted as a period (see WhalePeriod) so existing links and
// any indexed URLs keep working; it just isn't offered.
// Every accepted period, including the retired '7d', so a legacy URL still
// captions correctly. Record<WhalePeriod, …> is exhaustive: adding a period
// without a caption is a compile error, not an "undefined" in the table caption.
const PERIOD_CAPTIONS: Record<WhalePeriod, string> = {
  '1h': 'Last 1h',
  '24h': 'Last 24h',
  '7d': 'Last 7d',
  all: 'Max',
}

// Only these are offered as buttons.
const PERIOD_LABELS: Record<string, string> = {
  '1h': PERIOD_CAPTIONS['1h'],
  '24h': PERIOD_CAPTIONS['24h'],
  all: PERIOD_CAPTIONS.all,
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

  // Thresholds and tracked tokens are per-chain config. They used to be two
  // `Record<string, …>` maps indexed by `chainConfig.key` with no guard, so a
  // third chain read `undefined` and the next line 500'd the page.
  const { nativeMinWei, wrapped, stablecoins } = chainConfig.whales
  const tokenFilters = [wrapped, ...stablecoins]

  const { rows: whales, degraded } = await fetchWhales(period, nativeMinWei, tokenFilters)

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <BreadcrumbJsonLd items={[{ name: 'Whale Tracker' }]} />
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1">Whale Tracker</h1>
        <p className="text-gray-500 text-sm">
          Large transfers on {chainConfig.name} — native (≥{formatTokenAmount(nativeMinWei, 18)} {chainConfig.currency}), {wrapped.symbol}
          {stablecoins.length > 0 && <>, and stablecoins (≥${formatTokenAmount(stablecoins[0].minValue, stablecoins[0].decimals)})</>}
        </p>
        {period === 'all' && (
          <p className="text-gray-400 text-xs mt-1">
            Max covers everything currently retained, which is a few days rather than the full chain history.
          </p>
        )}
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
          <caption className="sr-only">Large transfers on {chainConfig.name} — {PERIOD_CAPTIONS[period]}</caption>
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
              // Native and wrapped are 18-decimal; stablecoins differ per chain
              // (6 on Ethereum, 18 on BNB Chain), so resolve from config.
              const decimals =
                stablecoins.find(s => s.symbol === w.tokenSymbol)?.decimals ?? 18
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
                    <AddressLink address={w.fromAddress} />
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {w.toAddress ? (
                      <AddressLink address={w.toAddress} />
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
  } catch (e) {
    swallow('whales/query', e)
    return '—'
  }
}

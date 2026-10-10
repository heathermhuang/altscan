import { fetchWhales, type WhalePeriod } from '@/lib/whales'
import { timeAgo, safeBigInt, formatCompactUsd } from '@/lib/format'
import Link from 'next/link'
import { chainConfig } from '@/lib/chain'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'
import { AdReserve } from '@/components/ads/AdReserve'
import type { Metadata } from 'next'
import { AddressLink } from '@/components/ui/AddressLink'
import { shortHash } from '@/lib/address-display'
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
      <div className="mb-5">
        <p className="k">{'// '}whales</p>
        <h1 className="mt-2 text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.05] tracking-[-0.03em] text-ink">Whale Tracker</h1>
        <p className="mt-2 max-w-3xl text-sm text-ink2">
          Large transfers on {chainConfig.name} — native (≥{formatTokenAmount(nativeMinWei, 18)} {chainConfig.currency}), {wrapped.symbol}
          {stablecoins.length > 0 && <>, and stablecoins (≥${formatTokenAmount(stablecoins[0].minValue, stablecoins[0].decimals)})</>}
        </p>
        <p className="text-mut text-xs mt-1">
          Ranked by estimated USD value: stablecoins at $1, {chainConfig.currency} and {wrapped.symbol} at the live {chainConfig.currency} price.
          A transfer with no price is listed last.
        </p>
        {period === 'all' && (
          <p className="text-mut text-xs mt-1">
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
            className={`rounded-[9px] border px-3 py-1.5 text-sm font-medium transition-colors ${
              period === key
                ? 'border-acc text-acc-ink'
                : 'border-hair text-ink2 hover:border-hair3'
            }`}
          >
            {label}
          </Link>
        ))}
      </div>

      {degraded && whales.length > 0 && (
        <p className="mb-3 rounded-xl border border-hair border-l-[3px] border-l-warn bg-card px-4 py-3 text-sm text-ink2">
          Showing partial results — one data source is unavailable.
        </p>
      )}

      {/* Table */}
      <div className="bg-card rounded-xl border border-hair overflow-hidden">
        <div className="overflow-x-auto">
        <table className="dt">
          <caption className="sr-only">Large transfers on {chainConfig.name} — {PERIOD_CAPTIONS[period]}</caption>
          <thead>
            <tr>
              <th scope="col" className="hidden sm:table-cell">Age</th>
              <th scope="col">Tx Hash</th>
              <th scope="col">From</th>
              <th scope="col" className="hidden sm:table-cell">To</th>
              <th scope="col" className="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {whales.map((w, i) => {
              // w.decimals is resolved from the token's contract address (6 for ETH's stablecoins, 18 elsewhere).
              const displayAmount = formatTokenAmount(w.value, w.decimals)
              const symbol = w.tokenSymbol ?? chainConfig.currency

              return (
                <tr key={`${w.hash}-${w.transferType}-${i}`}>
                  <td className="text-mut whitespace-nowrap hidden sm:table-cell">
                    {timeAgo(w.timestamp)}
                  </td>
                  <td className="whitespace-nowrap">
                    <Link href={`/tx/${w.hash}`} className="text-acc-ink hover:underline">
                      {shortHash(w.hash)}
                    </Link>
                  </td>
                  <td>
                    <AddressLink address={w.fromAddress} />
                  </td>
                  <td className="hidden sm:table-cell">
                    {w.toAddress ? (
                      <AddressLink address={w.toAddress} />
                    ) : (
                      <span className="text-mut">Contract Create</span>
                    )}
                  </td>
                  <td className="font-semibold text-right">
                    {displayAmount}{' '}
                    <span className="text-mut font-normal text-xs">{symbol}</span>
                    <span className="block text-mut font-normal text-xs">
                      {w.usd === null ? 'no price' : `≈ ${formatCompactUsd(w.usd)}`}
                    </span>
                  </td>
                </tr>
              )
            })}
            {whales.length === 0 && (
              <tr>
                <td colSpan={5} className="py-8 text-center font-sans">
                  {degraded ? (
                    <>
                      <p className="text-ink2">Couldn&rsquo;t load whale transfers right now.</p>
                      <p className="text-mut text-xs mt-1">This is a problem on our side, not an empty market. Try again shortly.</p>
                    </>
                  ) : (
                    <p className="text-mut">No large transfers found for this time period.</p>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      {/* After the table, so on a phone the transfers come first. The placement id is the settings key and keeps its name. */}
      <AdReserve
        context="whales"
        placement="whales_before_table"
        variant="compact"
        className="mt-6"
      />
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

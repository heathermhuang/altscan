import { db } from '@/lib/db'
import { sql } from 'drizzle-orm'
import type { Metadata } from 'next'
import { chainConfig } from '@/lib/chain'
import { formatGwei, formatUtcClock } from '@/lib/format'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'
import { BlockTape } from '@/components/home/BlockTape'
import { swallow } from '@/lib/observability'
import { fetchRecentTape } from '@/lib/recent-tape'
import { withTimeout } from '@/lib/with-timeout'
import { completeUtcDays } from '@/lib/chart-days'

export const revalidate = 300

export const metadata: Metadata = {
  title: `Network Charts`,
  description: `${chainConfig.name} network statistics and charts — daily transactions, gas prices, and more on ${chainConfig.brandDomain}.`,
  alternates: { canonical: '/charts' },
}

/** `firstTs`: epoch ms of the day's earliest block, so a day that starts mid-day can be told from a whole one. */
/** Days of data a chart needs before it is worth drawing. */
const MIN_DAYS = 3

type DataPoint = { date: string; value: number; firstTs: number }

function toPoint(row: unknown): DataPoint {
  const r = row as Record<string, unknown>
  return {
    date: String(r.date).slice(0, 10),
    value: Number(r.value),
    firstTs: Math.round(Number(r.first_ts) * 1000),
  }
}

async function fetchDailyTxCount(): Promise<DataPoint[]> {
  try {
    // Use blocks table (272K rows) joined with tx_count per block instead of
    // scanning the 36M-row transactions table directly. Much faster and avoids
    // queries that run for 8+ minutes and consume DB connections.
    const result = await withTimeout(db.execute(sql`
      SELECT DATE(b.timestamp AT TIME ZONE 'UTC') as date,
             SUM(b.tx_count)::int as value,
             EXTRACT(EPOCH FROM MIN(b.timestamp)) as first_ts
      FROM blocks b
      WHERE b.timestamp >= NOW() - INTERVAL '30 days'
      GROUP BY 1
      ORDER BY 1
    `))
    return Array.from(result).map(toPoint)
  } catch (e) {
    swallow('charts/query', e)
    return []
  }
}

async function fetchDailyGasHistory(): Promise<DataPoint[]> {
  // Try blocks.base_fee_per_gas first (works well for ETH).
  // BNB may have base_fee=0, so fall back to avg transaction gas_price.
  try {
    const result = await withTimeout(db.execute(sql`
      SELECT DATE(timestamp AT TIME ZONE 'UTC') as date,
             AVG(base_fee_per_gas::numeric / 1e9)::numeric(18,4) as value,
             EXTRACT(EPOCH FROM MIN(timestamp)) as first_ts
      FROM blocks
      WHERE timestamp >= NOW() - INTERVAL '30 days'
        AND base_fee_per_gas IS NOT NULL
        AND base_fee_per_gas > 0
      GROUP BY 1
      ORDER BY 1
    `))
    const data = Array.from(result).map(toPoint)
    if (data.length >= 3) return data
  } catch (e) { swallow('charts/fallback', e) }  // fall through

  return []
}

// COUNT(DISTINCT from_address) on 36M rows is too slow for an on-demand query.
// Use daily block count from the much smaller blocks table (272K rows → instant)
// as a useful proxy metric. Rename chart accordingly.
async function fetchDailyBlockCount(): Promise<DataPoint[]> {
  try {
    const result = await withTimeout(db.execute(sql`
      SELECT DATE(timestamp AT TIME ZONE 'UTC') as date,
             COUNT(*)::int as value,
             EXTRACT(EPOCH FROM MIN(timestamp)) as first_ts
      FROM blocks
      WHERE timestamp >= NOW() - INTERVAL '30 days'
      GROUP BY 1
      ORDER BY 1
    `))
    return Array.from(result).map(toPoint)
  } catch (e) {
    swallow('charts/series', e)
    return []
  }
}

export default async function ChartsPage() {
  // Run sequentially — each query can use 100MB+ on 36M row tables.
  // Promise.all() on these caused concurrent memory spikes → OOM.
  const now = new Date()
  // Complete UTC days only: a day still in progress, or one the index only caught the end of, would
  // plot as a collapse.
  const txData = completeUtcDays(await fetchDailyTxCount(), now)
  const gasData = completeUtcDays(await fetchDailyGasHistory(), now)
  const blockData = completeUtcDays(await fetchDailyBlockCount(), now)

  const header = (
    <div className="mb-6">
      <p className="k">{'// '}charts</p>
      <h1 className="mt-2 text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.05] tracking-[-0.03em] text-ink">Charts</h1>
      <p className="mt-2 text-sm text-ink2">{chainConfig.name} network activity from the blocks this explorer has indexed.</p>
    </div>
  )

  // With under 3 complete days of anything, every card below would say "not enough data". Show the blocks
  // the explorer does have instead, and pay for that query only then.
  const tape = [txData, gasData, blockData].every((d) => d.length < MIN_DAYS) ? await fetchRecentTape() : null
  if (tape !== null) {
    return (
      <>
        <div className="max-w-7xl mx-auto px-4 pt-8">
          <BreadcrumbJsonLd items={[{ name: 'Network Charts' }]} />
          {header}
          <h2 className="k mb-3"><span aria-hidden="true">{'// '}</span>recent blocks</h2>
        </div>
        {/* This page is cached for up to 5 minutes, so the tape says when it was drawn, not "latest". */}
        <BlockTape tape={tape} chainName={chainConfig.name} heading={`as of ${formatUtcClock(new Date())}`} />
        <div className="max-w-7xl mx-auto px-4 pb-8 pt-4">
          <p className="text-sm text-mut">Daily charts aren&apos;t available yet.</p>
        </div>
      </>
    )
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <BreadcrumbJsonLd items={[{ name: 'Network Charts' }]} />
      {header}

      <div className="space-y-8">
        <ChartCard title="Daily Transaction Count" data={txData}>
          <LineChart
            data={txData}
            label="Transactions"
            formatY={(n) => Math.round(n).toLocaleString()}
          />
        </ChartCard>

        {/* No base-fee series at all (BNB has none): say why, instead of a "not enough data" card. */}
        <ChartCard
          title={`Gas Price History — Avg Base Fee (Gwei)`}
          data={gasData}
          noSeries={gasData.length === 0 && BigInt(chainConfig.minGasPriceWei) > 0n ? (
            <div className="flex items-center justify-center h-32 text-center text-ink2 text-sm">
              <p>{chainConfig.name} has a low minimum gas price of {formatGwei(BigInt(chainConfig.minGasPriceWei))} Gwei. See the <a href="/gas" className="text-acc-ink hover:underline">Gas Tracker</a> for current rates.</p>
            </div>
          ) : undefined}
        >
          <LineChart
            data={gasData}
            label="Gwei"
            formatY={(n) => `${(n < 1 ? n.toFixed(4) : n.toFixed(2)).replace(/\.?0+$/, '')} Gwei`}
          />
        </ChartCard>

        <ChartCard title="Daily Block Count" data={blockData}>
          <LineChart
            data={blockData}
            label="Blocks"
            formatY={(n) => Math.round(n).toLocaleString()}
          />
        </ChartCard>
      </div>
    </div>
  )
}

function ChartCard({ title, data, children, noSeries }: {
  title: string
  data: DataPoint[]
  children: React.ReactNode
  noSeries?: React.ReactNode
}) {
  const dateRange = data.length >= 2
    ? `${data[0].date} — ${data[data.length - 1].date}`
    : data.length === 1
    ? data[0].date
    : null

  return (
    <div className="bg-card rounded-xl border border-hair p-4 sm:p-6">
      <h2 className="font-semibold tracking-[-0.02em] text-ink mb-1">{title}</h2>
      {dateRange && (
        <p className="text-xs text-mut mb-4">{dateRange} ({data.length} days)</p>
      )}
      {data.length >= MIN_DAYS ? (
        children
      ) : (
        noSeries ?? (
          <div className="h-48 flex items-center justify-center text-center text-mut">
            Not enough data yet — {data.length === 0 ? 'no complete UTC day' : `only ${data.length} complete UTC day${data.length === 1 ? '' : 's'}`} recorded.
            Charts will appear once at least {MIN_DAYS} complete days of data are available.
          </div>
        )
      )}
    </div>
  )
}

/**
 * A line chart of at least MIN_DAYS points. The plot is a stretched SVG (so it fills the card at any
 * width); the axis text is HTML, because text inside a stretched or scaled SVG shrinks with it (it
 * rendered at about 4px on a phone) and a label wider than a fixed gutter clipped.
 */
function LineChart({
  data,
  label,
  formatY,
}: {
  data: DataPoint[]
  label: string
  formatY?: (n: number) => string
}) {
  const maxVal = Math.max(...data.map((d) => d.value), 1)
  const minVal = Math.min(...data.map((d) => d.value), 0)
  const range = maxVal - minVal || 1
  const fmt = formatY ?? ((n: number) => n.toLocaleString())

  // The plot is a 100 x 100 box: x is the share of the width, y the share of the height.
  const last = data.length - 1
  const xOf = (i: number) => (i / last) * 100
  const points = data.map((d, i) => ({ x: xOf(i), y: 100 - ((d.value - minVal) / range) * 100 }))

  // Top to bottom, max first: five rules and the five labels beside them.
  const ticks = [1, 0.75, 0.5, 0.25, 0]
  // Five date labels, evenly spaced, first and last included, so they never touch.
  const labelCount = Math.min(data.length, 5)
  const dateIdx = Array.from({ length: labelCount }, (_, k) => Math.round((k * last) / (labelCount - 1)))

  return (
    <div role="img" aria-label={label} className="flex gap-2 text-[11px] leading-[14px] text-mut">
      {/* h-48 = the plot's height; each label is one 14px line, so justify-between centres the first
          and last on the plot's top and bottom rules once the plot is inset by half a line (7px). */}
      <div className="flex h-48 shrink-0 flex-col justify-between text-right">
        {ticks.map((t) => (
          <span key={t}>{fmt(minVal + t * range)}</span>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="h-48 py-[7px]">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full overflow-visible" aria-hidden="true">
            <path
              className="stroke-hair"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              d={ticks.map((t) => `M0 ${t * 100}H100`).join('')}
            />
            <polyline
              points={points.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="none"
              className="stroke-acc"
              strokeWidth="2"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            {/* Dots, only if few data points: zero-length round-capped segments, so they stay round
                (a <circle> would stretch with the plot). */}
            {data.length <= 30 && (
              <path
                className="stroke-acc"
                strokeWidth="6"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                d={points.map((p) => `M${p.x} ${p.y}h0`).join('')}
              />
            )}
          </svg>
        </div>
        <div className="relative mt-1 h-[14px]">
          {dateIdx.map((i) => (
            <span
              key={i}
              className="absolute whitespace-nowrap"
              style={{ left: `${xOf(i)}%`, transform: `translateX(-${xOf(i)}%)` }}
            >
              {data[i].date.slice(5)}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

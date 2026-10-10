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
import { completeUtcDays, dateLabelIndices, toDayPoint, type DataPoint } from '@/lib/chart-days'
import { completeUtcHours, hourLabel, hourlyCaption, hourlyRange, MIN_HOURS, type HourRow } from '@/lib/chart-hours'
import { fetchHourlyChart } from '@/lib/charts-hourly'

export const revalidate = 300

export const metadata: Metadata = {
  title: `Network Charts`,
  description: `${chainConfig.name} network statistics and charts — daily transactions, gas prices, and more on ${chainConfig.brandDomain}.`,
  alternates: { canonical: '/charts' },
}

/** Days of data a chart needs before it is worth drawing. */
const MIN_DAYS = 3

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
    return Array.from(result).map(toDayPoint)
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
    const data = Array.from(result).map(toDayPoint)
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
    return Array.from(result).map(toDayPoint)
  } catch (e) {
    swallow('charts/series', e)
    return []
  }
}

/**
 * The whole UTC hours to plot when there are too few whole days, or null when there are fewer than
 * MIN_HOURS (or the read failed): the page then keeps its block tape. Whether an hour is whole is
 * judged at the moment the cached rows were read, not at this render.
 */
async function fetchWholeHours(): Promise<HourRow[] | null> {
  try {
    const { asOf, rows } = await fetchHourlyChart()
    const whole = completeUtcHours(rows, new Date(asOf))
    return whole.length >= MIN_HOURS ? whole : null
  } catch (e) {
    swallow('charts/hourly', e)
    return null
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

  // With under 3 complete days of anything, every daily card would say "not enough data". A chain that
  // keeps about two days of blocks (BNB) plots the whole hours it has instead; with too few of those,
  // the blocks the explorer does have. The hourly read and the tape are paid for only then.
  const lacksDays = [txData, gasData, blockData].every((d) => d.length < MIN_DAYS)
  const hours = lacksDays ? await fetchWholeHours() : null
  if (hours !== null) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <BreadcrumbJsonLd items={[{ name: 'Network Charts' }]} />
        {header}
        <p className="mb-6 text-sm text-mut">
          Daily charts need {MIN_DAYS} complete UTC days of blocks and this explorer has indexed fewer, so these are hourly.
        </p>
        <ChartCards
          period="Hourly"
          tx={hourlySeries(hours, (h) => h.tx)}
          gas={hourlySeries(hours, (h) => h.gas)}
          blocks={hourlySeries(hours, (h) => h.blocks)}
        />
      </div>
    )
  }

  const tape = lacksDays ? await fetchRecentTape() : null
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
      <ChartCards period="Daily" tx={dailySeries(txData)} gas={dailySeries(gasData)} blocks={dailySeries(blockData)} />
    </div>
  )
}

/** What a chart draws: a value and an x tick per point, the caption under the title, and what to say if there are too few points. */
type Series = {
  values: number[]
  ticks: string[]
  caption: string | null
  /** Points needed before the chart is worth drawing. */
  min: number
  shortNote: string
}

function dailySeries(data: DataPoint[]): Series {
  const dateRange = data.length >= 2
    ? `${data[0].date} — ${data[data.length - 1].date}`
    : data.length === 1
    ? data[0].date
    : null
  return {
    values: data.map((d) => d.value),
    ticks: data.map((d) => d.date.slice(5)),
    caption: dateRange && `${dateRange} (${data.length} days)`,
    min: MIN_DAYS,
    shortNote: `Not enough data yet — ${data.length === 0 ? 'no complete UTC day' : `only ${data.length} complete UTC day${data.length === 1 ? '' : 's'}`} recorded. Charts will appear once at least ${MIN_DAYS} complete days of data are available.`,
  }
}

/** One series of the whole hours: the hours `pick` has a number for (the base fee is null where a chain has none). */
function hourlySeries(hours: HourRow[], pick: (h: HourRow) => number | null): Series {
  const points = hours.flatMap((h) => {
    const value = pick(h)
    return value === null ? [] : [{ hourMs: h.hourMs, value }]
  })
  return {
    values: points.map((p) => p.value),
    ticks: points.map((p) => hourLabel(p.hourMs)),
    caption: points.length > 0 ? `${hourlyCaption(points)} · ${hourlyRange(points)}` : null,
    min: MIN_HOURS,
    shortNote: `Not enough data yet — ${points.length === 0 ? 'no complete UTC hour' : `only ${points.length} complete UTC hour${points.length === 1 ? '' : 's'}`} recorded.`,
  }
}

/** The three charts, daily or hourly: `period` is the word in the titles. */
function ChartCards({ period, tx, gas, blocks }: { period: 'Daily' | 'Hourly'; tx: Series; gas: Series; blocks: Series }) {
  return (
    <div className="space-y-8">
      <ChartCard title={`${period} Transaction Count`} series={tx}>
        <LineChart
          series={tx}
          label="Transactions"
          formatY={(n) => Math.round(n).toLocaleString()}
        />
      </ChartCard>

      {/* No base-fee series at all (BNB has none): say why, instead of a "not enough data" card. */}
      <ChartCard
        title={`Gas Price History — Avg Base Fee (Gwei)`}
        series={gas}
        noSeries={gas.values.length === 0 && BigInt(chainConfig.minGasPriceWei) > 0n ? (
          <div className="flex items-center justify-center h-32 text-center text-ink2 text-sm">
            <p>{chainConfig.name} has a low minimum gas price of {formatGwei(BigInt(chainConfig.minGasPriceWei))} Gwei. See the <a href="/gas" className="text-acc-ink underline">Gas Tracker</a> for current rates.</p>
          </div>
        ) : undefined}
      >
        <LineChart
          series={gas}
          label="Gwei"
          formatY={(n) => `${(n < 1 ? n.toFixed(4) : n.toFixed(2)).replace(/\.?0+$/, '')} Gwei`}
        />
      </ChartCard>

      <ChartCard title={`${period} Block Count`} series={blocks}>
        <LineChart
          series={blocks}
          label="Blocks"
          formatY={(n) => Math.round(n).toLocaleString()}
        />
      </ChartCard>
    </div>
  )
}

function ChartCard({ title, series, children, noSeries }: {
  title: string
  series: Series
  children: React.ReactNode
  noSeries?: React.ReactNode
}) {
  return (
    <div className="bg-card rounded-xl border border-hair p-4 sm:p-6">
      <h2 className="font-semibold tracking-[-0.02em] text-ink mb-1">{title}</h2>
      {series.caption && (
        <p className="text-xs text-mut mb-4">{series.caption}</p>
      )}
      {series.values.length >= series.min ? (
        children
      ) : (
        noSeries ?? (
          <div className="h-48 flex items-center justify-center text-center text-mut">
            {series.shortNote}
          </div>
        )
      )}
    </div>
  )
}

/**
 * A line chart of at least MIN_DAYS (or MIN_HOURS) points. The plot is a stretched SVG (so it fills the card at any
 * width); the axis text is HTML, because text inside a stretched or scaled SVG shrinks with it (it
 * rendered at about 4px on a phone) and a label wider than a fixed gutter clipped.
 */
function LineChart({
  series,
  label,
  formatY,
}: {
  series: Series
  label: string
  formatY?: (n: number) => string
}) {
  const { values, ticks: xTicks } = series
  const maxVal = Math.max(...values, 1)
  const minVal = Math.min(...values, 0)
  const range = maxVal - minVal || 1
  const fmt = formatY ?? ((n: number) => n.toLocaleString())

  // The plot is a 100 x 100 box: x is the share of the width, y the share of the height.
  const last = values.length - 1
  const xOf = (i: number) => (i / last) * 100
  const points = values.map((v, i) => ({ x: xOf(i), y: 100 - ((v - minVal) / range) * 100 }))

  // Top to bottom, max first: five rules and the five labels beside them.
  const ticks = [1, 0.75, 0.5, 0.25, 0]
  // Up to five labels (dates, or HH:00 on an hourly chart), a whole step apart (first and last
  // included), so they do not overlap.
  const dateIdx = dateLabelIndices(values.length)

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
            {values.length <= 30 && (
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
              {xTicks[i]}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

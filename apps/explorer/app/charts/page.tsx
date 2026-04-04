import { db } from '@/lib/db'
import { sql } from 'drizzle-orm'
import type { Metadata } from 'next'
import { chainConfig } from '@/lib/chain'

export const revalidate = 30

export const metadata: Metadata = {
  title: `Network Charts`,
  description: `${chainConfig.name} network statistics and charts — daily transactions, gas prices, and more on ${chainConfig.brandDomain}.`,
  alternates: { canonical: '/charts' },
}

type DataPoint = { date: string; value: number }

const DB_TIMEOUT_MS = 8000

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('query timeout')), DB_TIMEOUT_MS)
    ),
  ])
}

async function fetchDailyTxCount(): Promise<DataPoint[]> {
  try {
    const result = await withTimeout(db.execute(sql`
      SELECT DATE(timestamp AT TIME ZONE 'UTC') as date, COUNT(*)::int as value
      FROM transactions
      WHERE timestamp >= (SELECT MAX(timestamp) FROM transactions) - INTERVAL '30 days'
      GROUP BY 1
      ORDER BY 1
    `))
    return Array.from(result).map((row) => ({
      date: String((row as Record<string, unknown>).date).slice(0, 10),
      value: Number((row as Record<string, unknown>).value),
    }))
  } catch {
    return []
  }
}

async function fetchDailyGasHistory(): Promise<DataPoint[]> {
  try {
    const result = await withTimeout(db.execute(sql`
      SELECT DATE(timestamp AT TIME ZONE 'UTC') as date,
             AVG(standard::numeric / 1e9)::numeric(18,4) as value
      FROM gas_history
      WHERE timestamp >= (SELECT MAX(timestamp) FROM gas_history) - INTERVAL '30 days'
      GROUP BY 1
      ORDER BY 1
    `))
    return Array.from(result).map((row) => ({
      date: String((row as Record<string, unknown>).date).slice(0, 10),
      value: Number((row as Record<string, unknown>).value),
    }))
  } catch {
    return []
  }
}

// COUNT(DISTINCT from_address) on 36M rows is too slow for an on-demand query.
// Use daily block count from the much smaller blocks table (272K rows → instant)
// as a useful proxy metric. Rename chart accordingly.
async function fetchDailyBlockCount(): Promise<DataPoint[]> {
  try {
    const result = await withTimeout(db.execute(sql`
      SELECT DATE(timestamp AT TIME ZONE 'UTC') as date,
             COUNT(*)::int as value
      FROM blocks
      WHERE timestamp >= (SELECT MAX(timestamp) FROM blocks) - INTERVAL '30 days'
      GROUP BY 1
      ORDER BY 1
    `))
    return Array.from(result).map((row) => ({
      date: String((row as Record<string, unknown>).date).slice(0, 10),
      value: Number((row as Record<string, unknown>).value),
    }))
  } catch {
    return []
  }
}

export default async function ChartsPage() {
  const [txData, gasData, blockData] = await Promise.all([
    fetchDailyTxCount(),
    fetchDailyGasHistory(),
    fetchDailyBlockCount(),
  ])

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-8">Charts</h1>

      <div className="space-y-8">
        <ChartCard title="Daily Transaction Count" data={txData}>
          <LineChart
            data={txData}
            label="Transactions"
            formatY={(n) => n.toLocaleString()}
          />
        </ChartCard>

        <ChartCard title="Gas Price History — Avg Standard (Gwei)" data={gasData}>
          <LineChart
            data={gasData}
            label="Gwei"
            formatY={(n) => `${n.toFixed(2)} Gwei`}
          />
        </ChartCard>

        <ChartCard title="Daily Block Count" data={blockData}>
          <LineChart
            data={blockData}
            label="Blocks"
            formatY={(n) => n.toLocaleString()}
          />
        </ChartCard>
      </div>
    </div>
  )
}

function ChartCard({ title, data, children }: { title: string; data: DataPoint[]; children: React.ReactNode }) {
  const dateRange = data.length >= 2
    ? `${data[0].date} — ${data[data.length - 1].date}`
    : data.length === 1
    ? data[0].date
    : null

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
      <h2 className="font-semibold text-gray-800 mb-1">{title}</h2>
      {dateRange && (
        <p className="text-xs text-gray-400 mb-4">{dateRange} ({data.length} days)</p>
      )}
      {data.length > 0 && data.length < 3 ? (
        <div className="h-48 flex items-center justify-center text-gray-400">
          Not enough data yet — only {data.length} day{data.length === 1 ? '' : 's'} recorded.
          Charts will appear once at least 3 days of data are available.
        </div>
      ) : (
        children
      )}
    </div>
  )
}

function LineChart({
  data,
  label,
  formatY,
}: {
  data: DataPoint[]
  label: string
  formatY?: (n: number) => string
}) {
  if (data.length === 0) {
    return (
      <div className="h-48 flex items-center justify-center text-gray-400">
        No data yet
      </div>
    )
  }

  const width = 800
  const height = 200
  const pad = { top: 10, right: 20, bottom: 30, left: 60 }
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom

  const maxVal = Math.max(...data.map((d) => d.value), 1)
  const minVal = Math.min(...data.map((d) => d.value), 0)
  const range = maxVal - minVal || 1

  const points = data.map((d, i) => ({
    x: pad.left + (i / (data.length - 1 || 1)) * innerW,
    y: pad.top + innerH - ((d.value - minVal) / range) * innerH,
    value: d.value,
    date: d.date,
  }))

  const polyline = points.map((p) => `${p.x},${p.y}`).join(' ')
  const fmt = formatY ?? ((n: number) => n.toLocaleString())

  // Y-axis ticks: 5 lines
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    y: pad.top + innerH - t * innerH,
    label: fmt(minVal + t * range),
  }))

  // X-axis: show every 7th date label, always include last
  const xLabels = data.filter((_, i) => i % 7 === 0 || i === data.length - 1)

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ minWidth: 300 }}
        aria-label={label}
      >
        {/* Grid lines */}
        {yTicks.map((t, i) => (
          <line
            key={i}
            x1={pad.left}
            y1={t.y}
            x2={width - pad.right}
            y2={t.y}
            stroke="#f0f0f0"
            strokeWidth="1"
          />
        ))}
        {/* Y-axis labels */}
        {yTicks.map((t, i) => (
          <text
            key={i}
            x={pad.left - 5}
            y={t.y + 4}
            textAnchor="end"
            fontSize="11"
            fill="#6b7280"
          >
            {t.label}
          </text>
        ))}
        {/* X-axis labels */}
        {xLabels.map((d, i) => {
          const idx = data.indexOf(d)
          const x = pad.left + (idx / (data.length - 1 || 1)) * innerW
          return (
            <text
              key={i}
              x={x}
              y={height - 5}
              textAnchor="middle"
              fontSize="10"
              fill="#6b7280"
            >
              {d.date.slice(5)}
            </text>
          )
        })}
        {/* Line */}
        <polyline
          points={polyline}
          fill="none"
          stroke="#EAB308"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        {/* Dots — only if few data points */}
        {data.length <= 30 &&
          points.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r="3" fill="#EAB308" />
          ))}
      </svg>
    </div>
  )
}

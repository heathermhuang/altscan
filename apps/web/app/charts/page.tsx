import { db } from '@/lib/db'
import { sql } from 'drizzle-orm'

export const revalidate = 3600

type DataPoint = { date: string; value: number }

async function fetchDailyTxCount(): Promise<DataPoint[]> {
  try {
    const result = await db.execute(sql`
      SELECT DATE(timestamp AT TIME ZONE 'UTC') as date, COUNT(*)::int as value
      FROM transactions
      WHERE timestamp >= NOW() - INTERVAL '30 days'
      GROUP BY 1
      ORDER BY 1
    `)
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
    const result = await db.execute(sql`
      SELECT DATE(timestamp AT TIME ZONE 'UTC') as date,
             AVG(standard::numeric / 1e9)::numeric(18,4) as value
      FROM gas_history
      WHERE timestamp >= NOW() - INTERVAL '30 days'
      GROUP BY 1
      ORDER BY 1
    `)
    return Array.from(result).map((row) => ({
      date: String((row as Record<string, unknown>).date).slice(0, 10),
      value: Number((row as Record<string, unknown>).value),
    }))
  } catch {
    return []
  }
}

async function fetchDailyActiveAddresses(): Promise<DataPoint[]> {
  try {
    const result = await db.execute(sql`
      SELECT DATE(timestamp AT TIME ZONE 'UTC') as date,
             COUNT(DISTINCT from_address)::int as value
      FROM transactions
      WHERE timestamp >= NOW() - INTERVAL '30 days'
      GROUP BY 1
      ORDER BY 1
    `)
    return Array.from(result).map((row) => ({
      date: String((row as Record<string, unknown>).date).slice(0, 10),
      value: Number((row as Record<string, unknown>).value),
    }))
  } catch {
    return []
  }
}

export default async function ChartsPage() {
  const [txData, gasData, addressData] = await Promise.all([
    fetchDailyTxCount(),
    fetchDailyGasHistory(),
    fetchDailyActiveAddresses(),
  ])

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-8">Charts</h1>

      <div className="space-y-8">
        <ChartCard title="Daily Transaction Count (Last 30 Days)">
          <LineChart
            data={txData}
            label="Transactions"
            formatY={(n) => n.toLocaleString()}
          />
        </ChartCard>

        <ChartCard title="Gas Price History — Avg Standard (Last 30 Days, Gwei)">
          <LineChart
            data={gasData}
            label="Gwei"
            formatY={(n) => `${n.toFixed(2)} Gwei`}
          />
        </ChartCard>

        <ChartCard title="Active Addresses (Last 30 Days)">
          <LineChart
            data={addressData}
            label="Active Addresses"
            formatY={(n) => n.toLocaleString()}
          />
        </ChartCard>
      </div>
    </div>
  )
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
      <h2 className="font-semibold text-gray-800 mb-4">{title}</h2>
      {children}
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

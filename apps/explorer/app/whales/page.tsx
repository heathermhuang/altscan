import { db, schema } from '@/lib/db'
import { desc, sql } from 'drizzle-orm'
import { timeAgo, formatAddress, safeBigInt } from '@/lib/format'
import Link from 'next/link'
import { chainConfig } from '@/lib/chain'

export const dynamic = 'force-dynamic'

type WhaleTx = {
  hash: string
  fromAddress: string
  toAddress: string | null
  value: string
  blockNumber: number
  timestamp: Date
}

const PERIOD_LABELS: Record<string, string> = {
  '1h': 'Last 1h',
  '24h': 'Last 24h',
  '7d': 'Last 7d',
  all: 'All Time',
}

export default async function WhalesPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>
}) {
  const { period: periodParam } = await searchParams
  const period = ['1h', '24h', '7d', 'all'].includes(periodParam ?? '') ? (periodParam as string) : '24h'

  // Compute cutoff relative to the most recently indexed data, not NOW().
  const maxTimestamp: Date | null = await db
    .select({ max: sql<Date>`MAX(timestamp)` })
    .from(schema.transactions)
    .then(r => r[0]?.max ?? null)
    .catch(() => null)

  const base = maxTimestamp ? new Date(maxTimestamp) : new Date()
  const cutoff =
    period === '1h'
      ? new Date(base.getTime() - 3600000)
      : period === '24h'
      ? new Date(base.getTime() - 86400000)
      : period === '7d'
      ? new Date(base.getTime() - 7 * 86400000)
      : null

  let whales: WhaleTx[] = []

  try {
    if (cutoff) {
      whales = await db
        .select({
          hash: schema.transactions.hash,
          fromAddress: schema.transactions.fromAddress,
          toAddress: schema.transactions.toAddress,
          value: schema.transactions.value,
          blockNumber: schema.transactions.blockNumber,
          timestamp: schema.transactions.timestamp,
        })
        .from(schema.transactions)
        .where(sql`${schema.transactions.timestamp} >= ${cutoff} AND ${schema.transactions.value}::numeric > 0`)
        .orderBy(desc(sql`${schema.transactions.value}::numeric`))
        .limit(50)
    } else {
      whales = await db
        .select({
          hash: schema.transactions.hash,
          fromAddress: schema.transactions.fromAddress,
          toAddress: schema.transactions.toAddress,
          value: schema.transactions.value,
          blockNumber: schema.transactions.blockNumber,
          timestamp: schema.transactions.timestamp,
        })
        .from(schema.transactions)
        .where(sql`${schema.transactions.value}::numeric > 0`)
        .orderBy(desc(sql`${schema.transactions.value}::numeric`))
        .limit(50)
    }
    whales = whales.map(w => ({ ...w, timestamp: new Date(w.timestamp) }))
  } catch { /* DB not connected */ }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1">Whale Tracker</h1>
        <p className="text-gray-500 text-sm">Large token transfers on {chainConfig.name}</p>
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
              <th className="text-right px-4 py-2 text-gray-500">Amount ({chainConfig.currency})</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {whales.map((w) => {
              const displayAmount = (() => {
                try {
                  const divisor = 10n ** 18n
                  const raw = safeBigInt(w.value)
                  const whole = raw / divisor
                  const frac = raw % divisor
                  const fracStr = frac.toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '')
                  return fracStr ? `${whole.toLocaleString()}.${fracStr}` : whole.toLocaleString()
                } catch {
                  return '—'
                }
              })()

              return (
                <tr key={w.hash} className="hover:bg-gray-50">
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
                    <span className="text-gray-500 font-normal text-xs">{chainConfig.currency}</span>
                  </td>
                </tr>
              )
            })}
            {whales.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                  No large {chainConfig.currency} transfers found for this time period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

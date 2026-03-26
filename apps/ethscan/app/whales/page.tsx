import { db, schema } from '@/lib/db'
import { desc, gte, sql } from 'drizzle-orm'
import { timeAgo, formatAddress, safeBigInt } from '@/lib/format'
import Link from 'next/link'

export const revalidate = 30

type WhaleTransfer = {
  id: number
  txHash: string
  tokenAddress: string
  fromAddress: string
  toAddress: string
  value: string
  blockNumber: number
  timestamp: Date
  tokenSymbol: string | null
  tokenName: string | null
  tokenDecimals: number | null
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

  const maxTimestamp: Date | null = await db
    .select({ max: sql<Date>`MAX(timestamp)` })
    .from(schema.tokenTransfers)
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

  let whales: WhaleTransfer[] = []

  try {
    let rawTransfers: typeof schema.tokenTransfers.$inferSelect[]

    if (cutoff) {
      rawTransfers = await db
        .select()
        .from(schema.tokenTransfers)
        .where(gte(schema.tokenTransfers.timestamp, cutoff))
        .orderBy(desc(sql`value::numeric`))
        .limit(50)
    } else {
      rawTransfers = await db
        .select()
        .from(schema.tokenTransfers)
        .orderBy(desc(sql`value::numeric`))
        .limit(50)
    }

    whales = await Promise.all(
      rawTransfers.map(async (t) => {
        let tokenSymbol: string | null = null
        let tokenName: string | null = null
        let tokenDecimals: number | null = null
        try {
          const [tok] = await db
            .select({ symbol: schema.tokens.symbol, name: schema.tokens.name, decimals: schema.tokens.decimals })
            .from(schema.tokens)
            .where(sql`address = ${t.tokenAddress}`)
            .limit(1)
          if (tok) { tokenSymbol = tok.symbol; tokenName = tok.name; tokenDecimals = tok.decimals }
        } catch { /* ignore */ }
        return {
          id: t.id,
          txHash: t.txHash,
          tokenAddress: t.tokenAddress,
          fromAddress: t.fromAddress,
          toAddress: t.toAddress,
          value: t.value ?? '0',
          blockNumber: t.blockNumber,
          timestamp: new Date(t.timestamp),
          tokenSymbol,
          tokenName,
          tokenDecimals,
        }
      })
    )
  } catch { /* DB not connected */ }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1">Whale Tracker</h1>
        <p className="text-gray-500 text-sm">Large token transfers on Ethereum</p>
      </div>

      {/* Period filter */}
      <div className="flex gap-2 mb-6">
        {Object.entries(PERIOD_LABELS).map(([key, label]) => (
          <Link
            key={key}
            href={`/whales?period=${key}`}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
              period === key
                ? 'bg-indigo-600 border-indigo-600 text-white'
                : 'bg-white border-gray-200 text-gray-600 hover:border-indigo-400 hover:text-indigo-700'
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
              <th className="text-left px-4 py-2 text-gray-500">Token</th>
              <th className="text-left px-4 py-2 text-gray-500">From</th>
              <th className="text-left px-4 py-2 text-gray-500">To</th>
              <th className="text-left px-4 py-2 text-gray-500">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {whales.map((w) => {
              const displayAmount = (() => {
                try {
                  const decimals = w.tokenDecimals ?? 18
                  const divisor = 10n ** BigInt(decimals)
                  const raw = safeBigInt(w.value)
                  const whole = raw / divisor
                  const frac = raw % divisor
                  const fracStr = frac.toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '')
                  return fracStr ? `${whole.toLocaleString()}.${fracStr}` : whole.toLocaleString()
                } catch {
                  return '—'
                }
              })()

              return (
                <tr key={w.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{timeAgo(w.timestamp)}</td>
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link href={`/tx/${w.txHash}`} className="text-indigo-600 hover:underline">
                      {w.txHash.slice(0, 14)}…
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <Link href={`/token/${w.tokenAddress}`} className="text-blue-600 hover:underline font-medium">
                      {w.tokenSymbol ?? w.tokenAddress.slice(0, 8) + '…'}
                    </Link>
                    {w.tokenName && (
                      <span className="text-xs text-gray-400 ml-1">{w.tokenName}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link href={`/address/${w.fromAddress}`} className="text-blue-600 hover:underline">
                      {formatAddress(w.fromAddress)}
                    </Link>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link href={`/address/${w.toAddress}`} className="text-blue-600 hover:underline">
                      {formatAddress(w.toAddress)}
                    </Link>
                  </td>
                  <td className="px-4 py-2 font-semibold">
                    {displayAmount}{' '}
                    <span className="text-gray-500 font-normal">{w.tokenSymbol ?? ''}</span>
                  </td>
                </tr>
              )
            })}
            {whales.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
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

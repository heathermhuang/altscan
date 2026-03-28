import { db, schema } from '@/lib/db'
import { desc, count, sql } from 'drizzle-orm'
import { timeAgo, formatETH } from '@/lib/format'
import { Pagination } from '@/components/ui/Pagination'
import Link from 'next/link'

export const revalidate = 10

const PAGE_SIZE = 25

type TopPair = { pair_address: string; dex: string; trade_count: number }

export default async function DexPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  const { page: pageStr } = await searchParams
  const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1)
  const offset = (page - 1) * PAGE_SIZE

  let trades: typeof schema.dexTrades.$inferSelect[] = []
  let totalTrades = 0
  let uniqueMakers = 0
  let topPairs: TopPair[] = []

  try {
    const [tradesResult, tradeCountResult, makerCountResult, topPairsResult] = await Promise.all([
      db.select().from(schema.dexTrades).orderBy(desc(schema.dexTrades.blockNumber)).limit(PAGE_SIZE).offset(offset),
      db.select({ value: count() }).from(schema.dexTrades),
      db.execute(sql`SELECT COUNT(DISTINCT maker)::int as value FROM dex_trades`),
      db.execute(sql`
        SELECT pair_address, dex, COUNT(*)::int as trade_count
        FROM dex_trades GROUP BY pair_address, dex ORDER BY trade_count DESC LIMIT 5
      `),
    ])

    trades = tradesResult
    totalTrades = tradeCountResult[0]?.value ?? 0
    uniqueMakers = Number((Array.from(makerCountResult)[0] as Record<string, unknown>)?.value ?? 0)
    topPairs = (Array.from(topPairsResult) as Record<string, unknown>[]).map(r => ({
      pair_address: String(r.pair_address),
      dex: String(r.dex),
      trade_count: Number(r.trade_count),
    }))
  } catch { /* DB not connected */ }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">DEX Trades</h1>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <p className="text-xs text-gray-500 mb-1">Total Trades</p>
          <p className="text-lg font-bold">{totalTrades.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <p className="text-xs text-gray-500 mb-1">Unique Traders</p>
          <p className="text-lg font-bold">{uniqueMakers.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <p className="text-xs text-gray-500 mb-1">DEXes Found</p>
          <p className="text-lg font-bold">{topPairs.length > 0 ? new Set(topPairs.map(p => p.dex)).size : '—'}</p>
        </div>
      </div>

      {/* Top Pairs */}
      {topPairs.length > 0 && (
        <div className="bg-white rounded-xl border shadow-sm mb-6 overflow-hidden">
          <div className="px-4 py-3 border-b">
            <h2 className="font-semibold">Top Pairs by Trade Count</h2>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-2 text-gray-500">#</th>
                <th className="text-left px-4 py-2 text-gray-500">Pair Address</th>
                <th className="text-left px-4 py-2 text-gray-500">DEX</th>
                <th className="text-left px-4 py-2 text-gray-500">Trades</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {topPairs.map((pair, i) => (
                <tr key={pair.pair_address} className="hover:bg-gray-50">
                  <td className="px-4 py-2 text-gray-400">{i + 1}</td>
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link href={`/address/${pair.pair_address}`} className="text-blue-600 hover:underline">
                      {pair.pair_address.slice(0, 14)}…
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-gray-700">{pair.dex}</td>
                  <td className="px-4 py-2 font-semibold">{pair.trade_count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Trades table */}
      <div className="bg-white rounded-xl border shadow-sm overflow-hidden mb-4">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-2 text-gray-500">Tx Hash</th>
              <th className="text-left px-4 py-2 text-gray-500">DEX</th>
              <th className="text-left px-4 py-2 text-gray-500">Pair</th>
              <th className="text-left px-4 py-2 text-gray-500">Amount In</th>
              <th className="text-left px-4 py-2 text-gray-500">Amount Out</th>
              <th className="text-left px-4 py-2 text-gray-500">Trader</th>
              <th className="text-left px-4 py-2 text-gray-500">Age</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {trades.map(t => (
              <tr key={t.id} className="hover:bg-gray-50">
                <td className="px-4 py-2 font-mono text-xs">
                  <Link href={`/tx/${t.txHash}`} className="text-indigo-600 hover:underline">
                    {t.txHash.slice(0, 14)}…
                  </Link>
                </td>
                <td className="px-4 py-2 text-gray-700">{t.dex}</td>
                <td className="px-4 py-2 font-mono text-xs">
                  <Link href={`/address/${t.pairAddress}`} className="text-blue-600 hover:underline">
                    {t.pairAddress.slice(0, 12)}…
                  </Link>
                </td>
                <td className="px-4 py-2 text-gray-700">{formatETH(BigInt(t.amountIn ?? '0'))}</td>
                <td className="px-4 py-2 text-gray-700">{formatETH(BigInt(t.amountOut ?? '0'))}</td>
                <td className="px-4 py-2 font-mono text-xs">
                  <Link href={`/address/${t.maker}`} className="text-blue-600 hover:underline">
                    {t.maker.slice(0, 12)}…
                  </Link>
                </td>
                <td className="px-4 py-2 text-gray-500">{timeAgo(t.timestamp)}</td>
              </tr>
            ))}
            {trades.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-16 text-center"><p className="text-gray-400 text-lg mb-1">No DEX trades found</p><p className="text-gray-300 text-sm">Trades from Uniswap and other DEXes will appear here as they are indexed.</p></td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={totalTrades} perPage={PAGE_SIZE} baseUrl="/dex" />
    </div>
  )
}

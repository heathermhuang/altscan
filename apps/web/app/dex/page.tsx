import { db, schema } from '@/lib/db'
import { desc } from 'drizzle-orm'
import { timeAgo } from '@/lib/format'
import Link from 'next/link'

export const revalidate = 10

export default async function DexPage() {
  const trades = await db.select().from(schema.dexTrades)
    .orderBy(desc(schema.dexTrades.blockNumber))
    .limit(50)

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">DEX Trades</h1>
      <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-2 text-gray-500">Tx Hash</th>
              <th className="text-left px-4 py-2 text-gray-500">DEX</th>
              <th className="text-left px-4 py-2 text-gray-500">Pair</th>
              <th className="text-left px-4 py-2 text-gray-500">Maker</th>
              <th className="text-left px-4 py-2 text-gray-500">Block</th>
              <th className="text-left px-4 py-2 text-gray-500">Age</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {trades.map(t => (
              <tr key={t.id} className="hover:bg-gray-50">
                <td className="px-4 py-2 font-mono text-xs">
                  <Link href={`/tx/${t.txHash}`} className="text-yellow-600 hover:underline">
                    {t.txHash.slice(0, 14)}…
                  </Link>
                </td>
                <td className="px-4 py-2 text-gray-700">{t.dex}</td>
                <td className="px-4 py-2 font-mono text-xs">
                  <Link href={`/address/${t.pairAddress}`} className="text-blue-600 hover:underline">
                    {t.pairAddress.slice(0, 12)}…
                  </Link>
                </td>
                <td className="px-4 py-2 font-mono text-xs">
                  <Link href={`/address/${t.maker}`} className="text-blue-600 hover:underline">
                    {t.maker.slice(0, 12)}…
                  </Link>
                </td>
                <td className="px-4 py-2 text-gray-500">{t.blockNumber}</td>
                <td className="px-4 py-2 text-gray-500">{timeAgo(new Date(t.timestamp))}</td>
              </tr>
            ))}
            {trades.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No trades indexed yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

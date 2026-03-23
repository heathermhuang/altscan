import { db, schema } from '@/lib/db'
import { desc, eq } from 'drizzle-orm'
import Link from 'next/link'
import { formatNumber } from '@/lib/format'

/** Format a raw token supply string into a human-readable number by dividing by 10^decimals. */
function formatSupply(raw: string, decimals: number): string {
  try {
    const divisor = 10n ** BigInt(decimals)
    const whole = BigInt(raw.split('.')[0]) / divisor
    // Abbreviate large numbers: T, B, M, K
    const n = Number(whole)
    if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`
    if (n >= 1e9)  return `${(n / 1e9).toFixed(2)}B`
    if (n >= 1e6)  return `${(n / 1e6).toFixed(2)}M`
    return whole.toLocaleString()
  } catch {
    return raw.slice(0, 12) + (raw.length > 12 ? '…' : '')
  }
}

export const revalidate = 60

export default async function TokenListPage() {
  let tokens: typeof schema.tokens.$inferSelect[] = []
  try {
    tokens = await db.select().from(schema.tokens)
      .where(eq(schema.tokens.type, 'BEP20'))
      .orderBy(desc(schema.tokens.holderCount))
      .limit(50)
  } catch { /* DB not connected */ }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">BEP-20 Tokens</h1>
      <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-2 text-gray-500">#</th>
              <th className="text-left px-4 py-2 text-gray-500">Token</th>
              <th className="text-left px-4 py-2 text-gray-500">Symbol</th>
              <th className="text-left px-4 py-2 text-gray-500">Holders</th>
              <th className="text-left px-4 py-2 text-gray-500">Total Supply</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {tokens.map((t, i) => (
              <tr key={t.address} className="hover:bg-gray-50">
                <td className="px-4 py-2 text-gray-400">{i + 1}</td>
                <td className="px-4 py-2">
                  <Link href={`/token/${t.address}`} className="text-yellow-600 hover:underline font-medium">
                    {t.name}
                  </Link>
                </td>
                <td className="px-4 py-2 text-gray-500">{t.symbol}</td>
                <td className="px-4 py-2">{formatNumber(t.holderCount)}</td>
                <td className="px-4 py-2 text-gray-600">
                  {formatSupply(t.totalSupply, t.decimals)}
                </td>
              </tr>
            ))}
            {tokens.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">No tokens indexed yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

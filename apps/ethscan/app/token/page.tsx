import { db, schema } from '@/lib/db'
import { desc, eq, sql } from 'drizzle-orm'
import Link from 'next/link'
import { formatNumber, safeBigInt } from '@/lib/format'

/** Format a raw token supply string into a human-readable number by dividing by 10^decimals. */
function formatSupply(raw: string, decimals: number): string {
  try {
    const divisor = 10n ** BigInt(decimals)
    const whole = safeBigInt(raw) / divisor
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

export default async function TokenListPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const { q: searchQuery } = await searchParams

  let tokens: typeof schema.tokens.$inferSelect[] = []
  try {
    if (searchQuery && searchQuery.trim().length > 0) {
      const q = `%${searchQuery.trim().toLowerCase()}%`
      tokens = await db.select().from(schema.tokens)
        .where(sql`LOWER(${schema.tokens.name}) LIKE ${q} OR LOWER(${schema.tokens.symbol}) LIKE ${q} OR ${schema.tokens.address} LIKE ${q}`)
        .orderBy(desc(schema.tokens.holderCount))
        .limit(50)
    } else {
      tokens = await db.select().from(schema.tokens)
        .orderBy(desc(schema.tokens.holderCount))
        .limit(50)
    }
  } catch { /* DB not connected */ }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-bold">ERC-20 Tokens</h1>
        <form action="/token" method="get" className="flex items-center gap-2">
          <input
            type="text"
            name="q"
            placeholder="Search by name, symbol, or address..."
            defaultValue={searchQuery ?? ''}
            className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 outline-none w-64 transition-colors"
          />
          <button type="submit" className="px-3 py-1.5 text-sm rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-500 transition-colors">
            Search
          </button>
          {searchQuery && (
            <a href="/token" className="text-xs text-gray-400 hover:text-gray-600">Clear</a>
          )}
        </form>
      </div>
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
                  <Link href={`/token/${t.address}`} className="text-indigo-600 hover:underline font-medium">
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
              <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                {searchQuery ? `No tokens matching "${searchQuery}".` : 'No tokens indexed yet.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

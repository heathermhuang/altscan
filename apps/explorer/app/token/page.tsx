import { db, schema } from '@/lib/db'
import { desc, eq, sql } from 'drizzle-orm'
import Link from 'next/link'
import { formatNumber, safeBigInt } from '@/lib/format'
import { chainConfig } from '@/lib/chain'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: `${chainConfig.key === 'eth' ? 'ERC-20' : 'BEP-20'} Tokens`,
  description: `Explore ${chainConfig.key === 'eth' ? 'ERC-20' : 'BEP-20'} tokens on ${chainConfig.name}. View token supply, holder count, and contract details on ${chainConfig.brandDomain}.`,
  alternates: { canonical: '/token' },
}

/** Format a raw token supply string into a human-readable number by dividing by 10^decimals. */
function formatSupply(raw: string, decimals: number): string {
  try {
    const divisor = 10n ** BigInt(decimals)
    const whole = safeBigInt(raw) / divisor
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

export const revalidate = 30

export default async function TokenListPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; q?: string }>
}) {
  const { type: typeParam, q: searchQuery } = await searchParams
  const validTypes = ['BEP20', 'BEP721', 'BEP1155'] as const
  const tokenType = validTypes.includes(typeParam as typeof validTypes[number])
    ? (typeParam as typeof validTypes[number])
    : 'BEP20'

  let tokens: typeof schema.tokens.$inferSelect[] = []
  try {
    if (searchQuery && searchQuery.trim().length > 0) {
      const q = `%${searchQuery.trim().toLowerCase()}%`
      tokens = await db.select().from(schema.tokens)
        .where(sql`${schema.tokens.type} = ${tokenType} AND (LOWER(${schema.tokens.name}) LIKE ${q} OR LOWER(${schema.tokens.symbol}) LIKE ${q} OR ${schema.tokens.address} LIKE ${q})`)
        .orderBy(desc(schema.tokens.holderCount))
        .limit(50)
    } else {
      tokens = await db.select().from(schema.tokens)
        .where(eq(schema.tokens.type, tokenType))
        .orderBy(desc(schema.tokens.holderCount))
        .limit(50)
    }
  } catch { /* DB not connected */ }

  // Use ERC standard names on Ethereum, BEP on BNB Chain
  const isEth = chainConfig.key === 'eth'
  const typeLabels = isEth
    ? { BEP20: 'ERC-20 Tokens', BEP721: 'ERC-721 NFTs', BEP1155: 'ERC-1155 Multi-Tokens' }
    : { BEP20: 'BEP-20 Tokens', BEP721: 'BEP-721 NFTs', BEP1155: 'BEP-1155 Multi-Tokens' }
  const tabLabels = isEth
    ? { BEP20: 'ERC-20', BEP721: 'ERC-721', BEP1155: 'ERC-1155' }
    : { BEP20: 'BEP20', BEP721: 'BEP721', BEP1155: 'BEP1155' }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-4">{typeLabels[tokenType]}</h1>
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <div className="flex gap-2">
          {validTypes.map(t => (
            <a
              key={t}
              href={`/token?type=${t}`}
              className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                t === tokenType
                  ? `${chainConfig.theme.border} font-semibold bg-opacity-10`
                  : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {tabLabels[t]}
            </a>
          ))}
        </div>
        <form action="/token" method="get" className="flex items-center gap-2 ml-auto">
          <input type="hidden" name="type" value={tokenType} />
          <input
            type="text"
            name="q"
            placeholder="Search by name, symbol, or address..."
            defaultValue={searchQuery ?? ''}
            className={`px-3 py-1.5 text-sm rounded-lg border border-gray-200 ${chainConfig.theme.focusRing} outline-none w-64 transition-colors`}
          />
          <button type="submit" className={`px-3 py-1.5 text-sm rounded-lg ${chainConfig.theme.buttonBg} ${chainConfig.theme.buttonText} font-medium hover:opacity-90 transition-colors`}>
            Search
          </button>
          {searchQuery && (
            <a href={`/token?type=${tokenType}`} className="text-xs text-gray-400 hover:text-gray-600">Clear</a>
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
                  <Link href={`/token/${t.address}`} className={`${chainConfig.theme.linkText} hover:underline font-medium`}>
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

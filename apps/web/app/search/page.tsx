import Link from 'next/link'
import { redirect } from 'next/navigation'
import { db, schema } from '@/lib/db'
import { or, ilike } from 'drizzle-orm'

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const { q } = await searchParams
  const query = (q?.trim() ?? '').slice(0, 200) // Cap length to prevent abuse

  // Server-side redirect for recognized query patterns
  if (query) {
    if (/^0x[0-9a-fA-F]{64}$/.test(query)) redirect(`/tx/${query}`)
    if (/^0x[0-9a-fA-F]{40}$/.test(query)) redirect(`/address/${query}`)
    if (/^\d+$/.test(query)) redirect(`/blocks/${query}`)
  }

  // Token name/symbol search — if nothing else matched, search tokens table
  if (query && query.length >= 2) {
    // Escape SQL LIKE wildcards in user input
    const safeQuery = query.replace(/[%_\\]/g, '\\$&')
    try {
      const tokenMatches = await db.select().from(schema.tokens)
        .where(
          or(
            ilike(schema.tokens.name, `%${safeQuery}%`),
            ilike(schema.tokens.symbol, `%${safeQuery}%`),
          )
        )
        .limit(5)

      if (tokenMatches.length === 1) {
        redirect(`/token/${tokenMatches[0].address}`)
      }

      if (tokenMatches.length > 1) {
        return (
          <div className="max-w-7xl mx-auto px-4 py-16">
            <h1 className="text-2xl font-bold mb-2">Search Results</h1>
            <p className="text-gray-500 mb-6">
              Found {tokenMatches.length} tokens matching{' '}
              <span className="font-mono bg-gray-100 px-2 py-0.5 rounded">{query}</span>
            </p>
            <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="text-left px-4 py-2 text-gray-500">Name</th>
                    <th className="text-left px-4 py-2 text-gray-500">Symbol</th>
                    <th className="text-left px-4 py-2 text-gray-500">Type</th>
                    <th className="text-left px-4 py-2 text-gray-500">Contract</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {tokenMatches.map(token => (
                    <tr key={token.address} className="hover:bg-gray-50">
                      <td className="px-4 py-2 font-medium">
                        <Link href={`/token/${token.address}`} className="text-yellow-600 hover:underline">
                          {token.name}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-gray-700">{token.symbol}</td>
                      <td className="px-4 py-2 text-gray-500">{token.type}</td>
                      <td className="px-4 py-2 font-mono text-xs">
                        <Link href={`/token/${token.address}`} className="text-blue-600 hover:underline">
                          {token.address.slice(0, 14)}…
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-6">
              <Link href="/" className="text-yellow-600 hover:underline font-medium">← Back to home</Link>
            </div>
          </div>
        )
      }
    } catch { /* DB error */ }
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-16 text-center">
      <p className="text-5xl mb-6">🔍</p>
      <h1 className="text-2xl font-bold mb-3">No results found</h1>
      {query ? (
        <p className="text-gray-500 mb-6">
          No match for <span className="font-mono bg-gray-100 px-2 py-0.5 rounded">{query}</span>
        </p>
      ) : (
        <p className="text-gray-500 mb-6">Enter a block number, transaction hash, address, or token name in the search bar.</p>
      )}
      <div className="flex flex-wrap justify-center gap-4 text-sm">
        <div className="bg-white border rounded-lg p-4 text-left max-w-xs">
          <p className="font-semibold mb-2">Search tips</p>
          <ul className="text-gray-500 space-y-1">
            <li>• Block number: <span className="font-mono">12345678</span></li>
            <li>• Tx hash: <span className="font-mono">0x + 64 hex chars</span></li>
            <li>• Address: <span className="font-mono">0x + 40 hex chars</span></li>
            <li>• Token name: <span className="font-mono">USDT, BNB, CAKE…</span></li>
          </ul>
        </div>
      </div>
      <div className="mt-8">
        <Link href="/" className="text-yellow-600 hover:underline font-medium">← Back to home</Link>
      </div>
    </div>
  )
}

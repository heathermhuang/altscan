import Link from 'next/link'
import { redirect } from 'next/navigation'

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const { q } = await searchParams
  const query = q?.trim() ?? ''

  // Server-side redirect for recognized query patterns
  if (query) {
    if (/^0x[0-9a-fA-F]{64}$/.test(query)) redirect(`/tx/${query}`)
    if (/^0x[0-9a-fA-F]{40}$/.test(query)) redirect(`/address/${query}`)
    if (/^\d+$/.test(query)) redirect(`/blocks/${query}`)
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
        <p className="text-gray-500 mb-6">Enter a block number, transaction hash, or address in the search bar.</p>
      )}
      <div className="flex flex-wrap justify-center gap-4 text-sm">
        <div className="bg-white border rounded-lg p-4 text-left max-w-xs">
          <p className="font-semibold mb-2">Search tips</p>
          <ul className="text-gray-500 space-y-1">
            <li>• Block number: <span className="font-mono">12345678</span></li>
            <li>• Tx hash: <span className="font-mono">0x + 64 hex chars</span></li>
            <li>• Address: <span className="font-mono">0x + 40 hex chars</span></li>
          </ul>
        </div>
      </div>
      <div className="mt-8">
        <Link href="/" className="text-yellow-600 hover:underline font-medium">← Back to home</Link>
      </div>
    </div>
  )
}

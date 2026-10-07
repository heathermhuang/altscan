import Link from 'next/link'
import { redirect } from 'next/navigation'
import { db, schema } from '@/lib/db'
import { or, ilike } from 'drizzle-orm'
import { chainConfig } from '@/lib/chain'
import { AdReserve } from '@/components/ads/AdReserve'
import { isBinanceIntentQuery } from '@/lib/binance-referral'
import type { Metadata } from 'next'
import { swallow } from '@/lib/observability'

export const metadata: Metadata = {
  title: 'Search',
  description: `Search ${chainConfig.name} blocks, transactions, addresses, and tokens on ${chainConfig.brandDomain}.`,
  alternates: { canonical: '/search' },
}

// Same heading as the detail pages (app/blocks/[number]/page.tsx).
const H1 = 'mt-2 text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.05] tracking-[-0.03em] text-ink'

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const { q } = await searchParams
  const query = (q?.trim() ?? '').slice(0, 200) // Cap length to prevent abuse
  const showReferral = isBinanceIntentQuery(query)

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
    // redirect() works by THROWING, so it must be called outside the try — the catch below would
    // swallow it and a single-token match would fall through to "No results found".
    let singleMatch: string | null = null
    try {
      const tokenMatches = await db.select().from(schema.tokens)
        .where(
          or(
            ilike(schema.tokens.name, `%${safeQuery}%`),
            ilike(schema.tokens.symbol, `%${safeQuery}%`),
          )
        )
        .limit(5)

      if (tokenMatches.length === 1) singleMatch = tokenMatches[0].address

      if (tokenMatches.length > 1) {
        return (
          <div className="max-w-7xl mx-auto px-4 py-8">
            <p className="k">{'// '}search</p>
            <h1 className={H1}>Search results</h1>
            <p className="mt-3 mb-6 text-ink2">
              Found {tokenMatches.length} tokens matching{' '}
              <span className="font-mono text-ink break-all">{query}</span>
            </p>
            {showReferral && (
              <AdReserve
                context="search_intent"
                placement="search_results"
                variant="compact"
                className="mb-6"
              />
            )}
            <div className="bg-card rounded-xl border border-hair overflow-hidden">
              <div className="overflow-x-auto">
              <table className="dt">
                <caption className="sr-only">Token search results for {query}</caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Symbol</th>
                    <th scope="col">Type</th>
                    <th scope="col">Contract</th>
                  </tr>
                </thead>
                <tbody>
                  {tokenMatches.map(token => (
                    <tr key={token.address}>
                      <td>
                        <Link href={`/token/${token.address}`} className="text-acc-ink font-medium hover:underline">
                          {token.name}
                        </Link>
                      </td>
                      <td className="text-ink">{token.symbol}</td>
                      <td className="text-mut">{token.type}</td>
                      <td>
                        <Link href={`/token/${token.address}`} className="text-acc-ink hover:underline">
                          {token.address.slice(0, 14)}…
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
            <div className="mt-6">
              <Link href="/" className="text-acc-ink hover:underline font-medium">← Back to home</Link>
            </div>
          </div>
        )
      }
    } catch (e) { swallow('search/query', e) }  // DB error
    if (singleMatch) redirect(`/token/${singleMatch}`)
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <p className="k">{'// '}search</p>
      <h1 className={H1}>No results found</h1>
      {query ? (
        <p className="mt-3 mb-6 text-ink2">
          No match for <span className="font-mono text-ink break-all">{query}</span>
        </p>
      ) : (
        <p className="mt-3 mb-6 text-ink2">Enter a block number, transaction hash, address, or token name in the search bar.</p>
      )}
      {showReferral && (
        <AdReserve
          context="search_intent"
          placement="search_no_results"
          variant="compact"
          className="mb-6 text-left"
        />
      )}
      <div className="max-w-xs rounded-xl border border-hair bg-card p-4 text-sm">
        <p className="font-semibold mb-2 text-ink">Search tips</p>
        <ul className="text-mut space-y-1">
          <li>• Block number: <span className="font-mono text-ink2">12345678</span></li>
          <li>• Tx hash: <span className="font-mono text-ink2">0x + 64 hex chars</span></li>
          <li>• Address: <span className="font-mono text-ink2">0x + 40 hex chars</span></li>
          <li>• Token name: <span className="font-mono text-ink2">USDT, {chainConfig.currency}…</span></li>
        </ul>
      </div>
      <div className="mt-8">
        <Link href="/" className="text-acc-ink hover:underline font-medium">← Back to home</Link>
      </div>
    </div>
  )
}

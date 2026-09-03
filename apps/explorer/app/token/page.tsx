import { db, schema } from '@/lib/db'
import { desc, eq, sql } from 'drizzle-orm'
import Link from 'next/link'
import { formatNumber, safeBigInt } from '@/lib/format'
import { chainConfig } from '@/lib/chain'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'
import type { Metadata } from 'next'
import { swallow } from '@/lib/observability'

export const metadata: Metadata = {
  title: `${chainConfig.tokenStandard} Tokens`,
  description: `Explore ${chainConfig.tokenStandard} tokens on ${chainConfig.name}. View token supply, holder count, and contract details on ${chainConfig.brandDomain}.`,
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
  } catch (e) {
    swallow('tokens/list', e)
    return raw.slice(0, 12) + (raw.length > 12 ? '…' : '')
  }
}

export const revalidate = 60

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
  } catch (e) { swallow('tokens/count', e) }  // DB not connected

  // 'ERC' on Ethereum, 'BEP' on BNB Chain — derived from the configured token
  // standard so a new chain gets its own prefix instead of silently inheriting
  // BNB's. (This also hyphenates the BNB tab labels, matching the headings.)
  const std = chainConfig.tokenStandard.split('-')[0]
  const typeLabels = {
    BEP20: `${std}-20 Tokens`, BEP721: `${std}-721 NFTs`, BEP1155: `${std}-1155 Multi-Tokens`,
  }
  const tabLabels = {
    BEP20: `${std}-20`, BEP721: `${std}-721`, BEP1155: `${std}-1155`,
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <BreadcrumbJsonLd items={[{ name: 'Tokens' }]} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: [
            { '@type': 'Question', name: `What are ${chainConfig.tokenStandard} tokens?`, acceptedAnswer: { '@type': 'Answer', text: `${chainConfig.tokenStandard} is the standard token interface on ${chainConfig.name}. These fungible tokens can represent anything — currencies, utility points, governance votes, or real-world assets. Each token is a smart contract that tracks balances and allows transfers between addresses.` } },
            { '@type': 'Question', name: `How do I check token holders on ${chainConfig.brandDomain}?`, acceptedAnswer: { '@type': 'Answer', text: `Click on any token in the list to see its detail page, which shows the total supply, holder count, recent transfers, and top holders. You can also search by token name, symbol, or contract address.` } },
            { '@type': 'Question', name: `What is the difference between ${std}-20, ${std}-721, and ${std}-1155?`, acceptedAnswer: { '@type': 'Answer', text: `${chainConfig.tokenStandard} tokens are fungible (interchangeable, like currencies). ${std}-721 tokens are non-fungible (unique, like NFTs). ${std}-1155 is a multi-token standard that supports both fungible and non-fungible tokens in a single contract.` } },
          ],
        }) }}
      />
      <h1 className="text-2xl font-bold mb-2">{typeLabels[tokenType]}</h1>
      <p className="text-gray-500 text-sm mb-4">
        Browse all indexed {chainConfig.tokenStandard} tokens on {chainConfig.name}, ranked by holder count. {chainConfig.tokenStandard} is the standard fungible token interface — each token listed here is a smart contract that tracks balances across all holders.
      </p>
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
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{typeLabels[tokenType]} sorted by holder count</caption>
          <thead className="bg-gray-50 border-b">
            <tr>
              <th scope="col" className="text-left px-4 py-2 text-gray-500">#</th>
              <th scope="col" className="text-left px-4 py-2 text-gray-500">Token</th>
              <th scope="col" className="text-left px-4 py-2 text-gray-500">Symbol</th>
              <th scope="col" className="text-left px-4 py-2 text-gray-500">Holders</th>
              <th scope="col" className="text-left px-4 py-2 text-gray-500">Total Supply</th>
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
    </div>
  )
}

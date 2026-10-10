import { db, schema } from '@/lib/db'
import { desc, eq, sql } from 'drizzle-orm'
import Link from 'next/link'
import { formatCompact, formatHolders, hasSupply, safeBigInt, tokenTextOr } from '@/lib/format'
import { shortenAddress } from '@/lib/address-display'
import { lookalikeOf, lookalikeNote } from '@/lib/lookalike'
import { looksLikeUrlOrHandle } from '@/lib/link-in-name'
import { LinkInName } from '@/components/ui/LinkInName'
import { tokenTypeLabel } from '@/lib/token-type-label'
import { chainConfig } from '@/lib/chain'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'
import type { Metadata } from 'next'
import { swallow } from '@/lib/observability'
import { HOLDER_LABELS } from '@/lib/holder-labels'

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
    // Under a million the whole figure, grouped; from there the one compact ladder (capped at 999T+).
    return whole < 1_000_000n ? whole.toLocaleString() : formatCompact(Number(whole))
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
  const tabLabels = {
    BEP20: tokenTypeLabel('BEP20', chainConfig.tokenStandard),
    BEP721: tokenTypeLabel('BEP721', chainConfig.tokenStandard),
    BEP1155: tokenTypeLabel('BEP1155', chainConfig.tokenStandard),
  }
  const typeLabels = {
    BEP20: `${tabLabels.BEP20} Tokens`, BEP721: `${tabLabels.BEP721} NFTs`, BEP1155: `${tabLabels.BEP1155} Multi-Tokens`,
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
      <div className="mb-5">
        <p className="k">{'// '}tokens</p>
        <h1 className="mt-2 text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.05] tracking-[-0.03em] text-ink">{typeLabels[tokenType]}</h1>
        <p className="mt-2 max-w-3xl text-sm text-ink2">
          Browse all indexed {chainConfig.tokenStandard} tokens on {chainConfig.name}, ranked by holder count. {chainConfig.tokenStandard} is the standard fungible token interface — each token listed here is a smart contract that tracks balances across all holders.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <div className="flex gap-2">
          {validTypes.map(t => (
            <a
              key={t}
              href={`/token?type=${t}`}
              className={`rounded-[9px] border px-3 py-1.5 text-sm transition-colors ${
                t === tokenType
                  ? 'border-acc font-semibold text-acc-ink'
                  : 'border-hair text-ink2 hover:border-hair3'
              }`}
            >
              {tabLabels[t]}
            </a>
          ))}
        </div>
        <form action="/token" method="get" className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
          <input type="hidden" name="type" value={tokenType} />
          <input
            type="text"
            name="q"
            placeholder="Search by name, symbol, or address..."
            defaultValue={searchQuery ?? ''}
            className="min-w-0 flex-1 rounded-[9px] border border-hair bg-card px-3 py-1.5 text-sm text-ink placeholder:text-mut hover:border-hair3 sm:w-64 sm:flex-none"
          />
          <button type="submit" className="shrink-0 rounded-[9px] bg-ink px-3 py-1.5 text-sm font-semibold text-card transition-opacity hover:opacity-90">
            Search
          </button>
          {searchQuery && (
            <a href={`/token?type=${tokenType}`} className="shrink-0 text-xs text-mut hover:text-ink">Clear</a>
          )}
        </form>
      </div>
      <div className="bg-card rounded-xl border border-hair overflow-hidden">
        <div className="overflow-x-auto">
        {/* `.dt-tk` (app/globals.css) turns each row into a three-line card under 640px from these same
            cells, so every column is in the DOM at every width. Keep the cell order. */}
        <table className="dt dt-tk">
          <caption className="sr-only">{typeLabels[tokenType]} sorted by holder count</caption>
          <thead className="max-sm:sr-only">
            <tr>
              <th scope="col">#</th>
              <th scope="col">Token</th>
              <th scope="col">Symbol</th>
              <th scope="col" title={HOLDER_LABELS.indexed.title}>{HOLDER_LABELS.indexed.heading}</th>
              <th scope="col">Total Supply</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t, i) => {
              const nameLink = (
                <Link href={`/token/${t.address}`} className="text-acc-ink font-medium hover:underline">
                  {tokenTextOr(t.name, shortenAddress(t.address))}
                </Link>
              )
              // Flagged rows only: an unflagged row's cell is the bare link, with no extra node in the HTML or the flight payload.
              const lookalike = lookalikeOf(t, chainConfig.key)
              const inName = looksLikeUrlOrHandle(t.name) || looksLikeUrlOrHandle(t.symbol)
              return (
                <tr key={t.address}>
                  <td className="text-mut">{i + 1}</td>
                  <td>
                    {lookalike || inName ? (
                      <>
                        {nameLink}
                        {lookalike && (
                          <span className="badge badge-bad ml-2" title={lookalikeNote(lookalike)}>
                            lookalike<span className="sr-only"> of {lookalike.symbol}</span>
                          </span>
                        )}
                        {inName && <LinkInName className="ml-2" />}
                      </>
                    ) : nameLink}
                  </td>
                  <td className="text-mut">{tokenTextOr(t.symbol, '—')}</td>
                  <td title={HOLDER_LABELS.indexed.title}>{formatHolders(t.holderCount)}</td>
                  <td className="text-mut">
                    {hasSupply(t.totalSupply) ? formatSupply(t.totalSupply, t.decimals) : '—'}
                  </td>
                </tr>
              )
            })}
            {tokens.length === 0 && (
              <tr><td colSpan={5} className="py-8 text-center font-sans text-mut">No tokens indexed yet.</td></tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}

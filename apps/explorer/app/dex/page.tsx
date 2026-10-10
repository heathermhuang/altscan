import { dbErrorMessage } from '@altscan/db'
import { schema } from '@/lib/db'
import {
  fetchDexPage, parseDexTrade, DEX_PAGE_SIZE, TOP_PAIRS_WINDOW, type TopPair,
} from '@/lib/dex-page'
import { parsePageParam } from '@/lib/list-pages'
import { timeAgo, formatAmountCompact, formatEstimate, tokenText, tokenTextOr, UNKNOWN_TOKEN } from '@/lib/format'
import { Pagination } from '@/components/ui/Pagination'
import Link from 'next/link'
import { chainConfig } from '@/lib/chain'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'
import { AdReserve } from '@/components/ads/AdReserve'
import type { Metadata } from 'next'
import { AddressLink } from '@/components/ui/AddressLink'
import { shortHash, shortenAddress } from '@/lib/address-display'
import { dexLegend, dexStripTiles, dexSummary, type DexSwap } from '@/lib/dex-size'
import { TileStrip } from '@/components/tape/TileStrip'

export const metadata: Metadata = {
  title: `DEX Trades`,
  description: `Live decentralized exchange trades on ${chainConfig.name}. View recent swaps, pairs, and amounts on ${chainConfig.brandDomain}.`,
  alternates: { canonical: '/dex' },
}

// Next.js statically analyses route segment config and cannot resolve an
// imported identifier here — `export const revalidate = DEX_REVALIDATE_SECONDS`
// fails the BUILD with "Unknown identifier at revalidate", which typecheck and
// the test suite both pass because CI never builds the explorer. It must be a
// literal. `revalidate-parity.test.ts` pins it to the cache TTL so the two
// cannot drift.
export const revalidate = 300

// What this page covers, said once so the intro and the FAQ JSON-LD cannot drift apart.
const dexScope = `Swaps from ${chainConfig.dex.primary} and compatible AMM pairs, indexed from on-chain Swap events.`

export default async function DexPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  const page = parsePageParam((await searchParams).page)

  let trades: typeof schema.dexTrades.$inferSelect[] = []
  let totalTrades = 0
  let topPairs: TopPair[] = []
  let nativeUsd: number | null = null
  const tokenDecimalsMap = new Map<string, number>()
  const tokenSymbolMap = new Map<string, string>()

  try {
    const data = await fetchDexPage(page)
    trades = data.trades.map(parseDexTrade)
    totalTrades = data.totalTrades
    topPairs = data.topPairs
    nativeUsd = data.nativeUsd
    for (const t of data.tokens) {
      tokenDecimalsMap.set(t.address, t.decimals)
      tokenSymbolMap.set(t.address, t.symbol)
    }
  } catch (err) {
    console.error('[dex] page query failed:', dbErrorMessage(err))
  }

  // The indexer stores '???' for a symbol it could not read: that is an unknown token, not a ticker.
  // A token with no metadata row at all keeps its bare amount. A symbol that reads as a URL or handle is an advert
  // (lib/link-in-name), so the leg names that token by its short address; any other is printed as given.
  const symbolText = (address: string | null) => {
    const symbol = tokenSymbolMap.get(address?.toLowerCase() ?? '')
    if (symbol === undefined) return ''
    const token = address ?? ''
    return tokenText(symbol, null, token).linkLike ? shortenAddress(token) : tokenTextOr(symbol, UNKNOWN_TOKEN)
  }

  // The strip draws the same trades as the table below it, sized from the cached trades and the cached
  // native price: nothing is fetched here (lib/dex-page.ts, lib/dex-size.ts).
  const swaps: DexSwap[] = trades.map(t => ({
    id: t.id, txHash: t.txHash, tokenIn: t.tokenIn, tokenOut: t.tokenOut,
    amountIn: t.amountIn, amountOut: t.amountOut,
  }))
  const stripTiles = dexStripTiles(
    swaps,
    nativeUsd,
    address => symbolText(address) || (address ? shortenAddress(address) : UNKNOWN_TOKEN),
  )
  const sized = stripTiles.filter(t => !t.hatch).length

  return (
    <>
    <div className="max-w-7xl mx-auto px-4 pt-8">
      <BreadcrumbJsonLd items={[{ name: 'DEX Trades' }]} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: [
            { '@type': 'Question', name: `What are DEX trades on ${chainConfig.name}?`, acceptedAnswer: { '@type': 'Answer', text: `DEX (Decentralized Exchange) trades are token swaps executed directly on ${chainConfig.name} through automated market maker (AMM) protocols like ${chainConfig.dex.primary}. Unlike centralized exchanges, DEX trades happen on-chain — every swap is a blockchain transaction that anyone can verify.` } },
            { '@type': 'Question', name: `Which DEXes does ${chainConfig.brandDomain} track?`, acceptedAnswer: { '@type': 'Answer', text: `${dexScope} Trades are detected by monitoring Swap event logs emitted by pair contracts.` } },
          ],
        }) }}
      />
      <div className="mb-5">
        <p className="k">{'// '}dex</p>
        <h1 className="mt-2 text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.05] tracking-[-0.03em] text-ink">DEX Trades</h1>
        <p className="mt-2 max-w-3xl text-sm text-ink2">
          Decentralized exchange activity on {chainConfig.name}. {dexScope}
        </p>
      </div>
    </div>

    {stripTiles.length > 0 && (
      <TileStrip
        entry="last"
        tiles={stripTiles}
        title={`${stripTiles.length} swaps, oldest to newest`}
        stats={{ main: `${sized} priced`, side: `${stripTiles.length - sized} not priced` }}
        label={`${chainConfig.name} recent swaps, width is USD size, hatched tiles are not priced`}
        legend={dexLegend(chainConfig.currency, nativeUsd !== null)}
        summary={dexSummary(swaps, nativeUsd, chainConfig.currency)}
      />
    )}

    <div className={`max-w-7xl mx-auto px-4 pb-8${stripTiles.length > 0 ? ' pt-6' : ''}`}>
      {/* Stats row */}
      <dl className="ledger [--cols:2] mb-6">
        <Fact label="Total trades (est.)" value={formatEstimate(totalTrades)} />
        <Fact label="DEXes in top pairs" value={topPairs.length > 0 ? new Set(topPairs.map(p => p.dex)).size : '—'} />
      </dl>

      {/* Top Pairs */}
      {topPairs.length > 0 && (
        <div className="bg-card rounded-xl border border-hair mb-6 overflow-hidden">
          <div className="px-4 py-3 border-b border-hair">
            <h2 className="font-semibold tracking-[-0.02em] text-ink">Top Pairs by Trade Count <span className="text-xs font-normal text-mut">(last {TOP_PAIRS_WINDOW.toLocaleString()} trades)</span></h2>
          </div>
          <div className="overflow-x-auto">
          <table className="dt">
            <caption className="sr-only">Top trading pairs by trade count over the last {TOP_PAIRS_WINDOW.toLocaleString()} trades on {chainConfig.name}</caption>
            <thead>
              <tr>
                <th scope="col" className="hidden sm:table-cell">#</th>
                <th scope="col">Pair Address</th>
                <th scope="col" className="hidden sm:table-cell">DEX</th>
                <th scope="col">Trades</th>
              </tr>
            </thead>
            <tbody>
              {topPairs.map((pair, i) => (
                <tr key={pair.pair_address}>
                  <td className="text-mut hidden sm:table-cell">{i + 1}</td>
                  <td>
                    <AddressLink address={pair.pair_address} />
                  </td>
                  <td className="text-ink2 hidden sm:table-cell">{pair.dex}</td>
                  <td className="font-semibold">{pair.trade_count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* Trades table */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold tracking-[-0.02em] text-ink">Recent Trades</h2>
      </div>
      <div className="bg-card rounded-xl border border-hair overflow-hidden mb-4">
        <div className="overflow-x-auto">
        <table className="dt">
          <caption className="sr-only">Recent DEX trades on {chainConfig.name}</caption>
          <thead>
            <tr>
              <th scope="col">Tx Hash</th>
              <th scope="col" className="hidden sm:table-cell">DEX</th>
              <th scope="col" className="hidden sm:table-cell">Pair</th>
              <th scope="col">Amount In</th>
              <th scope="col">Amount Out</th>
              <th scope="col" className="hidden sm:table-cell">Maker</th>
              <th scope="col" className="hidden sm:table-cell">Age</th>
            </tr>
          </thead>
          <tbody>
            {trades.map(t => {
              // Look up token decimals from enriched data, default to 18
              const inDecimals = tokenDecimalsMap.get(t.tokenIn?.toLowerCase() ?? '') ?? 18
              const outDecimals = tokenDecimalsMap.get(t.tokenOut?.toLowerCase() ?? '') ?? 18
              const inSymbol = symbolText(t.tokenIn)
              const outSymbol = symbolText(t.tokenOut)
              return (
                <tr key={t.id}>
                  <td className="whitespace-nowrap">
                    <Link href={`/tx/${t.txHash}`} className="text-acc-ink hover:underline">
                      {shortHash(t.txHash)}
                    </Link>
                  </td>
                  <td className="text-ink2 hidden sm:table-cell">{t.dex}</td>
                  <td className="hidden sm:table-cell">
                    <AddressLink address={t.pairAddress} />
                  </td>
                  <td>
                    {formatAmountCompact(t.amountIn, inDecimals)}
                    {inSymbol && <span className="inline-block text-mut ml-1 text-xs">{inSymbol}</span>}
                  </td>
                  <td>
                    {formatAmountCompact(t.amountOut, outDecimals)}
                    {outSymbol && <span className="inline-block text-mut ml-1 text-xs">{outSymbol}</span>}
                  </td>
                  <td className="hidden sm:table-cell">
                    <AddressLink address={t.maker} />
                  </td>
                  <td className="text-mut hidden sm:table-cell">{timeAgo(t.timestamp)}</td>
                </tr>
              )
            })}
            {trades.length === 0 && (
              <tr><td colSpan={7} className="py-16 text-center font-sans"><p className="text-ink2 text-lg mb-1">No DEX trades found</p><p className="text-mut text-sm">Swaps from {chainConfig.dex.primary} and compatible AMM pairs will appear here as they are indexed.</p></td></tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
      <Pagination
        page={page}
        total={totalTrades}
        perPage={DEX_PAGE_SIZE}
        baseUrl="/dex"
      />

      {/* After the tables, so on a phone the trades come first. The placement id is the settings key and keeps its name. */}
      <AdReserve
        context="dex"
        placement="dex_after_stats"
        variant="compact"
        className="mt-6"
      />
    </div>
    </>
  )
}

function Fact({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="k">{label}</dt>
      <dd className="mt-1 break-words font-mono text-[15px] text-ink">{value}</dd>
    </div>
  )
}

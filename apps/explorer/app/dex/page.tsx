import { schema } from '@/lib/db'
import {
  fetchDexPage, parseDexTrade, DEX_PAGE_SIZE, type TopPair,
} from '@/lib/dex-page'
import { parsePageParam } from '@/lib/list-pages'
import { timeAgo, safeBigInt } from '@/lib/format'
import { formatUnits } from 'ethers'
import { Pagination } from '@/components/ui/Pagination'
import Link from 'next/link'
import { chainConfig } from '@/lib/chain'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'
import { AdSlot } from '@/components/ads/AdSlot'
import type { Metadata } from 'next'

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

export default async function DexPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  const page = parsePageParam((await searchParams).page)

  let trades: typeof schema.dexTrades.$inferSelect[] = []
  let totalTrades = 0
  let uniqueMakers = 0
  let topPairs: TopPair[] = []
  const tokenDecimalsMap = new Map<string, number>()
  const tokenSymbolMap = new Map<string, string>()

  try {
    const data = await fetchDexPage(page)
    trades = data.trades.map(parseDexTrade)
    totalTrades = data.totalTrades
    uniqueMakers = data.uniqueMakers
    topPairs = data.topPairs
    for (const t of data.tokens) {
      tokenDecimalsMap.set(t.address, t.decimals)
      tokenSymbolMap.set(t.address, t.symbol)
    }
  } catch (err) {
    console.error('[dex] page query failed:', err instanceof Error ? err.message : err)
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <BreadcrumbJsonLd items={[{ name: 'DEX Trades' }]} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: [
            { '@type': 'Question', name: `What are DEX trades on ${chainConfig.name}?`, acceptedAnswer: { '@type': 'Answer', text: `DEX (Decentralized Exchange) trades are token swaps executed directly on ${chainConfig.name} through automated market maker (AMM) protocols like ${chainConfig.dex.primary}. Unlike centralized exchanges, DEX trades happen on-chain — every swap is a blockchain transaction that anyone can verify.` } },
            { '@type': 'Question', name: `Which DEXes does ${chainConfig.brandDomain} track?`, acceptedAnswer: { '@type': 'Answer', text: `${chainConfig.brandDomain} indexes swap events from all major ${chainConfig.name} DEXes including ${chainConfig.dex.others}. Trades are detected by monitoring Swap event logs emitted by pair contracts.` } },
          ],
        }) }}
      />
      <h1 className="text-2xl font-bold mb-2">DEX Trades</h1>
      <p className="text-gray-500 text-sm mb-6">
        Live decentralized exchange activity on {chainConfig.name}. Every swap from {chainConfig.dex.primary} and other AMMs is indexed in real-time as on-chain Swap events.
      </p>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <p className="text-xs text-gray-500 mb-1">Total Trades</p>
          <p className="text-lg font-bold">{totalTrades.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <p className="text-xs text-gray-500 mb-1">Unique Traders</p>
          <p className="text-lg font-bold">{uniqueMakers.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <p className="text-xs text-gray-500 mb-1">DEXes Found</p>
          <p className="text-lg font-bold">{topPairs.length > 0 ? new Set(topPairs.map(p => p.dex)).size : '—'}</p>
        </div>
      </div>

      <AdSlot
        context="dex"
        placement="dex_after_stats"
        variant="compact"
        className="mb-6"
      />

      {/* Top Pairs */}
      {topPairs.length > 0 && (
        <div className="bg-white rounded-xl border shadow-sm mb-6 overflow-hidden">
          <div className="px-4 py-3 border-b">
            <h2 className="font-semibold">Top Pairs by Trade Count</h2>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Top trading pairs by trade count on {chainConfig.name}</caption>
            <thead className="bg-gray-50 border-b">
              <tr>
                <th scope="col" className="text-left px-4 py-2 text-gray-500">#</th>
                <th scope="col" className="text-left px-4 py-2 text-gray-500">Pair Address</th>
                <th scope="col" className="text-left px-4 py-2 text-gray-500">DEX</th>
                <th scope="col" className="text-left px-4 py-2 text-gray-500">Trades</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {topPairs.map((pair, i) => (
                <tr key={pair.pair_address} className="hover:bg-gray-50">
                  <td className="px-4 py-2 text-gray-400">{i + 1}</td>
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link href={`/address/${pair.pair_address}`} className={`${chainConfig.theme.linkText} hover:underline`}>
                      {pair.pair_address.slice(0, 14)}…
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-gray-700">{pair.dex}</td>
                  <td className="px-4 py-2 font-semibold">{pair.trade_count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* Trades table */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold">Recent Trades</h2>
      </div>
      <div className="bg-white rounded-xl border shadow-sm overflow-hidden mb-4">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Recent DEX trades on {chainConfig.name}</caption>
          <thead className="bg-gray-50 border-b">
            <tr>
              <th scope="col" className="text-left px-4 py-2 text-gray-500">Tx Hash</th>
              <th scope="col" className="text-left px-4 py-2 text-gray-500">DEX</th>
              <th scope="col" className="text-left px-4 py-2 text-gray-500">Pair</th>
              <th scope="col" className="text-left px-4 py-2 text-gray-500">Amount In</th>
              <th scope="col" className="text-left px-4 py-2 text-gray-500">Amount Out</th>
              <th scope="col" className="text-left px-4 py-2 text-gray-500">Maker</th>
              <th scope="col" className="text-left px-4 py-2 text-gray-500">Age</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {trades.map(t => {
              // Look up token decimals from enriched data, default to 18
              const inDecimals = tokenDecimalsMap.get(t.tokenIn?.toLowerCase() ?? '') ?? 18
              const outDecimals = tokenDecimalsMap.get(t.tokenOut?.toLowerCase() ?? '') ?? 18
              const amtIn = Number(formatUnits(safeBigInt(t.amountIn), inDecimals))
              const amtOut = Number(formatUnits(safeBigInt(t.amountOut), outDecimals))
              const inSymbol = tokenSymbolMap.get(t.tokenIn?.toLowerCase() ?? '') ?? ''
              const outSymbol = tokenSymbolMap.get(t.tokenOut?.toLowerCase() ?? '') ?? ''
              return (
                <tr key={t.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link href={`/tx/${t.txHash}`} className={`${chainConfig.theme.linkText} hover:underline`}>
                      {t.txHash.slice(0, 14)}…
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-gray-700">{t.dex}</td>
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link href={`/address/${t.pairAddress}`} className={`${chainConfig.theme.linkText} hover:underline`}>
                      {t.pairAddress.slice(0, 12)}…
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-gray-700">
                    {amtIn > 1e6 ? `${(amtIn / 1e6).toFixed(2)}M` : amtIn > 1000 ? `${(amtIn / 1000).toFixed(2)}K` : amtIn.toFixed(4)}
                    {inSymbol && <span className="text-gray-400 ml-1 text-xs">{inSymbol}</span>}
                  </td>
                  <td className="px-4 py-2 text-gray-700">
                    {amtOut > 1e6 ? `${(amtOut / 1e6).toFixed(2)}M` : amtOut > 1000 ? `${(amtOut / 1000).toFixed(2)}K` : amtOut.toFixed(4)}
                    {outSymbol && <span className="text-gray-400 ml-1 text-xs">{outSymbol}</span>}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link href={`/address/${t.maker}`} className={`${chainConfig.theme.linkText} hover:underline`}>
                      {t.maker.slice(0, 12)}…
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-gray-500">{timeAgo(t.timestamp)}</td>
                </tr>
              )
            })}
            {trades.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-16 text-center"><p className="text-gray-400 text-lg mb-1">No DEX trades found</p><p className="text-gray-300 text-sm">Trades from {chainConfig.dex.primary} and other DEXes will appear here as they are indexed.</p></td></tr>
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
    </div>
  )
}

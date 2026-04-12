import { db, schema } from '@/lib/db'
import { desc, sql } from 'drizzle-orm'
import { timeAgo, safeBigInt } from '@/lib/format'
import { formatUnits } from 'ethers'
import { Pagination } from '@/components/ui/Pagination'
import Link from 'next/link'
import { chainConfig } from '@/lib/chain'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: `DEX Trades`,
  description: `Live decentralized exchange trades on ${chainConfig.name}. View recent swaps, pairs, and amounts on ${chainConfig.brandDomain}.`,
  alternates: { canonical: '/dex' },
}

export const revalidate = 300

const PAGE_SIZE = 25

type TopPair = { pair_address: string; dex: string; trade_count: number }

export default async function DexPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  const { page: pageStr } = await searchParams
  const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1)
  const offset = (page - 1) * PAGE_SIZE

  let trades: typeof schema.dexTrades.$inferSelect[] = []
  let totalTrades = 0
  let uniqueMakers = 0
  let topPairs: TopPair[] = []
  const tokenDecimalsMap = new Map<string, number>()
  const tokenSymbolMap = new Map<string, string>()

  try {
    // Run sequentially to avoid concurrent full-table scans.
    // Replaced COUNT(DISTINCT maker) with reltuples estimate — full scan was causing OOM.
    const tradesResult = await db.select().from(schema.dexTrades)
      .orderBy(desc(schema.dexTrades.blockNumber))
      .limit(PAGE_SIZE)
      .offset(offset)
    const tradeCountResult = await db.execute(sql`SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = 'dex_trades'`)
    // Use reltuples as proxy for unique makers — exact COUNT(DISTINCT) is too expensive
    const makerCountResult = await db.execute(sql`SELECT GREATEST(1, (reltuples / 10)::bigint) AS value FROM pg_class WHERE relname = 'dex_trades'`)
    const topPairsResult = await db.execute(sql`
      SELECT pair_address, dex, COUNT(*)::int as trade_count
      FROM dex_trades
      GROUP BY pair_address, dex
      ORDER BY trade_count DESC
      LIMIT 5
    `)

    trades = tradesResult
    // Fetch token decimals + symbols for all tokens in these trades
    const tokenAddrs = new Set<string>()
    for (const t of tradesResult) {
      if (t.tokenIn) tokenAddrs.add(t.tokenIn.toLowerCase())
      if (t.tokenOut) tokenAddrs.add(t.tokenOut.toLowerCase())
    }
    if (tokenAddrs.size > 0) {
      try {
        const tokens = await db.select({ address: schema.tokens.address, decimals: schema.tokens.decimals, symbol: schema.tokens.symbol })
          .from(schema.tokens)
          .where(sql`${schema.tokens.address} IN (${sql.join([...tokenAddrs].map(a => sql`${a}`), sql`, `)})`)
        for (const tok of tokens) {
          tokenDecimalsMap.set(tok.address.toLowerCase(), tok.decimals)
          tokenSymbolMap.set(tok.address.toLowerCase(), tok.symbol)
        }
      } catch { /* token lookup failed — will use defaults */ }
    }
    totalTrades = Math.max(0, Number((Array.from(tradeCountResult)[0] as Record<string, unknown>)?.estimate ?? 0))
    uniqueMakers = Math.max(0, Number((Array.from(makerCountResult)[0] as Record<string, unknown>)?.value ?? 0))
    topPairs = (Array.from(topPairsResult) as Record<string, unknown>[]).map(r => ({
      pair_address: String(r.pair_address),
      dex: String(r.dex),
      trade_count: Number(r.trade_count),
    }))
  } catch { /* DB not connected */ }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <BreadcrumbJsonLd items={[{ name: 'DEX Trades' }]} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: [
            { '@type': 'Question', name: `What are DEX trades on ${chainConfig.name}?`, acceptedAnswer: { '@type': 'Answer', text: `DEX (Decentralized Exchange) trades are token swaps executed directly on ${chainConfig.name} through automated market maker (AMM) protocols like ${chainConfig.key === 'bnb' ? 'PancakeSwap' : 'Uniswap'}. Unlike centralized exchanges, DEX trades happen on-chain — every swap is a blockchain transaction that anyone can verify.` } },
            { '@type': 'Question', name: `Which DEXes does ${chainConfig.brandDomain} track?`, acceptedAnswer: { '@type': 'Answer', text: `${chainConfig.brandDomain} indexes swap events from all major ${chainConfig.name} DEXes including ${chainConfig.key === 'bnb' ? 'PancakeSwap, BiSwap, and other BNB Chain AMMs' : 'Uniswap V2/V3, SushiSwap, and other Ethereum AMMs'}. Trades are detected by monitoring Swap event logs emitted by pair contracts.` } },
          ],
        }) }}
      />
      <h1 className="text-2xl font-bold mb-2">DEX Trades</h1>
      <p className="text-gray-500 text-sm mb-6">
        Live decentralized exchange activity on {chainConfig.name}. Every swap from {chainConfig.key === 'bnb' ? 'PancakeSwap' : 'Uniswap'} and other AMMs is indexed in real-time as on-chain Swap events.
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

      {/* Top Pairs */}
      {topPairs.length > 0 && (
        <div className="bg-white rounded-xl border shadow-sm mb-6 overflow-hidden">
          <div className="px-4 py-3 border-b">
            <h2 className="font-semibold">Top Pairs by Trade Count</h2>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-2 text-gray-500">#</th>
                <th className="text-left px-4 py-2 text-gray-500">Pair Address</th>
                <th className="text-left px-4 py-2 text-gray-500">DEX</th>
                <th className="text-left px-4 py-2 text-gray-500">Trades</th>
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
      )}

      {/* Trades table */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold">Recent Trades</h2>
      </div>
      <div className="bg-white rounded-xl border shadow-sm overflow-hidden mb-4">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-2 text-gray-500">Tx Hash</th>
              <th className="text-left px-4 py-2 text-gray-500">DEX</th>
              <th className="text-left px-4 py-2 text-gray-500">Pair</th>
              <th className="text-left px-4 py-2 text-gray-500">Amount In</th>
              <th className="text-left px-4 py-2 text-gray-500">Amount Out</th>
              <th className="text-left px-4 py-2 text-gray-500">Maker</th>
              <th className="text-left px-4 py-2 text-gray-500">Age</th>
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
              <tr><td colSpan={7} className="px-4 py-16 text-center"><p className="text-gray-400 text-lg mb-1">No DEX trades found</p><p className="text-gray-300 text-sm">Trades from {chainConfig.key === 'bnb' ? 'PancakeSwap' : 'Uniswap'} and other DEXes will appear here as they are indexed.</p></td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination
        page={page}
        total={totalTrades}
        perPage={PAGE_SIZE}
        baseUrl="/dex"
      />
    </div>
  )
}

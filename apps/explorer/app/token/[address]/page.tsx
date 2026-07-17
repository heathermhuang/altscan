import { db, schema } from '@/lib/db'
import { eq, desc, count } from 'drizzle-orm'
import { cache } from 'react'
import { notFound } from 'next/navigation'
import { formatNumber, formatAddress, formatUsdPrice, formatCompactUsd, formatPercent } from '@/lib/format'
import { CopyButton } from '@/components/ui/CopyButton'
import { Badge } from '@/components/ui/Badge'
import { Pagination } from '@/components/ui/Pagination'
import { BinanceReferralAd } from '@/components/ads/BinanceReferralAd'
import Link from 'next/link'
import type { Metadata } from 'next'
import { analyzeTokenRisk, type RiskSignal } from '@/lib/token-risk'
import { Contract } from 'ethers'
import { getProvider } from '@/lib/rpc'
import { chainConfig } from '@/lib/chain'
import { getTokenMarketData } from '@/lib/market-data'
import { getTokenHolders, EMPTY_HOLDERS } from '@/lib/holders'
import { isStablecoinToken } from '@/lib/binance-referral'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'
import { HoldersLazy, HoldersCountLazy } from './HoldersLazy'

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
]

type OnDemandToken = {
  name: string
  symbol: string
  decimals: number
  totalSupply: string
  holderCount: number
  address: string
  type: string
}

/** Resolve a fallback after `ms` so a slow DB/RPC call never blocks the page render. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

// Wrapped in cache() so generateMetadata and the page render share one RPC round-trip
// per request instead of each firing their own (which doubled the latency on
// not-yet-indexed tokens).
const fetchTokenFromRpc = cache(async (addr: string): Promise<OnDemandToken | null> => {
  try {
    const contract = new Contract(addr, ERC20_ABI, getProvider())
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      contract.name().catch(() => null),
      contract.symbol().catch(() => null),
      contract.decimals().catch(() => 18),
      contract.totalSupply().catch(() => 0n),
    ])
    if (!name && !symbol) return null
    return {
      name: name ?? 'Unknown Token',
      symbol: symbol ?? '???',
      decimals: Number(decimals),
      totalSupply: totalSupply.toString(),
      holderCount: 0,
      address: addr,
      type: chainConfig.key === 'bnb' ? 'BEP-20' : 'ERC-20',
    }
  } catch {
    return null
  }
})

// The indexer persists name='Unknown'/symbol='???'/totalSupply='0' when its
// first-sight RPC metadata fetch fails (apps/indexer/src/block-processor.ts) and
// never re-resolves — so mega-tokens first indexed during a rate-limited window
// (USDT/WBNB/CAKE) render forever as "Unknown (???)" with a 0 supply. When a
// stored row still carries a sentinel, re-resolve it live from RPC for display.
// Only the broken fields are overlaid (guarded against RPC's own failure values),
// so healthy rows and partially-good rows are never regressed. fetchTokenFromRpc
// is cache()'d, so generateMetadata and the page render share one round-trip.
async function healPlaceholderMeta(
  token: typeof schema.tokens.$inferSelect,
  addr: string,
): Promise<typeof schema.tokens.$inferSelect> {
  if (token.name !== 'Unknown' && token.symbol !== '???') return token
  const rpc = await fetchTokenFromRpc(addr)
  if (!rpc) return token
  return {
    ...token,
    name: token.name === 'Unknown' && rpc.name !== 'Unknown Token' ? rpc.name : token.name,
    symbol: token.symbol === '???' && rpc.symbol !== '???' ? rpc.symbol : token.symbol,
    totalSupply: token.totalSupply === '0' && rpc.totalSupply !== '0' ? rpc.totalSupply : token.totalSupply,
  }
}

// Missing tokens return noindex metadata instead of throwing notFound(): on
// this Next version, notFound() from generateMetadata still responds 200 with
// the not-found UI, so status can't be trusted for SEO — noindex in the head
// is what reliably keeps these off Google. The page body's notFound() still
// renders the 404 UI.
const NOT_FOUND_METADATA: Metadata = {
  robots: { index: false, follow: false },
}

export async function generateMetadata({ params }: { params: Promise<{ address: string }> }): Promise<Metadata> {
  const { address } = await params
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return { title: 'Token Not Found', ...NOT_FOUND_METADATA }
  }
  let token: typeof schema.tokens.$inferSelect | null = null
  try {
    const [row] = await db.select().from(schema.tokens).where(eq(schema.tokens.address, address.toLowerCase())).limit(1)
    token = row ?? null
  } catch { /* DB error */ }
  if (!token) {
    const rpcToken = await fetchTokenFromRpc(address.toLowerCase())
    if (rpcToken) return {
      title: `${rpcToken.name} (${rpcToken.symbol})`,
      description: `${rpcToken.name} (${rpcToken.symbol}) token on ${chainConfig.name}.`,
      alternates: { canonical: `/token/${address.toLowerCase()}` },
    }
    return { title: 'Token Not Found', ...NOT_FOUND_METADATA }
  }
  token = await healPlaceholderMeta(token, address.toLowerCase())
  return {
    // No brand suffix: the layout title template (`%s — ${brandDomain}`) appends it
    title: `${token.name} (${token.symbol})`,
    description: `${token.name} (${token.symbol}) ${token.type} token on ${chainConfig.name}. ${token.holderCount.toLocaleString()} holders.`,
    alternates: { canonical: `/token/${address.toLowerCase()}` },
    openGraph: {
      title: `${token.name} (${token.symbol})`,
      description: `${token.type} · ${token.holderCount.toLocaleString()} holders`,
    },
  }
}

export const revalidate = 300

const PAGE_SIZE = 25

export default async function TokenDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ address: string }>
  searchParams: Promise<{ page?: string }>
}) {
  const { address } = await params
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) notFound()
  const { page: pageStr } = await searchParams
  const addr = address.toLowerCase()
  const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1)
  const offset = (page - 1) * PAGE_SIZE

  let token: typeof schema.tokens.$inferSelect | null = null
  try {
    const [row] = await db
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.address, addr))
    token = row ?? null
  } catch { /* DB error */ }

  // If not in DB, fetch live from RPC (free — no Moralis CU cost)
  let isLive = false
  if (!token) {
    const rpcToken = await fetchTokenFromRpc(addr)
    if (rpcToken) {
      token = rpcToken as typeof schema.tokens.$inferSelect
      isLive = true
    } else {
      notFound()
    }
  } else {
    // Indexed row exists but may carry stale "Unknown (???)" placeholders the
    // indexer persisted on a failed first-sight metadata fetch (block-processor.ts).
    // Re-resolve live so mega-tokens (USDT/WBNB/CAKE) don't render as "Unknown".
    token = await healPlaceholderMeta(token, addr)
  }

  // Skip DB-heavy queries for live-fetched tokens (no local transfer data exists).
  // For indexed tokens, time-box every heavy query so a slow aggregation on a
  // mega-token (USDT/WBNB had millions of transfers) renders a partial page instead
  // of hanging until the connection drops ("Connection closed").
  const TRANSFERS_FALLBACK: typeof schema.tokenTransfers.$inferSelect[] = []
  // Market data is independent of local indexing (external DEX/CoinGecko), so fetch it for
  // every real token — including live/not-yet-indexed ones. Holders need Moralis or local
  // transfer data, so they stay gated to indexed tokens (matches the "live" banner).
  // Holders: SSR always renders the labeled local net-flow estimate (0 Moralis CU) — safe for
  // crawlers AND no-JS scrapers hitting the origin direct. Real browsers get accurate Moralis
  // holders client-side via <HoldersLazy> → /api/internal/token/<addr>/holders (bots don't run
  // the XHR, so they never spend CU — same model as the address tabs). This removes the last
  // unguarded SSR Moralis call; the edge /token/ Managed Challenge + holders bucket cap remain.
  const marketDataPromise = withTimeout(getTokenMarketData(addr).catch(() => null), 6000, null)
  const [transfers, totalTransfersRaw, holdersResult, riskSignals] = isLive
    ? [TRANSFERS_FALLBACK, -1, EMPTY_HOLDERS, [] as RiskSignal[]]
    : await Promise.all([
        // Top-N by indexed (token_address, block_number) — fast even for big tokens.
        withTimeout(
          db
            .select()
            .from(schema.tokenTransfers)
            .where(eq(schema.tokenTransfers.tokenAddress, addr))
            .orderBy(desc(schema.tokenTransfers.blockNumber))
            .limit(PAGE_SIZE)
            .offset(offset)
            .catch(() => TRANSFERS_FALLBACK),
          6000,
          TRANSFERS_FALLBACK,
        ),
        // COUNT(*) scans every matching row — slow for mega-tokens. -1 = "unknown"
        // (timed out / errored) so we never render a misleading "0 total".
        withTimeout(
          db
            .select({ value: count() })
            .from(schema.tokenTransfers)
            .where(eq(schema.tokenTransfers.tokenAddress, addr))
            .then(([r]) => r?.value ?? 0)
            .catch(() => -1),
          5000,
          -1,
        ),
        withTimeout(getTokenHolders(addr, { skipProvider: true }).catch(() => EMPTY_HOLDERS), 6000, EMPTY_HOLDERS),
        withTimeout(analyzeTokenRisk(addr).catch(() => [] as RiskSignal[]), 5000, [] as RiskSignal[]),
      ])
  const marketData = await marketDataPromise
  const countKnown = totalTransfersRaw >= 0
  const totalTransfers = countKnown ? totalTransfersRaw : 0
  // When the exact count is unknown, estimate just enough to drive prev/next:
  // assume another page exists only if this one came back full.
  const paginationTotal = countKnown
    ? totalTransfers
    : offset + transfers.length + (transfers.length === PAGE_SIZE ? PAGE_SIZE : 0)

  const displaySupply = (() => {
    try {
      const divisor = 10n ** BigInt(token.decimals)
      const whole = BigInt(token.totalSupply ?? '0') / divisor
      return whole.toLocaleString()
    } catch {
      return (token.totalSupply ?? '0').slice(0, 20)
    }
  })()

  const tokenReferralContext = isStablecoinToken(token.symbol, token.name)
    ? 'stablecoin'
    : 'token_research'

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <BreadcrumbJsonLd items={[{ name: 'Tokens', href: '/token' }, { name: `${token.name} (${token.symbol})` }]} />
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold">{token.name}</h1>
        <Badge variant="default">{token.symbol}</Badge>
        <Badge variant="default">{token.type}</Badge>
        <a
          href={`${chainConfig.externalExplorerUrl}/token/${addr}`}
          target="_blank"
          rel="noopener noreferrer"
          className={`ml-auto text-xs text-gray-400 hover:${chainConfig.theme.linkText} border border-gray-200 hover:${chainConfig.theme.border} rounded px-2 py-1 transition-colors`}
        >
          View on {chainConfig.externalExplorer} ↗
        </a>
      </div>

      {isLive && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-4 text-sm text-blue-800 flex items-center gap-2">
          <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 010 8.49m-8.48-.01a6 6 0 010-8.49m11.31-2.82a10 10 0 010 14.14m-14.14 0a10 10 0 010-14.14"/></svg>
          <span>Showing live data from {chainConfig.name} RPC — this token is not yet in the local index. Transfer history and holder data are unavailable.</span>
        </div>
      )}

      <div className="bg-white rounded-xl border shadow-sm mb-6 p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-gray-500 text-xs mb-0.5">Contract</p>
            <p className="font-mono text-xs">
              {addr.slice(0, 14)}…<CopyButton text={addr} />
            </p>
          </div>
          <div>
            <p className="text-gray-500 text-xs mb-0.5">Decimals</p>
            <p className="font-semibold">{token.decimals}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs mb-0.5">Total Supply</p>
            <p className="font-semibold">{displaySupply}</p>
          </div>
          {!isLive && (
            <div>
              <p className="text-gray-500 text-xs mb-0.5">Holders</p>
              <p className="font-semibold">
                <HoldersCountLazy address={addr} fallback={holdersResult.holderCount ?? token.holderCount} />
              </p>
            </div>
          )}
        </div>
      </div>

      {marketData && (
        <div className="bg-white rounded-xl border shadow-sm mb-6 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Market</h2>
            {marketData.dexUrl && (
              <a
                href={marketData.dexUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-gray-400 hover:underline"
              >
                {marketData.pairLabel} ↗
              </a>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-gray-500 text-xs mb-0.5">Price</p>
              <p className="font-semibold">
                {marketData.priceUsd != null ? formatUsdPrice(marketData.priceUsd) : '—'}
                {marketData.priceChange24h != null && (
                  <span
                    className={`ml-2 text-xs ${
                      marketData.priceChange24h >= 0
                        ? chainConfig.theme.positiveChange
                        : chainConfig.theme.negativeChange
                    }`}
                  >
                    {formatPercent(marketData.priceChange24h)}
                  </span>
                )}
              </p>
            </div>
            <div>
              <p className="text-gray-500 text-xs mb-0.5">24h Volume</p>
              <p className="font-semibold">
                {marketData.volume24h != null ? formatCompactUsd(marketData.volume24h) : '—'}
              </p>
            </div>
            <div>
              <p className="text-gray-500 text-xs mb-0.5">Liquidity</p>
              <p className="font-semibold">
                {marketData.liquidityUsd != null ? formatCompactUsd(marketData.liquidityUsd) : '—'}
              </p>
            </div>
            <div>
              <p className="text-gray-500 text-xs mb-0.5">
                {marketData.marketCap != null ? 'Market Cap' : 'FDV'}
              </p>
              <p className="font-semibold">
                {marketData.marketCap != null
                  ? formatCompactUsd(marketData.marketCap)
                  : marketData.fdv != null
                    ? formatCompactUsd(marketData.fdv)
                    : '—'}
              </p>
            </div>
          </div>
          {marketData.circulatingSupply != null && (
            <p className="text-xs text-gray-400 mt-3">
              Circulating supply: {formatNumber(Math.round(marketData.circulatingSupply))} {token.symbol}
            </p>
          )}
          <p className="text-[11px] text-gray-400 mt-2">
            Market data via DexScreener{marketData.source.includes('coingecko') ? ' + CoinGecko' : ''}. For information only.
          </p>
        </div>
      )}

      <BinanceReferralAd
        context={tokenReferralContext}
        placement={tokenReferralContext === 'stablecoin' ? 'token_stablecoin' : 'token_research'}
        variant="compact"
        className="mb-6"
      />

      {/* Top Holders — SSR shows the local net-flow estimate (0 Moralis CU, crawler/no-JS safe);
          HoldersLazy enhances to accurate Moralis balances client-side for real browsers. */}
      {!isLive && (
        <HoldersLazy
          address={addr}
          symbol={token.symbol}
          decimals={token.decimals}
          totalSupply={token.totalSupply ?? null}
          initial={holdersResult}
        />
      )}

      {/* Risk Signals */}
      {riskSignals.length > 0 && (
        <div className="bg-white rounded-xl border shadow-sm mb-6 p-4">
          <h2 className="font-semibold mb-3">🛡️ Risk Signals</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {riskSignals.map((s, i) => (
              <div key={i} className={`flex items-start gap-2 rounded-lg p-2 text-sm
                ${s.severity === 'danger' ? 'bg-red-50' : s.severity === 'warn' ? 'bg-yellow-50' : 'bg-green-50'}`}>
                <span>{s.ok ? '✅' : s.severity === 'danger' ? '🚨' : '⚠️'}</span>
                <div>
                  <p className="font-medium">{s.label}</p>
                  <p className="text-xs text-gray-600">{s.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Token Transfers */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold">
          Token Transfers{' '}
          <span className="text-gray-400 font-normal text-sm">
            {countKnown ? `(${formatNumber(totalTransfers)} total)` : '(showing latest)'}
          </span>
        </h2>
      </div>
      <div className="bg-white rounded-xl border shadow-sm overflow-hidden mb-4">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-2 text-gray-500">Tx Hash</th>
              <th className="text-left px-4 py-2 text-gray-500">Block</th>
              <th className="text-left px-4 py-2 text-gray-500">From</th>
              <th className="text-left px-4 py-2 text-gray-500">To</th>
              <th className="text-left px-4 py-2 text-gray-500">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {transfers.map((t) => {
              const amount = (() => {
                try {
                  const divisor = 10n ** BigInt(token.decimals)
                  const whole = BigInt(t.value ?? '0') / divisor
                  const frac = BigInt(t.value ?? '0') % divisor
                  const fracStr = frac
                    .toString()
                    .padStart(token.decimals, '0')
                    .slice(0, 4)
                    .replace(/0+$/, '')
                  return fracStr
                    ? `${whole.toLocaleString()}.${fracStr}`
                    : whole.toLocaleString()
                } catch {
                  return (t.value ?? '0').slice(0, 10)
                }
              })()
              return (
                <tr key={`${t.txHash}-${t.logIndex}`} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link
                      href={`/tx/${t.txHash}`}
                      className={`${chainConfig.theme.linkText} hover:underline`}
                    >
                      {t.txHash.slice(0, 14)}…
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-gray-500">{t.blockNumber}</td>
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link
                      href={`/address/${t.fromAddress}`}
                      className={`${chainConfig.theme.linkText} hover:underline`}
                    >
                      {formatAddress(t.fromAddress)}
                    </Link>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link
                      href={`/address/${t.toAddress}`}
                      className={`${chainConfig.theme.linkText} hover:underline`}
                    >
                      {formatAddress(t.toAddress)}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    {amount} {token.symbol}
                  </td>
                </tr>
              )
            })}
            {transfers.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                  No transfers yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination
        page={page}
        total={paginationTotal}
        perPage={PAGE_SIZE}
        baseUrl={`/token/${addr}`}
      />
    </div>
  )
}

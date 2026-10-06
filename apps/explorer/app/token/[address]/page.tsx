import { db, schema } from '@/lib/db'
import { countTokenTransfers, selectTokenTransfers, TOKEN_TRANSFERS_MAX_ROWS } from '@/lib/token-transfers-query'
import { eq } from 'drizzle-orm'
import { cache } from 'react'
import { notFound } from 'next/navigation'
import { formatNumber, formatUsdPrice, formatCompactUsd, formatPercent, hasSupply, tokenTextOr } from '@/lib/format'
import { CopyButton } from '@/components/ui/CopyButton'
import { Badge } from '@/components/ui/Badge'
import { Icon } from '@/components/ui/Icon'
import { Pagination } from '@/components/ui/Pagination'
import { AdReserve } from '@/components/ads/AdReserve'
import Link from 'next/link'
import type { Metadata } from 'next'
import { analyzeTokenRisk, type RiskSignal } from '@/lib/token-risk'
import { lookalikeOf, lookalikeNote } from '@/lib/lookalike'
import { Contract } from 'ethers'
import { getWebProvider } from '@/lib/rpc'
import { chainConfig } from '@/lib/chain'
import { getTokenMarketData } from '@/lib/market-data'
import { getTokenHolders, EMPTY_HOLDERS } from '@/lib/holders'
import { isStablecoinToken } from '@/lib/binance-referral'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'
import { HoldersLazy, HoldersCountLazy } from './HoldersLazy'
import { AddressLink } from '@/components/ui/AddressLink'
import { swallow } from '@/lib/observability'
import { shortHash, toChecksumAddress } from '@/lib/address-display'

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
    const contract = new Contract(addr, ERC20_ABI, await getWebProvider())
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
      type: chainConfig.tokenStandard,
    }
  } catch (e) {
    swallow('token/lookup', e)
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
  } catch (e) { swallow('token/meta', e) }  // DB error
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
    // A holder count of 0 is a lagging reading (the Holders card shows "—"), so it is not stated.
    description: `${token.name} (${token.symbol}) ${token.type} token on ${chainConfig.name}.${token.holderCount > 0 ? ` ${token.holderCount.toLocaleString()} holders.` : ''}`,
    alternates: { canonical: `/token/${address.toLowerCase()}` },
    openGraph: {
      title: `${token.name} (${token.symbol})`,
      description: token.holderCount > 0 ? `${token.type} · ${token.holderCount.toLocaleString()} holders` : token.type,
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
  // The list stops at TOKEN_TRANSFERS_MAX_ROWS, so a deeper ?page= gets its last page.
  const page = Math.min(TOKEN_TRANSFERS_MAX_ROWS / PAGE_SIZE, Math.max(1, parseInt(pageStr ?? '1', 10) || 1))
  const offset = (page - 1) * PAGE_SIZE

  let token: typeof schema.tokens.$inferSelect | null = null
  try {
    const [row] = await db
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.address, addr))
    token = row ?? null
  } catch (e) { swallow('token/stats', e) }  // DB error

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
        withTimeout(
          selectTokenTransfers(db, addr, { limit: PAGE_SIZE, offset })
            .catch(() => TRANSFERS_FALLBACK),
          6000,
          TRANSFERS_FALLBACK,
        ),
        // Counts at most one row past the list. -1 = "unknown" (timed out /
        // errored) so we never render a misleading "0 total".
        withTimeout(
          countTokenTransfers(db, addr)
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
  // More than the list serves reads as "10,000+".
  const totalLabel = totalTransfers > TOKEN_TRANSFERS_MAX_ROWS
    ? `${formatNumber(TOKEN_TRANSFERS_MAX_ROWS)}+`
    : formatNumber(totalTransfers)
  // When the exact count is unknown, estimate just enough to drive prev/next:
  // assume another page exists only if this one came back full.
  const paginationTotal = Math.min(TOKEN_TRANSFERS_MAX_ROWS, countKnown
    ? totalTransfers
    : offset + transfers.length + (transfers.length === PAGE_SIZE ? PAGE_SIZE : 0))

  const displaySupply = (() => {
    try {
      const divisor = 10n ** BigInt(token.decimals)
      const whole = BigInt(token.totalSupply ?? '0') / divisor
      return whole.toLocaleString()
    } catch (e) {
      swallow('token/transfers', e)
      return (token.totalSupply ?? '0').slice(0, 20)
    }
  })()

  // A token the indexer could not read (and the live re-resolve could not either) keeps its
  // '???' / 'Unknown' placeholders: those are "missing", so the header says "—", not a name.
  const nameText = tokenTextOr(token.name, '—')
  const symbolText = tokenTextOr(token.symbol, '—')

  // Pure string check, so it holds on the live (RPC-only) path too, where analyzeTokenRisk is skipped.
  const lookalike = lookalikeOf({ address: addr, symbol: token.symbol, name: token.name }, chainConfig.key)
  const signals: RiskSignal[] = lookalike
    ? [{ label: 'Lookalike', ok: false, severity: 'danger', description: lookalikeNote(lookalike) }, ...riskSignals]
    : riskSignals

  const tokenReferralContext = isStablecoinToken(token.symbol, token.name)
    ? 'stablecoin'
    : 'token_research'

  const checksummedAddr = toChecksumAddress(addr)

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <BreadcrumbJsonLd items={[{ name: 'Tokens', href: '/token' }, { name: `${token.name} (${token.symbol})` }]} />
      <div className="mb-5">
        <p className="k">{'// '}token</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="mr-1 min-w-0 [overflow-wrap:anywhere] text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.05] tracking-[-0.03em] text-ink">
            {nameText}
            {symbolText !== '—' && <>{' '}<span className="font-mono font-semibold text-ink2">{symbolText}</span></>}
          </h1>
          {/* Beside the h1, not in it: inside, "lookalike of USDT" would become part of the page's heading name. */}
          {lookalike && (
            <span className="badge badge-bad" title={lookalikeNote(lookalike)}>
              lookalike<span className="sr-only"> of {lookalike.symbol}</span>
            </span>
          )}
          <Badge variant="default">{token.type}</Badge>
          <a
            href={`${chainConfig.externalExplorerUrl}/token/${addr}`}
            target="_blank"
            rel="noopener noreferrer"
            className="sm:ml-auto rounded-[9px] border border-hair px-2.5 py-1 font-mono text-xs text-ink2 transition-colors hover:border-hair3"
          >
            View on {chainConfig.externalExplorer} ↗
          </a>
        </div>
        <div className="mt-2 flex items-start font-mono text-[13px] text-ink2">
          <span className="min-w-0 break-all pt-0.5">{checksummedAddr}</span>
          <CopyButton text={checksummedAddr} />
        </div>
      </div>

      {isLive && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-hair border-l-[3px] border-l-acc bg-card px-4 py-3 text-sm text-ink2">
          <svg className="w-4 h-4 shrink-0 text-acc-ink" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 010 8.49m-8.48-.01a6 6 0 010-8.49m11.31-2.82a10 10 0 010 14.14m-14.14 0a10 10 0 010-14.14"/></svg>
          <span>Showing live data from {chainConfig.name} RPC — this token is not yet in the local index. Transfer history and holder data are unavailable.</span>
        </div>
      )}

      <dl className={`ledger mb-6 ${isLive ? '[--cols:2]' : '[--cols:3]'}`}>
        <Fact label="Decimals">{token.decimals}</Fact>
        <Fact label="Total Supply">{hasSupply(token.totalSupply) ? displaySupply : '—'}</Fact>
        {!isLive && (
          <Fact label="Holders">
            <HoldersCountLazy address={addr} fallback={holdersResult.holderCount ?? token.holderCount} />
          </Fact>
        )}
      </dl>

      {marketData && (
        <div className="mb-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold tracking-[-0.02em] text-ink">Market</h2>
            {marketData.dexUrl && (
              <a
                href={marketData.dexUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-acc-ink hover:underline"
              >
                {marketData.pairLabel} ↗
              </a>
            )}
          </div>
          <dl className="ledger">
            <Fact label="Price">
              {marketData.priceUsd != null ? formatUsdPrice(marketData.priceUsd) : '—'}
              {marketData.priceChange24h != null && (
                <span
                  className={`ml-2 text-xs ${
                    marketData.priceChange24h >= 0
                      ? 'text-live'
                      : 'text-warn'
                  }`}
                >
                  {formatPercent(marketData.priceChange24h)}
                </span>
              )}
            </Fact>
            <Fact label="24h Volume">
              {marketData.volume24h != null ? formatCompactUsd(marketData.volume24h) : '—'}
            </Fact>
            <Fact label="Liquidity">
              {marketData.liquidityUsd != null ? formatCompactUsd(marketData.liquidityUsd) : '—'}
            </Fact>
            <Fact label={marketData.marketCap != null ? 'Market Cap' : 'FDV'}>
              {marketData.marketCap != null
                ? formatCompactUsd(marketData.marketCap)
                : marketData.fdv != null
                  ? formatCompactUsd(marketData.fdv)
                  : '—'}
            </Fact>
          </dl>
          {marketData.circulatingSupply != null && (
            <p className="text-xs text-mut mt-3">
              Circulating supply: {formatNumber(Math.round(marketData.circulatingSupply))} {token.symbol}
            </p>
          )}
          <p className="text-[11px] text-mut mt-2">
            Market data via DexScreener{marketData.source.includes('coingecko') ? ' + CoinGecko' : ''}. For information only.
          </p>
        </div>
      )}

      <AdReserve
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
      {signals.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-3 flex items-center gap-2 font-semibold tracking-[-0.02em] text-ink">
            <Icon name="shield" className="h-4 w-4 text-mut" />Risk Signals
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {signals.map((s, i) => (
              <div key={i} className={`flex items-start gap-2 rounded-xl border border-hair border-l-[3px] px-3 py-2 text-sm
                ${s.severity === 'danger' ? 'border-l-warn bg-warn-t' : s.severity === 'warn' ? 'border-l-warn bg-card' : 'border-l-acc bg-card'}`}>
                <Icon
                  name={s.ok ? 'check' : s.severity === 'danger' ? 'danger' : 'warn'}
                  className={`mt-0.5 h-4 w-4 ${s.ok ? 'text-live' : 'text-warn'}`}
                />
                <div>
                  <p className="font-medium text-ink">
                    <span className="sr-only">{s.ok ? 'Pass: ' : s.severity === 'danger' ? 'Danger: ' : 'Warning: '}</span>
                    {s.label}
                  </p>
                  <p className="text-xs text-ink2">{s.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Token Transfers */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold tracking-[-0.02em] text-ink">
          Token Transfers{' '}
          <span className="text-mut font-normal text-sm">
            {countKnown ? `(${totalLabel} total)` : '(showing latest)'}
          </span>
        </h2>
      </div>
      <div className="bg-card rounded-xl border border-hair overflow-hidden mb-4">
        <div className="overflow-x-auto">
        <table className="dt">
          <caption className="sr-only">Token transfers for {token.symbol}</caption>
          <thead>
            <tr>
              <th scope="col">Tx Hash</th>
              <th scope="col" className="hidden sm:table-cell">Block</th>
              <th scope="col">From</th>
              <th scope="col" className="hidden sm:table-cell">To</th>
              <th scope="col">Amount</th>
            </tr>
          </thead>
          <tbody>
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
                } catch (e) {
                  swallow('token/holder-fmt', e)
                  return (t.value ?? '0').slice(0, 10)
                }
              })()
              return (
                <tr key={`${t.txHash}-${t.logIndex}`}>
                  <td className="whitespace-nowrap">
                    <Link
                      href={`/tx/${t.txHash}`}
                      className="text-acc-ink hover:underline"
                    >
                      {shortHash(t.txHash)}
                    </Link>
                  </td>
                  <td className="text-mut hidden sm:table-cell">{t.blockNumber}</td>
                  <td>
                    <AddressLink address={t.fromAddress} />
                  </td>
                  <td className="hidden sm:table-cell">
                    <AddressLink address={t.toAddress} />
                  </td>
                  <td>
                    {amount} {token.symbol}
                  </td>
                </tr>
              )
            })}
            {transfers.length === 0 && (
              <tr>
                <td colSpan={5} className="py-8 text-center font-sans text-mut">
                  No transfers yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
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

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="k">{label}</dt>
      <dd className="mt-1 break-words font-mono text-[15px] text-ink">{children}</dd>
    </div>
  )
}

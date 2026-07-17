import { db, schema } from '@/lib/db'
import { eq, or, desc, sql, inArray } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { headers } from 'next/headers'
import { formatNativeToken, formatNumber, timeAgo, formatAddress, safeBigInt, sanitizeSymbol } from '@/lib/format'
import { Badge } from '@/components/ui/Badge'
import { CopyButton } from '@/components/ui/CopyButton'
import { Pagination } from '@/components/ui/Pagination'
import Link from 'next/link'
import type { Metadata } from 'next'
import { getAddressLabel } from '@/lib/known-addresses'
import { resolveName } from '@/lib/name-resolver'
import { getAddressRisk } from '@/lib/goplus'
import { isBotRequest } from '@/lib/providers'
import { getRetentionFloor, isLocalHistoryIncomplete } from '@/lib/retention'
import { TxnsLazy } from './TxnsLazy'
import { TransfersLazy } from './TransfersLazy'
import { HoldingsLazy } from './HoldingsLazy'
import { NftsLazy } from './NftsLazy'
import { getProvider } from '@/lib/rpc'
import { chainConfig } from '@/lib/chain'
import { WatchlistButton } from '@/components/ui/WatchlistButton'
import { AbiReader } from '@/components/contracts/AbiReader'
import { BinanceReferralAd } from '@/components/ads/BinanceReferralAd'

export const revalidate = 300

export async function generateMetadata({ params }: { params: Promise<{ address: string }> }): Promise<Metadata> {
  const { address } = await params
  let info: typeof schema.addresses.$inferSelect | null = null
  try {
    const [row] = await db.select().from(schema.addresses).where(eq(schema.addresses.address, address.toLowerCase())).limit(1)
    info = row ?? null
  } catch { /* DB error */ }
  const type = info?.isContract ? 'Contract' : 'Address'
  return {
    // No brand suffix: the layout title template (`%s — ${brandDomain}`) appends it
    title: `${type} ${address.slice(0, 14)}…`,
    description: `${chainConfig.name} ${type.toLowerCase()} ${address} — Balance: ${formatNativeToken(safeBigInt(info?.balance))} ${chainConfig.currency}, ${info?.txCount ?? 0} transactions`,
    alternates: { canonical: `/address/${address.toLowerCase()}` },
    openGraph: {
      title: `${type} ${address.slice(0, 14)}…`,
      description: `Balance: ${formatNativeToken(safeBigInt(info?.balance))} ${chainConfig.currency}`,
    },
  }
}

const PAGE_SIZE = 25

export default async function AddressPage({
  params,
  searchParams,
}: {
  params: Promise<{ address: string }>
  searchParams: Promise<{ tab?: string; page?: string; cursor?: string }>
}) {
  const { address } = await params
  const { tab, page: pageStr, cursor } = await searchParams
  const addr = address.toLowerCase()
  const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1)
  const offset = (page - 1) * PAGE_SIZE

  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) notFound()

  // Always fetch address info and contract info.
  // txCount and firstSeen come from the addresses table (instant PK lookup)
  // instead of COUNT(*)/MIN(timestamp) on 36M-row transactions table (OOM risk).
  let addressInfo: typeof schema.addresses.$inferSelect | null = null
  let contractResult: typeof schema.contracts.$inferSelect | null = null

  try {
    ;[addressInfo, contractResult] = await Promise.all([
      db
        .select()
        .from(schema.addresses)
        .where(eq(schema.addresses.address, addr))
        .limit(1)
        .then((r) => r[0] ?? null),
      db
        .select()
        .from(schema.contracts)
        .where(eq(schema.contracts.address, addr))
        .limit(1)
        .then((r) => r[0] ?? null),
    ])
  } catch {
    // DB not connected
  }

  const txCount = addressInfo?.txCount ?? 0
  const firstTxTimestamp = addressInfo?.firstSeen ?? null

  // Enrich with external data — split into two batches to reduce peak memory.
  // Batch 1: lightweight lookups. Batch 2: heavier RPC + Moralis calls.
  // Bot-gate Moralis: crawlers sweep many DISTINCT idle addresses, and each one is a Moralis cache
  // miss → a billed API call, which exhausts the free CU budget so real users dead-end. This page
  // already reads searchParams, so it is dynamically rendered (cache-control: private, no-cache) —
  // reading headers() forfeits no caching that was actually in effect. Bots get the local-index
  // view; humans still get the Moralis fallback. (The transfers/holdings/nfts tabs already honor this.)
  const isBot = isBotRequest((await headers()).get('user-agent'))
  const noLocalData = txCount === 0 && !addressInfo
  const provider = getProvider()

  // Batch 1: lightweight lookups (name resolution, risk check, price)
  const [resolvedName, riskData, nativePrice] = await Promise.all([
    resolveName(addr),
    getAddressRisk(addr),
    (async () => {
      const sym = chainConfig.key === 'bnb' ? 'BNBUSDT' : 'ETHUSDT'
      const ccSym = chainConfig.key === 'bnb' ? 'BNB' : 'ETH'
      // Try Binance US first (Render servers are US-based), then Binance global
      for (const host of ['https://api.binance.us', 'https://api.binance.com']) {
        try {
          const r = await fetch(`${host}/api/v3/ticker/price?symbol=${sym}`, { signal: AbortSignal.timeout(3000), next: { revalidate: 300 } })
          if (r.ok) { const d = await r.json(); const p = parseFloat(d.price); if (p > 0) return p }
        } catch { /* try next */ }
      }
      // Fallback: CryptoCompare
      try {
        const r = await fetch(`https://min-api.cryptocompare.com/data/price?fsym=${ccSym}&tsyms=USD`, { signal: AbortSignal.timeout(5000), next: { revalidate: 300 } })
        if (r.ok) { const d = await r.json(); if (d?.USD > 0) return d.USD }
      } catch { /* try next */ }
      // Fallback: CoinGecko
      try {
        const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${chainConfig.coingeckoId}&vs_currencies=usd`, { signal: AbortSignal.timeout(5000), next: { revalidate: 300 } })
        if (r.ok) { const d = await r.json(); return d[chainConfig.coingeckoId]?.usd ?? null }
      } catch { /* try next */ }
      // Fallback: CoinCap
      const ccId = chainConfig.key === 'bnb' ? 'binance-coin' : 'ethereum'
      try {
        const r = await fetch(`https://api.coincap.io/v2/assets/${ccId}`, { signal: AbortSignal.timeout(5000), next: { revalidate: 300 } })
        if (r.ok) { const d = await r.json(); const p = parseFloat(d?.data?.priceUsd); if (p > 0) return p }
      } catch { /* all failed */ }
      return null
    })(),
  ])

  // Batch 2: heavier RPC calls (after batch 1 frees its memory).
  // Moralis txn history is now fetched lazily on the client via TxnsLazy — no SSR prefetch,
  // so HTML scrapers (fake browser UAs, no JS) never trigger getWalletHistory during render.
  const [liveBalance, rpcTxCount] = await Promise.all([
    provider.getBalance(addr).catch(() => null),
    provider.getTransactionCount(addr).catch(() => null),   // nonce = outgoing tx count (free RPC)
  ])

  // Use live RPC balance when the address isn't in our index yet
  const displayBalance = liveBalance !== null
    ? liveBalance
    : safeBigInt(addressInfo?.balance)
  // Transaction count: prefer DB, then RPC nonce. Moralis history is now loaded lazily on the
  // client, so we no longer have it available here during SSR.
  const displayTxCount = txCount || addressInfo?.txCount || rpcTxCount || 0
  const displayFirstSeen = addressInfo?.firstSeen
    ? new Date(addressInfo.firstSeen)
    : null
  // USD value of native token balance
  const nativeUsd = nativePrice && displayBalance
    ? (Number(displayBalance) / 1e18 * nativePrice)
    : null

  const activeTab = tab ?? 'txns'
  const lowGasBalanceWei = chainConfig.key === 'bnb'
    ? 10_000_000_000_000_000n
    : 5_000_000_000_000_000n
  const gasReferralContext = displayBalance === 0n
    ? 'address_zero_balance'
    : displayBalance < lowGasBalanceWei
      ? 'address_low_balance'
      : null

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* GoPlus risk warning */}
      {riskData && (riskData.isMalicious || riskData.isPhishing || riskData.isBlacklist) && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-4 flex items-start gap-3">
          <span className="text-lg mt-0.5">🚨</span>
          <div>
            <p className="font-semibold text-red-800 text-sm">Security Risk Detected</p>
            <ul className="mt-1 space-y-0.5">
              {riskData.riskItems.map(item => (
                <li key={item} className="text-xs text-red-700">• {item}</li>
              ))}
            </ul>
            <p className="text-xs text-red-500 mt-1">Source: GoPlus Security</p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold">Address</h1>
        <a
          href={`${chainConfig.externalExplorerUrl}/address/${addr}`}
          target="_blank"
          rel="noopener noreferrer"
          className={`ml-auto text-xs text-gray-400 hover:${chainConfig.theme.linkText} border border-gray-200 hover:${chainConfig.theme.border} rounded px-2 py-1 transition-colors`}
        >
          View on {chainConfig.externalExplorer} ↗
        </a>
        {resolvedName && (
          <Badge variant="default">
            <span>🪪</span> {resolvedName}
          </Badge>
        )}
        {addressInfo?.isContract && <Badge variant="default">Contract</Badge>}
        {(addressInfo?.label ?? getAddressLabel(addr)) && (
          <Badge variant="default">{addressInfo?.label ?? getAddressLabel(addr)}</Badge>
        )}
        <WatchlistButton address={addr} />
      </div>

      {/* Address + stats */}
      <div className="bg-white rounded-xl border shadow-sm mb-6 p-4">
        <div className="font-mono text-sm break-all text-gray-800">
          {addr}
          <CopyButton text={addr} referralPlacement="address_copy" />
        </div>
        <div className="mt-4 grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
          <StatItem
            label={`${chainConfig.currency} Balance`}
            value={`${formatNativeToken(displayBalance)} ${chainConfig.currency}`}
            subValue={nativeUsd ? `$${nativeUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : undefined}
          />
          <StatItem
            label="Transactions"
            value={formatNumber(displayTxCount)}
          />
          <StatItem
            label="First Seen"
            value={displayFirstSeen ? timeAgo(displayFirstSeen) : 'Unknown'}
          />
        </div>
      </div>

      {gasReferralContext && (
        <BinanceReferralAd
          context={gasReferralContext}
          placement={gasReferralContext === 'address_zero_balance' ? 'address_zero_balance' : 'address_low_balance'}
          variant="compact"
          className="mb-6"
        />
      )}

      {/* Contract section */}
      {addressInfo?.isContract && (
        <div className="bg-white rounded-xl border shadow-sm mb-6 p-4">
          <h2 className="font-semibold mb-3">Contract</h2>
          {contractResult?.verifiedAt ? (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Badge variant="success">Verified</Badge>
                <span className="text-sm text-gray-500">
                  via {contractResult.verifySource} •{' '}
                  {contractResult.compilerVersion ?? 'unknown'}
                </span>
              </div>
              {contractResult.license && (
                <p className="text-sm text-gray-500 mb-2">
                  License: {contractResult.license}
                </p>
              )}
              {contractResult.sourceCode && (
                <pre className="mt-3 bg-gray-50 p-3 rounded text-xs overflow-auto max-h-64 border">
                  {contractResult.sourceCode.slice(0, 2000)}
                  {contractResult.sourceCode.length > 2000
                    ? '\n// ... truncated'
                    : ''}
                </pre>
              )}
              {contractResult.verifiedAt && contractResult.abi != null && (
                <div className="mt-4">
                  <h3 className="font-medium text-sm mb-2">Read Contract</h3>
                  <AbiReader address={addr} abi={contractResult.abi as unknown[]} />
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <Badge variant="pending">Unverified</Badge>
              <Link href="/verify" className={`text-sm ${chainConfig.theme.linkText} hover:underline`}>
                Verify this contract →
              </Link>
            </div>
          )}
        </div>
      )}

      {/* Tab bar */}
      <div className="flex overflow-x-auto border-b border-gray-200 mb-6 -mx-4 px-4 sm:mx-0 sm:px-0">
        <TabLink
          href={`/address/${addr}?tab=txns`}
          active={activeTab === 'txns'}
          label={`Transactions (${formatNumber(displayTxCount)})`}
        />
        <TabLink
          href={`/address/${addr}?tab=transfers`}
          active={activeTab === 'transfers'}
          label="Token Transfers"
        />
        <TabLink
          href={`/address/${addr}?tab=holdings`}
          active={activeTab === 'holdings'}
          label="Holdings"
        />
        <TabLink
          href={`/address/${addr}?tab=analytics`}
          active={activeTab === 'analytics'}
          label="Analytics"
        />
        <TabLink
          href={`/address/${addr}?tab=nfts`}
          active={activeTab === 'nfts'}
          label="NFTs"
        />
      </div>

      {/* Tab content */}
      {activeTab === 'txns' && (
        <TxnsTab addr={addr} page={page} total={displayTxCount} cursor={cursor} isBot={isBot} firstSeen={firstTxTimestamp} />
      )}
      {activeTab === 'transfers' && <TransfersTab addr={addr} page={page} isBot={isBot} firstSeen={firstTxTimestamp} />}
      {activeTab === 'holdings' && <HoldingsTab addr={addr} isBot={isBot} />}
      {activeTab === 'analytics' && <AnalyticsTab addr={addr} addressInfo={addressInfo} />}
      {activeTab === 'nfts' && <NftsTab addr={addr} isBot={isBot} />}
    </div>
  )
}

// ---- Transactions Tab ----

async function TxnsTab({
  addr,
  page,
  total,
  cursor,
  isBot,
  firstSeen,
}: {
  addr: string
  page: number
  total: number
  cursor?: string
  isBot: boolean
  firstSeen: Date | null
}) {
  const offset = (page - 1) * PAGE_SIZE
  let txs: typeof schema.transactions.$inferSelect[] = []

  try {
    txs = await db
      .select()
      .from(schema.transactions)
      .where(
        or(
          eq(schema.transactions.fromAddress, addr),
          eq(schema.transactions.toAddress, addr),
        ),
      )
      .orderBy(desc(schema.transactions.timestamp))
      .limit(PAGE_SIZE)
      .offset(offset)
  } catch {
    // DB error
  }

  // Serve the full Moralis history (TxnsLazy) when local can't show the complete picture:
  //   - empty local index (page 1), OR
  //   - retention-pruned wallet — `total` (addresses.tx_count) is the never-pruned lifetime
  //     count, but the local transactions table holds only the last RETENTION_DAYS, so the
  //     page-of-N pagination against `total` is bogus (e.g. heatherm.eth: 118 lifetime, 1
  //     row retained, "Page 1 of 5"). isLocalHistoryIncomplete() detects this in O(1) via
  //     first_seen < oldest-retained-block. This fires on ANY page so the bogus pagination
  //     never renders. Fully-indexed active wallets (first_seen within the window) fall
  //     through to the fast local table with no extra Moralis call.
  // Either way the fetch is lazy on the client, so HTML scrapers (fake browser UAs, no JS)
  // never trigger getWalletHistory during SSR — bots keep the local-index "not available" view.
  const incomplete = isLocalHistoryIncomplete(firstSeen, await getRetentionFloor())
  if (incomplete || (txs.length === 0 && page === 1)) {
    if (isBot) {
      return (
        <div>
          <p className="text-gray-500 mb-2">Transaction history is not available in the local index for this address.</p>
          {total > 0 && (
            <p className="text-sm text-gray-400">
              This address has {formatNumber(total)} transactions on-chain.{' '}
              <a href={`${chainConfig.externalExplorerUrl}/address/${addr}`} target="_blank" rel="noopener noreferrer" className={`${chainConfig.theme.linkText} hover:underline`}>
                View on {chainConfig.externalExplorer} ↗
              </a>
            </p>
          )}
        </div>
      )
    }
    return <TxnsLazy addr={addr} />
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-gray-500">
          Transactions ({formatNumber(total)})
        </p>
        <a
          href={`/api/v1/addresses/${addr}/export`}
          className={`text-xs ${chainConfig.theme.linkText} hover:underline border ${chainConfig.theme.border} rounded px-2 py-0.5`}
          download
        >
          ↓ Export CSV
        </a>
      </div>
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden mb-4">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-3 sm:px-4 py-2 font-medium text-gray-500">Tx Hash</th>
              <th className="text-left px-3 sm:px-4 py-2 font-medium text-gray-500 hidden sm:table-cell">Age</th>
              <th className="text-left px-3 sm:px-4 py-2 font-medium text-gray-500">From / To</th>
              <th className="text-left px-3 sm:px-4 py-2 font-medium text-gray-500">Value</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {txs.map((tx) => (
              <tr key={tx.hash} className="hover:bg-gray-50">
                <td className="px-3 sm:px-4 py-2 font-mono text-xs">
                  <Link href={`/tx/${tx.hash}`} className={`${chainConfig.theme.linkText} hover:underline`}>
                    {tx.hash.slice(0, 14)}...
                  </Link>
                </td>
                <td className="px-3 sm:px-4 py-2 text-gray-500 hidden sm:table-cell">
                  {timeAgo(new Date(tx.timestamp))}
                </td>
                <td className="px-3 sm:px-4 py-2 font-mono text-xs">
                  <div>
                    <span className="text-gray-400 text-xs">
                      {tx.fromAddress.toLowerCase() === addr ? 'OUT' : 'IN'}{' '}
                    </span>
                    <Link
                      href={`/address/${
                        tx.fromAddress.toLowerCase() === addr
                          ? tx.toAddress ?? addr
                          : tx.fromAddress
                      }`}
                      className={`${chainConfig.theme.linkText} hover:underline`}
                    >
                      {(
                        tx.fromAddress.toLowerCase() === addr
                          ? tx.toAddress ?? 'Contract Creation'
                          : tx.fromAddress
                      ).slice(0, 12)}
                      ...
                    </Link>
                  </div>
                </td>
                <td className="px-3 sm:px-4 py-2">
                  {formatNativeToken(safeBigInt(tx.value))} {chainConfig.currency}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
      <Pagination
        page={page}
        total={total}
        perPage={PAGE_SIZE}
        baseUrl={`/address/${addr}?tab=txns`}
      />
    </div>
  )
}

// ---- Token Transfers Tab ----

async function TransfersTab({ addr, page, isBot, firstSeen }: { addr: string; page: number; isBot: boolean; firstSeen: Date | null }) {
  const offset = (page - 1) * PAGE_SIZE
  let transfers: typeof schema.tokenTransfers.$inferSelect[] = []
  let total = 0

  try {
    // Fetch one extra row to detect "has next page" — avoids COUNT(*) on token_transfers
    // which is a full table scan with OR across two columns on millions of rows.
    const rows = await db
      .select()
      .from(schema.tokenTransfers)
      .where(
        or(
          eq(schema.tokenTransfers.fromAddress, addr),
          eq(schema.tokenTransfers.toAddress, addr),
        ),
      )
      .orderBy(desc(schema.tokenTransfers.blockNumber))
      .limit(PAGE_SIZE + 1)
      .offset(offset)
    transfers = rows.slice(0, PAGE_SIZE)
    // Estimate total for pagination: if we got more than PAGE_SIZE, there are more pages
    total = rows.length > PAGE_SIZE ? offset + PAGE_SIZE + 1 : offset + rows.length
  } catch {
    // DB error
  }

  // Serve the full Moralis history (TransfersLazy) when local can't show the complete
  // picture: empty local index (page 1), or a retention-pruned wallet whose first_seen
  // predates the oldest retained block — token_transfers is pruned to the same rolling
  // window as transactions, so the same O(1) signal applies. Fires on any page so the
  // pagination is never bogus. Lazy on the client, so HTML scrapers never trigger Moralis
  // during SSR; bots keep the local-index message. Fully-indexed active wallets fall
  // through to the fast local table below with no extra Moralis call.
  const incomplete = isLocalHistoryIncomplete(firstSeen, await getRetentionFloor())
  if (incomplete || (transfers.length === 0 && page === 1)) {
    if (isBot) {
      return (
        <p className="text-gray-500">
          {transfers.length === 0
            ? 'No token transfers found for this address.'
            : 'Full token transfer history is not available in the local index for this address.'}
        </p>
      )
    }
    return <TransfersLazy addr={addr} />
  }

  // Look up token info (name/symbol/decimals) for DB transfers
  const tokenInfoMap = new Map<string, { name: string; symbol: string; decimals: number }>()
  if (transfers.length > 0) {
    try {
      const uniqueAddrs = [...new Set(transfers.map(t => t.tokenAddress))]
      const tokenRows = await db.select({
        address: schema.tokens.address,
        name: schema.tokens.name,
        symbol: schema.tokens.symbol,
        decimals: schema.tokens.decimals,
      }).from(schema.tokens).where(inArray(schema.tokens.address, uniqueAddrs))
      for (const tok of tokenRows) {
        tokenInfoMap.set(tok.address, { name: tok.name, symbol: tok.symbol, decimals: tok.decimals })
      }
    } catch { /* token lookup error */ }
  }

  return (
    <div>
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden mb-4">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-2 font-medium text-gray-500">Tx Hash</th>
              <th className="text-left px-4 py-2 font-medium text-gray-500">Block</th>
              <th className="text-left px-4 py-2 font-medium text-gray-500">From</th>
              <th className="text-left px-4 py-2 font-medium text-gray-500">To</th>
              <th className="text-left px-4 py-2 font-medium text-gray-500">Token</th>
              <th className="text-left px-4 py-2 font-medium text-gray-500">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {transfers.map((t) => (
              <tr key={`${t.txHash}-${t.logIndex}`} className="hover:bg-gray-50">
                <td className="px-4 py-2 font-mono text-xs">
                  <Link href={`/tx/${t.txHash}`} className={`${chainConfig.theme.linkText} hover:underline`}>
                    {t.txHash.slice(0, 14)}...
                  </Link>
                </td>
                <td className="px-4 py-2 text-gray-500">{t.blockNumber}</td>
                <td className="px-4 py-2 font-mono text-xs">
                  <Link
                    href={`/address/${t.fromAddress}`}
                    className={
                      t.fromAddress.toLowerCase() === addr
                        ? 'text-gray-800 font-semibold'
                        : `${chainConfig.theme.linkText} hover:underline`
                    }
                  >
                    {formatAddress(t.fromAddress)}
                  </Link>
                </td>
                <td className="px-4 py-2 font-mono text-xs">
                  <Link
                    href={`/address/${t.toAddress}`}
                    className={
                      t.toAddress.toLowerCase() === addr
                        ? 'text-gray-800 font-semibold'
                        : `${chainConfig.theme.linkText} hover:underline`
                    }
                  >
                    {formatAddress(t.toAddress)}
                  </Link>
                </td>
                <td className="px-4 py-2 text-xs">
                  <Link
                    href={`/token/${t.tokenAddress}`}
                    className={`${chainConfig.theme.linkText} hover:underline`}
                  >
                    {tokenInfoMap.get(t.tokenAddress)?.symbol
                      ? sanitizeSymbol(tokenInfoMap.get(t.tokenAddress)!.symbol)
                      : tokenInfoMap.get(t.tokenAddress)?.name
                        ? sanitizeSymbol(tokenInfoMap.get(t.tokenAddress)!.name)
                        : formatAddress(t.tokenAddress)}
                  </Link>
                </td>
                <td className="px-4 py-2 text-xs">
                  {(() => {
                    const decimals = tokenInfoMap.get(t.tokenAddress)?.decimals ?? 0
                    const raw = t.value ?? '0'
                    if (decimals > 0) {
                      const formatted = Number(BigInt(raw)) / 10 ** decimals
                      return formatted.toLocaleString(undefined, { maximumFractionDigits: 6 })
                    }
                    return raw.slice(0, 12)
                  })()}
                  {tokenInfoMap.get(t.tokenAddress)?.symbol
                    ? ` ${sanitizeSymbol(tokenInfoMap.get(t.tokenAddress)!.symbol)}`
                    : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination
        page={page}
        total={total}
        perPage={PAGE_SIZE}
        baseUrl={`/address/${addr}?tab=transfers`}
      />
    </div>
  )
}

// ---- Holdings Tab ----

type HoldingRow = { tokenAddress: string; balance: string; name: string | null; symbol: string | null; decimals: number | null }

async function HoldingsTab({ addr, isBot }: { addr: string; isBot: boolean }) {
  let holdings: HoldingRow[] = []

  try {
    // Use pre-computed token_balances table (indexed, instant) instead of
    // scanning token_transfers with SUM aggregation (millions of rows, OOM risk).
    const result = await db.execute(sql`
      SELECT tb.token_address, tb.balance::text as balance
      FROM token_balances tb
      WHERE tb.holder_address = ${addr} AND tb.balance::numeric > 0
      ORDER BY tb.balance::numeric DESC
      LIMIT 50
    `)

    const rows = Array.from(result) as Record<string, unknown>[]
    const tokenAddresses = rows.map(r => String(r.token_address))
    const tokenInfos = tokenAddresses.length > 0
      ? await db.select({
          address: schema.tokens.address,
          name: schema.tokens.name,
          symbol: schema.tokens.symbol,
          decimals: schema.tokens.decimals,
        }).from(schema.tokens).where(inArray(schema.tokens.address, tokenAddresses))
      : []
    const tokenMap = new Map(tokenInfos.map(t => [t.address, t]))
    holdings = rows.map((row) => {
      const tokenAddress = String(row.token_address)
      const balance = String(row.balance)
      const tok = tokenMap.get(tokenAddress)
      return {
        tokenAddress,
        balance,
        name: tok?.name ?? null,
        symbol: tok?.symbol ?? null,
        decimals: tok?.decimals ?? null,
      }
    })
  } catch {
    // DB error
  }

  if (holdings.length === 0) {
    if (isBot) {
      return <p className="text-gray-500">No token holdings found for this address.</p>
    }
    return <HoldingsLazy addr={addr} />
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b">
          <tr>
            <th className="text-left px-4 py-2 font-medium text-gray-500">Token</th>
            <th className="text-left px-4 py-2 font-medium text-gray-500">Symbol</th>
            <th className="text-left px-4 py-2 font-medium text-gray-500">Approx. Balance</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {holdings.map((h) => {
            const displayBalance = (() => {
              try {
                if (h.decimals !== null) {
                  const divisor = 10n ** BigInt(h.decimals)
                  const whole = BigInt(h.balance) / divisor
                  const frac = BigInt(h.balance) % divisor
                  const fracStr = frac.toString().padStart(h.decimals, '0').slice(0, 4).replace(/0+$/, '')
                  return fracStr ? `${whole.toLocaleString()}.${fracStr}` : whole.toLocaleString()
                }
                return h.balance.slice(0, 18)
              } catch {
                return h.balance.slice(0, 18)
              }
            })()
            return (
              <tr key={h.tokenAddress} className="hover:bg-gray-50">
                <td className="px-4 py-2">
                  <Link href={`/token/${h.tokenAddress}`} className={`${chainConfig.theme.linkText} hover:underline font-medium`}>
                    {h.name ? sanitizeSymbol(h.name) : h.tokenAddress.slice(0, 14) + '…'}
                  </Link>
                </td>
                <td className="px-4 py-2 text-gray-600">{h.symbol ? sanitizeSymbol(h.symbol) : '—'}</td>
                <td className="px-4 py-2">
                  {displayBalance} {h.symbol ? sanitizeSymbol(h.symbol) : ''}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ---- Analytics Tab ----

async function AnalyticsTab({
  addr,
  addressInfo,
}: {
  addr: string
  addressInfo: typeof schema.addresses.$inferSelect | null
}) {
  let totalSentNative = '0'
  let totalReceivedNative = '0'
  let firstSeen: Date | null = addressInfo?.firstSeen ? new Date(addressInfo.firstSeen) : null
  let lastSeen: Date | null = addressInfo?.lastSeen ? new Date(addressInfo.lastSeen) : null

  try {
    // Use a capped sample (last 1000 txs) instead of full-table SUM scans.
    // Full SUM on 36M+ row transactions table was the #1 cause of OOM crashes.
    const [sentResult, receivedResult] = await Promise.all([
      db.execute(sql`
        SELECT COALESCE(SUM(value::numeric), 0) as total
        FROM (SELECT value FROM transactions WHERE from_address = ${addr} ORDER BY timestamp DESC LIMIT 1000) sub
      `),
      db.execute(sql`
        SELECT COALESCE(SUM(value::numeric), 0) as total
        FROM (SELECT value FROM transactions WHERE to_address = ${addr} ORDER BY timestamp DESC LIMIT 1000) sub
      `),
    ])

    totalSentNative = String(
      (Array.from(sentResult)[0] as Record<string, unknown>)?.total ?? '0',
    )
    totalReceivedNative = String(
      (Array.from(receivedResult)[0] as Record<string, unknown>)?.total ?? '0',
    )

    // first_seen/last_seen are pre-computed by the indexer in the addresses table.
    // All 1.9M+ addresses have these fields populated, so no fallback needed.
    // The previous fallback queried the 36M-row transactions table and took 30+ minutes.
  } catch {
    // DB error
  }

  const formatWei = (raw: string) => {
    try {
      return formatNativeToken(safeBigInt(raw))
    } catch {
      return '0.0000'
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
      <h2 className="font-semibold text-gray-800 mb-4">Address Analytics</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
        <AnalyticItem label="Total Sent" value={`${formatWei(totalSentNative)} ${chainConfig.currency}`} />
        <AnalyticItem
          label="Total Received"
          value={`${formatWei(totalReceivedNative)} ${chainConfig.currency}`}
        />
        <AnalyticItem
          label="First Seen"
          value={firstSeen ? firstSeen.toLocaleDateString() : 'Unknown'}
        />
        <AnalyticItem
          label="Last Seen"
          value={lastSeen ? lastSeen.toLocaleDateString() : 'Unknown'}
        />
      </div>
    </div>
  )
}

// ---- NFTs Tab ----

async function NftsTab({ addr, isBot }: { addr: string; isBot: boolean }) {
  let nftTransfers: Array<{
    txHash: string
    tokenAddress: string
    tokenId: string | null
    fromAddress: string
    toAddress: string
    blockNumber: number
    name?: string
    symbol?: string
  }> = []

  try {
    const result = await db.execute(sql`
      SELECT
        tt.tx_hash as "txHash",
        tt.token_address as "tokenAddress",
        tt.token_id::text as "tokenId",
        tt.from_address as "fromAddress",
        tt.to_address as "toAddress",
        tt.block_number as "blockNumber",
        t.name,
        t.symbol
      FROM token_transfers tt
      LEFT JOIN tokens t ON t.address = tt.token_address
      WHERE
        (tt.to_address = ${addr} OR tt.from_address = ${addr})
        AND t.type = 'BEP721'
        AND tt.token_id IS NOT NULL
      ORDER BY tt.block_number DESC
      LIMIT 50
    `)
    nftTransfers = Array.from(result).map(row => {
      const r = row as Record<string, unknown>
      return {
        txHash: String(r.txHash ?? ''),
        tokenAddress: String(r.tokenAddress ?? ''),
        tokenId: r.tokenId ? String(r.tokenId) : null,
        fromAddress: String(r.fromAddress ?? ''),
        toAddress: String(r.toAddress ?? ''),
        blockNumber: Number(r.blockNumber ?? 0),
        name: r.name ? String(r.name) : undefined,
        symbol: r.symbol ? String(r.symbol) : undefined,
      }
    })
  } catch { /* DB error */ }

  // Augment with Moralis NFT holdings when DB has no data — lazy on client so bots don't trigger it
  if (nftTransfers.length === 0) {
    if (isBot) {
      return <p className="text-gray-500 py-8 text-center">No NFT activity found for this address.</p>
    }
    return <NftsLazy addr={addr} />
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b">
          <tr>
            <th className="text-left px-4 py-2 text-gray-500">NFT</th>
            <th className="text-left px-4 py-2 text-gray-500">Token ID</th>
            <th className="text-left px-4 py-2 text-gray-500">Action</th>
            <th className="text-left px-4 py-2 text-gray-500">Tx Hash</th>
            <th className="text-left px-4 py-2 text-gray-500">Block</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {nftTransfers.map((t, i) => (
            <tr key={i} className="hover:bg-gray-50">
              <td className="px-4 py-2">
                <Link href={`/token/${t.tokenAddress}`} className={`${chainConfig.theme.linkText} hover:underline`}>
                  {t.name ?? t.tokenAddress.slice(0, 12) + '...'}
                </Link>
                {t.symbol && <span className="ml-1 text-xs text-gray-400">({t.symbol})</span>}
              </td>
              <td className="px-4 py-2 font-mono text-xs">
                #{t.tokenId}
              </td>
              <td className="px-4 py-2">
                <span className={`text-xs font-medium ${t.toAddress.toLowerCase() === addr ? 'text-green-600' : 'text-red-500'}`}>
                  {t.toAddress.toLowerCase() === addr ? 'Received' : 'Sent'}
                </span>
              </td>
              <td className="px-4 py-2 font-mono text-xs">
                <Link href={`/tx/${t.txHash}`} className={`${chainConfig.theme.linkText} hover:underline`}>
                  {t.txHash.slice(0, 14)}...
                </Link>
              </td>
              <td className="px-4 py-2 text-gray-500">{t.blockNumber}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---- Sub-components ----

function TabLink({
  href,
  active,
  label,
}: {
  href: string
  active: boolean
  label: string
}) {
  return (
    <Link
      href={href}
      className={`px-3 sm:px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
        active
          ? `${chainConfig.theme.border} ${chainConfig.theme.linkText}`
          : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
      }`}
    >
      {label}
    </Link>
  )
}

function StatItem({ label, value, subValue }: { label: string; value: string; subValue?: string }) {
  return (
    <div>
      <p className="text-gray-500 text-xs mb-0.5">{label}</p>
      <p className="font-semibold">{value}</p>
      {subValue && <p className="text-xs text-gray-400">{subValue}</p>}
    </div>
  )
}

function AnalyticItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className="font-bold text-gray-900">{value}</p>
    </div>
  )
}

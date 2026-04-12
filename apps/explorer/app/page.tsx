import { db, schema } from '@/lib/db'
import { desc, sql } from 'drizzle-orm'
import Link from 'next/link'
import { formatNumber, timeAgo } from '@/lib/format'
import { BlockTable } from '@/components/blocks/BlockTable'
import { TxTable } from '@/components/transactions/TxTable'
import { AutoRefresh } from '@/components/ui/AutoRefresh'
import { chainConfig } from '@/lib/chain'

// Shared ISR cache: one server render per 30s, served to all users from cache in between.
// This replaces force-dynamic (which rendered fresh for every request) — the primary cause
// Revalidate every 60s. Higher frequency causes concurrent renders that OOM on 2GB.
export const revalidate = 60

const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': `https://${chainConfig.domain}/#website`,
      url: `https://${chainConfig.domain}`,
      name: `${chainConfig.brandDomain} by MDT`,
      description: `An open, independent ${chainConfig.name} block explorer maintained by Measurable Data Token (MDT).`,
      potentialAction: {
        '@type': 'SearchAction',
        target: {
          '@type': 'EntryPoint',
          urlTemplate: `https://${chainConfig.domain}/search?q={search_term_string}`,
        },
        'query-input': 'required name=search_term_string',
      },
    },
    {
      '@type': 'Organization',
      '@id': `https://${chainConfig.domain}/#organization`,
      name: 'Measurable Data Token (MDT)',
      url: 'https://mdt.io',
      sameAs: ['https://mdt.io'],
    },
  ],
}

async function fetchNativePrice(): Promise<{ usd: number; change24h: number } | null> {
  const binanceSymbol = chainConfig.key === 'bnb' ? 'BNBUSDT' : 'ETHUSDT'
  const ccSymbol = chainConfig.key === 'bnb' ? 'BNB' : 'ETH'

  // Try multiple Binance endpoints (binance.us for US-based servers like Render)
  for (const host of ['https://api.binance.us', 'https://api.binance.com']) {
    try {
      const res = await fetch(
        `${host}/api/v3/ticker/24hr?symbol=${binanceSymbol}`,
        { cache: 'no-store', signal: AbortSignal.timeout(3000) }
      )
      if (res.ok) {
        const data = await res.json()
        const price = parseFloat(data.lastPrice)
        const change = parseFloat(data.priceChangePercent)
        if (price > 0) return { usd: price, change24h: change || 0 }
      }
    } catch { /* try next */ }
  }

  // Fallback: CryptoCompare (no API key needed, works from US)
  try {
    const res = await fetch(
      `https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${ccSymbol}&tsyms=USD`,
      { cache: 'no-store', signal: AbortSignal.timeout(5000) }
    )
    if (res.ok) {
      const data = await res.json()
      const raw = data?.RAW?.[ccSymbol]?.USD
      if (raw?.PRICE > 0) return { usd: raw.PRICE, change24h: raw.CHANGEPCT24HOUR ?? 0 }
    }
  } catch { /* try next */ }

  // Fallback: CoinGecko
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${chainConfig.coingeckoId}&vs_currencies=usd&include_24hr_change=true`,
      { cache: 'no-store', signal: AbortSignal.timeout(5000) }
    )
    if (res.ok) {
      const data = await res.json()
      const coin = data[chainConfig.coingeckoId]
      if (coin?.usd) {
        return {
          usd: coin.usd,
          change24h: coin.usd_24h_change ?? 0,
        }
      }
    }
  } catch { /* try next */ }

  // Fallback: CoinCap
  const coincapId = chainConfig.key === 'bnb' ? 'binance-coin' : 'ethereum'
  try {
    const res = await fetch(
      `https://api.coincap.io/v2/assets/${coincapId}`,
      { cache: 'no-store', signal: AbortSignal.timeout(5000) }
    )
    if (res.ok) {
      const data = await res.json()
      const price = parseFloat(data?.data?.priceUsd)
      const change = parseFloat(data?.data?.changePercent24Hr)
      if (price > 0) return { usd: price, change24h: change || 0 }
    }
  } catch { /* all failed */ }

  return null
}

/** Count transactions indexed in the last 24 hours. */
async function fetchTxCount24h(): Promise<number> {
  try {
    const result = await db.execute(
      sql`SELECT COUNT(*)::int AS cnt FROM transactions WHERE timestamp > NOW() - INTERVAL '24 hours'`
    )
    return Number(Array.from(result)[0]?.cnt ?? 0)
  } catch {
    return 0
  }
}

/** Fetch market cap for the native currency. */
async function fetchMarketCap(): Promise<number | null> {
  const ccSymbol = chainConfig.key === 'bnb' ? 'BNB' : 'ETH'

  // Try CryptoCompare (has MKTCAP in RAW data)
  try {
    const res = await fetch(
      `https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${ccSymbol}&tsyms=USD`,
      { cache: 'no-store', signal: AbortSignal.timeout(5000) }
    )
    if (res.ok) {
      const data = await res.json()
      const mktcap = data?.RAW?.[ccSymbol]?.USD?.MKTCAP
      if (mktcap > 0) return mktcap
    }
  } catch { /* try next */ }

  // Try CoinGecko
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${chainConfig.coingeckoId}&vs_currencies=usd&include_market_cap=true`,
      { cache: 'no-store', signal: AbortSignal.timeout(5000) }
    )
    if (res.ok) {
      const data = await res.json()
      const mktcap = data[chainConfig.coingeckoId]?.usd_market_cap
      if (mktcap > 0) return mktcap
    }
  } catch { /* try next */ }

  // Try CoinCap
  const coincapId = chainConfig.key === 'bnb' ? 'binance-coin' : 'ethereum'
  try {
    const res = await fetch(
      `https://api.coincap.io/v2/assets/${coincapId}`,
      { cache: 'no-store', signal: AbortSignal.timeout(5000) }
    )
    if (res.ok) {
      const data = await res.json()
      const mktcap = parseFloat(data?.data?.marketCapUsd)
      if (mktcap > 0) return mktcap
    }
  } catch { /* all failed */ }

  return null
}

function formatMarketCap(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(1)}T`
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`
  return `$${formatNumber(Math.round(value))}`
}

export default async function HomePage() {
  let latestBlocks: typeof schema.blocks.$inferSelect[] = []
  let latestTxs: typeof schema.transactions.$inferSelect[] = []
  const [blocksResult, txsResult, txCount24h, nativePrice, marketCap] = await Promise.all([
    db.select().from(schema.blocks).orderBy(desc(schema.blocks.number)).limit(7).catch(() => []),
    db.select().from(schema.transactions).orderBy(desc(schema.transactions.timestamp)).limit(7).catch(() => []),
    fetchTxCount24h(),
    fetchNativePrice(),
    fetchMarketCap(),
  ])

  latestBlocks = blocksResult
  latestTxs = txsResult

  const latestBlock = latestBlocks[0]

  const priceDisplay = nativePrice
    ? `$${nativePrice.usd.toFixed(2)}`
    : '—'
  const changeDisplay = nativePrice
    ? `${nativePrice.change24h >= 0 ? '+' : ''}${nativePrice.change24h.toFixed(2)}%`
    : null
  const changePositive = nativePrice ? nativePrice.change24h >= 0 : null

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <AutoRefresh intervalMs={30000} />

      {/* Hero tagline */}
      <div className="mb-8">
        <h1 className="text-2xl md:text-3xl font-bold text-gray-900 mb-1">
          {chainConfig.tagline}
        </h1>
        <p className="text-sm text-gray-500">
          Maintained by{' '}
          <a
            href="https://mdt.io"
            target="_blank"
            rel="noopener noreferrer"
            className={`${chainConfig.theme.linkText} hover:underline font-medium`}
          >
            Measurable Data Token (MDT)
          </a>
          {' '}— open, independent, and community-driven.
        </p>
      </div>

      {/* Stats bar */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-500">Network Overview</h2>
          <span className="flex items-center gap-1.5 text-xs text-green-600 font-medium">
            <span className="w-1.5 h-1.5 bg-green-500 rounded-full inline-block animate-pulse" />
            Live
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Latest Block"
          value={latestBlock ? formatNumber(latestBlock.number) : '—'}
          subtext={latestBlock ? timeAgo(new Date(latestBlock.timestamp)) : null}
        />
        <StatCard
          label="24H Transactions"
          value={txCount24h > 0 ? formatNumber(txCount24h) : '—'}
          subtext={latestTxs[0] ? `last ${timeAgo(new Date(latestTxs[0].timestamp))}` : null}
        />
        <StatCard label={`${chainConfig.currency} Market Cap`} value={marketCap ? formatMarketCap(marketCap) : '—'} />
        <StatCard
          label={`${chainConfig.currency} Price`}
          value={priceDisplay}
          subtext={changeDisplay}
          subtextPositive={changePositive}
        />
        </div>
      </div>

      {/* Two-column layout */}
      <div className="grid md:grid-cols-2 gap-6">
        <section className="min-w-0">
          <SectionHeader title="Latest Blocks" href="/blocks" />
          <BlockTable blocks={latestBlocks} compact />
        </section>
        <section className="min-w-0">
          <SectionHeader title="Latest Transactions" href="/txs" />
          <TxTable txs={latestTxs} compact />
        </section>
      </div>
    </div>
  )
}

function StatCard({
  label,
  value,
  subtext,
  subtextPositive,
}: {
  label: string
  value: string
  subtext?: string | null
  subtextPositive?: boolean | null
}) {
  return (
    <div className="bg-gray-50 rounded-xl p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className="text-lg font-bold">{value}</p>
      {subtext && (
        <p
          className={`text-xs mt-0.5 font-medium ${
            subtextPositive === true
              ? 'text-green-600'
              : subtextPositive === false
              ? 'text-red-500'
              : 'text-gray-400'
          }`}
        >
          {subtext}
        </p>
      )}
    </div>
  )
}

function SectionHeader({ title, href }: { title: string; href: string }) {
  return (
    <div className="flex justify-between items-center mb-3">
      <h2 className="text-lg font-semibold text-gray-800">{title}</h2>
      <Link href={href} className={`text-sm ${chainConfig.theme.linkText} hover:underline`}>View all →</Link>
    </div>
  )
}

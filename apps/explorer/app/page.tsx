import { db, schema } from '@/lib/db'
import { desc, sql } from 'drizzle-orm'
import Link from 'next/link'
import { formatNumber, timeAgo } from '@/lib/format'
import { BlockTable } from '@/components/blocks/BlockTable'
import { TxTable } from '@/components/transactions/TxTable'
import { AutoRefresh } from '@/components/ui/AutoRefresh'
import { chainConfig } from '@/lib/chain'

export const revalidate = 10

async function fetchNativePrice(): Promise<{ usd: number; change24h: number } | null> {
  // Try CoinGecko first (longer cache to avoid rate limits)
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${chainConfig.coingeckoId}&vs_currencies=usd&include_24hr_change=true`,
      { next: { revalidate: 300 } }
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
  } catch { /* CoinGecko failed, try backup */ }

  // Fallback: CoinCap API (only works well for BNB)
  if (chainConfig.key === 'bnb') {
    try {
      const res = await fetch(
        'https://api.coincap.io/v2/assets/binance-coin',
        { next: { revalidate: 300 } }
      )
      if (res.ok) {
        const data = await res.json()
        const price = parseFloat(data?.data?.priceUsd)
        const change = parseFloat(data?.data?.changePercent24Hr)
        if (price > 0) return { usd: price, change24h: change || 0 }
      }
    } catch { /* both failed */ }
  } else if (chainConfig.key === 'eth') {
    try {
      const res = await fetch(
        'https://api.coincap.io/v2/assets/ethereum',
        { next: { revalidate: 300 } }
      )
      if (res.ok) {
        const data = await res.json()
        const price = parseFloat(data?.data?.priceUsd)
        const change = parseFloat(data?.data?.changePercent24Hr)
        if (price > 0) return { usd: price, change24h: change || 0 }
      }
    } catch { /* both failed */ }
  }

  return null
}

// Use pg_class.reltuples for instant approximate row counts.
// COUNT(*) on 36M+ rows can take minutes -- reltuples is updated by ANALYZE and
// is accurate within ~1-2% for large tables. Good enough for a stats bar.
async function fetchTableEstimate(tableName: string): Promise<number> {
  try {
    const result = await db.execute(
      sql`SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = ${tableName}`
    )
    const rows = Array.from(result)
    return Number((rows[0] as Record<string, unknown>)?.estimate ?? 0)
  } catch {
    return 0
  }
}

/** Fetch total chain transaction count from external explorer stats API (cached 1h). BNB only. */
async function fetchExternalTotalTxCount(): Promise<number | null> {
  if (chainConfig.key !== 'bnb') return null
  try {
    const res = await fetch(
      'https://api.bscscan.com/api?module=stats&action=txcount',
      { next: { revalidate: 3600 } },
    )
    if (!res.ok) return null
    const data = (await res.json()) as { status: string; result?: string }
    if (data.status !== '1' || !data.result) return null
    // result is a hex string e.g. "0x1a2b3c4d"
    return Number(BigInt(data.result))
  } catch {
    return null
  }
}

export default async function HomePage() {
  let latestBlocks: typeof schema.blocks.$inferSelect[] = []
  let latestTxs: typeof schema.transactions.$inferSelect[] = []
  let totalTxCount = 0
  let totalTokenCount = 0

  const [blocksResult, txsResult, txCountResult, tokenCountResult, nativePrice, externalTxCount] = await Promise.all([
    db.select().from(schema.blocks).orderBy(desc(schema.blocks.number)).limit(7).catch(() => []),
    db.select().from(schema.transactions).orderBy(desc(schema.transactions.timestamp)).limit(7).catch(() => []),
    fetchTableEstimate('transactions'),
    db.select({ value: sql<number>`count(*)::int` }).from(schema.tokens).then(([r]) => r?.value ?? 0).catch(() => 0),
    fetchNativePrice(),
    fetchExternalTotalTxCount(),
  ])

  latestBlocks = blocksResult
  latestTxs = txsResult
  // Prefer the live external total over our partial local index
  totalTxCount = externalTxCount ?? (typeof txCountResult === 'number' ? txCountResult : 0)
  totalTokenCount = typeof tokenCountResult === 'number' ? tokenCountResult : 0

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
      <AutoRefresh intervalMs={10000} />

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
          <h2 className="text-base font-semibold text-gray-500">Network Overview</h2>
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
          label="Total Transactions"
          value={totalTxCount > 0 ? formatNumber(totalTxCount) : '—'}
          subtext={latestTxs[0] ? `last ${timeAgo(new Date(latestTxs[0].timestamp))}` : null}
        />
        <StatCard label="Total Tokens" value={totalTokenCount > 0 ? formatNumber(totalTokenCount) : '—'} />
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
        <section>
          <SectionHeader title="Latest Blocks" href="/blocks" />
          <BlockTable blocks={latestBlocks} compact />
        </section>
        <section>
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
      <h2 className="font-semibold text-gray-800">{title}</h2>
      <Link href={href} className={`text-sm ${chainConfig.theme.linkText} hover:underline`}>View all →</Link>
    </div>
  )
}

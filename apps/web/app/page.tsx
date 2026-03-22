import { db, schema } from '@/lib/db'
import { desc, count } from 'drizzle-orm'
import Link from 'next/link'
import { formatNumber, timeAgo } from '@/lib/format'
import { BlockTable } from '@/components/blocks/BlockTable'
import { TxTable } from '@/components/transactions/TxTable'
import { AutoRefresh } from '@/components/ui/AutoRefresh'

export const revalidate = 5

async function fetchBNBPrice(): Promise<{ usd: number; change24h: number } | null> {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd&include_24hr_change=true',
      { next: { revalidate: 60 } }
    )
    if (!res.ok) return null
    const data = await res.json()
    return {
      usd: data.binancecoin?.usd ?? 0,
      change24h: data.binancecoin?.usd_24h_change ?? 0,
    }
  } catch {
    return null
  }
}

export default async function HomePage() {
  let latestBlocks: typeof schema.blocks.$inferSelect[] = []
  let latestTxs: typeof schema.transactions.$inferSelect[] = []
  let totalTxCount = 0
  let totalTokenCount = 0

  const [blocksResult, txsResult, txCountResult, tokenCountResult, bnbPrice] = await Promise.all([
    db.select().from(schema.blocks).orderBy(desc(schema.blocks.number)).limit(7).catch(() => []),
    db.select().from(schema.transactions).orderBy(desc(schema.transactions.timestamp)).limit(7).catch(() => []),
    db.select({ value: count() }).from(schema.transactions).catch(() => [{ value: 0 }]),
    db.select({ value: count() }).from(schema.tokens).catch(() => [{ value: 0 }]),
    fetchBNBPrice(),
  ])

  latestBlocks = blocksResult
  latestTxs = txsResult
  totalTxCount = (txCountResult as { value: number }[])[0]?.value ?? 0
  totalTokenCount = (tokenCountResult as { value: number }[])[0]?.value ?? 0

  const latestBlock = latestBlocks[0]

  const priceDisplay = bnbPrice
    ? `$${bnbPrice.usd.toFixed(2)}`
    : '—'
  const changeDisplay = bnbPrice
    ? `${bnbPrice.change24h >= 0 ? '+' : ''}${bnbPrice.change24h.toFixed(2)}%`
    : null
  const changePositive = bnbPrice ? bnbPrice.change24h >= 0 : null

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <AutoRefresh intervalMs={10000} />

      {/* Stats bar */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-gray-500">Network Overview</h2>
        <span className="flex items-center gap-1.5 text-xs text-green-600 font-medium">
          <span className="w-1.5 h-1.5 bg-green-500 rounded-full inline-block animate-pulse" />
          Live
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Latest Block" value={latestBlock ? formatNumber(latestBlock.number) : '—'} />
        <StatCard label="Total Transactions" value={totalTxCount > 0 ? formatNumber(totalTxCount) : '—'} />
        <StatCard label="Total Tokens" value={totalTokenCount > 0 ? formatNumber(totalTokenCount) : '—'} />
        <StatCard
          label="BNB Price"
          value={priceDisplay}
          subtext={changeDisplay}
          subtextPositive={changePositive}
        />
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
    <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
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
      <Link href={href} className="text-sm text-yellow-600 hover:underline">View all →</Link>
    </div>
  )
}

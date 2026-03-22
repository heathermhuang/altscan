import { db, schema } from '@/lib/db'
import { desc, count } from 'drizzle-orm'
import Link from 'next/link'
import { formatNumber, timeAgo } from '@/lib/format'
import { BlockTable } from '@/components/blocks/BlockTable'
import { TxTable } from '@/components/transactions/TxTable'

export const revalidate = 10

export default async function HomePage() {
  let latestBlocks: typeof schema.blocks.$inferSelect[] = []
  let latestTxs: typeof schema.transactions.$inferSelect[] = []
  let totalTxCount = 0
  let totalTokenCount = 0

  try {
    const [blocksResult, txsResult, txCountResult, tokenCountResult] = await Promise.all([
      db.select().from(schema.blocks).orderBy(desc(schema.blocks.number)).limit(7),
      db.select().from(schema.transactions).orderBy(desc(schema.transactions.timestamp)).limit(7),
      db.select({ value: count() }).from(schema.transactions),
      db.select({ value: count() }).from(schema.tokens),
    ])
    latestBlocks = blocksResult
    latestTxs = txsResult
    totalTxCount = txCountResult[0]?.value ?? 0
    totalTokenCount = tokenCountResult[0]?.value ?? 0
  } catch {
    // DB not connected — show empty state
  }

  const latestBlock = latestBlocks[0]

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Stats bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Latest Block" value={latestBlock ? formatNumber(latestBlock.number) : '—'} />
        <StatCard label="Total Transactions" value={totalTxCount > 0 ? formatNumber(totalTxCount) : '—'} />
        <StatCard label="Total Tokens" value={totalTokenCount > 0 ? formatNumber(totalTokenCount) : '—'} />
        <StatCard label="Avg Block Time" value="~3s" />
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

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className="text-lg font-bold">{value}</p>
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

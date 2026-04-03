import { db, schema } from '@/lib/db'
import { desc, sql } from 'drizzle-orm'
import { TxTable } from '@/components/transactions/TxTable'
import { Pagination } from '@/components/ui/Pagination'
import type { Metadata } from 'next'
import { chainConfig } from '@/lib/chain'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: `Recent Transactions`,
  description: `Browse the latest ${chainConfig.name} transactions on ${chainConfig.brandDomain}. Filter by block, address, and more.`,
  alternates: { canonical: '/txs' },
}

const PER_PAGE = 25

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  const params = await searchParams
  const page = Math.max(1, Number(params.page ?? 1))
  const offset = (page - 1) * PER_PAGE

  let txs: typeof schema.transactions.$inferSelect[] = []
  let total = 0
  try {
    const [txsResult, totalResult] = await Promise.all([
      db.select().from(schema.transactions)
        .orderBy(desc(schema.transactions.timestamp))
        .limit(PER_PAGE)
        .offset(offset),
      db.execute(sql`SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = 'transactions'`),
    ])
    txs = txsResult
    const n = Number((Array.from(totalResult)[0] as Record<string, unknown>)?.estimate ?? 0)
    total = n < 0 ? 0 : n
  } catch {
    // DB not connected — show empty state
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Transactions</h1>
      <TxTable txs={txs} />
      <div className="mt-4 flex justify-end">
        <Pagination page={page} total={total} perPage={PER_PAGE} baseUrl="/txs" />
      </div>
    </div>
  )
}

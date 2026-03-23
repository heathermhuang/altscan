import { db, schema } from '@/lib/db'
import { desc, count } from 'drizzle-orm'
import { TxTable } from '@/components/transactions/TxTable'
import { Pagination } from '@/components/ui/Pagination'

export const revalidate = 5

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
      db.select({ count: count() }).from(schema.transactions),
    ])
    txs = txsResult
    total = Number(totalResult[0]?.count ?? 0)
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

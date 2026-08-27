import { schema } from '@/lib/db'
import { fetchTxPage, parseTx, parsePageParam, PER_PAGE } from '@/lib/list-pages'
import { TxTable } from '@/components/transactions/TxTable'
import { Pagination } from '@/components/ui/Pagination'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'
import type { Metadata } from 'next'
import { chainConfig } from '@/lib/chain'

// Next.js statically analyses route segment config and cannot resolve an
// imported identifier here — `export const revalidate = TXS_REVALIDATE_SECONDS`
// fails the BUILD with "Unknown identifier at revalidate", which typecheck and
// the test suite both pass because CI never builds the explorer. It must be a
// literal. `revalidate-parity.test.ts` pins it to the cache TTL so the two
// cannot drift.
export const revalidate = 45

export const metadata: Metadata = {
  title: `Recent Transactions`,
  description: `Browse the latest ${chainConfig.name} transactions on ${chainConfig.brandDomain}. Filter by block, address, and more.`,
  alternates: { canonical: '/txs' },
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  const params = await searchParams
  const page = parsePageParam(params.page)

  let txs: typeof schema.transactions.$inferSelect[] = []
  let total = 0
  try {
    const data = await fetchTxPage(page)
    txs = data.rows.map(parseTx)
    total = data.total
  } catch (err) {
    // Tagged, not swallowed: an unlogged catch here is how the Whale Tracker
    // stayed dead for months looking like a quiet chain.
    console.error('[txs] page query failed:', err instanceof Error ? err.message : err)
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <BreadcrumbJsonLd items={[{ name: 'Transactions' }]} />
      <h1 className="text-2xl font-bold mb-6">Transactions</h1>
      <TxTable txs={txs} />
      <div className="mt-4 flex justify-end">
        <Pagination page={page} total={total} perPage={PER_PAGE} baseUrl="/txs" />
      </div>
    </div>
  )
}

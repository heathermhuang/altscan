import { dbErrorMessage } from '@altscan/db'
import { schema } from '@/lib/db'
import { fetchTxPage, parseTx, parsePageParam, PER_PAGE, TXS_REVALIDATE_SECONDS } from '@/lib/list-pages'
import { TxTable } from '@/components/transactions/TxTable'
import { Pagination } from '@/components/ui/Pagination'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'
import type { Metadata } from 'next'
import { chainConfig } from '@/lib/chain'
import { getBlockStrip } from '@/lib/block-strip'
import { createPageCache } from '@/lib/page-cache'
import { BlockStrip } from '@/components/tape/BlockStrip'

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

// The newest block's strip, cached like the page's own query (built once at module scope, the block
// number is an ARGUMENT). Values are numbers/booleans only (a BigInt in an unstable_cache value
// silently voids the write).
const cachedStrip = createPageCache('txs-strip', TXS_REVALIDATE_SECONDS, getBlockStrip)

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
    console.error('[txs] page query failed:', dbErrorMessage(err))
  }

  // Page 1 only: the strip is the newest row's block, and a later page's first row is not "now".
  const strip = page === 1 && txs[0] ? await cachedStrip(Number(txs[0].blockNumber)) : null

  return (
    <>
    <div className="max-w-7xl mx-auto px-4 pt-8">
      <BreadcrumbJsonLd items={[{ name: 'Transactions' }]} />
      <div className="mb-5">
        <p className="k">{'// '}transactions</p>
        <h1 className="mt-2 text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.05] tracking-[-0.03em] text-ink">Transactions</h1>
        <p className="mt-2 text-sm text-ink2">The latest {chainConfig.name} transactions, newest first.</p>
      </div>
    </div>
    {strip && (
      <BlockStrip txs={strip.txs} blockNumber={Number(txs[0].blockNumber)} gasLimit={strip.gasLimit} chainName={chainConfig.name} />
    )}
    <div className={`max-w-7xl mx-auto px-4 pb-8${strip ? ' pt-6' : ''}`}>
      <TxTable txs={txs} />
      <div className="mt-4 flex justify-end">
        <Pagination page={page} total={total} perPage={PER_PAGE} baseUrl="/txs" />
      </div>
    </div>
    </>
  )
}

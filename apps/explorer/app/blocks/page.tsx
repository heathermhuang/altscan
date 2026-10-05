import { dbErrorMessage } from '@altscan/db'
import { schema } from '@/lib/db'
import { fetchBlockPage, parseBlock, parsePageParam, PER_PAGE } from '@/lib/list-pages'
import { BlockTable } from '@/components/blocks/BlockTable'
import { BlockTape } from '@/components/home/BlockTape'
import { Pagination } from '@/components/ui/Pagination'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'
import type { Metadata } from 'next'
import { chainConfig } from '@/lib/chain'
import { encodeTape, toTapeTuple } from '@/lib/tape'

// Page 1's query also feeds the tape: ~32s of chain time fills the content column (BNB 72 blocks,
// ETH 3), never fewer than a table page. Pages 2+ keep the plain page-size query.
const TAPE_N = Math.min(100, Math.max(PER_PAGE, Math.ceil(32 / chainConfig.blockTime)))

// Next.js statically analyses route segment config and cannot resolve an
// imported identifier here — `export const revalidate = BLOCKS_REVALIDATE_SECONDS`
// fails the BUILD with "Unknown identifier at revalidate", which typecheck and
// the test suite both pass because CI never builds the explorer. It must be a
// literal. `revalidate-parity.test.ts` pins it to the cache TTL so the two
// cannot drift.
export const revalidate = 60

export const metadata: Metadata = {
  title: `Recent Blocks`,
  description: `Browse the latest ${chainConfig.name} blocks on ${chainConfig.brandDomain}. View block height, miner, gas used, and transaction count.`,
  alternates: { canonical: '/blocks' },
}

export default async function BlocksPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  const params = await searchParams
  const page = parsePageParam(params.page)

  let fetched: typeof schema.blocks.$inferSelect[] = []
  let total = 0
  try {
    const data = await fetchBlockPage(page, page === 1 ? TAPE_N : PER_PAGE)
    fetched = data.rows.map(parseBlock)
    total = data.total
  } catch (err) {
    console.error('[blocks] page query failed:', dbErrorMessage(err))
  }
  const blocks = fetched.slice(0, PER_PAGE)
  // No tape past page 1, or when the query failed (it would claim "No indexed blocks yet").
  const tape = page === 1 && fetched.length > 0 ? encodeTape(fetched.map(toTapeTuple)) : null

  return (
    <>
      <div className="max-w-7xl mx-auto px-4 pt-8">
        <BreadcrumbJsonLd items={[{ name: 'Blocks' }]} />
        <h1 className="text-2xl font-bold mb-6">Blocks</h1>
      </div>
      {tape !== null && <BlockTape tape={tape} chainName={chainConfig.name} />}
      <div className={`max-w-7xl mx-auto px-4 pb-8${tape !== null ? ' pt-6' : ''}`}>
        <BlockTable blocks={blocks} />
        <div className="mt-4 flex justify-end">
          <Pagination page={page} total={total} perPage={PER_PAGE} baseUrl="/blocks" />
        </div>
      </div>
    </>
  )
}

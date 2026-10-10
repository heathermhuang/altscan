import { dbErrorMessage } from '@altscan/db'
import { schema } from '@/lib/db'
import { BLOCKS_REVALIDATE_SECONDS, fetchBlockPage, parseBlock, parsePageParam, PER_PAGE } from '@/lib/list-pages'
import { BlockTable } from '@/components/blocks/BlockTable'
import { Pagination } from '@/components/ui/Pagination'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'
import type { Metadata } from 'next'
import { chainConfig } from '@/lib/chain'
import { BlockTape } from '@/components/home/BlockTape'
import { queryRecentTape } from '@/lib/recent-tape'
import { createPageCache } from '@/lib/page-cache'
import { swallow } from '@/lib/observability'

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

// The tape rides the same cache as the table (this page reads searchParams, so the route itself is
// dynamic and would otherwise query on every request). Built once at module scope; the failure is
// swallowed OUTSIDE the cache, so a rejection is never stored and the next request retries.
// '-v2': the tape's block count changed (lib/tape.ts), so strings cached by the old build (72 BNB / 7 ETH
// blocks) are not served.
const cachedTape = createPageCache('blocks-tape-v2', BLOCKS_REVALIDATE_SECONDS, queryRecentTape)

async function readTape(): Promise<string | null> {
  try {
    return await cachedTape()
  } catch (e) {
    swallow('blocks/tape', e)
    return null
  }
}

export default async function BlocksPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  const params = await searchParams
  const page = parsePageParam(params.page)

  // Page 1 only: "latest #N" above an older page's table would read as a mismatch. Started first so it
  // runs beside the page query; it never rejects (readTape swallows to null).
  const tapeQuery = page === 1 ? readTape() : Promise.resolve(null)

  let blocks: typeof schema.blocks.$inferSelect[] = []
  let total = 0
  try {
    const data = await fetchBlockPage(page)
    blocks = data.rows.map(parseBlock)
    total = data.total
  } catch (err) {
    console.error('[blocks] page query failed:', dbErrorMessage(err))
  }

  const tape = await tapeQuery

  return (
    <>
    <div className="max-w-7xl mx-auto px-4 pt-8">
      <BreadcrumbJsonLd items={[{ name: 'Blocks' }]} />
      <div className="mb-5">
        <p className="k">{'// '}blocks</p>
        <h1 className="mt-2 text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.05] tracking-[-0.03em] text-ink">Blocks</h1>
        <p className="mt-2 text-sm text-ink2">The latest {chainConfig.name} blocks, newest first.</p>
      </div>
    </div>
    {tape && <BlockTape tape={tape} chainName={chainConfig.name} />}
    <div className={`max-w-7xl mx-auto px-4 pb-8${tape ? ' pt-6' : ''}`}>
      <BlockTable blocks={blocks} gasBar />
      <div className="mt-4 flex justify-end">
        <Pagination page={page} total={total} perPage={PER_PAGE} baseUrl="/blocks" />
      </div>
    </div>
    </>
  )
}

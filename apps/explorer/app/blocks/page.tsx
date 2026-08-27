import { schema } from '@/lib/db'
import { fetchBlockPage, parseBlock, parsePageParam, PER_PAGE, BLOCKS_REVALIDATE_SECONDS } from '@/lib/list-pages'
import { BlockTable } from '@/components/blocks/BlockTable'
import { Pagination } from '@/components/ui/Pagination'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'
import type { Metadata } from 'next'
import { chainConfig } from '@/lib/chain'

export const revalidate = BLOCKS_REVALIDATE_SECONDS

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

  let blocks: typeof schema.blocks.$inferSelect[] = []
  let total = 0
  try {
    const data = await fetchBlockPage(page)
    blocks = data.rows.map(parseBlock)
    total = data.total
  } catch (err) {
    console.error('[blocks] page query failed:', err instanceof Error ? err.message : err)
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <BreadcrumbJsonLd items={[{ name: 'Blocks' }]} />
      <h1 className="text-2xl font-bold mb-6">Blocks</h1>
      <BlockTable blocks={blocks} />
      <div className="mt-4 flex justify-end">
        <Pagination page={page} total={total} perPage={PER_PAGE} baseUrl="/blocks" />
      </div>
    </div>
  )
}

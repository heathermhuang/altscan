import { db, schema } from '@/lib/db'
import { desc, sql } from 'drizzle-orm'
import { BlockTable } from '@/components/blocks/BlockTable'
import { Pagination } from '@/components/ui/Pagination'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'
import type { Metadata } from 'next'
import { chainConfig } from '@/lib/chain'

export const revalidate = 60

export const metadata: Metadata = {
  title: `Recent Blocks`,
  description: `Browse the latest ${chainConfig.name} blocks on ${chainConfig.brandDomain}. View block height, miner, gas used, and transaction count.`,
  alternates: { canonical: '/blocks' },
}

const PER_PAGE = 25

export default async function BlocksPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  const params = await searchParams
  const page = Math.max(1, Number(params.page ?? 1))
  const offset = (page - 1) * PER_PAGE

  let blocks: typeof schema.blocks.$inferSelect[] = []
  let total = 0
  try {
    const [blocksResult, totalResult] = await Promise.all([
      db.select().from(schema.blocks)
        .orderBy(desc(schema.blocks.number))
        .limit(PER_PAGE)
        .offset(offset),
      db.execute(sql`SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = 'blocks'`),
    ])
    blocks = blocksResult
    const n = Number((Array.from(totalResult)[0] as Record<string, unknown>)?.estimate ?? 0)
    total = n < 0 ? 0 : n
  } catch {
    // DB not connected — show empty state
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

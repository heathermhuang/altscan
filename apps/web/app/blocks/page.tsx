import { db, schema } from '@/lib/db'
import { desc, sql } from 'drizzle-orm'
import { BlockTable } from '@/components/blocks/BlockTable'
import { Pagination } from '@/components/ui/Pagination'

export const revalidate = 5

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
    total = Number((Array.from(totalResult)[0] as Record<string, unknown>)?.estimate ?? 0)
  } catch {
    // DB not connected — show empty state
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Blocks</h1>
      <BlockTable blocks={blocks} />
      <div className="mt-4 flex justify-end">
        <Pagination page={page} total={total} perPage={PER_PAGE} baseUrl="/blocks" />
      </div>
    </div>
  )
}

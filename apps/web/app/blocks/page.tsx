import { db, schema } from '@/lib/db'
import { desc, count } from 'drizzle-orm'
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

  const [blocks, totalResult] = await Promise.all([
    db.select().from(schema.blocks)
      .orderBy(desc(schema.blocks.number))
      .limit(PER_PAGE)
      .offset(offset),
    db.select({ count: count() }).from(schema.blocks),
  ])

  const total = Number(totalResult[0]?.count ?? 0)

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

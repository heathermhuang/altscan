import type { Metadata } from 'next'
import { BlockView, blockMetadata } from '../../block-view'
import { parseTxsPage } from '@/lib/block-txs'

// A literal, like app/blocks/page.tsx: Next cannot resolve an imported identifier here, and CI
// never builds the explorer to notice. lib/revalidate-parity.test.ts pins it to a plain number.
// Same 60s as the block page, for the same reason (see ../../page.tsx).
export const revalidate = 60
// Empty for the reason given in ../../page.tsx: without it the route renders per request and a
// notFound() streams a 200 shell. Each page prerenders nothing and static-renders on first hit.
export async function generateStaticParams(): Promise<Array<{ number: string; page: string }>> {
  return []
}

// /blocks/<n>/txs/<p>, p >= 2: the block page's own table, 50 rows at a time. The page
// segment, not `?page=`: reading searchParams would make every block page render per request.
export async function generateMetadata({ params }: { params: Promise<{ number: string; page: string }> }): Promise<Metadata> {
  const { number, page } = await params
  return blockMetadata(Number(number), parseTxsPage(page))
}

export default async function BlockTxsPage({
  params,
}: {
  params: Promise<{ number: string; page: string }>
}) {
  const { number, page } = await params
  return <BlockView blockNumber={Number(number)} page={parseTxsPage(page)} />
}

import type { Metadata } from 'next'
import { BlockView, blockMetadata } from './block-view'

// 60s (not 300): with ISR a transient miss — a fresh block during indexer
// lag — caches its 404 for everyone until the next revalidate. Block content
// is immutable, so short revalidation costs one render/min per actively-hit
// path while keeping the fresh-URL 404 window ≤ ~1-2 min.
export const revalidate = 60
// Without generateStaticParams a dynamic-segment route renders per-request
// (verified live: no-store, no full-route ISR — `revalidate` above never
// engaged) and streams a 200 shell before notFound() can throw, so unknown
// block numbers soft-404'd. Empty array = prerender nothing at build; each
// path static-renders on first request, is cached per `revalidate`, and a
// notFound() render returns a real HTTP 404.
export async function generateStaticParams(): Promise<Array<{ number: string }>> {
  return []
}

export async function generateMetadata({ params }: { params: Promise<{ number: string }> }): Promise<Metadata> {
  const { number } = await params
  return blockMetadata(Number(number), 1)
}

export default async function BlockDetailPage({
  params,
}: {
  params: Promise<{ number: string }>
}) {
  const { number } = await params
  return <BlockView blockNumber={Number(number)} page={1} />
}

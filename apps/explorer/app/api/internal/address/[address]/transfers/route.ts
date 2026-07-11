import { NextResponse } from 'next/server'
import { getTokenTransfers } from '@/lib/moralis'
import { guardInternalAddress } from '@/lib/internal-guard'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  const guard = await guardInternalAddress(_req, address)
  if (guard) return guard
  const url = new URL(_req.url)
  const cursor = url.searchParams.get('cursor') ?? undefined

  const result = await getTokenTransfers(address, cursor || undefined)

  if (result === null) {
    return NextResponse.json(
      { transfers: [], cursor: null, limited: true },
      { status: 200, headers: { 'cache-control': 'private, no-store' } },
    )
  }

  return NextResponse.json(
    { transfers: result.transfers, cursor: result.cursor, limited: false },
    { headers: { 'cache-control': 'private, no-store' } },
  )
}

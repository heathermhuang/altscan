import { NextResponse } from 'next/server'
import { getDataProvider } from '@/lib/providers'
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

  const provider = getDataProvider()
  const result = provider ? await provider.getAddressTokenTransfers(address, cursor || undefined) : null

  if (!result || !result.ok) {
    return NextResponse.json(
      { transfers: [], cursor: null, limited: true, reason: result ? result.reason : 'not_configured' },
      { status: 200, headers: { 'cache-control': 'private, no-store' } },
    )
  }

  return NextResponse.json(
    { transfers: result.data.transfers, cursor: result.data.cursor, limited: false },
    { headers: { 'cache-control': 'private, no-store' } },
  )
}

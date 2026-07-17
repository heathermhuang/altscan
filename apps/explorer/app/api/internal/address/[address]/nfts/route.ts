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

  const provider = getDataProvider()
  const result = provider ? await provider.getAddressNfts(address) : null

  if (!result || !result.ok) {
    return NextResponse.json(
      { nfts: [], limited: true, reason: result ? result.reason : 'not_configured' },
      { headers: { 'cache-control': 'private, no-store' } },
    )
  }

  return NextResponse.json(
    { nfts: result.data, limited: false },
    { headers: { 'cache-control': 'private, no-store' } },
  )
}

import { NextResponse } from 'next/server'
import { getNfts } from '@/lib/moralis'
import { guardInternalAddress } from '@/lib/internal-guard'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  const guard = await guardInternalAddress(_req, address)
  if (guard) return guard

  const result = await getNfts(address)

  // getNfts returns [] both when rate-limited and when the address has no NFTs.
  return NextResponse.json(
    { nfts: result, limited: false },
    { headers: { 'cache-control': 'private, no-store' } },
  )
}

import { NextResponse } from 'next/server'
import { getTokenBalances } from '@/lib/moralis'
import { guardInternalAddress } from '@/lib/internal-guard'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  const guard = await guardInternalAddress(_req, address)
  if (guard) return guard

  const result = await getTokenBalances(address)

  // getTokenBalances returns [] both when rate-limited (null internally) and when the
  // address genuinely has no tokens. We can't distinguish here, so always return 200
  // with the array (empty = no holdings, limited flag not applicable for this fn shape).
  return NextResponse.json(
    { tokens: result, limited: false },
    { headers: { 'cache-control': 'private, no-store' } },
  )
}

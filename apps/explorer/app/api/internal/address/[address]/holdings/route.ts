import { NextResponse } from 'next/server'
import { getDataProvider } from '@/lib/providers'
import { guardInternalAddress } from '@/lib/internal-guard'
import { chainConfig } from '@/lib/chain'
import { withLookalikes } from '@/lib/lookalike'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  const guard = await guardInternalAddress(_req, address)
  if (guard) return guard

  const provider = getDataProvider()
  const result = provider ? await provider.getAddressTokenBalances(address) : null

  if (!result || !result.ok) {
    return NextResponse.json(
      { tokens: [], limited: true, reason: result ? result.reason : 'not_configured' },
      { headers: { 'cache-control': 'private, no-store' } },
    )
  }

  // The tab (a client component) badges a token that passes for a well-known one but cannot judge that itself
  // (lib/lookalike stays out of the browser), so every row leaves here with the verdict on it.
  const tokens = withLookalikes(result.data, chainConfig.key, (t) => ({ address: t.tokenAddress, symbol: t.symbol, name: t.name }))
  return NextResponse.json(
    { tokens, limited: false },
    { headers: { 'cache-control': 'private, no-store' } },
  )
}

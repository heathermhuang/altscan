import { NextResponse } from 'next/server'
import { getTokenHolders } from '@/lib/holders'
import { guardInternalAddress } from '@/lib/internal-guard'

export const dynamic = 'force-dynamic'

/**
 * Lazy holders endpoint — hit client-side by HoldersLazy after the token page mounts.
 * Moving the Moralis holders call here (off SSR) means no-JS scrapers and crawlers that
 * fetch the token page origin-direct never trigger it (they don't run the XHR), so it
 * costs 0 Moralis CU — the same defense the address tabs use. getTokenHolders falls back
 * to the labeled local net-flow estimate when Moralis is disabled/keyless/rate-limited.
 *
 * Edge protection: a Cloudflare WAF rule on /api/internal/* (cf_clearance / bot score) is
 * the intended companion guard for headless-browser abuse — real-browser XHR passes it.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  const guard = await guardInternalAddress(_req, address)
  if (guard) return guard

  // Lowercase to share Moralis KV-cache keys (owners:/holdercount:) with the SSR path.
  const result = await getTokenHolders(address.toLowerCase())

  return NextResponse.json(result, {
    headers: { 'cache-control': 'private, no-store' },
  })
}

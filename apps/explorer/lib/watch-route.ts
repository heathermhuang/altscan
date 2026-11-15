import { NextResponse } from 'next/server'
import { authFailure, authRequest, requireApiKeyOwner } from '@/lib/api-auth'
import { chainConfig } from '@/lib/chain'

const OWNER = /^0x[0-9a-f]{40}$/

/**
 * Phase 1 is BNB-only: the feed serves only up to the async token-transfer writer's durable watermark
 * (indexer_cursor.transfers_durable_block), and the ETH indexer runs the inline writer, which publishes
 * none, so the feed's tip would never advance there. Enabling ETH needs ASYNC_TT_WRITER on eth-indexer
 * or a watermark on the inline path. null = this chain serves wallet watch.
 */
export function watchChainGate(): Response | null {
  return chainConfig.key === 'bnb'
    ? null
    : NextResponse.json({ error: 'Wallet watch is available on BNBScan only' }, { status: 404 })
}

/** The chain gate first (before any rate limiting), then rate limiting (per-IP ceiling, then the key's own budget). null = admitted. */
export async function admitWatchRequest(request: Request): Promise<Response | null> {
  const wrongChain = watchChainGate()
  if (wrongChain) return wrongChain
  const auth = await authRequest(request)
  return auth.ok ? null : authFailure(auth)
}

export type WatchOwner = { ok: true; owner: string } | { ok: false; response: Response }

/** The owner must be an address and the request's X-API-Key must belong to it — as /api/v1/webhooks. */
export async function requireWatchOwner(request: Request, rawOwner: unknown): Promise<WatchOwner> {
  const owner = typeof rawOwner === 'string' ? rawOwner.toLowerCase() : ''
  if (!OWNER.test(owner)) {
    return { ok: false, response: NextResponse.json({ error: 'Missing or invalid owner address' }, { status: 400 }) }
  }
  const ownerAuth = await requireApiKeyOwner(request, owner)
  if (!ownerAuth.ok) return { ok: false, response: NextResponse.json({ error: ownerAuth.error }, { status: ownerAuth.status }) }
  return { ok: true, owner }
}

/** The indexer has not created watch_addresses yet, or has not published a durable block. */
export function watchUnavailable(): Response {
  return NextResponse.json({ error: 'Wallet watch is not available on this explorer yet' }, { status: 503 })
}

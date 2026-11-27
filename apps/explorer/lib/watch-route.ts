import { NextResponse } from 'next/server'
import { authFailure, authRequest, requireApiKeyOwner } from '@/lib/api-auth'
import { chainConfig } from '@/lib/chain'
import { isLowerHexAddress } from './hex'

/** null = this chain serves wallet watch (chain-config `features.hasWalletWatch` says why ETH does not). */
function watchChainGate(): Response | null {
  return chainConfig.features.hasWalletWatch
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

type WatchOwner = { ok: true; owner: string } | { ok: false; response: Response }

/** The owner must be an address and the request's X-API-Key must belong to it — as /api/v1/webhooks. */
export async function requireWatchOwner(request: Request, rawOwner: unknown): Promise<WatchOwner> {
  const owner = typeof rawOwner === 'string' ? rawOwner.toLowerCase() : ''
  if (!isLowerHexAddress(owner)) {
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

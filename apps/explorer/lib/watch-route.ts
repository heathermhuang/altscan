import { NextResponse } from 'next/server'
import { authFailure, authRequest, requireApiKeyOwner } from '@/lib/api-auth'

const OWNER = /^0x[0-9a-f]{40}$/

/** Rate limiting (per-IP ceiling, then the key's own budget). null = admitted. */
export async function admitWatchRequest(request: Request): Promise<Response | null> {
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

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { admitWatchRequest, requireWatchOwner, watchUnavailable } from '@/lib/watch-route'
import { WATCH_MAX_ADDRESSES, addWatchAddresses, isUndefinedTable, listWatchAddresses, normalizeAddresses } from '@/lib/watch-addresses'

export const dynamic = 'force-dynamic'

// GET: the owner's watched addresses (requires an X-API-Key belonging to the owner)
export async function GET(request: Request) {
  const refused = await admitWatchRequest(request)
  if (refused) return refused
  const who = await requireWatchOwner(request, new URL(request.url).searchParams.get('owner'))
  if (!who.ok) return who.response
  try {
    return NextResponse.json({ addresses: await listWatchAddresses(db, who.owner) })
  } catch (e) {
    if (isUndefinedTable(e)) return watchUnavailable()
    throw e
  }
}

// POST: add addresses, at most WATCH_MAX_ADDRESSES per owner in total; re-adding one is a no-op
export async function POST(request: Request) {
  const refused = await admitWatchRequest(request)
  if (refused) return refused

  let body: { owner?: unknown; addresses?: unknown; label?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (Array.isArray(body.addresses) && body.addresses.length > WATCH_MAX_ADDRESSES) {
    return NextResponse.json({ error: `At most ${WATCH_MAX_ADDRESSES} addresses per request` }, { status: 400 })
  }
  const normalized = normalizeAddresses(body.addresses)
  if (!normalized.ok) {
    return NextResponse.json({ error: 'addresses must be a non-empty array of 0x addresses', invalid: normalized.invalid }, { status: 400 })
  }
  if (body.label !== undefined && body.label !== null && (typeof body.label !== 'string' || body.label.length > 64)) {
    return NextResponse.json({ error: 'label must be a string of at most 64 characters' }, { status: 400 })
  }

  const who = await requireWatchOwner(request, body.owner)
  if (!who.ok) return who.response
  try {
    const result = await addWatchAddresses(db, who.owner, normalized.addresses, (body.label as string | undefined) ?? null)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ added: result.added, total: result.total })
  } catch (e) {
    if (isUndefinedTable(e)) return watchUnavailable()
    throw e
  }
}

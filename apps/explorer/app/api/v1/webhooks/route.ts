import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq, sql } from 'drizzle-orm'
import { authRequest, requireApiKeyOwner } from '@/lib/api-auth'
import crypto from 'crypto'

export const dynamic = 'force-dynamic'

// GET: list webhooks for an owner — requires X-API-Key matching ownerAddress
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const owner = searchParams.get('owner')?.toLowerCase()
  if (!owner || !/^0x[0-9a-f]{40}$/.test(owner)) {
    return NextResponse.json({ error: 'Missing or invalid owner address' }, { status: 400 })
  }

  const ownerAuth = await requireApiKeyOwner(request, owner)
  if (!ownerAuth.ok) return NextResponse.json({ error: ownerAuth.error }, { status: ownerAuth.status })

  const webhooks = await db.select({
    id: schema.webhooks.id,
    url: schema.webhooks.url,
    watchAddress: schema.webhooks.watchAddress,
    eventTypes: schema.webhooks.eventTypes,
    active: schema.webhooks.active,
    createdAt: schema.webhooks.createdAt,
    lastTriggeredAt: schema.webhooks.lastTriggeredAt,
    failCount: schema.webhooks.failCount,
  }).from(schema.webhooks).where(eq(schema.webhooks.ownerAddress, owner))

  return NextResponse.json({ webhooks })
}

// POST: register a new webhook (requires API key ownership)
export async function POST(request: Request) {
  const auth = await authRequest(request)
  if (!auth.ok) return NextResponse.json({ error: auth.reason === 'invalid_key' ? 'Invalid or inactive API key' : 'Rate limit exceeded' }, { status: auth.reason === 'invalid_key' ? 401 : 429 })

  const body = await request.json() as {
    ownerAddress: string
    url: string
    watchAddress?: string
    eventTypes?: string[]
  }

  const { ownerAddress, url, watchAddress, eventTypes = ['tx'] } = body

  if (!ownerAddress || !/^0x[0-9a-fA-F]{40}$/.test(ownerAddress)) {
    return NextResponse.json({ error: 'Invalid ownerAddress' }, { status: 400 })
  }

  // Verify the requesting API key belongs to the ownerAddress
  const ownerAuth = await requireApiKeyOwner(request, ownerAddress.toLowerCase())
  if (!ownerAuth.ok) return NextResponse.json({ error: ownerAuth.error }, { status: ownerAuth.status })

  // Parse and validate URL — block localhost + private IPs (SSRF protection)
  if (!url) {
    return NextResponse.json({ error: 'url is required' }, { status: 400 })
  }
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 })
  }
  // Require HTTPS — webhook payloads contain HMAC signatures; HTTP allows MITM
  if (parsedUrl.protocol !== 'https:') {
    return NextResponse.json({ error: 'Webhook URL must use HTTPS' }, { status: 400 })
  }
  const hostname = parsedUrl.hostname.toLowerCase()
  // Block internal/private networks — prevents SSRF against internal services
  const blockedHosts = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0|169\.254\.|::1|fc00:|fe80:|0x|%)/
  if (blockedHosts.test(hostname)) {
    return NextResponse.json({ error: 'Webhook URL must be a public endpoint' }, { status: 400 })
  }
  // Block numeric IPs entirely — DNS rebinding defense (attacker points domain to internal IP after validation)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) {
    return NextResponse.json({ error: 'Webhook URL must use a domain name, not an IP address' }, { status: 400 })
  }

  if (watchAddress && !/^0x[0-9a-fA-F]{40}$/.test(watchAddress)) {
    return NextResponse.json({ error: 'Invalid watchAddress' }, { status: 400 })
  }

  // Validate eventTypes
  const VALID_EVENTS = new Set(['tx', 'token_transfer', 'new_block'])
  const sanitizedEvents = (eventTypes ?? ['tx']).filter(e => VALID_EVENTS.has(e))
  if (sanitizedEvents.length === 0) {
    return NextResponse.json({ error: 'eventTypes must contain at least one of: tx, token_transfer, new_block' }, { status: 400 })
  }

  // Generate raw secret, store SHA-256 hash in DB (same pattern as API keys).
  // The raw secret is returned once and never stored — if the DB is compromised,
  // the attacker cannot forge webhook signatures.
  const rawSecret = crypto.randomBytes(32).toString('hex')
  const secretHash = crypto.createHash('sha256').update(rawSecret).digest('hex')

  const owner = ownerAddress.toLowerCase()

  // Cap webhooks per owner. Each active webhook fires every block, so an
  // uncapped owner could register many webhooks pointing at a victim URL and
  // turn the indexer into an amplifier. Global (address-less) webhooks match
  // EVERY tx, so they are capped tighter than address-scoped ones.
  //
  // Count + insert run in one transaction holding a per-owner advisory lock:
  // without it, N parallel POSTs all read the same pre-insert count and sail
  // past the cap (the amplification path the cap exists to close). The xact
  // lock releases automatically on commit/rollback.
  let created: { id: number } | undefined
  let capError: string | null = null
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${owner}))`)

    const existing = await tx.select({ watchAddress: schema.webhooks.watchAddress })
      .from(schema.webhooks)
      .where(eq(schema.webhooks.ownerAddress, owner))
    if (existing.length >= 10) {
      capError = 'Maximum 10 webhooks per address'
      return
    }
    if (!watchAddress) {
      const globalCount = existing.filter((w) => w.watchAddress === null).length
      if (globalCount >= 2) {
        capError = 'Maximum 2 global (address-less) webhooks per address'
        return
      }
    }

    const [row] = await tx.insert(schema.webhooks).values({
      ownerAddress: owner,
      url,
      watchAddress: watchAddress?.toLowerCase(),
      eventTypes: sanitizedEvents,
      secret: secretHash,
    }).returning({ id: schema.webhooks.id })
    created = row
  })
  if (capError || !created) {
    return NextResponse.json({ error: capError ?? 'Webhook creation failed' }, { status: 400 })
  }

  return NextResponse.json({
    id: created.id,
    secret: rawSecret,
    message: 'Webhook created. Keep the secret — it will not be shown again. BNBScan sends ONE POST per block with an X-BNBScan-Signature header (HMAC-SHA256 of the raw JSON body using sha256(yourSecret) as the HMAC key). The body batches matching transactions: { event, timestamp, blockNumber, count, data: [ { hash, blockNumber, from, to, value }, ... ] }.',
  }, { status: 201 })
}

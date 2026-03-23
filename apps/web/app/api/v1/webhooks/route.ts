import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { checkIpRateLimit } from '@/lib/api-rate-limit'
import crypto from 'crypto'

// GET: list webhooks for an owner
export async function GET(request: Request) {
  if (!checkIpRateLimit(request.headers.get('x-forwarded-for'))) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })

  const { searchParams } = new URL(request.url)
  const owner = searchParams.get('owner')?.toLowerCase()
  if (!owner || !/^0x[0-9a-f]{40}$/.test(owner)) {
    return NextResponse.json({ error: 'Missing or invalid owner address' }, { status: 400 })
  }

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

// POST: register a new webhook
export async function POST(request: Request) {
  if (!checkIpRateLimit(request.headers.get('x-forwarded-for'))) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })

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
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return NextResponse.json({ error: 'URL must use http or https' }, { status: 400 })
  }
  const hostname = parsedUrl.hostname.toLowerCase()
  const blockedHosts = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0|169\.254\.|::1|fc00:|fe80:)/
  if (blockedHosts.test(hostname)) {
    return NextResponse.json({ error: 'Webhook URL must be a public endpoint' }, { status: 400 })
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

  const [created] = await db.insert(schema.webhooks).values({
    ownerAddress: ownerAddress.toLowerCase(),
    url,
    watchAddress: watchAddress?.toLowerCase(),
    eventTypes: sanitizedEvents,
    secret: secretHash,
  }).returning()

  return NextResponse.json({
    id: created.id,
    secret: rawSecret,
    message: 'Webhook created. Keep the secret — it will not be shown again. BNBScan will POST to your URL with an X-BNBScan-Signature header (HMAC-SHA256 of the payload using sha256(yourSecret) as the HMAC key).',
  }, { status: 201 })
}

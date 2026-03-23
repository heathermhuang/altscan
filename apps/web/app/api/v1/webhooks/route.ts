import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { checkRateLimit } from '@/lib/api-rate-limit'
import crypto from 'crypto'

// GET: list webhooks for an owner
export async function GET(request: Request) {
  const ip = request.headers.get('x-forwarded-for') ?? 'unknown'
  if (!checkRateLimit(ip)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })

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
  const ip = request.headers.get('x-forwarded-for') ?? 'unknown'
  if (!checkRateLimit(ip)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })

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
  if (!url || !/^https?:\/\/.+/.test(url)) {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
  }
  if (watchAddress && !/^0x[0-9a-fA-F]{40}$/.test(watchAddress)) {
    return NextResponse.json({ error: 'Invalid watchAddress' }, { status: 400 })
  }

  const secret = crypto.randomBytes(32).toString('hex')

  const [created] = await db.insert(schema.webhooks).values({
    ownerAddress: ownerAddress.toLowerCase(),
    url,
    watchAddress: watchAddress?.toLowerCase(),
    eventTypes,
    secret,
  }).returning()

  return NextResponse.json({
    id: created.id,
    secret,
    message: 'Webhook created. Keep the secret — it will not be shown again. BNBScan will POST to your URL with an X-BNBScan-Signature header (HMAC-SHA256 of the payload using your secret).',
  }, { status: 201 })
}

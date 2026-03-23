import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { checkIpRateLimit } from '@/lib/api-rate-limit'
import crypto from 'crypto'

// GET: list keys for an address
export async function GET(request: Request) {
  if (!checkIpRateLimit(request.headers.get('x-forwarded-for'))) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })

  const { searchParams } = new URL(request.url)
  const owner = searchParams.get('owner')?.toLowerCase()
  if (!owner || !/^0x[0-9a-f]{40}$/.test(owner)) {
    return NextResponse.json({ error: 'Missing or invalid owner address' }, { status: 400 })
  }

  const keys = await db.select({
    id: schema.apiKeys.id,
    keyPrefix: schema.apiKeys.keyPrefix,
    label: schema.apiKeys.label,
    requestsPerMinute: schema.apiKeys.requestsPerMinute,
    totalRequests: schema.apiKeys.totalRequests,
    createdAt: schema.apiKeys.createdAt,
    lastUsedAt: schema.apiKeys.lastUsedAt,
    active: schema.apiKeys.active,
  }).from(schema.apiKeys).where(eq(schema.apiKeys.ownerAddress, owner))

  return NextResponse.json({ keys })
}

// POST: generate a new API key
export async function POST(request: Request) {
  if (!checkIpRateLimit(request.headers.get('x-forwarded-for'))) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })

  const body = await request.json() as { ownerAddress: string; label?: string }
  const { ownerAddress, label } = body

  if (!ownerAddress || !/^0x[0-9a-fA-F]{40}$/.test(ownerAddress)) {
    return NextResponse.json({ error: 'Invalid ownerAddress' }, { status: 400 })
  }

  // Generate key: bnbs_<32 random bytes hex>
  const rawKey = `bnbs_${crypto.randomBytes(32).toString('hex')}`
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
  const keyPrefix = rawKey.slice(0, 12)

  const [created] = await db.insert(schema.apiKeys).values({
    keyHash,
    keyPrefix,
    label: label ?? null,
    ownerAddress: ownerAddress.toLowerCase(),
    requestsPerMinute: 100,
    totalRequests: 0,
    active: true,
  }).returning({ id: schema.apiKeys.id })

  return NextResponse.json({
    id: created.id,
    key: rawKey,
    keyPrefix,
    message: 'API key created. Save it now — the full key will not be shown again. Pass it as X-API-Key header.',
  }, { status: 201 })
}

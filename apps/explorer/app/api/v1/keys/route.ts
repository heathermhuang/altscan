import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { authRequest, requireApiKeyOwner } from '@/lib/api-auth'
import crypto from 'crypto'
import { verifyMessage } from 'ethers'

/** Message the client must sign: deterministic, timestamped, non-replayable. */
function expectedMessage(ownerAddress: string, timestamp: number): string {
  return `BNBScan API Key Request\nAddress: ${ownerAddress.toLowerCase()}\nTimestamp: ${timestamp}`
}

/** Allow signatures up to 5 minutes old to accommodate clock skew. */
const SIG_MAX_AGE_MS = 5 * 60 * 1000

// GET: list keys for an address (requires API key ownership)
export async function GET(request: Request) {
  const auth = await authRequest(request)
  if (!auth.ok) return NextResponse.json({ error: auth.reason === 'invalid_key' ? 'Invalid or inactive API key' : 'Rate limit exceeded' }, { status: auth.reason === 'invalid_key' ? 401 : 429 })

  const { searchParams } = new URL(request.url)
  const owner = searchParams.get('owner')?.toLowerCase()
  if (!owner || !/^0x[0-9a-f]{40}$/.test(owner)) {
    return NextResponse.json({ error: 'Missing or invalid owner address' }, { status: 400 })
  }

  // Verify the requesting API key belongs to this owner — prevents enumeration of other users' keys
  const ownerAuth = await requireApiKeyOwner(request, owner)
  if (!ownerAuth.ok) return NextResponse.json({ error: ownerAuth.error }, { status: ownerAuth.status })

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

// POST: generate a new API key (requires API key ownership)
export async function POST(request: Request) {
  const auth = await authRequest(request)
  if (!auth.ok) return NextResponse.json({ error: auth.reason === 'invalid_key' ? 'Invalid or inactive API key' : 'Rate limit exceeded' }, { status: auth.reason === 'invalid_key' ? 401 : 429 })

  const body = await request.json() as { ownerAddress: string; label?: string; signature?: string; timestamp?: number }
  const { ownerAddress, label, signature, timestamp } = body

  if (!ownerAddress || !/^0x[0-9a-fA-F]{40}$/.test(ownerAddress)) {
    return NextResponse.json({ error: 'Invalid ownerAddress' }, { status: 400 })
  }

  // Verify the requesting API key belongs to the ownerAddress — prevents
  // creating keys for arbitrary addresses using someone else's API key.
  // Exception: if no keys exist yet for this address, allow first key creation.
  const existingKeys = await db.select({ id: schema.apiKeys.id })
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.ownerAddress, ownerAddress.toLowerCase()))
    .limit(1)

  if (existingKeys.length > 0) {
    const ownerAuth = await requireApiKeyOwner(request, ownerAddress.toLowerCase())
    if (!ownerAuth.ok) return NextResponse.json({ error: ownerAuth.error }, { status: ownerAuth.status })
  }

  // Limit keys per address to prevent abuse
  const keyCount = await db.select({ id: schema.apiKeys.id })
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.ownerAddress, ownerAddress.toLowerCase()))
  if (keyCount.length >= 10) {
    return NextResponse.json({ error: 'Maximum 10 API keys per address' }, { status: 400 })
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

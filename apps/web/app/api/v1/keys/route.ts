import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { authRequest } from '@/lib/api-auth'
import crypto from 'crypto'
import { verifyMessage } from 'ethers'

/** Message the client must sign: deterministic, timestamped, non-replayable. */
function expectedMessage(ownerAddress: string, timestamp: number): string {
  return `BNBScan API Key Request\nAddress: ${ownerAddress.toLowerCase()}\nTimestamp: ${timestamp}`
}

/** Allow signatures up to 5 minutes old to accommodate clock skew. */
const SIG_MAX_AGE_MS = 5 * 60 * 1000

// GET: list keys for an address
export async function GET(request: Request) {
  const auth = await authRequest(request)
  if (!auth.ok) return NextResponse.json({ error: auth.reason === 'invalid_key' ? 'Invalid or inactive API key' : 'Rate limit exceeded' }, { status: auth.reason === 'invalid_key' ? 401 : 429 })

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
  const auth = await authRequest(request)
  if (!auth.ok) return NextResponse.json({ error: auth.reason === 'invalid_key' ? 'Invalid or inactive API key' : 'Rate limit exceeded' }, { status: auth.reason === 'invalid_key' ? 401 : 429 })

  const body = await request.json() as { ownerAddress: string; label?: string; signature?: string; timestamp?: number }
  const { ownerAddress, label, signature, timestamp } = body

  if (!ownerAddress || !/^0x[0-9a-fA-F]{40}$/.test(ownerAddress)) {
    return NextResponse.json({ error: 'Invalid ownerAddress' }, { status: 400 })
  }

  // Signature verification — caller must sign a timestamped message to prove wallet ownership
  if (!signature || typeof timestamp !== 'number') {
    return NextResponse.json({
      error: 'signature and timestamp are required',
      hint: `Sign the message: "${expectedMessage(ownerAddress, '<unix_ms_timestamp>')}" with your wallet and include the result as "signature" plus the timestamp as "timestamp".`,
    }, { status: 400 })
  }
  if (Math.abs(Date.now() - timestamp) > SIG_MAX_AGE_MS) {
    return NextResponse.json({ error: 'Timestamp expired — re-sign with a fresh timestamp (within 5 minutes)' }, { status: 400 })
  }
  try {
    const recovered = verifyMessage(expectedMessage(ownerAddress, timestamp), signature)
    if (recovered.toLowerCase() !== ownerAddress.toLowerCase()) {
      return NextResponse.json({ error: 'Signature verification failed — recovered address does not match ownerAddress' }, { status: 403 })
    }
  } catch {
    return NextResponse.json({ error: 'Invalid signature format' }, { status: 400 })
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

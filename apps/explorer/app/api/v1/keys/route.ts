import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { authFailure, authRequest, requireApiKeyOwner } from '@/lib/api-auth'
import { checkIpRateLimit, checkRateLimit, clientIpBucket } from '@/lib/api-rate-limit'
import { keyRequestTimestampError } from '@/lib/key-request'
import { mintApiKey } from '@/lib/api-key-mint'
import crypto from 'crypto'
import { verifyMessage } from 'ethers'

export const dynamic = 'force-dynamic'

/**
 * Key mints per client (IP bucket) per hour. A key needs only a fresh wallet's signature: on 2026-10-22, 69 wallets
 * minted 69 keys within one hour on each chain. The per-minute limits could not see that, so minting has an hourly
 * bucket of its own.
 */
const API_KEY_MINTS_PER_HOUR = (() => {
  const n = Number(process.env.API_KEY_MINTS_PER_HOUR)
  return Number.isInteger(n) && n > 0 ? n : 5
})()
const HOUR_MS = 60 * 60 * 1000

/** Message the client must sign: deterministic and timestamped; reusable only inside the skew window. */
function expectedMessage(ownerAddress: string, timestamp: number): string {
  return `BNBScan API Key Request\nAddress: ${ownerAddress.toLowerCase()}\nTimestamp: ${timestamp}`
}

// GET: list keys for an address (requires API key ownership)
export async function GET(request: Request) {
  const auth = await authRequest(request)
  if (!auth.ok) return authFailure(auth)

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

// POST: generate a new API key. Proven by a wallet signature, not a key, so it is admitted by IP alone: running
// authRequest here charged whatever X-API-Key the caller sent, someone else's included.
export async function POST(request: Request) {
  if (!(await checkIpRateLimit(request.headers))
      || !(await checkRateLimit(`mint:${clientIpBucket(request.headers)}`, API_KEY_MINTS_PER_HOUR, HOUR_MS))) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  const body = await request.json() as { ownerAddress: string; label?: string; signature?: string; timestamp?: number }
  const { ownerAddress, label, signature, timestamp } = body

  if (!ownerAddress || !/^0x[0-9a-fA-F]{40}$/.test(ownerAddress)) {
    return NextResponse.json({ error: 'Invalid ownerAddress' }, { status: 400 })
  }

  // Verify wallet ownership via signature — prevents creating keys for arbitrary addresses.
  // Required for all key creation (first key and subsequent keys).
  if (!signature || !timestamp) {
    return NextResponse.json({ error: 'signature and timestamp required' }, { status: 400 })
  }
  const timestampError = keyRequestTimestampError(timestamp)
  if (timestampError) {
    return NextResponse.json({ error: timestampError }, { status: 400 })
  }
  const message = expectedMessage(ownerAddress, timestamp)
  try {
    const signer = verifyMessage(message, signature)
    if (signer.toLowerCase() !== ownerAddress.toLowerCase()) {
      return NextResponse.json({ error: 'Signature does not match ownerAddress' }, { status: 403 })
    }
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  // Generate key: bnbs_<32 random bytes hex>
  const rawKey = `bnbs_${crypto.randomBytes(32).toString('hex')}`
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
  const keyPrefix = rawKey.slice(0, 12)

  // The existing-key check, the per-address cap and the insert run under one per-owner
  // lock (lib/api-key-mint.ts). For subsequent keys, the requesting API key must also
  // belong to ownerAddress; that check reads through the pool, so it runs first.
  const owner = ownerAddress.toLowerCase()
  const ownerAuth = await requireApiKeyOwner(request, owner)
  const created = await mintApiKey(db, owner, { keyHash, keyPrefix, label: label ?? null }, ownerAuth)
  if (!created.ok) return NextResponse.json({ error: created.error }, { status: created.status })

  return NextResponse.json({
    id: created.id,
    key: rawKey,
    keyPrefix,
    message: 'API key created. Save it now — the full key will not be shown again. Pass it as X-API-Key header.',
  }, { status: 201 })
}

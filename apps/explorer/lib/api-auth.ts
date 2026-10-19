/**
 * API authentication middleware for BNBScan.
 *
 * Three modes:
 *   1. X-API-Key header present → look up hashed key in DB, use key's rate limit + track usage
 *   2. Authorization: Bearer (an OAuth token from lib/oauth.ts) → per-address limit (100 req/min)
 *   3. Neither → fall back to IP-based rate limit (100 req/min)
 *
 * The key lookup adds one DB query per API call. Acceptable for v1 traffic.
 * TODO (v2): add Redis key cache (TTL=60s) to eliminate per-call DB hit.
 */
import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq, and, sql } from 'drizzle-orm'
import { verifyBearer, wwwAuthenticate } from '@altscan/oauth'
import { checkIpRateLimit, checkRateLimit, clientIpFromHeaders } from '@/lib/api-rate-limit'
import { oauthConfig } from '@/lib/oauth'
import crypto from 'crypto'

/** An OAuth token's budget: the same as an API key's, shared by every token for one address. */
const TOKEN_REQUESTS_PER_MINUTE = 100

export type OwnerAuthResult =
  | { ok: true }
  | { ok: false; status: 400 | 401 | 403; error: string }

/**
 * Require a valid X-API-Key whose ownerAddress matches the provided owner.
 * Use on webhook and key management endpoints to prevent unauthorized enumeration/deletion.
 */
export async function requireApiKeyOwner(request: Request, owner: string): Promise<OwnerAuthResult> {
  const apiKey = request.headers.get('x-api-key')
  if (!apiKey) {
    return { ok: false, status: 401, error: 'X-API-Key header required for this operation' }
  }

  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex')
  try {
    const [row] = await db.select({
      ownerAddress: schema.apiKeys.ownerAddress,
      active: schema.apiKeys.active,
    }).from(schema.apiKeys).where(
      and(eq(schema.apiKeys.keyHash, keyHash), eq(schema.apiKeys.active, true))
    )

    if (!row) return { ok: false, status: 401, error: 'Invalid or inactive API key' }
    if ((row.ownerAddress ?? '').toLowerCase() !== owner.toLowerCase()) {
      return { ok: false, status: 403, error: 'API key does not belong to this owner address' }
    }
  } catch {
    return { ok: false, status: 401, error: 'Invalid or inactive API key' }
  }

  return { ok: true }
}

export type AuthResult =
  | { ok: true; limited: false }
  | { ok: false; limited: true; reason: 'rate_limit' | 'invalid_key' | 'invalid_token' }

/** The response for a failed authRequest. A bad bearer token gets RFC 6750's WWW-Authenticate. */
export function authFailure(auth: Extract<AuthResult, { ok: false }>): NextResponse {
  if (auth.reason === 'invalid_key') return NextResponse.json({ error: 'Invalid or inactive API key' }, { status: 401 })
  if (auth.reason === 'invalid_token') {
    const cfg = oauthConfig()
    return NextResponse.json(
      { error: 'Invalid or expired access token' },
      { status: 401, headers: cfg ? { 'WWW-Authenticate': wwwAuthenticate(cfg, true) } : {} },
    )
  }
  return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
}

/**
 * Authenticate and rate-limit a request.
 * Pass request.headers for both IP extraction and API key lookup.
 */
export async function authRequest(request: Request): Promise<AuthResult> {
  const apiKey = request.headers.get('x-api-key')

  if (apiKey) {
    // Hash the provided key and look it up
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex')

    let keyRow: { id: number; active: boolean; requestsPerMinute: number } | undefined
    try {
      const [row] = await db.select({
        id: schema.apiKeys.id,
        active: schema.apiKeys.active,
        requestsPerMinute: schema.apiKeys.requestsPerMinute,
      }).from(schema.apiKeys).where(
        and(eq(schema.apiKeys.keyHash, keyHash), eq(schema.apiKeys.active, true))
      )
      keyRow = row
    } catch {
      // DB error — fall back to IP rate limit
    }

    if (keyRow) {
      // Use the key's own rate limit (keyed by hash prefix for bucket isolation)
      const bucket = `key:${keyHash.slice(0, 16)}`
      if (!(await checkRateLimit(bucket, keyRow.requestsPerMinute))) {
        console.warn(`[api-auth] Rate limit exceeded for key ${keyHash.slice(0, 8)}...`)
        return { ok: false, limited: true, reason: 'rate_limit' }
      }
      // Track usage asynchronously — atomic increment via SQL to avoid race conditions
      db.update(schema.apiKeys)
        .set({ lastUsedAt: new Date(), totalRequests: sql`${schema.apiKeys.totalRequests} + 1` })
        .where(eq(schema.apiKeys.id, keyRow.id))
        .catch(() => {})
      return { ok: true, limited: false }
    }

    // Key provided but not found or inactive — log for brute-force detection
    console.warn(`[api-auth] Invalid API key attempt: prefix=${apiKey.slice(0, 8)}... ip=${clientIpFromHeaders(request.headers)}`)
    // Count the attempt against the IP bucket (same budget as key-less requests); otherwise
    // any bogus X-API-Key would skip every limiter on this route.
    if (!(await checkIpRateLimit(request.headers))) {
      return { ok: false, limited: true, reason: 'rate_limit' }
    }
    return { ok: false, limited: true, reason: 'invalid_key' }
  }

  // An OAuth token, when this explorer issues them. A bad one is refused, not ignored, and still
  // costs the IP's budget, like a bogus key above.
  const oauth = oauthConfig()
  const bearer = oauth ? await verifyBearer(request.headers.get('authorization'), oauth) : null
  if (bearer === 'invalid') {
    if (!(await checkIpRateLimit(request.headers))) return { ok: false, limited: true, reason: 'rate_limit' }
    return { ok: false, limited: true, reason: 'invalid_token' }
  }
  if (bearer) {
    if (!(await checkRateLimit(`sub:${bearer.sub}`, TOKEN_REQUESTS_PER_MINUTE))) return { ok: false, limited: true, reason: 'rate_limit' }
    return { ok: true, limited: false }
  }

  // No credential — IP-based rate limit
  if (!(await checkIpRateLimit(request.headers))) {
    console.warn(`[api-auth] IP rate limit exceeded: ${clientIpFromHeaders(request.headers)}`)
    return { ok: false, limited: true, reason: 'rate_limit' }
  }
  return { ok: true, limited: false }
}

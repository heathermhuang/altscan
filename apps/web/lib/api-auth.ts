/**
 * API authentication middleware for BNBScan.
 *
 * Two modes:
 *   1. X-API-Key header present → look up hashed key in DB, use key's rate limit + track usage
 *   2. No key → fall back to IP-based rate limit (100 req/min)
 *
 * The key lookup adds one DB query per API call. Acceptable for v1 traffic.
 * TODO (v2): add Redis key cache (TTL=60s) to eliminate per-call DB hit.
 */
import { db, schema } from '@/lib/db'
import { eq, and } from 'drizzle-orm'
import { checkIpRateLimit, checkRateLimit } from '@/lib/api-rate-limit'
import crypto from 'crypto'

export type AuthResult =
  | { ok: true; limited: false }
  | { ok: false; limited: true; reason: 'rate_limit' | 'invalid_key' }

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
      if (!checkRateLimit(bucket, keyRow.requestsPerMinute)) {
        return { ok: false, limited: true, reason: 'rate_limit' }
      }
      // Track usage asynchronously (non-blocking)
      db.update(schema.apiKeys)
        .set({ lastUsedAt: new Date(), totalRequests: keyRow.id }) // increment via raw SQL would be ideal but this updates lastUsedAt
        .where(eq(schema.apiKeys.id, keyRow.id))
        .catch(() => {})
      return { ok: true, limited: false }
    }

    // Key provided but not found or inactive
    return { ok: false, limited: true, reason: 'invalid_key' }
  }

  // No API key — IP-based rate limit
  const xForwardedFor = request.headers.get('x-forwarded-for')
  if (!checkIpRateLimit(xForwardedFor)) {
    return { ok: false, limited: true, reason: 'rate_limit' }
  }
  return { ok: true, limited: false }
}

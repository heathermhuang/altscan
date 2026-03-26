/**
 * API authentication helpers for EthScan.
 * Mirrors apps/web/lib/api-auth.ts but connects to ETH_DATABASE_URL via @/lib/db.
 */
import { db, schema } from '@/lib/db'
import { eq, and, sql } from 'drizzle-orm'
import { checkIpRateLimit, checkRateLimit } from '@/lib/api-rate-limit'
import crypto from 'crypto'

export type AuthResult =
  | { ok: true; limited: false }
  | { ok: false; limited: true; reason: 'rate_limit' | 'invalid_key' }

export async function authRequest(request: Request): Promise<AuthResult> {
  const apiKey = request.headers.get('x-api-key')

  if (apiKey) {
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
      const bucket = `key:${keyHash.slice(0, 16)}`
      if (!checkRateLimit(bucket, keyRow.requestsPerMinute)) {
        return { ok: false, limited: true, reason: 'rate_limit' }
      }
      // Track usage asynchronously — atomic increment via SQL to avoid race conditions
      db.update(schema.apiKeys)
        .set({ lastUsedAt: new Date(), totalRequests: sql`${schema.apiKeys.totalRequests} + 1` })
        .where(eq(schema.apiKeys.id, keyRow.id))
        .catch(() => {})
      return { ok: true, limited: false }
    }

    return { ok: false, limited: true, reason: 'invalid_key' }
  }

  const xForwardedFor = request.headers.get('x-forwarded-for')
  if (!checkIpRateLimit(xForwardedFor)) {
    return { ok: false, limited: true, reason: 'rate_limit' }
  }
  return { ok: true, limited: false }
}

export type OwnerAuthResult =
  | { ok: true }
  | { ok: false; status: 400 | 401 | 403; error: string }

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

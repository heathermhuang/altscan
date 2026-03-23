/**
 * In-memory rate limiter shared across all explorer apps.
 *
 * SECURITY: always extract the real client IP from the LAST entry in X-Forwarded-For.
 * Render's load balancer appends the real IP last. The first entries are attacker-controlled
 * and must not be trusted for rate limiting.
 *
 * NOTE (v2): Replace with Redis-backed sliding window when running multiple instances.
 * Redis connection is already in the stack (REDIS_URL env var on bnbscan-web).
 */

const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

const DEFAULT_MAX_REQUESTS = 100
const WINDOW_MS = 60 * 1000
const MAX_MAP_SIZE = 50_000

/**
 * Extract the real client IP from an X-Forwarded-For header.
 * Render's LB appends the real client IP last — use that one.
 */
export function extractClientIp(xForwardedFor: string | null): string {
  if (!xForwardedFor) return 'unknown'
  const parts = xForwardedFor.split(',')
  return parts[parts.length - 1].trim() || 'unknown'
}

/**
 * Check whether a key (IP address or API key prefix) is within the rate limit.
 * Returns true if the request is allowed, false if rate-limited.
 */
export function checkRateLimit(key: string, maxRequests = DEFAULT_MAX_REQUESTS): boolean {
  const now = Date.now()

  // Purge expired entries when map grows large (prevents OOM on long-running processes)
  if (rateLimitMap.size > MAX_MAP_SIZE) {
    for (const [k, val] of rateLimitMap) {
      if (now > val.resetAt) rateLimitMap.delete(k)
    }
  }

  const entry = rateLimitMap.get(key)

  if (!entry || now > entry.resetAt) {
    rateLimitMap.delete(key)
    rateLimitMap.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return true
  }

  if (entry.count >= maxRequests) return false
  entry.count++
  return true
}

/**
 * Convenience wrapper: extract client IP from header and check rate limit.
 * Use in Next.js API routes:
 *   const ip = request.headers.get('x-forwarded-for') ?? null
 *   if (!checkIpRateLimit(ip)) return 429 response
 */
export function checkIpRateLimit(xForwardedFor: string | null, maxRequests = DEFAULT_MAX_REQUESTS): boolean {
  const ip = extractClientIp(xForwardedFor)
  return checkRateLimit(ip, maxRequests)
}

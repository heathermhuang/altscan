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
const CLEANUP_INTERVAL_MS = 60_000 // Sweep expired entries every 60s

// Periodic cleanup — prevents unbounded growth from unique IPs that never return
let cleanupTimer: ReturnType<typeof setInterval> | null = null
function startCleanupTimer() {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const now = Date.now()
    let swept = 0
    for (const [k, val] of rateLimitMap) {
      if (now > val.resetAt) {
        rateLimitMap.delete(k)
        swept++
      }
    }
    if (swept > 0) {
      // Only log when significant cleanup happens
      if (swept > 100) console.log(`[rate-limit] Swept ${swept} expired entries (${rateLimitMap.size} remaining)`)
    }
  }, CLEANUP_INTERVAL_MS)
  // Don't prevent process exit
  if (cleanupTimer.unref) cleanupTimer.unref()
}

/**
 * Extract the real client IP from an X-Forwarded-For header.
 * Render's LB appends the real client IP last — use that one.
 * Falls back to 'unknown' which shares a single rate limit bucket
 * (safe because the rate limit is generous at 100 req/min).
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
  startCleanupTimer()
  const now = Date.now()

  // Emergency purge if map somehow exceeds cap despite periodic cleanup
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

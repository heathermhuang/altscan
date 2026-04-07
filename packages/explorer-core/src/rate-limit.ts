/**
 * Rate limiter — Redis sliding window with in-memory fallback.
 *
 * Primary: Redis INCR + PEXPIRE sliding window (correct across multiple instances).
 * Fallback: in-memory Map (used when REDIS_URL is absent or Redis is unreachable).
 *
 * SECURITY: always extract the real client IP from the LAST entry in X-Forwarded-For.
 * Render's load balancer appends the real IP last. The first entries are attacker-controlled
 * and must not be trusted for rate limiting.
 */

import Redis from 'ioredis'

const DEFAULT_MAX_REQUESTS = 100
const WINDOW_MS = 60 * 1000

// ── Redis client (lazy singleton) ────────────────────────────────────────────

let redis: Redis | null = null
let redisUnavailable = false  // once broken, don't keep retrying

function getRedis(): Redis | null {
  if (redisUnavailable) return null
  if (redis) return redis

  const url = process.env.REDIS_URL
  if (!url) return null  // Redis not configured — use in-memory fallback

  try {
    redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      lazyConnect: true,
      enableOfflineQueue: false,
    })
    redis.on('error', (err) => {
      // Only log once per failure cycle — don't spam logs
      if (!redisUnavailable) {
        console.warn('[rate-limit] Redis unavailable, falling back to in-memory:', err.message)
        redisUnavailable = true
      }
    })
    redis.on('connect', () => {
      if (redisUnavailable) {
        console.log('[rate-limit] Redis reconnected — resuming Redis rate limiting')
        redisUnavailable = false
      }
    })
  } catch {
    redisUnavailable = true
  }
  return redis
}

// ── Redis sliding window ──────────────────────────────────────────────────────

async function checkRateLimitRedis(key: string, maxRequests: number): Promise<boolean> {
  const r = getRedis()
  if (!r || redisUnavailable) return checkRateLimitMemory(key, maxRequests)

  const redisKey = `rl:${key}`
  try {
    const count = await r.incr(redisKey)
    if (count === 1) {
      // First request in this window — set the expiry
      await r.pexpire(redisKey, WINDOW_MS)
    }
    return count <= maxRequests
  } catch {
    // Redis blip — fall through to in-memory
    return checkRateLimitMemory(key, maxRequests)
  }
}

// ── In-memory fallback ────────────────────────────────────────────────────────

const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const MAX_MAP_SIZE = 10_000        // reduced from 50K to limit memory
const CLEANUP_INTERVAL_MS = 30_000 // reduced from 60s to 30s for faster eviction

let cleanupTimer: ReturnType<typeof setInterval> | null = null
function startCleanupTimer() {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const now = Date.now()
    let swept = 0
    for (const [k, val] of rateLimitMap) {
      if (now > val.resetAt) { rateLimitMap.delete(k); swept++ }
    }
    if (swept > 100) console.log(`[rate-limit] Swept ${swept} expired entries (${rateLimitMap.size} remaining)`)
  }, CLEANUP_INTERVAL_MS)
  if (cleanupTimer.unref) cleanupTimer.unref()
}

function checkRateLimitMemory(key: string, maxRequests: number): boolean {
  startCleanupTimer()
  const now = Date.now()
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

// ── Public API ────────────────────────────────────────────────────────────────

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
 * Async rate limit check — uses Redis when available, in-memory otherwise.
 * Returns true if allowed, false if rate-limited.
 */
export async function checkRateLimit(key: string, maxRequests = DEFAULT_MAX_REQUESTS): Promise<boolean> {
  return checkRateLimitRedis(key, maxRequests)
}

/**
 * Convenience wrapper: extract IP and check rate limit.
 */
export async function checkIpRateLimit(xForwardedFor: string | null, maxRequests = DEFAULT_MAX_REQUESTS): Promise<boolean> {
  return checkRateLimit(extractClientIp(xForwardedFor), maxRequests)
}

/** Expose in-memory rate limit map size for monitoring */
export function getRateLimitMapSize(): number {
  return rateLimitMap.size
}

/**
 * Shared Redis client — lazy singleton used by rate limiting and the KV cache.
 *
 * One connection per process, shared across all consumers (rate-limit, kv-cache).
 * When REDIS_URL is absent or Redis is unreachable, getRedis() returns null and
 * callers fall back to their own in-memory implementation.
 *
 * Behavior is intentionally identical to the original inline client that lived in
 * rate-limit.ts: short timeouts, no offline queue, and a sticky `unavailable` flag
 * so a single failure doesn't spam logs or retry-storm under load.
 */
import Redis from 'ioredis'

let redis: Redis | null = null
let redisUnavailable = false // once broken, don't keep retrying every call

/**
 * Get the shared Redis client, or null when Redis is not configured/available.
 * Pair every use with an in-memory fallback — Redis is best-effort here.
 */
export function getRedis(): Redis | null {
  if (redisUnavailable) return null
  if (redis) return redis

  const url = process.env.REDIS_URL
  if (!url) return null // Redis not configured — callers use in-memory fallback

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
        console.warn('[redis] unavailable, falling back to in-memory:', err.message)
        redisUnavailable = true
      }
    })
    redis.on('connect', () => {
      if (redisUnavailable) {
        console.log('[redis] reconnected — resuming Redis-backed paths')
        redisUnavailable = false
      }
    })
  } catch {
    redisUnavailable = true
  }
  return redis
}

/** True when the shared client has hit an error and callers should use fallback. */
export function isRedisUnavailable(): boolean {
  return redisUnavailable
}

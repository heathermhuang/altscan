/**
 * KV cache — Redis-backed string cache with a bounded in-memory fallback.
 *
 * Primary: Redis GET / SET PX (shared across all instances, lives off the heap).
 * Fallback: a small bounded Map, used only when REDIS_URL is absent or Redis is
 * unreachable (e.g. EthScan, which has no Redis service provisioned).
 *
 * WHY THIS EXISTS: the Moralis response cache used to be an in-process Map that
 * grew with traffic and was the named culprit in the BNBScan OOM crash-loop
 * (commit "disable Moralis on BNBScan"). Moving it to Redis removes that heap
 * pressure entirely on instances that have Redis, while the bounded fallback
 * keeps memory flat where Redis is absent.
 *
 * Values are opaque strings — callers serialize/deserialize (JSON, sentinels)
 * themselves so this stays a generic, easily-tested primitive.
 */
import { getRedis, isRedisUnavailable } from './redis-client'

/** Max entries kept in the in-memory fallback before oldest-first eviction. */
export const KV_FALLBACK_MAX = 50

type Entry = { value: string; expiresAt: number }
const fallback = new Map<string, Entry>()

// Periodic sweep of expired fallback entries so memory doesn't hold stale data
// between accesses. Unref'd so it never keeps the process alive.
let sweepTimer: ReturnType<typeof setInterval> | null = null
function startSweep(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const [k, e] of fallback) {
      if (now > e.expiresAt) fallback.delete(k)
    }
  }, 30_000)
  if (sweepTimer.unref) sweepTimer.unref()
}

function memGet(key: string): string | null {
  const e = fallback.get(key)
  if (!e) return null
  if (Date.now() > e.expiresAt) {
    fallback.delete(key)
    return null
  }
  return e.value
}

function memSet(key: string, value: string, ttlMs: number): void {
  startSweep()
  // Bound the map: evict the oldest entry (insertion order) when at capacity.
  if (fallback.size >= KV_FALLBACK_MAX && !fallback.has(key)) {
    const oldest = fallback.keys().next().value
    if (oldest !== undefined) fallback.delete(oldest)
  }
  // Re-set moves the key to the newest insertion position.
  fallback.delete(key)
  fallback.set(key, { value, expiresAt: Date.now() + ttlMs })
}

/**
 * Get a cached string, or null on miss/expiry.
 * Tries Redis first; falls back to the in-memory map on any Redis problem.
 */
export async function kvGet(key: string): Promise<string | null> {
  const r = getRedis()
  if (r && !isRedisUnavailable()) {
    try {
      return await r.get(key)
    } catch {
      // Redis blip — fall through to in-memory
    }
  }
  return memGet(key)
}

/**
 * Cache a string for ttlMs milliseconds.
 * Writes to Redis when available, otherwise to the bounded in-memory map.
 */
export async function kvSet(key: string, value: string, ttlMs: number): Promise<void> {
  const r = getRedis()
  if (r && !isRedisUnavailable()) {
    try {
      await r.set(key, value, 'PX', ttlMs)
      return
    } catch {
      // Redis blip — fall through to in-memory
    }
  }
  memSet(key, value, ttlMs)
}

/** Current in-memory fallback size — for the health endpoint / cache registry. */
export function getKvFallbackSize(): number {
  return fallback.size
}

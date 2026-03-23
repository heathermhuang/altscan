/** Simple in-memory rate limiter for API routes. */

const WINDOW_MS = 60_000 // 1 minute
const DEFAULT_MAX = 100

const counters = new Map<string, { count: number; resetAt: number }>()

export function rateLimit(key: string, max = DEFAULT_MAX): { ok: boolean; remaining: number } {
  const now = Date.now()
  const entry = counters.get(key)

  if (!entry || entry.resetAt < now) {
    counters.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return { ok: true, remaining: max - 1 }
  }

  entry.count++
  if (entry.count > max) {
    return { ok: false, remaining: 0 }
  }

  return { ok: true, remaining: max - entry.count }
}

/** Convenience wrapper — returns true if the request is within the rate limit. */
export function checkRateLimit(key: string, max = DEFAULT_MAX): boolean {
  return rateLimit(key, max).ok
}

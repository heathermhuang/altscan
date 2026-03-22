const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

const MAX_REQUESTS = 100
const WINDOW_MS = 60 * 1000 // 60 seconds
const MAX_MAP_SIZE = 50_000  // evict all expired entries when map exceeds this

export function checkRateLimit(ip: string): boolean {
  // Take the LAST IP in X-Forwarded-For — Render's LB appends the real client IP last.
  // The first IP is attacker-controlled and must not be trusted for rate limiting.
  const ips = ip.split(',')
  const clientIp = ips[ips.length - 1].trim() || 'unknown'
  const now = Date.now()

  // Purge expired entries if map is getting large (prevents OOM on long-running processes)
  if (rateLimitMap.size > MAX_MAP_SIZE) {
    for (const [key, val] of rateLimitMap) {
      if (now > val.resetAt) rateLimitMap.delete(key)
    }
  }

  const entry = rateLimitMap.get(clientIp)

  if (!entry || now > entry.resetAt) {
    rateLimitMap.delete(clientIp)
    rateLimitMap.set(clientIp, { count: 1, resetAt: now + WINDOW_MS })
    return true
  }

  if (entry.count >= MAX_REQUESTS) {
    return false
  }

  entry.count++
  return true
}

/**
 * Rate limiter — Redis sliding window with in-memory fallback.
 *
 * Primary: Redis fixed window — INCR + PEXPIRE in one atomic Lua script (correct across
 * multiple instances; a counter can never exist without a TTL).
 * Fallback: in-memory Map (used when REDIS_URL is absent or Redis is unreachable).
 *
 * SECURITY: key on clientIpFromHeaders(), never on a leading X-Forwarded-For entry — those
 * are attacker-controlled. Render's load balancer appends its connecting peer LAST, and that
 * peer is a Cloudflare edge (bnbscan.com/ethscan.io and Render's own onrender.com hostnames
 * are all Cloudflare-fronted), so the last hop alone lumps every visitor on one edge together.
 */

import { BlockList, isIP } from 'net'
import { getRedis, isRedisUnavailable } from './redis-client'

const DEFAULT_MAX_REQUESTS = 100
const WINDOW_MS = 60 * 1000

// ── Redis fixed window ────────────────────────────────────────────────────────

// INCR and the expiry run as ONE script (one round trip, atomic), so a crash or error between
// the two can no longer leave a counter with no TTL — that would pin the bucket over its limit
// forever. The expiry is set whenever the key has none (PTTL == -1): on the first request of a
// window (the window starts there, as before) and on a key some earlier bug left without one
// (self-healing). Plain EVAL needs no Redis version beyond 2.6; `PEXPIRE ... NX` would need 7.0
// and, on an older server, would error after the INCR had already applied.
const INCR_WITH_EXPIRY = `
local n = redis.call('INCR', KEYS[1])
if redis.call('PTTL', KEYS[1]) == -1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return n
`

async function checkRateLimitRedis(key: string, maxRequests: number): Promise<boolean> {
  const r = getRedis()
  if (!r || isRedisUnavailable()) return checkRateLimitMemory(key, maxRequests)

  const redisKey = `rl:${key}`
  try {
    const count = Number(await r.eval(INCR_WITH_EXPIRY, 1, redisKey, WINDOW_MS))
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
 * The connecting peer: the LAST X-Forwarded-For hop, which Render's LB appends.
 * Behind Cloudflare this is the Cloudflare edge, not the visitor — use
 * clientIpFromHeaders() for rate-limit keys.
 */
export function extractClientIp(xForwardedFor: string | null): string {
  if (!xForwardedFor) return 'unknown'
  const parts = xForwardedFor.split(',')
  return parts[parts.length - 1].trim() || 'unknown'
}

// https://www.cloudflare.com/ips/ (fetched 2026-10-06). If Cloudflare adds a range
// and this goes stale, requests from it fall back to the peer IP — never spoofable.
const CLOUDFLARE_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
]

const cloudflare = new BlockList()
for (const range of CLOUDFLARE_RANGES) {
  const [net, bits] = range.split('/')
  cloudflare.addSubnet(net, Number(bits), isIP(net) === 6 ? 'ipv6' : 'ipv4')
}

function isCloudflareIp(ip: string): boolean {
  const family = isIP(ip)
  return family !== 0 && cloudflare.check(ip, family === 6 ? 'ipv6' : 'ipv4')
}

/**
 * The visitor's IP, for rate-limit keys.
 *
 * Trusts cf-connecting-ip only when the connecting peer is a Cloudflare edge:
 * Cloudflare sets that header itself and refuses a client-supplied one (error
 * 1000). From any other peer a cf-connecting-ip may be forged, so the peer is used.
 */
export function clientIpFromHeaders(headers: { get(name: string): string | null }): string {
  const peer = extractClientIp(headers.get('x-forwarded-for'))
  const cf = headers.get('cf-connecting-ip')?.trim()
  return cf && isCloudflareIp(peer) ? cf : peer
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
export async function checkIpRateLimit(
  headers: { get(name: string): string | null },
  maxRequests = DEFAULT_MAX_REQUESTS,
): Promise<boolean> {
  return checkRateLimit(clientIpFromHeaders(headers), maxRequests)
}

/** Expose in-memory rate limit map size for monitoring */
export function getRateLimitMapSize(): number {
  return rateLimitMap.size
}

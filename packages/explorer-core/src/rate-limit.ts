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
import { CLOUDFLARE_RANGES } from './cloudflare-ranges'

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

async function checkRateLimitRedis(key: string, maxRequests: number, windowMs: number): Promise<boolean> {
  const r = getRedis()
  if (!r || isRedisUnavailable()) return checkRateLimitMemory(key, maxRequests, windowMs)

  const redisKey = `rl:${key}`
  try {
    const count = Number(await r.eval(INCR_WITH_EXPIRY, 1, redisKey, windowMs))
    return count <= maxRequests
  } catch {
    // Redis blip — fall through to in-memory
    return checkRateLimitMemory(key, maxRequests, windowMs)
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

// The cap is hard: a flood of distinct keys (rotating IPv6 clients) while Redis is down must not
// grow the map without bound. Expired windows go first, swept at most once a second so a full map
// does not cost an O(n) scan per request; then the oldest windows are evicted (a Map iterates in
// insertion order, and a reset re-inserts at the end). Eviction hands that client a fresh window
// early — briefly lenient — where refusing new keys would lock out every new visitor.
const FULL_SWEEP_MIN_INTERVAL_MS = 1_000
let lastFullSweep = 0

function makeRoom(now: number) {
  if (now - lastFullSweep >= FULL_SWEEP_MIN_INTERVAL_MS) {
    lastFullSweep = now
    for (const [k, val] of rateLimitMap) {
      if (now > val.resetAt) rateLimitMap.delete(k)
    }
  }
  while (rateLimitMap.size >= MAX_MAP_SIZE) {
    const oldest = rateLimitMap.keys().next().value
    if (oldest === undefined) break
    rateLimitMap.delete(oldest)
  }
}

function checkRateLimitMemory(key: string, maxRequests: number, windowMs: number): boolean {
  startCleanupTimer()
  const now = Date.now()
  const entry = rateLimitMap.get(key)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.delete(key)
    if (rateLimitMap.size >= MAX_MAP_SIZE) makeRoom(now)
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs })
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

const cloudflare = new BlockList()
for (const range of CLOUDFLARE_RANGES) {
  const [net, bits] = range.split('/')
  cloudflare.addSubnet(net, Number(bits), isIP(net) === 6 ? 'ipv6' : 'ipv4')
}

export function isCloudflareIp(ip: string): boolean {
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

/** The 8 groups of an IPv6 address as numbers, or null. Handles "::" and a dotted IPv4 tail. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    if (isIP(dotted[2]) !== 4) return null
    const [a, b, c, d] = dotted[2].split('.').map(Number)
    s = dotted[1] + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16)
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null
  const parts = [...head, ...Array(fill).fill('0'), ...tail]
  if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null
  return parts.map((p) => parseInt(p, 16))
}

/**
 * The rate-limit bucket for a client address. One subscriber is routinely handed a whole IPv6 /64 and can rotate
 * through it for free: on 2026-10-19 ETH web saw ~4k rotating IPv6 addresses in one burst. So an IPv6 address buckets
 * by its /64. An IPv4-mapped IPv6 address (::ffff:1.2.3.4) is that IPv4 address, and every spelling of one address
 * (case, leading zeros, "::" placement, brackets, a zone id) is one key. Anything else is returned as given.
 */
export function ipBucketKey(ip: string): string {
  const raw = ip.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  if (isIP(raw) === 4) return raw
  if (isIP(raw) !== 6) return ip
  const g = ipv6Groups(raw)
  if (!g) return ip
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.')
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`
}

/** `clientIpFromHeaders`, as a rate-limit bucket (ipBucketKey). Every per-IP limit keys on this. */
export function clientIpBucket(headers: { get(name: string): string | null }): string {
  return ipBucketKey(clientIpFromHeaders(headers))
}

// DECR only an existing counter, never below zero: a bare DECR on a key that expired meanwhile would create -1 with
// no TTL, a counter that never expires and starts every window one request ahead.
const DECR_IF_POSITIVE = `
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n > 0 then return redis.call('DECR', KEYS[1]) end
return 0
`

/**
 * Give back one count from `key`'s current window: for a check whose request then did not go ahead (a later gate
 * refused it), so the client is charged only for what it actually got. Best effort; a failure leaves the charge.
 */
export async function refundRateLimit(key: string): Promise<void> {
  const r = getRedis()
  if (r && !isRedisUnavailable()) {
    try {
      await r.eval(DECR_IF_POSITIVE, 1, `rl:${key}`)
      return
    } catch { /* fall through to the in-memory map, as checkRateLimit does */ }
  }
  const entry = rateLimitMap.get(key)
  if (entry && entry.count > 0) entry.count--
}

/**
 * Async rate limit check — uses Redis when available, in-memory otherwise.
 * Returns true if allowed, false if rate-limited.
 */
export async function checkRateLimit(key: string, maxRequests = DEFAULT_MAX_REQUESTS, windowMs = WINDOW_MS): Promise<boolean> {
  return checkRateLimitRedis(key, maxRequests, windowMs)
}

/**
 * Convenience wrapper: extract IP and check rate limit.
 */
export async function checkIpRateLimit(
  headers: { get(name: string): string | null },
  maxRequests = DEFAULT_MAX_REQUESTS,
): Promise<boolean> {
  return checkRateLimit(clientIpBucket(headers), maxRequests)
}

/** Expose in-memory rate limit map size for monitoring */
export function getRateLimitMapSize(): number {
  return rateLimitMap.size
}

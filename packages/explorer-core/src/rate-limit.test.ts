import { describe, it, expect, beforeEach } from 'vitest'
import { extractClientIp, checkRateLimit, checkIpRateLimit, clientIpFromHeaders } from './rate-limit'

describe('extractClientIp', () => {
  it('returns unknown for null header', () => {
    expect(extractClientIp(null)).toBe('unknown')
  })

  it('returns the single IP when no commas', () => {
    expect(extractClientIp('203.0.113.5')).toBe('203.0.113.5')
  })

  it('returns the LAST IP from X-Forwarded-For (Render LB appends real IP last)', () => {
    // First entry is attacker-controlled, last is Render's trusted append
    expect(extractClientIp('1.2.3.4, 5.6.7.8, 203.0.113.5')).toBe('203.0.113.5')
  })

  it('trims whitespace from the extracted IP', () => {
    expect(extractClientIp('1.2.3.4,   203.0.113.5  ')).toBe('203.0.113.5')
  })

  it('prevents IP spoofing — attacker-prepended IPs are ignored', () => {
    // Attacker sends X-Forwarded-For: attacker-ip, <real-ip>
    // If we naively took the first IP, the attacker would bypass rate limiting
    const extracted = extractClientIp('1.1.1.1, 203.0.113.99')
    expect(extracted).toBe('203.0.113.99')
    expect(extracted).not.toBe('1.1.1.1')
  })
})

// Shapes seen in prod (2026-10-06): Render's LB appends the Cloudflare edge it
// received the request from as the LAST X-Forwarded-For hop, on bnbscan.com and
// on bnbscan-web.onrender.com alike; cf-connecting-ip carries the visitor.
describe('clientIpFromHeaders', () => {
  const h = (init: Record<string, string>) => new Headers(init)

  it('returns cf-connecting-ip when the connecting peer is a Cloudflare edge', () => {
    expect(clientIpFromHeaders(h({
      'x-forwarded-for': '203.0.113.9, 162.158.193.138',
      'cf-connecting-ip': '203.0.113.9',
    }))).toBe('203.0.113.9')
  })

  it('returns cf-connecting-ip behind an IPv6 Cloudflare edge', () => {
    expect(clientIpFromHeaders(h({
      'x-forwarded-for': '2001:db8::1, 2a06:98c0:3600::103',
      'cf-connecting-ip': '2001:db8::1',
    }))).toBe('2001:db8::1')
  })

  it('ignores a forged cf-connecting-ip when the peer is not Cloudflare', () => {
    expect(clientIpFromHeaders(h({
      'x-forwarded-for': '198.51.100.7',
      'cf-connecting-ip': '1.2.3.4',
    }))).toBe('198.51.100.7')
  })

  it('treats addresses just outside a Cloudflare range as non-Cloudflare', () => {
    // 172.64.0.0/13 ends at 172.71.255.255; 104.16.0.0/13 starts at 104.16.0.0.
    for (const peer of ['172.72.0.1', '104.15.255.255']) {
      expect(clientIpFromHeaders(h({ 'x-forwarded-for': peer, 'cf-connecting-ip': '1.2.3.4' }))).toBe(peer)
    }
  })

  it('falls back to the peer when a Cloudflare request has no cf-connecting-ip', () => {
    expect(clientIpFromHeaders(h({ 'x-forwarded-for': '162.158.193.138' }))).toBe('162.158.193.138')
  })

  it('returns unknown with no forwarding headers', () => {
    expect(clientIpFromHeaders(h({}))).toBe('unknown')
  })
})

describe('checkIpRateLimit', () => {
  // Unique per run so a Redis-backed run never sees a previous run's counters.
  const octet = () => Math.floor(Math.random() * 256)
  const visitor = () => `198.18.${octet()}.${octet()}`

  it('gives two visitors behind the same Cloudflare edge separate buckets', async () => {
    const a = visitor()
    const b = visitor()
    const via = (ip: string) => new Headers({ 'x-forwarded-for': `${ip}, 172.71.146.94`, 'cf-connecting-ip': ip })
    for (let i = 0; i < 3; i++) await checkIpRateLimit(via(a), 3)
    expect(await checkIpRateLimit(via(a), 3)).toBe(false)
    expect(await checkIpRateLimit(via(b), 3)).toBe(true)
  })

  it('keeps one visitor in one bucket across Cloudflare edges, keyed on the bare IP', async () => {
    const a = visitor()
    for (const edge of ['172.71.146.94', '104.22.160.5', '162.158.152.130']) {
      await checkIpRateLimit(new Headers({ 'x-forwarded-for': `${a}, ${edge}`, 'cf-connecting-ip': a }), 3)
    }
    // Same counter as checkRateLimit(<ip>) → the Redis key is still rl:<ip>.
    expect(await checkRateLimit(a, 3)).toBe(false)
  })
})

describe('checkRateLimit', () => {
  it('allows requests up to the limit', async () => {
    const key = `test-bucket-${Math.random()}`
    for (let i = 0; i < 5; i++) {
      expect(await checkRateLimit(key, 5)).toBe(true)
    }
  })

  it('blocks requests that exceed the limit', async () => {
    const key = `test-bucket-${Math.random()}`
    for (let i = 0; i < 5; i++) await checkRateLimit(key, 5) // exhaust
    expect(await checkRateLimit(key, 5)).toBe(false)
  })

  it('uses separate buckets for different keys', async () => {
    const key1 = `test-bucket-a-${Math.random()}`
    const key2 = `test-bucket-b-${Math.random()}`
    for (let i = 0; i < 3; i++) await checkRateLimit(key1, 3) // exhaust key1
    // key2 should still be allowed
    expect(await checkRateLimit(key2, 3)).toBe(true)
  })
})

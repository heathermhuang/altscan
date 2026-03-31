import { describe, it, expect, beforeEach } from 'vitest'
import { extractClientIp, checkRateLimit } from './rate-limit'

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

import { describe, expect, it } from 'vitest'
import { checkIpRateLimit, clientIpBucket, ipBucketKey } from './rate-limit'

// One subscriber is handed a whole IPv6 /64 and can rotate through it for free (ETH web, 2026-10-19: ~4k rotating
// IPv6 addresses in one burst), so per-IP limits bucket IPv6 by /64, and every spelling of one address is one key.
describe('ipBucketKey', () => {
  it.each([
    '2001:db8:1:2:3:4:5:6',
    '2001:0DB8:0001:0002:0003:0004:0005:0006',
    '2001:db8:1:2::abcd',
    '[2001:db8:1:2::1]',
    '2001:db8:1:2::1%eth0',
    ' 2001:db8:1:2:ffff:ffff:ffff:ffff ',
  ])('buckets %s by its /64', (ip) => {
    expect(ipBucketKey(ip)).toBe('2001:db8:1:2::/64')
  })

  it('keeps different /64s apart', () => {
    expect(ipBucketKey('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64')
    expect(ipBucketKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(ipBucketKey('::1')).toBe('0:0:0:0::/64')
  })

  it.each(['::ffff:1.2.3.4', '::FFFF:0102:0304', '0:0:0:0:0:ffff:1.2.3.4', '[::ffff:1.2.3.4]'])('reads the IPv4-mapped %s as 1.2.3.4', (ip) => {
    expect(ipBucketKey(ip)).toBe('1.2.3.4')
  })

  it('reads a dotted IPv4 tail on another prefix as IPv6', () => {
    expect(ipBucketKey('64:ff9b::1.2.3.4')).toBe('64:ff9b:0:0::/64')
  })

  it('returns IPv4 as is, and anything that is not an address unchanged', () => {
    expect(ipBucketKey('203.0.113.9')).toBe('203.0.113.9')
    expect(ipBucketKey('unknown')).toBe('unknown')
    expect(ipBucketKey('1:2:3')).toBe('1:2:3')
  })
})

describe('per-IP limits share a /64', () => {
  const headers = (ip: string) => new Headers({ 'x-forwarded-for': ip })

  it('clientIpBucket keys on the /64', () => {
    expect(clientIpBucket(headers('2001:db8:aa:bb::7'))).toBe('2001:db8:aa:bb::/64')
  })

  it('two addresses in one /64 draw on one limit', async () => {
    expect(await checkIpRateLimit(headers('2001:db8:cc:dd::1'), 2)).toBe(true)
    expect(await checkIpRateLimit(headers('2001:db8:cc:dd::2'), 2)).toBe(true)
    expect(await checkIpRateLimit(headers('2001:db8:cc:dd:ffff::3'), 2)).toBe(false)
    expect(await checkIpRateLimit(headers('2001:db8:cc:de::1'), 2), 'the next /64 has its own').toBe(true)
  })
})

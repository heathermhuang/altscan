import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { middleware } from './middleware'
import { CLOUDFLARE_RANGES } from '@altscan/explorer-core/cloudflare-ranges'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'

// As in prod: Render's load balancer appends the Cloudflare edge it received the request from
// as the LAST X-Forwarded-For hop, and cf-connecting-ip carries the visitor.
const CF_EDGE = '162.158.193.138'
function statusFor(ip: string, path = '/tx/0x' + 'ab'.repeat(32)): number {
  return statusWith({ 'cf-connecting-ip': ip, 'x-forwarded-for': `${ip}, ${CF_EDGE}` }, path)
}
function statusWith(headers: Record<string, string>, path = '/tx/0x' + 'ab'.repeat(32)): number {
  const req = new NextRequest(`https://ethscan.io${path}`, { headers: { 'user-agent': UA, ...headers } })
  return middleware(req).status
}

describe('middleware IP denylist', () => {
  it('blocks the IPv4 abuse range', () => {
    expect(statusFor('47.79.13.1')).toBe(403)
    expect(statusFor('47.80.0.1')).not.toBe(403)
  })

  // Real client IPs from the 2026-10-19 ethscan-web /tx/ flood, one per blocked /29.
  it.each([
    '2a12:f547:9b10:3cf1:8d2e:41a7:5c09:e3b2',
    '2a13:f40:1a2b:3c4d:5e6f:7a8b:9c0d:1e2f',
    '2a10:7b07:1708:4ff7:6c10:1d85:4351:af34',
    '2a10:4a06:77:0:1:2:3:4',
    '2a13:dcc5::1',
    '2a01:F2C3::abcd',
    '2a11:c47:ffff:ffff:ffff:ffff:ffff:ffff',
    '2a12:da80::',
  ])('blocks %s', (ip) => {
    expect(statusFor(ip)).toBe(403)
  })

  it.each([
    '2a12:f548::1', // first address past 2a12:f540::/29
    '2a13:f3f:ffff::1', // last /32 before 2a13:f40::/29
    '2804:14c:5b80:8a3e::1', // residential tail of the same flood — not denylisted
    '2606:4700::1111',
    '::1',
    'not-an-ip',
    '2a12:f547::1::2', // two "::" — invalid, never blocked
  ])('does not block %s', (ip) => {
    expect(statusFor(ip)).not.toBe(403)
  })
})

// The denylist reads the visitor's IP by explorer-core's clientIpFromHeaders rule: the
// connecting peer is the last X-Forwarded-For hop, and cf-connecting-ip counts only when
// that peer is a Cloudflare edge. A request that reached Render without crossing
// Cloudflare could otherwise name any address it liked and walk past the block.
describe('middleware client IP: cf-connecting-ip only from a Cloudflare peer', () => {
  const BLOCKED = '47.79.13.1'

  it('a blocked client that skipped Cloudflare cannot forge its way past', () => {
    expect(statusWith({ 'x-forwarded-for': BLOCKED, 'cf-connecting-ip': '8.8.8.8' })).toBe(403)
    expect(statusWith({ 'x-forwarded-for': BLOCKED, 'x-real-ip': '8.8.8.8' })).toBe(403)
    expect(statusWith({ 'x-forwarded-for': `8.8.8.8, ${BLOCKED}` })).toBe(403)
  })

  it('a cf-connecting-ip from a peer that is not Cloudflare is not believed', () => {
    expect(statusWith({ 'x-forwarded-for': '198.51.100.7', 'cf-connecting-ip': BLOCKED })).not.toBe(403)
    // Just outside 172.64.0.0/13, and with no peer at all.
    expect(statusWith({ 'x-forwarded-for': '172.72.0.1', 'cf-connecting-ip': BLOCKED })).not.toBe(403)
    expect(statusWith({ 'cf-connecting-ip': BLOCKED })).not.toBe(403)
  })

  it.each(CLOUDFLARE_RANGES)('believes cf-connecting-ip behind an edge in %s', (range) => {
    const net = range.split('/')[0]
    const edge = net.includes(':') ? `${net}1` : net.replace(/\.0$/, '.1')
    expect(statusWith({ 'x-forwarded-for': `${BLOCKED}, ${edge}`, 'cf-connecting-ip': BLOCKED })).toBe(403)
  })
})

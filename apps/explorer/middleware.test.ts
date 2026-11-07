import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { middleware } from './middleware'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'

function statusFor(ip: string, path = '/tx/0x' + 'ab'.repeat(32)): number {
  const req = new NextRequest(`https://ethscan.io${path}`, {
    headers: { 'cf-connecting-ip': ip, 'user-agent': UA },
  })
  return middleware(req).status
}

describe('markdown negotiation', () => {
  // A markdown answer at a page URL goes to /md/_negotiated/…, where the /md route marks it private. The
  // middleware cannot do that itself: Next replaces a middleware Cache-Control with the route's own.
  const TX = '/tx/0x' + 'ab'.repeat(32)
  const at = (path: string, accept: string) =>
    middleware(new NextRequest(`https://ethscan.io${path}`, { headers: { accept, 'user-agent': UA } }))
  const target = (res: Response) => {
    const to = res.headers.get('x-middleware-rewrite')
    return to === null ? null : new URL(to).pathname
  }

  it.each([
    [TX, `/md/_negotiated${TX}`],
    ['/blocks/1', '/md/_negotiated/blocks/1'],
    ['/block/1', '/md/_negotiated/block/1'],
    ['/about', '/md/_negotiated/about'],
    ['/', '/md/_negotiated'],
  ])('rewrites a markdown request for %s to %s', (path, to) => {
    expect(target(at(path, 'text/markdown'))).toBe(to)
  })

  it('leaves browsers on the page and direct /md URLs on the public route', () => {
    expect(target(at(TX, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'))).toBeNull()
    expect(target(at('/md' + TX, 'text/markdown'))).toBeNull()
  })
})

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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// getSetting reads the database; this suite is about which request headers name a country.
vi.mock('@/lib/settings', () => ({ getSetting: async () => null }))

import { GET } from '@/app/api/ads/binance-eligibility/route'

// The route once read five country headers with no check on who sent them, so any client could
// claim (or hide) a restricted country. Only cf-ipcountry from a Cloudflare edge counts now. The
// connecting peer is the LAST X-Forwarded-For hop (Render's LB appends it); behind Cloudflare that
// is a Cloudflare edge, here 172.64.0.5 (172.64.0.0/13). 203.0.113.9 is a documentation address.
const CF_EDGE = '172.64.0.5'
const NOT_CF = '203.0.113.9'

async function eligible(headers: Record<string, string>): Promise<boolean> {
  const res = await GET(new NextRequest('http://localhost/api/ads/binance-eligibility', { headers }))
  return (await res.json()).eligible
}

// eligible is `!restricted && refCode !== null`: with a code set it reads the country gate alone.
beforeEach(() => { vi.stubEnv('BINANCE_REF_CODE', 'TESTCODE') })
afterEach(() => { vi.unstubAllEnvs() })

describe('GET /api/ads/binance-eligibility country', () => {
  it('is eligible with no country at all', async () => {
    expect(await eligible({})).toBe(true)
  })

  it("honors a Cloudflare edge's cf-ipcountry: a restricted country is not eligible", async () => {
    expect(await eligible({ 'x-forwarded-for': `198.51.100.7, ${CF_EDGE}`, 'cf-ipcountry': 'US' })).toBe(false)
  })

  it("honors a Cloudflare edge's cf-ipcountry: an unrestricted country is eligible", async () => {
    expect(await eligible({ 'x-forwarded-for': `198.51.100.7, ${CF_EDGE}`, 'cf-ipcountry': 'DE' })).toBe(true)
  })

  it('ignores cf-ipcountry from a peer that is not a Cloudflare edge', async () => {
    expect(await eligible({ 'x-forwarded-for': NOT_CF, 'cf-ipcountry': 'US' })).toBe(true)
  })

  it('ignores cf-ipcountry when there is no peer address at all', async () => {
    expect(await eligible({ 'cf-ipcountry': 'US' })).toBe(true)
  })

  it('ignores a client-forged leading hop that claims to be Cloudflare: only the last hop is the peer', async () => {
    expect(await eligible({ 'x-forwarded-for': `${CF_EDGE}, ${NOT_CF}`, 'cf-ipcountry': 'US' })).toBe(true)
  })

  it.each(['x-vercel-ip-country', 'cloudfront-viewer-country', 'x-country-code', 'x-appengine-country'])(
    'ignores %s even from a Cloudflare edge',
    async (header) => {
      expect(await eligible({ 'x-forwarded-for': `198.51.100.7, ${CF_EDGE}`, [header]: 'US' })).toBe(true)
    },
  )

  it('varies on the one header it reads', async () => {
    const res = await GET(new NextRequest('http://localhost/api/ads/binance-eligibility'))
    expect(res.headers.get('vary')).toBe('CF-IPCountry')
  })
})

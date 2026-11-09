import { beforeEach, describe, expect, it, vi } from 'vitest'

// authRequest admits a client by its IP bucket BEFORE it looks any credential up: a flood of made-up keys used to cost
// one DB lookup each, and a client with several keys (a wallet mints one for free) had a full budget per key. The
// database, the limiter and the OAuth verifier are faked; nothing here reaches Redis or Postgres.
const h = vi.hoisted(() => ({
  keys: [] as string[],
  deny: new Set<string>(),
  dbLookups: 0,
  keyRow: null as null | { id: number; active: boolean; requestsPerMinute: number },
  service: false,
  bearer: null as null | 'invalid' | { sub: string },
}))

vi.mock('@/lib/api-rate-limit', () => ({
  checkRateLimit: async (key: string) => { h.keys.push(key); return ![...h.deny].some((d) => key.startsWith(d)) },
  checkIpRateLimit: async () => { h.keys.push('ip'); return !h.deny.has('ip') },
  clientIpBucket: () => '2001:db8:1:2::/64',
  clientIpFromHeaders: () => '2001:db8:1:2::9',
  isAltscanService: () => h.service,
}))
vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  const where = async () => { h.dbLookups++; return h.keyRow ? [h.keyRow] : [] }
  return { schema, db: { select: () => ({ from: () => ({ where }) }), update: () => ({ set: () => ({ where: () => ({ catch: () => {} }) }) }) } }
})
vi.mock('@/lib/oauth', () => ({ oauthConfig: () => ({}) }))
vi.mock('@altscan/oauth', () => ({ verifyBearer: async () => h.bearer, wwwAuthenticate: () => '' }))

const req = (headers: Record<string, string> = {}) => new Request('http://x/api/v1/stats', { headers })
const auth = async (headers?: Record<string, string>) => (await import('./api-auth')).authRequest(req(headers))

beforeEach(() => {
  h.keys = []; h.deny = new Set(); h.dbLookups = 0; h.keyRow = null; h.service = false; h.bearer = null
})

describe('authRequest: the per-IP ceiling comes first', () => {
  it.each([
    ['an API key', { 'x-api-key': 'bnbs_made_up' }],
    ['a bearer token', { authorization: 'Bearer abc' }],
    ['no credential', {}],
  ])('over the ceiling, %s is refused before any lookup', async (_label, headers) => {
    h.deny.add('ceiling:')
    h.bearer = { sub: '0xabc' }
    expect(await auth(headers)).toMatchObject({ ok: false, reason: 'rate_limit' })
    expect(h.dbLookups).toBe(0)
    expect(h.keys).toEqual(['ceiling:2001:db8:1:2::/64'])
  })

  it('a valid key is charged the ceiling, then its own bucket', async () => {
    h.keyRow = { id: 1, active: true, requestsPerMinute: 100 }
    expect(await auth({ 'x-api-key': 'bnbs_real' })).toEqual({ ok: true, limited: false })
    expect(h.keys[0]).toBe('ceiling:2001:db8:1:2::/64')
    expect(h.keys[1]).toMatch(/^key:/)
  })

  it('a bearer token is charged the ceiling, then its address', async () => {
    h.bearer = { sub: '0xabc' }
    expect(await auth({ authorization: 'Bearer good' })).toEqual({ ok: true, limited: false })
    expect(h.keys).toEqual(['ceiling:2001:db8:1:2::/64', 'sub:0xabc'])
  })

  it('the altscan.io service token skips the ceiling (it calls from a shared Worker address)', async () => {
    h.service = true
    h.deny.add('ceiling:')
    expect(await auth()).toEqual({ ok: true, limited: false })
    expect(h.keys).toEqual(['ip'])
  })
})

import crypto from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Two rate-limit gaps in /api/v1, pinned against the REAL limiter (explorer-core) with only
 * Redis faked (a counting stand-in for the shared client) or absent (the in-memory fallback):
 *
 *  1. GET /webhooks and DELETE /webhooks/:id had no limiter at all (only POST did).
 *  2. POST /verify (10/min) incremented the same Redis key `rl:<ip>` as every 100/min route,
 *     so 11 ordinary calls in a minute made the next verify 429. It now has `rl:verify:<ip>`.
 *
 * Every other route keeps `rl:<ip>` byte-for-byte, so live counters survive the deploy.
 *
 * A VALID X-API-Key is the third path: it counts into its own `rl:key:<hash16>` bucket at the
 * key's requestsPerMinute, never into the per-IP bucket (see the last two describes).
 */

const h = vi.hoisted(() => {
  const counters = new Map<string, number>()
  const fake = {
    // The limiter's one round trip: INCR + expiry in a Lua script. Only the counting matters here.
    async eval(_script: string, _numkeys: number, key: string) {
      const n = (counters.get(key) ?? 0) + 1
      counters.set(key, n)
      return n
    },
  }
  return { counters, fake, useRedis: false }
})
// ioredis itself is not resolvable from apps/explorer, so stand in for the shared client
// module the limiter imports. `useRedis: false` is exactly "REDIS_URL absent" -> memory.
vi.mock('../../../packages/explorer-core/src/redis-client', () => ({
  getRedis: () => (h.useRedis ? h.fake : null),
  isRedisUnavailable: () => false,
}))

const IP = '203.0.113.7'
const ORIGIN = 'https://x.test'
const OWNER = '0x1111111111111111111111111111111111111111'

beforeEach(() => { h.counters.clear() })
afterEach(() => { vi.resetModules() })

const VALID_KEY = 'bnbs_a_valid_key'
const VALID_KEY_BUCKET = `rl:key:${crypto.createHash('sha256').update(VALID_KEY).digest('hex').slice(0, 16)}`

async function load(backend: 'redis' | 'memory', opts: { keyRequestsPerMinute?: number } = {}) {
  vi.resetModules()
  h.useRedis = backend === 'redis'
  // No real DB. The API-key lookup (only reached when a request sends X-API-Key) finds no row,
  // i.e. every key is bogus, unless `keyRequestsPerMinute` is given: then the api_keys table has
  // one active key owned by OWNER with that budget (whatever key is presented matches it; the
  // tests use VALID_KEY and assert the bucket name is its hash). Other tables are empty.
  // The verifier and chain config are not reached on the paths under test.
  const apiKeys = { id: 'id', active: 'active', requestsPerMinute: 'rpm', keyHash: 'key_hash', ownerAddress: 'owner', totalRequests: 'total' }
  const keyRows = opts.keyRequestsPerMinute === undefined ? []
    : [{ id: 7, active: true, requestsPerMinute: opts.keyRequestsPerMinute, ownerAddress: OWNER }]
  vi.doMock('@/lib/db', () => ({
    db: {
      select: () => ({ from: (table: unknown) => ({ where: async () => (table === apiKeys ? keyRows : []) }) }),
      update: () => ({ set: () => ({ where: async () => undefined }) }), // usage tracking
      delete: () => ({ where: () => ({ returning: async () => [{ id: 5 }] }) }),
    },
    schema: { apiKeys, webhooks: { id: 'id', ownerAddress: 'owner' } },
  }))
  vi.doMock('@/lib/chain', () => ({ chainConfig: { domain: 'x.test' } }))
  vi.doMock('@/lib/verifier', () => ({
    triggerSourcifyVerification: vi.fn(async () => ({ success: false, error: 'not verified' })),
  }))
  const { checkIpRateLimit } = await import('@/lib/api-rate-limit')
  const webhooks = await import('@/app/api/v1/webhooks/route')
  const webhook = await import('@/app/api/v1/webhooks/[id]/route')
  const verify = await import('@/app/api/v1/verify/route')

  const xff = { 'x-forwarded-for': IP }
  return {
    /** What every ordinary route does: the shared 100/min per-IP bucket. */
    ordinaryHit: () => checkIpRateLimit(new Headers(xff)),
    exhaustOrdinary: async () => { for (let i = 0; i < 100; i++) await checkIpRateLimit(new Headers(xff)) },
    listWebhooks: (init: Record<string, string> = {}) =>
      webhooks.GET(new Request(`${ORIGIN}/api/v1/webhooks`, { headers: { ...xff, ...init } })),
    /** GET/DELETE as the owner of VALID_KEY: past the limiter these reach the (mocked) DB and succeed. */
    listWebhooksAsKey: () =>
      webhooks.GET(new Request(`${ORIGIN}/api/v1/webhooks?owner=${OWNER}`, { headers: { ...xff, 'x-api-key': VALID_KEY } })),
    deleteWebhookAsKey: () =>
      webhook.DELETE(
        new Request(`${ORIGIN}/api/v1/webhooks/5?ownerAddress=${OWNER}`, { method: 'DELETE', headers: { ...xff, 'x-api-key': VALID_KEY } }),
        { params: Promise.resolve({ id: '5' }) },
      ),
    createWebhook: () =>
      webhooks.POST(new Request(`${ORIGIN}/api/v1/webhooks`, { method: 'POST', headers: xff, body: '{}' })),
    deleteWebhook: () =>
      webhook.DELETE(
        new Request(`${ORIGIN}/api/v1/webhooks/abc`, { method: 'DELETE', headers: xff }),
        { params: Promise.resolve({ id: 'abc' }) },
      ),
    verify: () =>
      verify.POST(new Request(`${ORIGIN}/api/v1/verify`, {
        method: 'POST',
        headers: { ...xff, origin: ORIGIN },
        body: JSON.stringify({ address: OWNER }),
      })),
  }
}

describe.each(['redis', 'memory'] as const)('webhooks GET / DELETE are rate-limited (%s)', (backend) => {
  it('GET answers 429 with the same body POST uses once the IP is over its budget', async () => {
    const api = await load(backend)
    await api.exhaustOrdinary()
    const res = await api.listWebhooks()
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'Rate limit exceeded' })
    // POST is untouched and answers identically.
    const post = await api.createWebhook()
    expect(post.status).toBe(429)
    expect(await post.json()).toEqual({ error: 'Rate limit exceeded' })
  })

  it('DELETE answers 429 with the same body once the IP is over its budget', async () => {
    const api = await load(backend)
    await api.exhaustOrdinary()
    const res = await api.deleteWebhook()
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'Rate limit exceeded' })
  })

  it('under budget both fall through to their own validation (no DB needed to see it)', async () => {
    const api = await load(backend)
    expect((await api.listWebhooks()).status).toBe(400) // missing owner
    expect((await api.deleteWebhook()).status).toBe(400) // id "abc"
  })
})

describe.each(['redis', 'memory'] as const)('a bogus X-API-Key does not skip the IP limit (%s)', (backend) => {
  const bogus = { 'x-api-key': 'bnbs_not_a_real_key' }

  it('is 401 while under budget, then 429 on the 101st attempt from one IP', async () => {
    const api = await load(backend)
    for (let i = 0; i < 100; i++) {
      const res = await api.listWebhooks(bogus)
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Invalid or inactive API key' })
    }
    const res = await api.listWebhooks(bogus)
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'Rate limit exceeded' })
  })

  it('draws on the same per-IP budget as key-less requests', async () => {
    const api = await load(backend)
    await api.exhaustOrdinary()
    expect((await api.listWebhooks(bogus)).status).toBe(429)
  })
})

describe('Redis key format (what live counters depend on)', () => {
  it('a bogus X-API-Key increments rl:<ip> (and nothing else)', async () => {
    const api = await load('redis')
    expect((await api.listWebhooks({ 'x-api-key': 'bnbs_not_a_real_key' })).status).toBe(401)
    expect([...h.counters]).toEqual([[`rl:${IP}`, 1]])
  })

  it('webhooks GET/DELETE count into the shared per-IP key, exactly like POST', async () => {
    const api = await load('redis')
    await api.listWebhooks()
    await api.deleteWebhook()
    expect([...h.counters]).toEqual([[`rl:${IP}`, 2]])
  })

  it('ordinary routes keep rl:<ip>; verify uses rl:verify:<ip> and touches nothing else', async () => {
    const api = await load('redis')
    for (let i = 0; i < 3; i++) await api.ordinaryHit()
    for (let i = 0; i < 2; i++) await api.verify()
    expect(Object.fromEntries(h.counters)).toEqual({ [`rl:${IP}`]: 3, [`rl:verify:${IP}`]: 2 })
  })
})

describe.each(['redis', 'memory'] as const)('verify budget is independent of the 100/min budget (%s)', (backend) => {
  it('is still allowed after the ordinary budget is fully spent', async () => {
    const api = await load(backend)
    await api.exhaustOrdinary()
    expect(await api.ordinaryHit()).toBe(false) // ordinary budget really is gone
    const res = await api.verify()
    expect(res.status).toBe(422) // got past the limiter and Origin check to the (mocked) verifier
  })

  it('11 ordinary calls no longer 429 the next verify (the original bug)', async () => {
    const api = await load(backend)
    for (let i = 0; i < 11; i++) expect(await api.ordinaryHit()).toBe(true)
    expect((await api.verify()).status).toBe(422)
  })

  it('verify still 429s on its own 11th call in the window, with the same body as before', async () => {
    const api = await load(backend)
    for (let i = 0; i < 10; i++) expect((await api.verify()).status).toBe(422)
    const res = await api.verify()
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'Rate limit exceeded' })
  })

  it('a spent verify budget does not touch the ordinary budget', async () => {
    const api = await load(backend)
    for (let i = 0; i < 11; i++) await api.verify()
    expect(await api.ordinaryHit()).toBe(true)
    expect((await api.listWebhooks()).status).toBe(400) // not 429
  })
})

describe.each(['redis', 'memory'] as const)('a valid X-API-Key is limited by its own budget, not the IP (%s)', (backend) => {
  it.each(['listWebhooksAsKey', 'deleteWebhookAsKey'] as const)('%s: 429 once the key exceeds its requestsPerMinute', async (call) => {
    const api = await load(backend, { keyRequestsPerMinute: 3 })
    for (let i = 0; i < 3; i++) expect((await api[call]()).status).toBe(200)
    const res = await api[call]()
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'Rate limit exceeded' })
  })

  it('a spent key budget does not touch the IP budget', async () => {
    const api = await load(backend, { keyRequestsPerMinute: 3 })
    for (let i = 0; i < 4; i++) await api.listWebhooksAsKey() // key now spent
    expect((await api.listWebhooks()).status).toBe(400) // key-less from the same IP: not 429
  })

  it('a spent IP budget does not touch a valid key', async () => {
    const api = await load(backend, { keyRequestsPerMinute: 3 })
    await api.exhaustOrdinary()
    expect((await api.listWebhooks()).status).toBe(429) // the IP really is spent
    expect((await api.listWebhooksAsKey()).status).toBe(200)
    expect((await api.deleteWebhookAsKey()).status).toBe(200)
  })
})

describe('Redis key format for a valid X-API-Key', () => {
  it.each(['listWebhooksAsKey', 'deleteWebhookAsKey'] as const)('%s counts into rl:key:<hash16> and NOT rl:<ip>', async (call) => {
    const api = await load('redis', { keyRequestsPerMinute: 100 })
    expect((await api[call]()).status).toBe(200)
    expect((await api[call]()).status).toBe(200)
    expect([...h.counters]).toEqual([[VALID_KEY_BUCKET, 2]])
  })
})

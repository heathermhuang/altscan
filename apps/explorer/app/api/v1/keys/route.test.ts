import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/v1/keys is proven by a wallet signature, not a key, so it is admitted by IP alone: it used to run
// authRequest, which charged whatever X-API-Key the caller sent, someone else's included. And minting has an hourly
// bucket: on 2026-10-22, 69 fresh wallets minted 69 keys within one hour on each chain.
const h = vi.hoisted(() => ({ calls: [] as Array<{ key: string; max?: number; windowMs?: number }>, deny: new Set<string>(), authCalls: 0 }))

vi.mock('@/lib/api-rate-limit', () => ({
  checkRateLimit: async (key: string, max?: number, windowMs?: number) => {
    h.calls.push({ key, max, windowMs })
    return ![...h.deny].some((d) => key.startsWith(d))
  },
  checkIpRateLimit: async () => { h.calls.push({ key: 'ip' }); return !h.deny.has('ip') },
  clientIpBucket: () => '203.0.113.9',
}))
vi.mock('@/lib/api-auth', () => ({
  authRequest: async () => { h.authCalls++; return { ok: true, limited: false } },
  authFailure: () => new Response(null, { status: 429 }),
  requireApiKeyOwner: async () => ({ ok: true }),
}))
vi.mock('@/lib/db', () => ({ db: {}, schema: {} }))
vi.mock('@/lib/api-key-mint', () => ({ mintApiKey: async () => ({ ok: true }) }))

const mint = async () => {
  const { POST } = await import('./route')
  return POST(new Request('http://x/api/v1/keys', {
    method: 'POST',
    headers: { 'x-api-key': 'bnbs_someone_elses_key' },
    body: JSON.stringify({ ownerAddress: '0x' + 'a'.repeat(40) }),   // no signature: refused after admission
  }))
}

beforeEach(() => { h.calls = []; h.deny = new Set(); h.authCalls = 0 })

describe('POST /api/v1/keys admission', () => {
  it('never runs authRequest, so the X-API-Key it carries is not charged', async () => {
    expect((await mint()).status).toBe(400)
    expect(h.authCalls).toBe(0)
    expect(h.calls.map((c) => c.key)).toEqual(['ip', 'mint:203.0.113.9'])
  })

  it('charges an hourly mint bucket of 5 per client', async () => {
    await mint()
    expect(h.calls[1]).toEqual({ key: 'mint:203.0.113.9', max: 5, windowMs: 60 * 60 * 1000 })
  })

  it.each(['ip', 'mint:'])('refuses with 429 when the %s bucket is spent, before checking the signature', async (bucket) => {
    h.deny.add(bucket)
    expect((await mint()).status).toBe(429)
  })
})

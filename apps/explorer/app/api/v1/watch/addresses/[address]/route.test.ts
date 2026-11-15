import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ chain: 'bnb', auth: 0 }))

vi.mock('@/lib/chain', () => ({ chainConfig: { get key() { return h.chain } } }))
vi.mock('@/lib/api-auth', () => ({
  authRequest: async () => { h.auth++; return { ok: true, limited: false } },
  authFailure: () => new Response(null, { status: 429 }),
  requireApiKeyOwner: async () => ({ ok: true }),
}))
vi.mock('@/lib/db', () => ({ db: {}, schema: {} }))

const OWNER = '0x' + 'a'.repeat(40)

beforeEach(() => { h.chain = 'bnb'; h.auth = 0 })

describe('DELETE /api/v1/watch/addresses/[address]', () => {
  it('answers 404 on a non-BNB chain before any auth', async () => {
    h.chain = 'eth'
    const { DELETE } = await import('./route')
    const res = await DELETE(
      new Request(`http://x/api/v1/watch/addresses/${OWNER}?owner=${OWNER}`, { method: 'DELETE' }),
      { params: Promise.resolve({ address: OWNER }) },
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Wallet watch is available on BNBScan only' })
    expect(h.auth).toBe(0)
  })
})

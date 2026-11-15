import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  chain: 'bnb',
  auth: 0,
  ownerOk: true,
  add: vi.fn(),
  list: vi.fn(),
}))

vi.mock('@/lib/chain', () => ({ chainConfig: { get key() { return h.chain } } }))
vi.mock('@/lib/api-auth', () => ({
  authRequest: async () => { h.auth++; return { ok: true, limited: false } },
  authFailure: () => new Response(null, { status: 429 }),
  requireApiKeyOwner: async () => (h.ownerOk ? { ok: true } : { ok: false, status: 403, error: 'API key does not belong to this owner address' }),
}))
vi.mock('@/lib/db', () => ({ db: {}, schema: {} }))
vi.mock('@/lib/watch-addresses', async (orig) => ({
  ...(await orig<typeof import('@/lib/watch-addresses')>()),
  addWatchAddresses: h.add,
  listWatchAddresses: h.list,
}))

const OWNER = '0x' + 'a'.repeat(40)
const post = async (body: unknown) => {
  const { POST } = await import('./route')
  return POST(new Request('http://x/api/v1/watch/addresses', { method: 'POST', body: JSON.stringify(body) }))
}

beforeEach(() => {
  h.chain = 'bnb'
  h.auth = 0
  h.ownerOk = true
  h.add.mockReset().mockResolvedValue({ ok: true, added: 1, total: 1 })
  h.list.mockReset().mockResolvedValue([])
})

describe('POST /api/v1/watch/addresses', () => {
  it('answers 404 on a non-BNB chain before any auth or body handling', async () => {
    h.chain = 'eth'
    const res = await post({ owner: OWNER, addresses: ['0x' + 'b'.repeat(40)] })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Wallet watch is available on BNBScan only' })
    expect(h.auth).toBe(0)
    expect(h.add).not.toHaveBeenCalled()
  })

  it.each(['null', '[]', '5', '"x"'])('refuses the JSON body %s with 400', async (raw) => {
    const { POST } = await import('./route')
    const res = await POST(new Request('http://x/api/v1/watch/addresses', { method: 'POST', body: raw }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid JSON body' })
  })

  it('adds and reports the totals', async () => {
    const res = await post({ owner: OWNER, addresses: ['0x' + 'b'.repeat(40)] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ added: 1, total: 1 })
    expect(h.add).toHaveBeenCalledWith({}, OWNER, ['0x' + 'b'.repeat(40)], null)
  })

  it('names the invalid addresses and adds nothing', async () => {
    const res = await post({ owner: OWNER, addresses: ['0x12'] })
    expect(res.status).toBe(400)
    expect((await res.json()).invalid).toEqual(['0x12'])
    expect(h.add).not.toHaveBeenCalled()
  })

  it('refuses more addresses than the cap before touching the database', async () => {
    const many = Array.from({ length: 51 }, (_, i) => '0x' + i.toString(16).padStart(40, '0'))
    expect((await post({ owner: OWNER, addresses: many })).status).toBe(400)
    expect(h.add).not.toHaveBeenCalled()
  })

  it('refuses a label over 64 characters', async () => {
    expect((await post({ owner: OWNER, addresses: ['0x' + 'b'.repeat(40)], label: 'x'.repeat(65) })).status).toBe(400)
  })

  it('passes through the owner check', async () => {
    h.ownerOk = false
    expect((await post({ owner: OWNER, addresses: ['0x' + 'b'.repeat(40)] })).status).toBe(403)
    expect(h.add).not.toHaveBeenCalled()
  })

  it('answers 503 while the table does not exist', async () => {
    h.add.mockRejectedValue({ message: 'Failed query', cause: { code: '42P01' } })
    expect((await post({ owner: OWNER, addresses: ['0x' + 'b'.repeat(40)] })).status).toBe(503)
  })
})

describe('GET /api/v1/watch/addresses', () => {
  it('answers 404 on a non-BNB chain before any auth', async () => {
    h.chain = 'eth'
    const { GET } = await import('./route')
    expect((await GET(new Request(`http://x/api/v1/watch/addresses?owner=${OWNER}`))).status).toBe(404)
    expect(h.auth).toBe(0)
    expect(h.list).not.toHaveBeenCalled()
  })

  it('lists the owner\'s addresses', async () => {
    h.list.mockResolvedValue([{ address: '0x' + 'b'.repeat(40), label: null, createdAt: new Date(0) }])
    const { GET } = await import('./route')
    const res = await GET(new Request(`http://x/api/v1/watch/addresses?owner=${OWNER}`))
    expect(res.status).toBe(200)
    expect((await res.json()).addresses).toHaveLength(1)
  })

  it('refuses a malformed owner', async () => {
    const { GET } = await import('./route')
    expect((await GET(new Request('http://x/api/v1/watch/addresses?owner=0x1'))).status).toBe(400)
  })
})

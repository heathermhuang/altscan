/**
 * POST /api/v1/webhooks: which event types a registration stores. The indexer only ever delivers 'tx'
 * (a webhook whose eventTypes lacks it is skipped), so a registration asking for nothing else used to
 * succeed, count against the owner's cap, and never fire. The database is faked; nothing here reaches it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// selects: what each tx.select returns, in order (the owner's webhooks, then every active webhook's url).
const h = vi.hoisted(() => ({ inserted: [] as Array<{ eventTypes: string[] }>, selects: [] as unknown[][], locks: [] as string[] }))

vi.mock('@/lib/api-auth', () => ({
  authRequest: async () => ({ ok: true, limited: false }),
  authFailure: () => new Response(null, { status: 429 }),
  requireApiKeyOwner: async () => ({ ok: true }),
}))
vi.mock('@/lib/webhook-insert', () => ({
  insertWebhookSql: (row: { eventTypes: string[] }) => { h.inserted.push(row); return 'insert' },
}))
vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  const tx = {
    execute: async (q: unknown) => {
      if (q === 'insert') return [{ id: 7 }]
      h.locks.push(JSON.stringify(q))
      return []
    },
    select: () => ({ from: () => ({ where: async () => h.selects.shift() ?? [] }) }),
  }
  return { schema, db: { transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx) } }
})

const OWNER = '0x' + 'a'.repeat(40)
const post = async (eventTypes?: unknown, url = 'https://hooks.example.com/x') => {
  const { POST } = await import('@/app/api/v1/webhooks/route')
  return POST(new Request('http://x/api/v1/webhooks', {
    method: 'POST',
    body: JSON.stringify({ ownerAddress: OWNER, url, ...(eventTypes === undefined ? {} : { eventTypes }) }),
  }))
}

describe('POST /api/v1/webhooks eventTypes', () => {
  beforeEach(() => { h.inserted.length = 0; h.selects.length = 0; h.locks.length = 0 })

  it('defaults to tx and echoes it', async () => {
    const res = await post()
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ id: 7, eventTypes: ['tx'], ignoredEventTypes: [] })
    expect(h.inserted[0].eventTypes).toEqual(['tx'])
  })

  it.each([['token_transfer'], ['new_block'], ['token_transfer', 'new_block'], ['nonsense'], []])(
    'refuses a list without tx (%j): nothing would ever be delivered',
    async (...types) => {
      const res = await post(types)
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/only 'tx' events are delivered/)
      expect(h.inserted).toEqual([])
    },
  )

  // Older clients send ['tx', 'token_transfer']; rejecting that would break them for no gain.
  it('accepts a mixed list, stores only tx, and reports what it ignored', async () => {
    const res = await post(['tx', 'token_transfer', 'new_block'])
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ eventTypes: ['tx'], ignoredEventTypes: ['token_transfer', 'new_block'] })
    expect(h.inserted[0].eventTypes).toEqual(['tx'])
  })

  it('refuses an eventTypes that is not an array instead of throwing', async () => {
    const res = await post('tx')
    expect(res.status).toBe(400)
    expect(h.inserted).toEqual([])
  })
})

// The per-owner caps bound one wallet, and wallets are free: on 2026-10-22, 69 fresh wallets each registered one webhook,
// within an hour, on both chains, all aimed at one host. So active webhooks are capped in total and per URL host.
describe('POST /api/v1/webhooks caps across owners', () => {
  beforeEach(() => { h.inserted.length = 0; h.selects.length = 0; h.locks.length = 0 })
  const active = (n: number, url = (i: number) => `https://h${i}.example.org/hook`) => Array.from({ length: n }, (_, i) => ({ url: url(i) }))

  it('refuses a registration once 100 webhooks are active, whoever owns them', async () => {
    h.selects.push([], active(100))
    const res = await post(undefined)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/registrations are full/)
    expect(h.inserted).toEqual([])
  })

  it('refuses a sixth active webhook on the same host, by hostname and ignoring case', async () => {
    h.selects.push([], [...active(5, (i) => `https://Sink.Example.CN/r/${i}`), ...active(3)])
    const res = await post(undefined, 'https://sink.example.cn/another')
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Maximum 5 active webhooks per URL host/)
    expect(h.inserted).toEqual([])
  })

  it('accepts below both caps, and takes the global lock after the owner lock', async () => {
    h.selects.push([], [...active(4, () => 'https://sink.example.cn/r'), ...active(90)])
    expect((await post(undefined, 'https://sink.example.cn/x')).status).toBe(201)
    expect(h.locks).toHaveLength(2)
    expect(h.locks[1]).toContain('webhooks:global')
  })
})

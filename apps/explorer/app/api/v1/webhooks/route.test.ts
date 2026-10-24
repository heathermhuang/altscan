/**
 * POST /api/v1/webhooks: which event types a registration stores. The indexer only ever delivers 'tx'
 * (a webhook whose eventTypes lacks it is skipped), so a registration asking for nothing else used to
 * succeed, count against the owner's cap, and never fire. The database is faked; nothing here reaches it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ inserted: [] as Array<{ eventTypes: string[] }> }))

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
    execute: async (q: unknown) => (q === 'insert' ? [{ id: 7 }] : []),
    select: () => ({ from: () => ({ where: async () => [] }) }),
  }
  return { schema, db: { transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx) } }
})

const OWNER = '0x' + 'a'.repeat(40)
const post = async (eventTypes?: unknown) => {
  const { POST } = await import('@/app/api/v1/webhooks/route')
  return POST(new Request('http://x/api/v1/webhooks', {
    method: 'POST',
    body: JSON.stringify({ ownerAddress: OWNER, url: 'https://hooks.example.com/x', ...(eventTypes === undefined ? {} : { eventTypes }) }),
  }))
}

describe('POST /api/v1/webhooks eventTypes', () => {
  beforeEach(() => { h.inserted.length = 0 })

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

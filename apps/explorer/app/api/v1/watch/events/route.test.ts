import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeCursor } from '@/lib/watch-cursor'

const h = vi.hoisted(() => ({ read: vi.fn() }))

vi.mock('@/lib/api-auth', () => ({
  authRequest: async () => ({ ok: true, limited: false }),
  authFailure: () => new Response(null, { status: 429 }),
  requireApiKeyOwner: async () => ({ ok: true }),
}))
vi.mock('@/lib/db', () => ({ db: {}, schema: {} }))
vi.mock('@/lib/watch-events', () => ({ readWatchEvents: h.read }))

const OWNER = '0x' + 'a'.repeat(40)
const CURSOR = encodeCursor({ b: 10, h: '0x' + 'ab'.repeat(32), k: 2, i: 0, w: '' })
const get = async (qs: string) => {
  const { GET } = await import('./route')
  return GET(new Request(`http://x/api/v1/watch/events?${qs}`))
}
const BODY = { events: [], cursor: CURSOR, tip: 10, oldestAvailableBlock: 1, rewound: false }

beforeEach(() => { h.read.mockReset().mockResolvedValue({ status: 'ok', body: BODY }) })

describe('GET /api/v1/watch/events', () => {
  it('returns the page and passes the decoded cursor and limit', async () => {
    const res = await get(`owner=${OWNER}&cursor=${CURSOR}&limit=50`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(BODY)
    expect(h.read).toHaveBeenCalledWith({}, OWNER, expect.objectContaining({ b: 10 }), 50)
  })

  it('defaults to no cursor and a limit of 100', async () => {
    await get(`owner=${OWNER}`)
    expect(h.read).toHaveBeenCalledWith({}, OWNER, null, 100)
  })

  it.each(['limit=0', 'limit=501', 'limit=abc', 'cursor=nope'])('refuses %s with 400', async (qs) => {
    expect((await get(`owner=${OWNER}&${qs}`)).status).toBe(400)
    expect(h.read).not.toHaveBeenCalled()
  })

  it('answers 410 with the oldest available block', async () => {
    h.read.mockResolvedValue({ status: 'gone', oldestAvailableBlock: 99 })
    const res = await get(`owner=${OWNER}&cursor=${CURSOR}`)
    expect(res.status).toBe(410)
    expect((await res.json()).oldestAvailableBlock).toBe(99)
  })

  it.each([
    ['no durable block yet', () => h.read.mockResolvedValue({ status: 'not_ready' })],
    ['no table yet', () => h.read.mockRejectedValue({ cause: { code: '42P01' } })],
  ])('answers 503 when there is %s', async (_, arrange) => {
    arrange()
    expect((await get(`owner=${OWNER}`)).status).toBe(503)
  })

  it('logs a hashed owner, never the address', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await get(`owner=${OWNER}`)
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[watch]'))
    expect(line).toMatch(/^\[watch\] owner=[0-9a-f]{8}$/)
    expect(line).not.toContain(OWNER.slice(2, 10))
    log.mockRestore()
  })
})

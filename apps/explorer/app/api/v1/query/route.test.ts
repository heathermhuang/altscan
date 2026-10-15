/**
 * POST /api/v1/query: the offset bound. An unbounded OFFSET is an anonymous, rate-limit-sized way to make
 * Postgres walk an index to the statement timeout; the route must refuse it before touching the database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ selects: 0 }))

vi.mock('@/lib/api-auth', () => ({ authRequest: async () => ({ ok: true, limited: false }) }))
vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  return {
    schema,
    db: {
      select: () => {
        h.selects++
        throw new Error('db reached')
      },
    },
  }
})

const post = async (body: unknown) => {
  const { POST } = await import('@/app/api/v1/query/route')
  return POST(new Request('http://x/api/v1/query', { method: 'POST', body: JSON.stringify(body) }))
}

describe('POST /api/v1/query offset bound', () => {
  beforeEach(() => { h.selects = 0 })

  it('refuses an offset past the cap without querying', async () => {
    const res = await post({ entity: 'transactions', offset: 10_001 })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/offset/)
    expect(h.selects).toBe(0)
  })

  it('still serves an offset at the cap', async () => {
    const res = await post({ entity: 'blocks', offset: 10_000 })
    expect(res.status).not.toBe(400)
    expect(h.selects).toBe(1)
  })
})

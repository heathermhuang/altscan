/**
 * DELETE /api/v1/keys/:id: revoking an API key. Nothing used to write api_keys.active = false, so a
 * leaked key could not be retired. The update must be scoped to the owner the requesting key was
 * proven to belong to, and a key of another owner must not be reachable by id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

const OWNER = '0x' + 'a'.repeat(40)
const OTHER = '0x' + 'b'.repeat(40)

const h = vi.hoisted(() => ({
  authOk: true,
  ownerAuth: { ok: true } as { ok: true } | { ok: false; status: number; error: string },
  ownerChecks: [] as string[],
  sets: [] as unknown[],
  wheres: [] as unknown[],
  returned: [{ id: 7 }] as { id: number }[],
}))

vi.mock('@/lib/api-auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-auth')>()),
  authRequest: async () => (h.authOk ? { ok: true, limited: false } : { ok: false, limited: true, reason: 'rate_limit' }),
  requireApiKeyOwner: async (_req: Request, owner: string) => { h.ownerChecks.push(owner); return h.ownerAuth },
}))
vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  return {
    schema,
    db: {
      update: () => ({
        set: (values: unknown) => {
          h.sets.push(values)
          return { where: (cond: unknown) => { h.wheres.push(cond); return { returning: async () => h.returned } } }
        },
      }),
    },
  }
})

const del = async (id: string, query: string = `?owner=${OWNER}`) => {
  const { DELETE } = await import('@/app/api/v1/keys/[id]/route')
  return DELETE(new Request(`http://x/api/v1/keys/${id}${query}`, { method: 'DELETE', headers: { 'x-api-key': 'bnbs_k' } }), {
    params: Promise.resolve({ id }),
  })
}
const sqlOf = (cond: unknown) => new PgDialect().sqlToQuery(cond as SQL)

beforeEach(() => {
  h.authOk = true
  h.ownerAuth = { ok: true }
  h.ownerChecks = []
  h.sets = []
  h.wheres = []
  h.returned = [{ id: 7 }]
})

describe('DELETE /api/v1/keys/:id', () => {
  it('deactivates the key, scoped to its id AND the owner the requesting key belongs to', async () => {
    const res = await del('7', `?owner=${OWNER.toUpperCase().replace('0X', '0x')}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ revoked: 7 })
    expect(h.sets).toEqual([{ active: false }])
    // The owner is checked, and updated on, in lowercase: api_keys.owner_address is stored lowercase.
    expect(h.ownerChecks).toEqual([OWNER])
    expect(h.wheres).toHaveLength(1)
    const { sql, params } = sqlOf(h.wheres[0])
    expect(sql).toMatch(/"id" = \$1/)
    expect(sql).toMatch(/"owner_address" = \$2/)
    expect(params).toEqual([7, OWNER])
  })

  it('answers 404 when no row matched: another owner\'s key id, or none', async () => {
    h.returned = []
    const res = await del('7')
    expect(res.status).toBe(404)
    expect(sqlOf(h.wheres[0]).params).toEqual([7, OWNER])
  })

  it('answers 403 and updates nothing when the requesting key belongs to a different owner than the one named', async () => {
    h.ownerAuth = { ok: false, status: 403, error: 'API key does not belong to this owner address' }
    const res = await del('7', `?owner=${OTHER}`)
    expect(res.status).toBe(403)
    expect(h.ownerChecks).toEqual([OTHER])
    expect(h.wheres).toEqual([])
  })

  it('answers 401 and updates nothing without a valid key', async () => {
    h.ownerAuth = { ok: false, status: 401, error: 'X-API-Key header required for this operation' }
    const res = await del('7')
    expect(res.status).toBe(401)
    expect(h.wheres).toEqual([])
  })

  it('answers with the rate-limit or key failure before reading anything else', async () => {
    h.authOk = false
    const res = await del('7')
    expect(res.status).toBe(429)
    expect(h.ownerChecks).toEqual([])
    expect(h.wheres).toEqual([])
  })

  it.each(['abc', '12abc', '-1', '1.5', '', '2147483648', '99999999999999999999'])('refuses id %j with 400', async (id) => {
    const res = await del(id)
    expect(res.status).toBe(400)
    expect(h.ownerChecks).toEqual([])
    expect(h.wheres).toEqual([])
  })

  it.each(['', '?owner=', '?owner=0x123', `?ownerAddress=${OWNER}`])('refuses owner query %j with 400', async (query) => {
    const res = await del('7', query)
    expect(res.status).toBe(400)
    expect(h.ownerChecks).toEqual([])
    expect(h.wheres).toEqual([])
  })
})

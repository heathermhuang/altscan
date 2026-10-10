/**
 * GET /api/search/suggest?q= : the header search box's token typeahead. Real route, real limiter
 * (the in-memory fallback); the database and Redis are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DrizzleQueryError } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[] | Error | 'hang',
  queries: [] as unknown[],
}))
vi.mock('../../../../../../packages/explorer-core/src/redis-client', () => ({
  getRedis: () => null,
  isRedisUnavailable: () => false,
}))

const addr = (i: number) => `0x${i.toString(16).padStart(40, '0')}`
const row = (i: number, symbol: string, name: string, holderCount: number) => ({ address: addr(i), symbol, name, holderCount })

async function load() {
  vi.resetModules()
  vi.doMock('@/lib/db', async () => {
    const { schema } = await import('@altscan/db')
    return {
      schema,
      db: {
        // The route's DB path is a transaction (SET LOCAL statement_timeout, then the query); both go through tx.execute.
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb({
          execute: (q: unknown) => {
            h.queries.push(new PgDialect().sqlToQuery(q as Parameters<PgDialect['sqlToQuery']>[0]).sql.replace(/\s+/g, ' ').trim())
            if (h.queries.length === 1) return Promise.resolve([]) // the SET LOCAL
            if (h.rows === 'hang') return new Promise(() => {})
            return h.rows instanceof Error ? Promise.reject(h.rows) : Promise.resolve(h.rows.map((r) => ({ ...r, holder_count: r.holderCount })))
          },
        }),
      },
    }
  })
  return import('@/app/api/search/suggest/route')
}

const get = (route: { GET: (r: Request) => Promise<Response> }, qs: string, ip = '203.0.113.7') =>
  route.GET(new Request(`https://x.test/api/search/suggest${qs}`, { headers: { 'x-forwarded-for': ip } }))

beforeEach(() => { h.rows = []; h.queries.length = 0; vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { vi.useRealTimers(); vi.resetModules(); vi.doUnmock('@/lib/db') })

describe('GET /api/search/suggest', () => {
  it('is dynamic: an API route may be force-dynamic, a page may not', async () => {
    expect((await load()).dynamic).toBe('force-dynamic')
  })

  it('answers with the top tokens, JSON-safe, cacheable for 30 s', async () => {
    h.rows = [row(1, 'CAKE', 'PancakeSwap Token', 900_000), row(2, 'CAKEX', 'Cakex', 10)]
    const res = await get(await load(), '?q=Cak')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=30')
    expect(await res.json()).toEqual({
      tokens: [
        { address: addr(1), symbol: 'CAKE', name: 'PancakeSwap Token', holders: 900_000, lookalikeOf: null },
        { address: addr(2), symbol: 'CAKEX', name: 'Cakex', holders: 10, lookalikeOf: null },
      ],
    })
  })

  it('lists lookalikes after real tokens and names what they imitate', async () => {
    h.rows = [row(1, 'USDT', 'Tether USD', 9_000_000), row(2, 'USDX', 'Usdx', 5)]
    const body = await (await get(await load(), '?q=usd')).json() as { tokens: { symbol: string; lookalikeOf: string | null }[] }
    expect(body.tokens.map((t) => [t.symbol, t.lookalikeOf])).toEqual([['USDX', null], ['USDT', 'USDT']])
  })

  it.each(['', '?q=', '?q=a', '?q=%20a%20', `?q=${'a'.repeat(51)}`, '?q=us%00dt'])(
    'an unusable query (%s) is an empty list and never reaches the database', async (qs) => {
      const res = await get(await load(), qs)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ tokens: [] })
      expect(h.queries).toEqual([])
    })

  it('429s past 100 requests a minute per client, in a bucket of its own', async () => {
    const route = await load()
    const statuses: number[] = []
    for (let i = 0; i < 101; i++) statuses.push((await get(route, '?q=ab', '198.51.100.9')).status)
    expect(statuses.slice(0, 100).every((s) => s === 200)).toBe(true)
    expect(statuses[100]).toBe(429)
    // Another client, and the shared /api/v1 bucket (checkIpRateLimit), are untouched.
    expect((await get(route, '?q=ab', '198.51.100.10')).status).toBe(200)
    const { checkIpRateLimit } = await import('@/lib/api-rate-limit')
    expect(await checkIpRateLimit(new Headers({ 'x-forwarded-for': '198.51.100.9' }))).toBe(true)
  })

  it('has the SERVER cancel a slow query: SET LOCAL statement_timeout, in the same transaction, before the query', async () => {
    h.rows = [row(1, 'CAKE', 'PancakeSwap Token', 9)]
    await get(await load(), '?q=ca')
    expect(h.queries).toHaveLength(2)
    expect(h.queries[0]).toBe("SET LOCAL statement_timeout = '1500ms'")
    expect(h.queries[1]).toMatch(/^SELECT address, symbol, name, holder_count FROM/)
  })

  // What drizzle >= 0.44 throws when Postgres cancels the statement: a wrapper, the reason and SQLSTATE on .cause.
  it('a statement the server cancelled (57014) is the same 503, not cached, logged with the database\'s reason', async () => {
    const cause = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
    h.rows = new DrizzleQueryError('select …', [], cause)
    const res = await get(await load(), '?q=ab')
    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ error: 'Suggestions unavailable' })
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain('canceling statement due to statement timeout')
  })

  it('a database error is a 503 that is not cached, and is logged', async () => {
    h.rows = new Error('connection closed')
    const res = await get(await load(), '?q=ab')
    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(console.error).toHaveBeenCalled()
  })

  it('gives up after 1.5 s', async () => {
    vi.useFakeTimers()
    h.rows = 'hang'
    const pending = get(await load(), '?q=ab')
    await vi.advanceTimersByTimeAsync(1499)
    let settled = false
    pending.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect((await pending).status).toBe(503)
  })
})

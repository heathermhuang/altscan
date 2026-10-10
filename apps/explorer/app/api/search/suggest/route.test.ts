/**
 * GET /api/search/suggest?q= : the header search box's token typeahead. Real route, real limiter
 * (the in-memory fallback); the database and Redis are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
        select: (cols: unknown) => {
          h.queries.push(cols)
          const q: Record<string, unknown> = {}
          for (const m of ['from', 'where', 'orderBy', 'limit']) q[m] = (...a: unknown[]) => { h.queries.push([m, ...a]); return q }
          q.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) =>
            h.rows === 'hang' ? undefined : h.rows instanceof Error ? reject(h.rows) : resolve(h.rows)
          return q
        },
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
        { address: addr(1), symbol: 'CAKE', name: 'PancakeSwap Token', holders: 900_000, lookalike: false },
        { address: addr(2), symbol: 'CAKEX', name: 'Cakex', holders: 10, lookalike: false },
      ],
    })
  })

  it('lists lookalikes after real tokens and flags them', async () => {
    h.rows = [row(1, 'USDT', 'Tether USD', 9_000_000), row(2, 'USDX', 'Usdx', 5)]
    const body = await (await get(await load(), '?q=usd')).json() as { tokens: { symbol: string; lookalike: boolean }[] }
    expect(body.tokens.map((t) => [t.symbol, t.lookalike])).toEqual([['USDX', false], ['USDT', true]])
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

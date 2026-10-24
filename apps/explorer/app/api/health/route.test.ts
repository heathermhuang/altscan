/**
 * GET /api/health: a failing completeness query still reports `unknown` to everyone (the public status
 * page alerts on it), but the raw driver message — which can name internal hosts — reaches only the admin view.
 * A blocks read that fails, times out or finds no row is `degraded`, never `ok`, and stays HTTP 200.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const DRIVER_ERROR = 'getaddrinfo ENOTFOUND dpg-internal-host-a'
type BlocksRead = 'row' | 'empty' | 'reject' | 'hang'
const h = vi.hoisted(() => ({ admin: false, blocks: 'row' as BlocksRead }))

vi.mock('@/lib/admin-auth', () => ({ isAdminRequest: () => h.admin }))
vi.mock('@/lib/providers', () => ({ getDataProviderHealth: async () => ({}) }))
vi.mock('@/lib/cache-registry', () => ({ getCacheSizes: () => ({}), getTotalCacheEntries: () => 0 }))
vi.mock('@altscan/explorer-core', () => ({ getRateLimitMapSize: () => 0 }))
vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  const chain = {
    from: () => chain,
    orderBy: () => chain,
    limit: async () => {
      if (h.blocks === 'reject') throw new Error(DRIVER_ERROR)
      if (h.blocks === 'hang') return new Promise<never>(() => {})
      return h.blocks === 'row' ? [{ number: 100, timestamp: new Date(Date.now() - 3000) }] : []
    },
  }
  return {
    schema,
    db: {
      select: () => chain,
      execute: async () => { throw new Error(DRIVER_ERROR) },
    },
  }
})

const get = async () => {
  const { GET } = await import('@/app/api/health/route')
  const res = await GET(new Request('http://x/api/health') as never)
  return res.json() as Promise<{
    status: string
    latestBlock: number | null
    lagSeconds: number | null
    completeness: Record<string, unknown>
  }>
}

describe('GET /api/health completeness failure', () => {
  beforeEach(() => { h.admin = false; h.blocks = 'row' })

  it('reports unknown publicly without the driver message', async () => {
    const body = await get()
    expect(body.completeness.status).toBe('unknown')
    expect(JSON.stringify(body)).not.toContain('ENOTFOUND')
  })

  it('keeps the reason for an admin caller', async () => {
    h.admin = true
    const body = await get()
    expect(body.completeness).toEqual({ status: 'unknown', reason: DRIVER_ERROR })
  })
})

describe('GET /api/health blocks read', () => {
  beforeEach(() => { h.admin = false; h.blocks = 'row' })
  afterEach(() => { vi.useRealTimers() })

  it('reports ok with the head when the read succeeds', async () => {
    const body = await get()
    expect(body.status).toBe('ok')
    expect(body.latestBlock).toBe(100)
    expect(body.lagSeconds).toBeGreaterThanOrEqual(0)
  })

  it('reports degraded, not ok, when the read throws', async () => {
    h.blocks = 'reject'
    const body = await get()
    expect(body.status).toBe('degraded')
    expect(body.latestBlock).toBeNull()
    expect(body.lagSeconds).toBeNull()
  })

  it('reports degraded when the read returns no row', async () => {
    h.blocks = 'empty'
    expect((await get()).status).toBe('degraded')
  })

  it('reports degraded when the read times out', async () => {
    h.blocks = 'hang'
    vi.useFakeTimers()
    const pending = get()
    await vi.advanceTimersByTimeAsync(8000)
    expect((await pending).status).toBe('degraded')
  })
})

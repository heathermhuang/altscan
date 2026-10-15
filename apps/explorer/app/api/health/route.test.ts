/**
 * GET /api/health: a failing completeness query still reports `unknown` to everyone (the public status
 * page alerts on it), but the raw driver message — which can name internal hosts — reaches only the admin view.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const DRIVER_ERROR = 'getaddrinfo ENOTFOUND dpg-internal-host-a'
const h = vi.hoisted(() => ({ admin: false }))

vi.mock('@/lib/admin-auth', () => ({ isAdminRequest: () => h.admin }))
vi.mock('@/lib/providers', () => ({ getDataProviderHealth: async () => ({}) }))
vi.mock('@/lib/cache-registry', () => ({ getCacheSizes: () => ({}), getTotalCacheEntries: () => 0 }))
vi.mock('@altscan/explorer-core', () => ({ getRateLimitMapSize: () => 0 }))
vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  const chain = { from: () => chain, orderBy: () => chain, limit: async () => [] }
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
  return res.json() as Promise<{ completeness: Record<string, unknown> }>
}

describe('GET /api/health completeness failure', () => {
  beforeEach(() => { h.admin = false })

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

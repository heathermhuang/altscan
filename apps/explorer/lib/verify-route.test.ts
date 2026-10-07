import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * POST /api/v1/verify used to upsert `contracts.compiler_version` from the REQUEST body once
 * Sourcify confirmed the contract, so anyone could stamp an arbitrary compiler string onto a
 * verified contract (a production test wrote the form default v0.8.19 onto USDT and WBNB,
 * which are 0.4.18). The persisted value is now Sourcify's, and the request's is ignored.
 *
 * Real route + real verifier; only axios (Sourcify), the DB and Redis are faked.
 */

const h = vi.hoisted(() => ({
  get: vi.fn(),
  inserted: [] as Array<Record<string, unknown>>,
  updated: [] as Array<Record<string, unknown>>,
}))
vi.mock('axios', () => ({ default: { get: h.get } }))
// ioredis is not resolvable from apps/explorer; no Redis = the in-memory limiter.
vi.mock('../../../packages/explorer-core/src/redis-client', () => ({
  getRedis: () => null,
  isRedisUnavailable: () => false,
}))

const ORIGIN = 'https://eth.test'
const ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const SOURCIFY_VERSION = '0.4.18+commit.9cf6e910'
const FORM_DEFAULT = 'v0.8.19+commit.7dd6d404'

afterEach(() => {
  vi.resetModules()
  h.get.mockReset()
  h.inserted.length = 0
  h.updated.length = 0
})

async function post(body: unknown) {
  vi.resetModules()
  vi.doMock('@/lib/db', () => ({
    db: {
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          h.inserted.push(v)
          return { onConflictDoUpdate: async ({ set }: { set: Record<string, unknown> }) => { h.updated.push(set) } }
        },
      }),
    },
    schema: { contracts: { address: 'address' } },
  }))
  vi.doMock('@/lib/chain', () => ({ chainConfig: { domain: 'eth.test', chainId: 1, name: 'Ethereum' } }))
  const { POST } = await import('@/app/api/v1/verify/route')
  return POST(new Request(`${ORIGIN}/api/v1/verify`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.9' },
    body: JSON.stringify(body),
  }))
}

const sourcifyVerified = (compilation?: unknown) => ({
  status: 200,
  data: { match: 'match', chainId: '1', address: ADDRESS, ...(compilation === undefined ? {} : { compilation }) },
})

describe('POST /api/v1/verify persists Sourcify\'s compiler version, never the request\'s', () => {
  it('stores Sourcify\'s value in the insert and the conflict update when the request sends a different one', async () => {
    h.get.mockResolvedValue(sourcifyVerified({ compilerVersion: SOURCIFY_VERSION }))
    const res = await post({ address: ADDRESS, compilerVersion: FORM_DEFAULT })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, match: 'sourcify' })
    expect(h.inserted).toHaveLength(1)
    expect(h.inserted[0].compilerVersion).toBe(SOURCIFY_VERSION)
    expect(h.updated[0].compilerVersion).toBe(SOURCIFY_VERSION)
    expect(JSON.stringify([h.inserted, h.updated])).not.toContain(FORM_DEFAULT)
  })

  it('stores null, not the request\'s value, when Sourcify reports no compiler version', async () => {
    h.get.mockResolvedValue(sourcifyVerified())
    const res = await post({ address: ADDRESS, compilerVersion: FORM_DEFAULT })
    expect(res.status).toBe(200)
    expect(h.inserted[0].compilerVersion).toBeNull()
    expect(h.updated[0].compilerVersion).toBeNull()
  })

  it('still lowercases the address and keeps accepting a request with no compilerVersion', async () => {
    h.get.mockResolvedValue(sourcifyVerified({ compilerVersion: SOURCIFY_VERSION }))
    const res = await post({ address: ADDRESS })
    expect(res.status).toBe(200)
    expect(h.inserted[0]).toMatchObject({ address: ADDRESS.toLowerCase(), compilerVersion: SOURCIFY_VERSION })
  })

  it('writes nothing when Sourcify does not have the contract', async () => {
    h.get.mockResolvedValue({ status: 404, data: { match: null } })
    const res = await post({ address: ADDRESS, compilerVersion: FORM_DEFAULT })
    expect(res.status).toBe(422)
    expect(h.inserted).toHaveLength(0)
  })
})

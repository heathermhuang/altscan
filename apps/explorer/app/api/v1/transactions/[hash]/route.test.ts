/**
 * GET /api/v1/transactions/:hash — the index serves recent transactions, the chain the rest. The
 * route used to 404 anything older than retention while the tx page showed it, and to 404 an
 * uppercase hash the index did hold.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rows: [] as unknown[], eqValues: [] as unknown[], lookup: vi.fn() }))

vi.mock('@/lib/api-rate-limit', () => ({ checkIpRateLimit: async () => true }))
vi.mock('@/lib/api-tx-lookup', () => ({ lookupTxOnChain: h.lookup }))
vi.mock('drizzle-orm', async (orig) => ({
  ...(await orig<typeof import('drizzle-orm')>()),
  eq: (_col: unknown, value: unknown) => { h.eqValues.push(value); return {} },
}))
vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  const chain = { from: () => chain, where: () => chain, limit: async () => h.rows }
  return { schema, db: { select: () => chain } }
})

const HASH = '0x' + 'ab'.repeat(32)
const get = async (hash: string) => {
  const { GET } = await import('./route')
  return GET(new Request(`http://x/api/v1/transactions/${hash}`), { params: Promise.resolve({ hash }) })
}

beforeEach(() => {
  h.rows = []
  h.eqValues = []
  h.lookup.mockReset()
})

describe('GET /api/v1/transactions/:hash', () => {
  it('serves an indexed transaction with source "index", without touching the chain', async () => {
    h.rows = [{ hash: HASH, blockNumber: 1 }]
    const res = await get(HASH)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ source: 'index', transaction: { hash: HASH } })
    expect(h.lookup).not.toHaveBeenCalled()
  })

  it('queries the index with the lowercased hash', async () => {
    h.rows = [{ hash: HASH }]
    await get(HASH.toUpperCase().replace('0X', '0x'))
    expect(h.eqValues).toEqual([HASH])
  })

  it('falls back to the chain outside the index, keeping unknown fields null', async () => {
    h.lookup.mockResolvedValue({
      kind: 'found',
      tx: { hash: HASH, pending: true, status: null, gasUsed: null, blockNumber: null, timestamp: null, value: 5n },
    })
    const res = await get(HASH)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      source: 'chain',
      transaction: { hash: HASH, pending: true, status: null, gasUsed: null, blockNumber: null, timestamp: null, value: '5' },
    })
    expect(h.lookup).toHaveBeenCalledWith(HASH)
  })

  it('returns 404 only when neither the index nor the node knows the hash', async () => {
    h.lookup.mockResolvedValue({ kind: 'missing' })
    const res = await get(HASH)
    expect(res.status).toBe(404)
    expect((await res.json()).detail).toMatch(/node/)
  })

  it('returns a retryable 503, not 404, when the node lookup fails', async () => {
    h.lookup.mockResolvedValue({ kind: 'unavailable' })
    const res = await get(HASH)
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('30')
  })

  it('rejects a malformed hash before any lookup', async () => {
    const res = await get('0x1234')
    expect(res.status).toBe(400)
    expect(h.eqValues).toEqual([])
    expect(h.lookup).not.toHaveBeenCalled()
  })
})

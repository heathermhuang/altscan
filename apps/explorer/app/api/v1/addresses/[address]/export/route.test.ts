/**
 * GET /api/v1/addresses/:address/export — the CSV is up to 1,000 rows of what the index still holds, and the body
 * alone cannot say whether that is the wallet's whole history. The headers do, from the same coverage read as the
 * JSON route (lib/address-coverage.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chainConfig } from '@/lib/chain'
import { GET } from './route'

const h = vi.hoisted(() => ({
  addressRows: [] as unknown[],
  txRows: [] as unknown[],
  txError: null as Error | null,
  floor: null as Date | null,
  limit: 0,
}))

vi.mock('@/lib/api-rate-limit', () => ({ checkIpRateLimit: async () => true }))
vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  const select = () => {
    let table: unknown
    const chain = {
      from: (t: unknown) => { table = t; return chain },
      where: () => chain,
      orderBy: () => chain,
      limit: async (n: number) => {
        if (table === schema.addresses) return h.addressRows
        h.limit = n
        if (h.txError) throw h.txError
        return h.txRows
      },
    }
    return chain
  }
  return { schema, db: { select } }
})
vi.mock('@/lib/retention', async (orig) => ({
  ...(await orig<typeof import('@/lib/retention')>()),
  getRetentionFloor: async () => h.floor,
}))

const ADDR = '0x' + '12'.repeat(20)
const FLOOR = new Date('2026-10-20T00:00:00.000Z')
const get = (address = ADDR) =>
  GET(new Request(`http://x/api/v1/addresses/${address}/export`), { params: Promise.resolve({ address }) })
const tx = (i: number) => ({
  hash: '0x' + i.toString(16).padStart(64, '0'), blockNumber: 100 + i, timestamp: new Date('2026-10-23T00:00:00.000Z'),
  fromAddress: ADDR, toAddress: '0x' + '34'.repeat(20), value: '1500000000000000000', gasUsed: 21000, gasPrice: '5000000000',
  status: true, methodId: null,
})

beforeEach(() => {
  h.addressRows = [{ firstSeen: new Date('2025-01-01T00:00:00.000Z') }]
  h.txRows = [tx(1)]
  h.txError = null
  h.floor = FLOOR
  h.limit = 0
})

describe('GET /api/v1/addresses/:address/export completeness headers', () => {
  it('says the history is incomplete when the address was first seen before the oldest retained block', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get('X-History-Complete')).toBe('false')
    expect(res.headers.get('X-Indexed-From')).toBe(FLOOR.toISOString())
    expect(res.headers.get('X-History-Truncated')).toBeNull()
  })

  it('says the history is complete when the address was first seen inside the retained window', async () => {
    h.addressRows = [{ firstSeen: new Date('2026-10-20T12:00:00.000Z') }]
    const res = await get()
    expect(res.headers.get('X-History-Complete')).toBe('true')
    expect(res.headers.get('X-Indexed-From')).toBe(FLOOR.toISOString())
  })

  it('makes no completeness claim for an address the index has no row for, but still gives the floor', async () => {
    h.addressRows = []
    const res = await get()
    expect(res.headers.get('X-History-Complete')).toBeNull()
    expect(res.headers.get('X-Indexed-From')).toBe(FLOOR.toISOString())
  })

  it('omits both when the retention floor is unknown', async () => {
    h.floor = null
    const res = await get()
    expect(res.headers.get('X-History-Complete')).toBeNull()
    expect(res.headers.get('X-Indexed-From')).toBeNull()
  })

  it('flags a full 1,000-row page as truncated, and only a full one', async () => {
    h.txRows = Array.from({ length: 1000 }, (_, i) => tx(i))
    expect((await get()).headers.get('X-History-Truncated')).toBe('true')
    expect(h.limit).toBe(1000)
    h.txRows = Array.from({ length: 999 }, (_, i) => tx(i))
    expect((await get()).headers.get('X-History-Truncated')).toBeNull()
  })
})

describe('GET /api/v1/addresses/:address/export body', () => {
  it('keeps the CSV format: header line, then one row per transaction', async () => {
    h.txRows = [tx(1), tx(2)]
    const res = await get()
    expect(res.headers.get('Content-Type')).toBe('text/csv')
    const lines = (await res.text()).split('\n')
    expect(lines[0]).toBe(`Tx Hash,Block,Timestamp,From,To,Value (${chainConfig.currency}),Gas Used,Gas Price (Gwei),Status,Method`)
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe(`${tx(1).hash},101,2026-10-23T00:00:00.000Z,${ADDR},${'0x' + '34'.repeat(20)},1.50000000,21000,5.00,Success,`)
  })

  it('still answers 500 when the transactions read fails, and 400 for a malformed address', async () => {
    h.txError = new Error('db down')
    expect((await get()).status).toBe(500)
    expect((await get('0x1234')).status).toBe(400)
  })
})

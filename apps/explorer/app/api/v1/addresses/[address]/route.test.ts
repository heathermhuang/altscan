/**
 * GET /api/v1/addresses/:address — the coverage and balance fields. The index keeps a few days, so
 * empty lists used to read as "no activity" for any wallet quiet that long; historyComplete says
 * which it is. Every new field degrades to null on failure: none may turn a 200 into a 500.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { trackedTokens } from '@/lib/holdings'
import { chainConfig } from '@/lib/chain'
import { GET } from './route'

const h = vi.hoisted(() => ({
  addressRows: [] as unknown[] | Error,
  indexError: null as Error | null,
  floor: null as Date | null,
  provider: null as null | { getCode: () => Promise<string>; getBalance: () => Promise<bigint> },
  tracked: null as Record<string, string> | null,
  swallow: vi.fn(),
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
      limit: async () => {
        if (table === schema.addresses) {
          if (h.addressRows instanceof Error) throw h.addressRows
          return h.addressRows
        }
        if (h.indexError) throw h.indexError
        return []
      },
    }
    return chain
  }
  return { schema, db: { select } }
})
vi.mock('@/lib/address-query', () => ({
  selectByAddress: async () => { if (h.indexError) throw h.indexError; return [] },
}))
vi.mock('@/lib/retention', async (orig) => ({
  ...(await orig<typeof import('@/lib/retention')>()),
  getRetentionFloor: async () => h.floor,
}))
vi.mock('@/lib/rpc', () => ({
  getWebProvider: async () => { if (!h.provider) throw new Error('no provider'); return h.provider },
}))
vi.mock('@/lib/tracked-balances', () => ({ readTrackedBalances: async () => h.tracked }))
vi.mock('@/lib/observability', () => ({
  swallow: h.swallow,
  swallowed: (tag: string, fallback: unknown) => (e: unknown) => { h.swallow(tag, e); return fallback },
}))

const ADDR = '0x' + '12'.repeat(20)
const FLOOR = new Date('2026-10-20T00:00:00.000Z')
const get = (address = ADDR) =>
  GET(new Request(`http://x/api/v1/addresses/${address}`), { params: Promise.resolve({ address }) })
const tokens = trackedTokens(chainConfig.whales)

beforeEach(() => {
  h.addressRows = [{ firstSeen: new Date('2025-01-01T00:00:00.000Z') }]
  h.indexError = null
  h.floor = FLOOR
  h.provider = { getCode: async () => '0x', getBalance: async () => 1250000000000000000n }
  h.tracked = null
  h.swallow.mockReset()
})

describe('GET /api/v1/addresses/:address coverage', () => {
  it('reports history cut short when the address was first seen before the oldest retained block', async () => {
    const body = await (await get()).json()
    expect(body).toMatchObject({ transactions: [], tokenTransfers: [], historyComplete: false, indexedFrom: FLOOR.toISOString() })
  })

  it('reports history complete when the address was first seen inside the retained window', async () => {
    h.addressRows = [{ firstSeen: new Date('2026-10-20T12:00:00.000Z') }]
    expect(await (await get()).json()).toMatchObject({ historyComplete: true, indexedFrom: FLOOR.toISOString() })
  })

  it('cannot tell for an address the index has no row for', async () => {
    h.addressRows = []
    expect(await (await get()).json()).toMatchObject({ historyComplete: null, indexedFrom: FLOOR.toISOString() })
  })

  it('cannot tell when the retention floor is unknown', async () => {
    h.floor = null
    expect(await (await get()).json()).toMatchObject({ historyComplete: null, indexedFrom: null })
  })

  it('degrades to unknown, not a 500, when the addresses lookup fails', async () => {
    h.addressRows = new Error('statement timeout')
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).historyComplete).toBeNull()
    expect(h.swallow).toHaveBeenCalledWith('api/v1/addresses/coverage', h.addressRows)
  })
})

describe('GET /api/v1/addresses/:address balances', () => {
  it('returns the native balance in wei and every tracked token, zeros included, in config order', async () => {
    h.tracked = Object.fromEntries(tokens.map((t, i) => [t.address, i === 0 ? '605000000000000000000000000' : '0']))
    const body = await (await get()).json()
    expect(body.nativeBalance).toBe('1250000000000000000')
    expect(body.trackedTokenBalances).toEqual(tokens.map((t, i) => ({
      tokenAddress: t.address, symbol: t.symbol, decimals: t.decimals, balance: i === 0 ? '605000000000000000000000000' : '0',
    })))
  })

  it('reports an empty wallet as "0", not null', async () => {
    h.provider = { getCode: async () => '0x', getBalance: async () => 0n }
    expect((await (await get()).json()).nativeBalance).toBe('0')
  })

  it('keeps the token balances when only the native read fails', async () => {
    const err = new Error('rpc timeout')
    h.provider = { getCode: async () => '0x', getBalance: async () => { throw err } }
    h.tracked = Object.fromEntries(tokens.map(t => [t.address, '1']))
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.nativeBalance).toBeNull()
    expect(body.trackedTokenBalances).toHaveLength(tokens.length)
    expect(h.swallow).toHaveBeenCalledWith('api/v1/addresses/balance', err)
  })

  it('returns null token balances when the multicall read fails', async () => {
    const body = await (await get()).json()
    expect(body.trackedTokenBalances).toBeNull()
    expect(body.nativeBalance).toBe('1250000000000000000')
  })

  it('degrades every chain field to unknown, not a 500, when no provider is available', async () => {
    h.provider = null
    // An address no earlier test resolved: the contract verdict is cached across requests.
    const res = await get('0x' + '34'.repeat(20))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ nativeBalance: null, trackedTokenBalances: null, isContractKnown: false, historyComplete: false })
    expect(h.swallow).toHaveBeenCalledWith('api/v1/addresses/balance', expect.any(Error))
  })
})

describe('GET /api/v1/addresses/:address failures', () => {
  it('still answers 500 when the index itself fails, with the new reads left harmlessly in flight', async () => {
    h.indexError = new Error('db down')
    expect((await get()).status).toBe(500)
  })

  it('rejects a malformed address', async () => {
    expect((await get('0x1234')).status).toBe(400)
  })
})

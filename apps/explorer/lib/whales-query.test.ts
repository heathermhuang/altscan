import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execute, fetchNativeUsd, createPageCache } = vi.hoisted(() => ({
  execute: vi.fn(),
  fetchNativeUsd: vi.fn(),
  // The identity wrapper: what the page hands createPageCache (name, TTL, the query) is observable, and fetchWhales runs the query itself.
  createPageCache: vi.fn((_name: string, _ttl: number, query: unknown) => query),
}))
vi.mock('@/lib/db', () => ({ db: { execute } }))
vi.mock('@/lib/native-price', () => ({ fetchNativeUsd, NATIVE_PRICE_BUDGET_MS: 11_000 }))
vi.mock('@/lib/page-cache', () => ({ createPageCache }))

import { chainConfig } from '@/lib/chain'
import { fetchWhales, queryWhales, WHALES_SHOWN } from '@/lib/whales'

const NATIVE_ROW = {
  hash: '0xn', fromAddress: '0xf', toAddress: '0xt', value: String(10n * 10n ** 18n), blockNumber: 1,
  timestamp: '2026-10-10T00:00:00Z', transferType: 'native', tokenSymbol: 'BNB',
}

beforeEach(() => {
  // First execute() is the native half, the second the token half (none when there are no filters).
  execute.mockReset().mockResolvedValue([NATIVE_ROW])
  fetchNativeUsd.mockReset()
})
afterEach(() => { vi.useRealTimers() })

describe('queryWhales and the native price', () => {
  it('returns the price it ranked with, and prices the native rows by it', async () => {
    fetchNativeUsd.mockResolvedValue(730)
    const out = await queryWhales('24h', '1', [])
    expect(out.nativeUsd).toBe(730)
    expect(out.rows[0].usd).toBe(7300)
  })

  it.each([
    ['a rejected fetch', () => fetchNativeUsd.mockRejectedValue(new Error('down'))],
    ['a zero price', () => fetchNativeUsd.mockResolvedValue(0)],
    ['no price', () => fetchNativeUsd.mockResolvedValue(null)],
  ])('reports no native price, and ranks nothing native, on %s', async (_label, arrange) => {
    arrange()
    const out = await queryWhales('24h', '1', [])
    expect(out.nativeUsd).toBeNull()
    expect(out.rows[0].usd).toBeNull()
  })

  it('stops waiting for a price that never arrives, after the helper\'s own budget', async () => {
    vi.useFakeTimers()
    fetchNativeUsd.mockReturnValue(new Promise(() => {}))
    const pending = queryWhales('24h', '1', [])
    await vi.advanceTimersByTimeAsync(10_999)
    let settled = false
    pending.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const out = await pending
    expect(out.nativeUsd).toBeNull()
    expect(out.rows).toHaveLength(1)
  })

  it('carries nothing a JSON cache cannot hold', async () => {
    fetchNativeUsd.mockResolvedValue(730)
    const out = await queryWhales('24h', '1', [])
    expect(() => JSON.stringify(out)).not.toThrow()
  })
})

describe('queryWhales: rank every candidate, then show the top 50', () => {
  const E18 = 10n ** 18n
  const stable = chainConfig.whales.stablecoins[0]
  const nativeRow = (i: number) => ({ ...NATIVE_ROW, hash: `0xn${i}`, value: String(BigInt(i) * E18) })
  const tokenRow = (hash: string, whole: bigint, timestamp: string) => ({
    hash, fromAddress: '0xf', toAddress: '0xt', value: String(whole * 10n ** BigInt(stable.decimals)), blockNumber: 1,
    timestamp, transferType: 'token', tokenSymbol: 'USDT', tokenAddress: stable.address,
  })
  const filters = [{ address: stable.address, minValue: '1', indexFloor: '2' }]

  it('caps the list at 50 AFTER the USD sort, so the cut keeps the largest, not the first 50 fetched', async () => {
    fetchNativeUsd.mockResolvedValue(730)
    // 60 native candidates, smallest first in the fetch order, so a cut before ranking would keep the wrong 50.
    execute.mockReset()
      .mockResolvedValueOnce(Array.from({ length: 60 }, (_, i) => nativeRow(i + 1)))
      .mockResolvedValueOnce([])

    const out = await queryWhales('24h', '1', filters)

    expect(WHALES_SHOWN).toBe(50)
    expect(out.rows).toHaveLength(50)
    expect(out.rows[0].hash).toBe('0xn60')
    expect(out.rows[49].hash).toBe('0xn11') // 1..10 BNB are the ten cut
  })

  it('an older large stablecoin transfer among the candidates outranks recent small ones', async () => {
    fetchNativeUsd.mockResolvedValue(730)
    execute.mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        tokenRow('0xs1', 1_000n, '2026-10-10T11:00:00Z'),
        tokenRow('0xs2', 1_000n, '2026-10-10T10:59:00Z'),
        tokenRow('0xbig', 1_000_000n, '2026-10-09T15:00:00Z'),
      ])

    const out = await queryWhales('24h', '1', filters)

    expect(out.rows.map(r => r.hash)).toEqual(['0xbig', '0xs1', '0xs2'])
  })
})

describe('the whales page cache', () => {
  it('is named whales-usd-v2, once: the candidate set changed under the same value shape, and the cache outlives a deploy', () => {
    // Next keys an entry by the cache NAME alone, across deploys. Under the old 'whales-usd' name the first
    // visitors after this deploy would be handed the newest-25 candidate set for up to a revalidate window.
    expect(createPageCache.mock.calls.map(c => c[0])).toEqual(['whales-usd-v2'])
    expect(createPageCache.mock.calls[0][1]).toBe(300)
  })

  it('holds no BigInt: what reaches the cache is strings, numbers, null and booleans', async () => {
    fetchNativeUsd.mockResolvedValue(730)
    const stable = chainConfig.whales.stablecoins[0]
    execute.mockReset()
      .mockResolvedValueOnce([NATIVE_ROW])
      .mockResolvedValueOnce([{
        hash: '0xs', fromAddress: '0xf', toAddress: '0xt', value: String(1_000_000n * 10n ** BigInt(stable.decimals)), blockNumber: 1,
        timestamp: '2026-10-09T15:00:00Z', transferType: 'token', tokenSymbol: 'USDT', tokenAddress: stable.address,
      }])

    const out = await fetchWhales('24h', '1', [{ address: stable.address, minValue: '1', indexFloor: '2' }])

    expect(out.rows.map(r => r.hash)).toEqual(['0xs', '0xn'])
    // Timestamps cross the cache as ISO strings and come back as Dates; nothing else may be exotic.
    expect(() => JSON.stringify(out)).not.toThrow()
  })
})

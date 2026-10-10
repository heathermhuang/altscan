import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execute, fetchNativeUsd } = vi.hoisted(() => ({ execute: vi.fn(), fetchNativeUsd: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { execute } }))
vi.mock('@/lib/native-price', () => ({ fetchNativeUsd, NATIVE_PRICE_BUDGET_MS: 11_000 }))

import { queryWhales } from '@/lib/whales'

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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ db: {}, schema: {} }))
vi.mock('@/lib/page-cache', () => ({ createPageCache: (_name: string, _ttl: number, q: unknown) => q }))

import { readNativeUsd } from './dex-page'
import { NATIVE_PRICE_BUDGET_MS } from './native-price'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

// The strip's wrapped-native legs need the native price, fetched inside the cached /dex read (once per
// cache fill, never per render).
describe('readNativeUsd (the price the cached /dex read carries)', () => {
  it('is the price when a source answers', async () => {
    await expect(readNativeUsd(async () => 612.5)).resolves.toBe(612.5)
  })

  it('is null when every source failed (the helper says null) or threw: the strip then leaves those swaps unpriced', async () => {
    await expect(readNativeUsd(async () => null)).resolves.toBeNull()
    await expect(readNativeUsd(async () => { throw new Error('dns') })).resolves.toBeNull()
  })

  // The same bound /whales uses (lib/whales.ts): what the helper's own chain needs to reach a non-Binance fallback.
  // A smaller wait makes every fallback after Binance unreachable whenever Binance hangs (native-price.test.ts).
  it('stops waiting after the helper\'s own budget: a hung provider cannot hold the cache fill forever', async () => {
    const hung = () => new Promise<number | null>(() => {})
    const p = readNativeUsd(hung)
    await vi.advanceTimersByTimeAsync(NATIVE_PRICE_BUDGET_MS - 1)
    let settled = false
    void p.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    await expect(p).resolves.toBeNull()
  })
})

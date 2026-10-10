import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ db: {}, schema: {} }))
vi.mock('@/lib/page-cache', () => ({ createPageCache: (_name: string, _ttl: number, q: unknown) => q }))

import { DEX_PRICE_WAIT_MS, readNativeUsd } from './dex-page'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

// The strip's wrapped-native legs need the native price, fetched inside the cached /dex read (once per
// cache fill, never per render). The price is not worth waiting long for: the table does not need it.
describe('readNativeUsd (the price the cached /dex read carries)', () => {
  it('is the price when a source answers', async () => {
    await expect(readNativeUsd(async () => 612.5)).resolves.toBe(612.5)
  })

  it('is null when every source failed (the helper says null) or threw: the strip then leaves those swaps unpriced', async () => {
    await expect(readNativeUsd(async () => null)).resolves.toBeNull()
    await expect(readNativeUsd(async () => { throw new Error('dns') })).resolves.toBeNull()
  })

  it('stops waiting after the bound: a hung provider cannot hold the cache fill', async () => {
    const hung = () => new Promise<number | null>(() => {})
    const p = readNativeUsd(hung)
    await vi.advanceTimersByTimeAsync(DEX_PRICE_WAIT_MS - 1)
    let settled = false
    void p.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    await expect(p).resolves.toBeNull()
  })

  it('waits less than the helper\'s own 11 s chain, which is the point of bounding it', () => {
    expect(DEX_PRICE_WAIT_MS).toBeLessThan(11_000)
  })
})

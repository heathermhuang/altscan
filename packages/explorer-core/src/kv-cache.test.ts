import { describe, it, expect } from 'vitest'
import { kvGet, kvSet, getKvFallbackSize, KV_FALLBACK_MAX } from './kv-cache'

// These tests run without REDIS_URL, so they exercise the in-memory fallback path.
const uniq = () => `test:${Math.random().toString(36).slice(2)}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('kv-cache (in-memory fallback)', () => {
  it('returns the stored value after set', async () => {
    const k = uniq()
    await kvSet(k, 'hello', 1000)
    expect(await kvGet(k)).toBe('hello')
  })

  it('returns null for an absent key (cache miss)', async () => {
    expect(await kvGet(uniq())).toBeNull()
  })

  it('expires entries after their TTL', async () => {
    const k = uniq()
    await kvSet(k, 'soon-gone', 25)
    expect(await kvGet(k)).toBe('soon-gone')
    await sleep(45)
    expect(await kvGet(k)).toBeNull()
  })

  it('overwrites an existing key with a fresh value and TTL', async () => {
    const k = uniq()
    await kvSet(k, 'v1', 1000)
    await kvSet(k, 'v2', 1000)
    expect(await kvGet(k)).toBe('v2')
  })

  it('keeps independent values for different keys', async () => {
    const a = uniq()
    const b = uniq()
    await kvSet(a, 'A', 1000)
    await kvSet(b, 'B', 1000)
    expect(await kvGet(a)).toBe('A')
    expect(await kvGet(b)).toBe('B')
  })

  it('bounds the in-memory fallback map size to prevent heap growth', async () => {
    // Insert well over the cap — size must never exceed KV_FALLBACK_MAX.
    for (let i = 0; i < KV_FALLBACK_MAX * 3; i++) {
      await kvSet(`bound:${i}:${Math.random()}`, String(i), 60_000)
    }
    expect(getKvFallbackSize()).toBeLessThanOrEqual(KV_FALLBACK_MAX)
  })
})

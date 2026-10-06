import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Redis path of the limiter, against a fake client. The point of the Lua script is that
 * INCR and the expiry are ONE command: a counter must never exist without a TTL, or the bucket
 * stays over its limit forever. The fake only offers `eval` (no `incr`/`pexpire`), so any
 * return to a two-step INCR-then-PEXPIRE would throw, fall back to memory, and fail these.
 */

const h = vi.hoisted(() => {
  /** pttl: ms to live; -1 = key exists with no expiry (what a crashed INCR/PEXPIRE leaves). */
  const store = new Map<string, { n: number; pttl: number }>()
  const state = { evalCalls: 0, failing: false }
  const fake = {
    // A JS mirror of the script's semantics. It can't run Lua, so it refuses a script that
    // lacks any of the three commands the semantics depend on.
    async eval(script: string, numkeys: number, key: string, windowMs: number) {
      state.evalCalls++
      if (state.failing) throw new Error('Redis blip')
      for (const cmd of ['INCR', 'PTTL', 'PEXPIRE']) {
        if (!script.includes(cmd)) throw new Error(`script is missing ${cmd}`)
      }
      if (numkeys !== 1) throw new Error('script takes exactly one key')
      const entry = store.get(key) ?? { n: 0, pttl: -1 }
      entry.n++
      if (entry.pttl === -1) entry.pttl = Number(windowMs)
      store.set(key, entry)
      return entry.n
    },
  }
  /** Let `ms` pass: keys whose TTL runs out are gone. */
  function advance(ms: number) {
    for (const [k, e] of store) {
      if (e.pttl === -1) continue
      e.pttl -= ms
      if (e.pttl <= 0) store.delete(k)
    }
  }
  return { store, state, fake, advance }
})
vi.mock('./redis-client', () => ({
  getRedis: () => h.fake,
  isRedisUnavailable: () => false,
}))

import { checkRateLimit } from './rate-limit'

const WINDOW_MS = 60_000
let key: string
beforeEach(() => {
  h.store.clear()
  h.state.evalCalls = 0
  h.state.failing = false
  key = `redis-test-${Math.random()}` // memory-fallback state is module-level; keep keys unique
})

describe('checkRateLimit (Redis)', () => {
  it('the first request creates rl:<key> with count 1 and a full-window TTL, in one round trip', async () => {
    expect(await checkRateLimit(key, 5)).toBe(true)
    expect([...h.store]).toEqual([[`rl:${key}`, { n: 1, pttl: WINDOW_MS }]])
    expect(h.state.evalCalls).toBe(1)
  })

  it('is a fixed window: later requests count up without moving the expiry', async () => {
    await checkRateLimit(key, 5)
    h.advance(30_000)
    await checkRateLimit(key, 5)
    expect(h.store.get(`rl:${key}`)).toEqual({ n: 2, pttl: 30_000 })
  })

  it('a new window starts at the first request after the key expires', async () => {
    for (let i = 0; i < 3; i++) await checkRateLimit(key, 2)
    expect(await checkRateLimit(key, 2)).toBe(false)
    h.advance(WINDOW_MS)
    expect(await checkRateLimit(key, 2)).toBe(true)
    expect(h.store.get(`rl:${key}`)).toEqual({ n: 1, pttl: WINDOW_MS })
  })

  it('allows up to max and limits beyond it', async () => {
    for (let i = 0; i < 3; i++) expect(await checkRateLimit(key, 3)).toBe(true)
    expect(await checkRateLimit(key, 3)).toBe(false)
    expect(await checkRateLimit(key, 3)).toBe(false)
  })

  it('self-heals a counter that exists without a TTL: the next request gives it one', async () => {
    // What a process dying between INCR and PEXPIRE used to leave behind: permanently over the limit.
    h.store.set(`rl:${key}`, { n: 500, pttl: -1 })
    expect(await checkRateLimit(key, 100)).toBe(false) // still counted as over the limit...
    expect(h.store.get(`rl:${key}`)).toEqual({ n: 501, pttl: WINDOW_MS }) // ...but now it expires
    h.advance(WINDOW_MS)
    expect(await checkRateLimit(key, 100)).toBe(true) // and the visitor is released
  })

  it('falls back to the in-memory limiter, with the same limit, when Redis errors', async () => {
    h.state.failing = true
    expect(await checkRateLimit(key, 2)).toBe(true)
    expect(await checkRateLimit(key, 2)).toBe(true)
    expect(await checkRateLimit(key, 2)).toBe(false)
    expect(h.store.size).toBe(0)
  })
})

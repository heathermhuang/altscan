import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPageCache, PAGE_CACHE_MAX_IN_FLIGHT } from '@/lib/page-cache'
import { DB_TIMEOUT_MS } from '@/lib/with-timeout'

// The same stand-in for Next 15.5's `unstable_cache` as page-cache-staleness.test.ts: a cold miss runs the callback
// for EVERY concurrent caller (Next's dedupe lives on the request), and a too-old entry is returned while a refresh
// runs in the background.
const { store, background, refresh, swallow, fakeUnstableCache } = vi.hoisted(() => {
  const refresh = { on: true }
  const swallow = vi.fn()
  const store = new Map<string, { body: string | undefined; storedAt: number }>()
  const background: Promise<unknown>[] = []
  const fakeUnstableCache = (
    cb: (...a: unknown[]) => Promise<unknown>,
    keyParts: string[],
    opts: { revalidate: number },
  ) => async (...args: unknown[]) => {
    const id = `${cb.toString()}-${keyParts.join(',')}-${JSON.stringify(args)}`
    const put = (result: unknown) => store.set(id, { body: JSON.stringify(result), storedAt: Date.now() })
    const entry = store.get(id)
    if (!entry) {
      const result = await cb(...args)
      put(result)
      return result
    }
    if (refresh.on && (Date.now() - entry.storedAt) / 1000 > opts.revalidate) {
      background.push(cb(...args).then(put, () => {}))
    }
    return entry.body === undefined ? undefined : JSON.parse(entry.body)
  }
  return { store, background, refresh, swallow, fakeUnstableCache }
})
vi.mock('next/cache', () => ({ unstable_cache: fakeUnstableCache }))
vi.mock('@/lib/observability', () => ({ swallow }))
vi.mock('@/lib/observability', () => ({ swallow }))

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0)
const settle = () => Promise.all(background.splice(0))
const PENDING = Symbol('pending')
const peek = <T>(p: Promise<T>) => Promise.race([p, Promise.resolve(PENDING)])
/** A query that resolves only when told to, and counts how often it ran. */
function controlled() {
  const pending: Array<(v: string) => void> = []
  const query = vi.fn((page: number = 1) => new Promise<string>(res => { pending.push((v) => res(`${v}:${page}`)) }))
  return { query, resolveAll: (v: string) => pending.splice(0).forEach(r => r(v)) }
}

beforeEach(() => {
  store.clear()
  background.length = 0
  refresh.on = true
  swallow.mockClear()
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => { vi.useRealTimers() })

describe('one flight per key, cold or stale', () => {
  it('runs one query for N concurrent cold reads, and every reader gets its value', async () => {
    const { query, resolveAll } = controlled()
    const read = createPageCache('cold-shared', 60, query)
    const readers = Array.from({ length: 6 }, () => read(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(query).toHaveBeenCalledTimes(1)
    resolveAll('v')
    expect(await Promise.all(readers)).toEqual(Array(6).fill('v:1'))
  })

  it('shares the stale read\'s inline recompute with Next\'s background refresh', async () => {
    const { query, resolveAll } = controlled()
    const read = createPageCache('stale-shared', 60, query)
    const first = read(1)
    await vi.advanceTimersByTimeAsync(0)
    resolveAll('old')
    await first
    query.mockClear()

    vi.setSystemTime(T0 + 61_000)
    const reader = read(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(query).toHaveBeenCalledTimes(1)   // the inline recompute and the background refresh are one query
    resolveAll('new')
    expect(await reader).toBe('new:1')
    await settle()
  })

  it('fills the cache from a cold query slower than the page deadline', async () => {
    const { query, resolveAll } = controlled()
    const read = createPageCache('cold-slow', 60, query)
    const reader = read(1)
    await vi.advanceTimersByTimeAsync(DB_TIMEOUT_MS + 2_000)
    expect(await peek(reader)).toBe(PENDING)   // a cold reader has no old value to fall back on: it waits
    resolveAll('slow')
    expect(await reader).toBe('slow:1')
    expect(await read(1)).toBe('slow:1')       // stored: the next reader hits
    expect(query).toHaveBeenCalledTimes(1)
  })
})

describe('a bound on distinct keys in flight', () => {
  it(`refuses a ${PAGE_CACHE_MAX_IN_FLIGHT + 1}th distinct cold key without querying, and serves a stale one its old value`, async () => {
    const warm = controlled()
    const readWarm = createPageCache('bound-warm', 60, warm.query)
    const w = readWarm(1)
    await vi.advanceTimersByTimeAsync(0)
    warm.resolveAll('old')
    await w

    const cold = controlled()
    const readCold = createPageCache('bound-cold', 60, cold.query)
    const hung = Array.from({ length: PAGE_CACHE_MAX_IN_FLIGHT }, (_, i) => readCold(i + 1))
    await vi.advanceTimersByTimeAsync(0)
    expect(cold.query).toHaveBeenCalledTimes(PAGE_CACHE_MAX_IN_FLIGHT)

    await expect(readCold(999)).rejects.toThrow(/queries already in flight/)
    expect(cold.query).toHaveBeenCalledTimes(PAGE_CACHE_MAX_IN_FLIGHT)

    vi.setSystemTime(T0 + 61_000)
    refresh.on = false
    expect(await readWarm(1)).toBe('old:1')
    expect(swallow).toHaveBeenCalledWith('page-cache/bound-warm:stale-on-error', expect.objectContaining({ message: expect.stringMatching(/in flight/) }))

    cold.resolveAll('done')
    await Promise.all(hung)
    // Settled flights free their slots.
    const later = readCold(999)
    await vi.advanceTimersByTimeAsync(0)
    expect(cold.query).toHaveBeenCalledTimes(PAGE_CACHE_MAX_IN_FLIGHT + 1)
    cold.resolveAll('later')
    expect(await later).toBe('later:999')
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPageCache } from '@/lib/page-cache'
import { DB_TIMEOUT_MS } from '@/lib/with-timeout'

// A stand-in for Next 15.5's `unstable_cache` on a dynamic route, written from
// next/dist/server/web/spec-extension/unstable-cache.js. The real one throws outside a Next request
// scope, so this is the only way to drive the contract that matters here:
//
//   - the entry is JSON round-tripped (so a BigInt in the value throws, as it does in production);
//   - an entry older than `revalidate` is STILL RETURNED, however old, while a refresh runs in the
//     background (`age > revalidate` -> kick `cb`, then `return cachedResponse`);
//   - a refresh that rejects is swallowed and stores nothing.
//
// `refresh.on = false` switches the background refresh off, to isolate the reader's own inline
// recompute: in production Next starts one refresh PER REQUEST (its dedupe lives on the request's
// workStore), so a count of query runs would otherwise mix the two.
//
// That second line is the bug this file pins: after an idle gap the first reader gets the entry as the
// previous reader left it, 27 minutes old on ethscan.io/blocks.
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

const T0 = Date.UTC(2026, 9, 9, 11, 50, 59)
const SECOND = 1000

/** A query whose answer the test controls, and which counts how often it actually ran. */
function source(first = 'v1') {
  const state = { value: first, calls: 0 }
  const query = vi.fn(async (page: number = 1) => {
    state.calls++
    return { page, tip: state.value }
  })
  return { state, query }
}

/** Let the stale read's background refresh land, as Next does after the response. */
const settle = () => Promise.all(background.splice(0))

beforeEach(() => {
  store.clear()
  background.length = 0
  refresh.on = true
  swallow.mockClear()
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => { vi.useRealTimers() })

describe('createPageCache bounds how stale a served entry can be', () => {
  it('serves a fresh entry without querying again', async () => {
    const { state, query } = source()
    const read = createPageCache('t', 60, query)

    expect(await read(1)).toEqual({ page: 1, tip: 'v1' })
    state.value = 'v2'
    vi.setSystemTime(T0 + 10 * SECOND)

    expect(await read(1)).toEqual({ page: 1, tip: 'v1' })
    expect(state.calls).toBe(1)
  })

  it('never serves an entry older than the TTL: after an idle gap the first reader gets current data', async () => {
    // The production failure. ethscan.io/blocks was read at 11:50:59 and next at 12:17:51; the cache
    // handed back the 11:50:59 rows (every one "27m ago") while the homepage, warm from other
    // traffic, showed the block mined 17 seconds earlier.
    const { state, query } = source()
    const read = createPageCache('t', 60, query)
    await read(1)

    state.value = 'v2'
    vi.setSystemTime(T0 + 26 * 60 * SECOND + 52 * SECOND)

    expect(await read(1)).toEqual({ page: 1, tip: 'v2' })
  })

  it('still lets the stale read refresh the entry, so the next reader gets a cache hit', async () => {
    const { state, query } = source()
    const read = createPageCache('t', 60, query)
    await read(1)
    state.value = 'v2'
    vi.setSystemTime(T0 + 30 * 60 * SECOND)

    await read(1)
    await settle()
    const callsAfterRefresh = state.calls

    expect(await read(1)).toEqual({ page: 1, tip: 'v2' })
    expect(state.calls).toBe(callsAfterRefresh)
  })

  it.each([45, 60, 300])('bounds a %is cache at exactly that many seconds, inclusive', async (ttl) => {
    // An age of exactly the TTL is still fresh (Next's own test is `age > revalidate`); one
    // millisecond past it is not. Pinned both sides so an off-by-one in either direction fails.
    const { state, query } = source()
    const read = createPageCache(`ttl-${ttl}`, ttl, query)
    await read(1)
    state.value = 'v2'

    vi.setSystemTime(T0 + ttl * SECOND)
    expect(await read(1)).toEqual({ page: 1, tip: 'v1' })
    expect(state.calls).toBe(1)

    vi.setSystemTime(T0 + ttl * SECOND + 1)
    expect(await read(1)).toEqual({ page: 1, tip: 'v2' })
  })

  it('measures an entry from when its query finished, not when it started', async () => {
    // Next ages an entry from the moment it is stored. Stamping at the start of a slow query (/dex runs
    // several) would make the entry look older here than it does there, so a hit Next calls fresh
    // would be recomputed for nothing.
    const state = { value: 'v1', calls: 0 }
    const query = vi.fn(async () => {
      state.calls++
      await new Promise(resolve => setTimeout(resolve, 5 * SECOND))
      return state.value
    })
    const read = createPageCache('t', 60, query)
    const first = read()
    await vi.advanceTimersByTimeAsync(5 * SECOND)
    await first
    state.value = 'v2'

    vi.setSystemTime(T0 + 65 * SECOND)

    expect(await read()).toBe('v1')
    expect(state.calls).toBe(1)
  })

  it('bounds each argument set on its own entry', async () => {
    const { state, query } = source()
    const read = createPageCache('t', 60, query)
    await read(1)
    vi.setSystemTime(T0 + 50 * SECOND)
    await read(2)
    state.value = 'v2'

    // Page 1 is 70 s old, page 2 only 20 s: one is recomputed and the other is not.
    vi.setSystemTime(T0 + 70 * SECOND)
    expect(await read(1)).toEqual({ page: 1, tip: 'v2' })
    expect(await read(2)).toEqual({ page: 2, tip: 'v1' })
  })
})

describe('createPageCache failure semantics', () => {
  // The outage case must be no worse than before this module bounded staleness: a too-old entry whose
  // recompute fails is served (and logged), because the alternative is an empty page or a 500 for a
  // list that was fine a minute ago. The normal case never gets here: it is fresh.

  it('(b) a cold miss that rejects propagates, and stores nothing', async () => {
    const boom = new Error('db down')
    const query = vi.fn<(page: number) => Promise<string>>()
    query.mockRejectedValueOnce(boom).mockResolvedValueOnce('ok')
    const read = createPageCache('t', 60, query)

    await expect(read(1)).rejects.toBe(boom)
    expect(swallow).not.toHaveBeenCalled()
    expect(store.size).toBe(0)
    expect(await read(1)).toBe('ok')
  })

  it('(a) a too-old entry whose recompute rejects serves the old value and logs the failure', async () => {
    const boom = new Error('db down')
    const query = vi.fn<(page: number) => Promise<string>>()
    query.mockResolvedValueOnce('old').mockRejectedValue(boom)
    const read = createPageCache('t', 60, query)
    await read(1)

    vi.setSystemTime(T0 + 30 * 60 * SECOND)

    expect(await read(1)).toBe('old')
    expect(swallow).toHaveBeenCalledTimes(1)
    expect(swallow).toHaveBeenCalledWith('page-cache/t:stale-on-error', boom)
    await settle()
  })

  it('(c) a fresh entry never reaches the query, even one that would reject', async () => {
    const query = vi.fn<(page: number) => Promise<string>>()
    query.mockResolvedValueOnce('ok').mockRejectedValue(new Error('db down'))
    const read = createPageCache('t', 60, query)
    await read(1)

    vi.setSystemTime(T0 + 10 * SECOND)

    expect(await read(1)).toBe('ok')
    expect(query).toHaveBeenCalledTimes(1)
    expect(swallow).not.toHaveBeenCalled()
  })

  it('caches nothing from a failure: the stored entry keeps its old stamp and the next read recovers', async () => {
    const boom = new Error('db down')
    const query = vi.fn<(page: number) => Promise<string>>()
    query.mockResolvedValueOnce('old').mockRejectedValueOnce(boom).mockRejectedValueOnce(boom).mockResolvedValue('new')
    const read = createPageCache('t', 60, query)
    await read(1)
    const before = [...store.values()].map(e => e.body)

    vi.setSystemTime(T0 + 90 * SECOND)
    expect(await read(1)).toBe('old')
    await settle()
    expect([...store.values()].map(e => e.body)).toEqual(before)

    expect(await read(1)).toBe('new')
  })

  it('does not serve an entry with no usable stamp on error: there is nothing trustworthy to serve', async () => {
    const boom = new Error('db down')
    const query = vi.fn<(page: number) => Promise<unknown>>()
    query.mockResolvedValueOnce('old').mockRejectedValue(boom)
    const read = createPageCache('t', 60, query)
    await read(1)
    for (const [id, entry] of store) store.set(id, { ...entry, body: JSON.stringify({ bare: 'value' }) })

    await expect(read(1)).rejects.toBe(boom)
    expect(swallow).not.toHaveBeenCalled()
  })
})

describe('createPageCache recomputes a too-old entry once for all concurrent readers', () => {
  // A slow query, so the readers genuinely overlap. Next's own refresh is off (see the top of the file).
  function slowSource() {
    const state = { value: 'v1', calls: 0, fail: null as Error | null }
    const query = vi.fn(async (page: number = 1) => {
      state.calls++
      await new Promise(resolve => setTimeout(resolve, 100))
      if (state.fail) throw state.fail
      return { page, tip: state.value }
    })
    return { state, query }
  }
  async function warm(read: (page: number) => Promise<unknown>, page = 1) {
    const first = read(page)
    await vi.advanceTimersByTimeAsync(100)
    await first
  }
  const CONCURRENT = 8

  it('runs one query for N concurrent stale reads, and every reader gets the fresh value', async () => {
    refresh.on = false
    const { state, query } = slowSource()
    const read = createPageCache('t', 60, query)
    await warm(read)
    state.value = 'v2'
    vi.setSystemTime(T0 + 30 * 60 * SECOND)
    state.calls = 0

    const reads = Array.from({ length: CONCURRENT }, () => read(1))
    await vi.advanceTimersByTimeAsync(100)

    expect(await Promise.all(reads)).toEqual(Array(CONCURRENT).fill({ page: 1, tip: 'v2' }))
    expect(state.calls).toBe(1)
  })

  it('forgets the flight once it settles: a later stale read queries again', async () => {
    refresh.on = false
    const { state, query } = slowSource()
    const read = createPageCache('t', 60, query)
    await warm(read)
    vi.setSystemTime(T0 + 30 * 60 * SECOND)
    state.calls = 0

    const first = read(1)
    await vi.advanceTimersByTimeAsync(100)
    await first
    expect(state.calls).toBe(1)

    // The stand-in's entry is still stale (its refresh is off), so this read recomputes again.
    state.value = 'v2'
    const second = read(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(await second).toEqual({ page: 1, tip: 'v2' })
    expect(state.calls).toBe(2)
  })

  it('shares a failed recompute too: one query, every reader gets the old value, and the next read retries', async () => {
    refresh.on = false
    const boom = new Error('db down')
    const { state, query } = slowSource()
    const read = createPageCache('t', 60, query)
    await warm(read)
    vi.setSystemTime(T0 + 30 * 60 * SECOND)
    state.calls = 0
    state.fail = boom

    const reads = Array.from({ length: CONCURRENT }, () => read(1))
    await vi.advanceTimersByTimeAsync(100)

    expect(await Promise.all(reads)).toEqual(Array(CONCURRENT).fill({ page: 1, tip: 'v1' }))
    expect(state.calls).toBe(1)
    expect(swallow).toHaveBeenCalledTimes(CONCURRENT)

    state.fail = null
    state.value = 'v2'
    const retry = read(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(await retry).toEqual({ page: 1, tip: 'v2' })
    expect(state.calls).toBe(2)
  })

  it('does not share across different arguments', async () => {
    refresh.on = false
    const { state, query } = slowSource()
    const read = createPageCache('t', 60, query)
    await warm(read, 1)
    await warm(read, 2)
    vi.setSystemTime(T0 + 30 * 60 * SECOND)
    state.calls = 0

    const reads = [read(1), read(2), read(1), read(2)]
    await vi.advanceTimersByTimeAsync(100)

    expect((await Promise.all(reads)).map(r => (r as { page: number }).page)).toEqual([1, 2, 1, 2])
    expect(state.calls).toBe(2)
  })

  it('does not share across different caches that happen to take the same arguments', async () => {
    refresh.on = false
    const a = slowSource()
    const b = slowSource()
    const readA = createPageCache('cache-a', 60, a.query)
    const readB = createPageCache('cache-b', 60, b.query)
    await warm(readA)
    await warm(readB)
    vi.setSystemTime(T0 + 30 * 60 * SECOND)
    a.state.calls = 0
    b.state.calls = 0

    const reads = [readA(1), readB(1)]
    await vi.advanceTimersByTimeAsync(100)
    await Promise.all(reads)

    expect([a.state.calls, b.state.calls]).toEqual([1, 1])
  })
})

describe('createPageCache entries are self-describing and JSON-safe', () => {
  it('stamps the entry with a plain number, never a BigInt or a Date', async () => {
    // JSON.stringify throws on a BigInt inside Next's cache write, which silently voids the cache (#122).
    // The stamp is the one value this module adds to what callers cache, so it must survive that write.
    const { query } = source()
    const read = createPageCache('t', 60, query)
    await read(1)

    const bodies = [...store.values()].map(e => JSON.parse(e.body as string))
    expect(bodies).toHaveLength(1)
    expect(typeof bodies[0].at).toBe('number')
    expect(bodies[0].value).toEqual({ page: 1, tip: 'v1' })
  })

  it.each([
    ['a bare value from the previous shape', { page: 1, tip: 'bare' }],
    ['null', null],
    ['a string', 'bare'],
    ['a stamp that is not a number', { at: 'yesterday', value: { page: 1, tip: 'bare' } }],
  ])('treats an entry with no usable stamp as too old rather than serving it: %s', async (_label, body) => {
    // The data cache can outlive a deploy (see whales.ts). A bare value written by the previous shape
    // has no `at`: `Date.now() - undefined` is NaN, and NaN > bound is false, so the naive comparison
    // would hand back `undefined` for the whole TTL.
    const { state, query } = source()
    const read = createPageCache('t', 60, query)
    await read(1)
    for (const [id, entry] of store) store.set(id, { ...entry, body: JSON.stringify(body) })
    state.value = 'v2'

    expect(await read(1)).toEqual({ page: 1, tip: 'v2' })
  })

  it('treats an entry from the future as too old (the clock stepped back)', async () => {
    const { state, query } = source()
    const read = createPageCache('t', 60, query)
    await read(1)
    state.value = 'v2'

    vi.setSystemTime(T0 - 60 * 60 * SECOND)

    expect(await read(1)).toEqual({ page: 1, tip: 'v2' })
  })
})

describe('createPageCache puts a deadline on the inline recompute', () => {
  // A query can hang: statement_timeout is opt-in and does not fire on a dead socket. Without a
  // deadline one hung recompute pins every too-old reader of that key for as long as it hangs, where
  // serving the old entry used to be instant. Distinct cache names throughout, so a flight that never
  // settles cannot leak into another test through the module-level in-flight map.
  const PENDING = Symbol('pending')
  /** The promise's value if it has settled by now, PENDING if not (never waits). */
  const peek = <T,>(p: Promise<T>) => Promise.race([p, Promise.resolve(PENDING)])

  /** A cache that has one good entry, then a query that never answers. */
  async function hung(name: string) {
    const query = vi.fn<(page: number) => Promise<string>>()
    query.mockResolvedValueOnce('old')
    const read = createPageCache(name, 60, query)
    await read(1)
    query.mockImplementation(() => new Promise<string>(() => {}))
    vi.setSystemTime(T0 + 30 * 60 * SECOND)
    return { query, read }
  }

  it('is the existing page deadline: DB_TIMEOUT_MS', () => {
    expect(DB_TIMEOUT_MS).toBe(8000)
  })

  it('serves the old value and logs once the deadline passes on a never-settling query', async () => {
    refresh.on = false
    const { read } = await hung('hang-serve')

    const reader = read(1)
    await vi.advanceTimersByTimeAsync(DB_TIMEOUT_MS - 1)
    expect(await peek(reader)).toBe(PENDING)
    expect(swallow).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(await peek(reader)).toBe('old')
    expect(swallow).toHaveBeenCalledTimes(1)
    expect(swallow).toHaveBeenCalledWith('page-cache/hang-serve:stale-on-error', expect.objectContaining({ message: 'query timeout' }))
  })

  it('shares one hung flight between concurrent readers, and all of them get the old value at the deadline', async () => {
    refresh.on = false
    const { query, read } = await hung('hang-shared')
    query.mockClear()

    const readers = Array.from({ length: 5 }, () => read(1))
    await vi.advanceTimersByTimeAsync(DB_TIMEOUT_MS)

    expect(await Promise.all(readers.map(peek))).toEqual(Array(5).fill('old'))
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('clears the flight when the deadline fires: a later stale read starts a new one', async () => {
    refresh.on = false
    const { query, read } = await hung('hang-clears')
    query.mockClear()

    const first = read(1)
    await vi.advanceTimersByTimeAsync(DB_TIMEOUT_MS)
    expect(await peek(first)).toBe('old')
    expect(query).toHaveBeenCalledTimes(1)

    // The hung promise is still pending somewhere; the map must not be waiting on it.
    query.mockResolvedValueOnce('new')
    const second = read(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(await peek(second)).toBe('new')
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('lets a slow recompute that beats the deadline return its fresh value', async () => {
    refresh.on = false
    // The value changes between the warm read and the recompute: with one fixed answer for both, a
    // reader handed the old entry would be indistinguishable from one handed the fresh recompute.
    const state = { tip: 'v1' }
    const query = vi.fn(async (page: number) => {
      await new Promise(resolve => setTimeout(resolve, 5 * SECOND))
      return { page, tip: state.tip }
    })
    const read = createPageCache('slow-ok', 60, query)
    const warm = read(1)
    await vi.advanceTimersByTimeAsync(5 * SECOND)
    await warm
    state.tip = 'v2'
    vi.setSystemTime(T0 + 30 * 60 * SECOND)

    const reader = read(1)
    await vi.advanceTimersByTimeAsync(5 * SECOND)

    expect(await peek(reader)).toEqual({ page: 1, tip: 'v2' })
    expect(swallow).not.toHaveBeenCalled()
  })

  it('does not apply to a cold miss: a first read slower than the deadline still resolves', async () => {
    const query = vi.fn(async (page: number) => {
      await new Promise(resolve => setTimeout(resolve, 3 * DB_TIMEOUT_MS))
      return page
    })
    const read = createPageCache('cold-slow', 60, query)

    const reader = read(1)
    await vi.advanceTimersByTimeAsync(3 * DB_TIMEOUT_MS)

    expect(await peek(reader)).toBe(1)
    expect(swallow).not.toHaveBeenCalled()
  })
})

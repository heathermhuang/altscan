import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPageCache } from '@/lib/page-cache'

// A stand-in for Next 15.5's `unstable_cache` on a dynamic route, written from
// next/dist/server/web/spec-extension/unstable-cache.js. The real one throws outside a Next request
// scope, so this is the only way to drive the contract that matters here:
//
//   - the entry is JSON round-tripped (so a BigInt in the value throws, as it does in production);
//   - an entry older than `revalidate` is STILL RETURNED, however old, while a refresh runs in the
//     background (`age > revalidate` -> kick `cb`, then `return cachedResponse`);
//   - a refresh that rejects is swallowed and stores nothing.
//
// That second line is the bug this file pins: after an idle gap the first reader gets the entry as the
// previous reader left it, 27 minutes old on ethscan.io/blocks.
const { store, background, fakeUnstableCache } = vi.hoisted(() => {
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
    if ((Date.now() - entry.storedAt) / 1000 > opts.revalidate) {
      background.push(cb(...args).then(put, () => {}))
    }
    return entry.body === undefined ? undefined : JSON.parse(entry.body)
  }
  return { store, background, fakeUnstableCache }
})
vi.mock('next/cache', () => ({ unstable_cache: fakeUnstableCache }))

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
  it('lets a rejection propagate on a miss, and stores nothing', async () => {
    const boom = new Error('db down')
    const query = vi.fn<(page: number) => Promise<string>>()
    query.mockRejectedValueOnce(boom).mockResolvedValueOnce('ok')
    const read = createPageCache('t', 60, query)

    await expect(read(1)).rejects.toBe(boom)
    expect(await read(1)).toBe('ok')
  })

  it('lets a rejection propagate when the entry is too old, instead of serving it silently', async () => {
    // A page that cannot be queried must say so (callers catch and render their own error state), not
    // show a 27-minute-old list as though it were current.
    const boom = new Error('db down')
    const query = vi.fn<(page: number) => Promise<string>>()
    query.mockResolvedValueOnce('old').mockRejectedValue(boom)
    const read = createPageCache('t', 60, query)
    await read(1)

    vi.setSystemTime(T0 + 30 * 60 * SECOND)
    await expect(read(1)).rejects.toBe(boom)
    await settle()
  })

  it('does not let a failed refresh poison the entry: the next read recovers', async () => {
    const boom = new Error('db down')
    const query = vi.fn<(page: number) => Promise<string>>()
    query.mockResolvedValueOnce('old').mockRejectedValueOnce(boom).mockRejectedValueOnce(boom).mockResolvedValue('new')
    const read = createPageCache('t', 60, query)
    await read(1)

    vi.setSystemTime(T0 + 90 * SECOND)
    await expect(read(1)).rejects.toBe(boom)
    await settle()

    expect(await read(1)).toBe('new')
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

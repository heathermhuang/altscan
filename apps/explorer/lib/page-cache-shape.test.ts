import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPageCache } from '@/lib/page-cache'

// vi.hoisted, because vi.mock's factory is hoisted above the const declarations
// it would otherwise close over. The real unstable_cache throws outside a Next
// request scope, so counting the wrapper is the only way to check the shape.
const { unstableCacheSpy } = vi.hoisted(() => ({ unstableCacheSpy: vi.fn((fn: unknown) => fn) }))
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => unstableCacheSpy(fn) }))

beforeEach(() => { unstableCacheSpy.mockClear() })

describe('the cache wrapper is built once, not per request', () => {
  it('calls unstable_cache exactly once, at construction, and never per read', async () => {
    const read = createPageCache('t', 60, async (page: number) => page)
    expect(unstableCacheSpy).toHaveBeenCalledTimes(1)

    // The shipped bug built a new wrapper around a new closure on EVERY request,
    // so Next derived a new cache id every time and every lookup missed —
    // silently, with no error and no failing test. /blocks advanced its top
    // block four times in ten seconds on a 60s TTL, while /gas, static ISR on
    // the same incremental cache, reported x-nextjs-cache: HIT.
    await read(1)
    await read(2)
    await read(1)
    expect(unstableCacheSpy).toHaveBeenCalledTimes(1)
  })

  it('hands unstable_cache one stable function at construction, not a per-request closure', async () => {
    // It used to be the query itself. It is now a module-scope wrapper that stamps the entry with the
    // time it was computed (see page-cache.ts), so identity with `query` is no longer the property:
    // what matters is that Next gets exactly one function, up front, and the same one forever.
    const read = createPageCache('t2', 60, async (page: number) => page)
    expect(unstableCacheSpy).toHaveBeenCalledTimes(1)
    const handed = unstableCacheSpy.mock.calls[0][0]
    expect(typeof handed).toBe('function')

    await read(1)
    await read(2)
    expect(unstableCacheSpy).toHaveBeenCalledTimes(1)
    expect(unstableCacheSpy.mock.calls[0][0]).toBe(handed)
  })
})

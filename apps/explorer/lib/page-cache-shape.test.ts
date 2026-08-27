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

  it('hands unstable_cache the query itself, not a per-request closure', () => {
    const query = async (page: number) => page
    createPageCache('t2', 60, query)
    expect(unstableCacheSpy).toHaveBeenCalledWith(query)
  })
})

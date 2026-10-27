import { describe, expect, it } from 'vitest'
import { SharedCacheControls } from 'next/dist/server/lib/incremental-cache/shared-cache-controls.external.js'
import { IncrementalCache } from 'next/dist/server/lib/incremental-cache'
import { loadIsrCacheControls, trimOldest } from './isr-cache-controls-cap'

describe('trimOldest', () => {
  it('deletes the oldest-inserted entries down to the cap', () => {
    const map = new Map(['a', 'b', 'c', 'd', 'e'].map((k) => [k, 1]))
    expect(trimOldest(map, 2)).toBe(3)
    expect([...map.keys()]).toEqual(['d', 'e'])
  })

  it('leaves a map at or under the cap alone', () => {
    const map = new Map([['a', 1], ['b', 1]])
    expect(trimOldest(map, 2)).toBe(0)
    expect(trimOldest(new Map(), 0)).toBe(0)
    expect([...map.keys()]).toEqual(['a', 'b'])
  })
})

// These pin Next internals the cap depends on. If a Next upgrade fails here, the
// cap has stopped working (or stopped being safe): re-check before bumping.
describe('Next ISR cache-control contract', () => {
  it('loads the static Map that SharedCacheControls#set writes to', async () => {
    const map = await loadIsrCacheControls()
    new SharedCacheControls({ routes: {}, dynamicRoutes: {} }).set('/__cap_test__', { revalidate: 60, expire: undefined })
    expect(map.has('/__cap_test__')).toBe(true)
    map.delete('/__cap_test__')
  })

  it('has no cache control for a runtime path whose entry was trimmed', () => {
    const owner = { kind: 'APP_PAGE', sourceRoute: '/tx/[hash]/page' } as const
    const controls = new SharedCacheControls({ routes: {}, dynamicRoutes: {} })
    expect(controls.get('/tx/0xtrimmed', owner as never)).toBeUndefined()
  })

  it('revalidates an entry with no cache control after 1 second, not never', () => {
    const calculateRevalidate = (IncrementalCache.prototype as unknown as {
      calculateRevalidate: (cc: undefined, from: number, dev: boolean, isFallback: boolean) => number | false
    }).calculateRevalidate
    expect(calculateRevalidate.call({}, undefined, 0, false, false)).toBe(1000)
  })
})

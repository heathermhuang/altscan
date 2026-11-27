import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createTtlCache } from './ttl-cache'
import { getCacheSizes } from './cache-registry'

const mk = (max = 3, ttlMs = 100) => {
  const now = { t: 0 }
  return { now, cache: createTtlCache<string | null>({ max, ttlMs, clock: () => now.t }) }
}

describe('createTtlCache', () => {
  it('serves an entry until its TTL, then misses and drops it', () => {
    const { now, cache } = mk()
    cache.set('a', 'A')
    now.t = 99
    expect(cache.get('a')).toBe('A')
    now.t = 100
    expect(cache.get('a')).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('a cached null is a hit, distinct from a miss', () => {
    const { cache } = mk()
    cache.set('gone', null)
    expect(cache.get('gone')).toBeNull()
    expect(cache.get('never')).toBeUndefined()
  })

  it('a per-entry TTL overrides the default', () => {
    const { now, cache } = mk(3, 100)
    cache.set('long', 'L', 1000)
    now.t = 500
    expect(cache.get('long')).toBe('L')
  })

  it('never holds more than max, evicting the least recently used', () => {
    const { cache } = mk(3)
    cache.set('a', 'A'); cache.set('b', 'B'); cache.set('c', 'C')
    cache.get('a')                 // touch: b is now the oldest
    cache.set('d', 'D')
    expect(cache.size).toBe(3)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe('A')
  })

  it('re-setting a key refreshes it in place instead of evicting another', () => {
    const { now, cache } = mk(2)
    cache.set('a', 'A'); cache.set('b', 'B')
    now.t = 50
    cache.set('a', 'A2')
    expect(cache.size).toBe(2)
    expect(cache.get('b')).toBe('B')
    now.t = 120                    // past b's TTL, inside a's refreshed one
    expect(cache.get('a')).toBe('A2')
    expect(cache.get('b')).toBeUndefined()
  })

  it('delete and clear', () => {
    const { cache } = mk()
    cache.set('a', 'A'); cache.set('b', 'B')
    cache.delete('a')
    expect(cache.get('a')).toBeUndefined()
    cache.clear()
    expect(cache.size).toBe(0)
  })

  it('a named cache reports its size to /api/health', () => {
    const cache = createTtlCache<number>({ name: 'ttl-cache-test', max: 5, ttlMs: 1000 })
    cache.set('x', 1)
    expect(getCacheSizes()['ttl-cache-test']).toBe(1)
  })
})

// The guard: in-process caches go through createTtlCache, which both bounds them and makes
// them visible to /api/health. Six hand-rolled copies existed; two of them (the code-class
// verdicts and the transaction-lookup hits) were never registered, so their memory was
// invisible. registerCache stays legal only for a store that is not a TTL map: the Moralis
// kv-cache fallback, which lives in @altscan/explorer-core.
const ROOT = join(__dirname, '..')
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) return []
    if (statSync(p).isDirectory()) return sources(p)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}
const rel = (f: string) => f.slice(ROOT.length + 1)

describe('one in-process cache implementation', () => {
  const files = sources(ROOT)

  it('registerCache is called only by createTtlCache and the kv-cache fallback', () => {
    const callers = files.filter((f) => /\bregisterCache\(/.test(readFileSync(f, 'utf8'))).map(rel).sort()
    expect(callers).toEqual(['lib/cache-registry.ts', join('lib', 'providers', 'index.ts'), 'lib/ttl-cache.ts'].sort())
  })

  it('no module hand-rolls oldest-entry eviction', () => {
    const evicts = /\.keys\(\)\.next\(\)/
    const hits = files.filter((f) => evicts.test(readFileSync(f, 'utf8'))).map(rel)
    expect(hits).toEqual(['lib/ttl-cache.ts'])
  })
})

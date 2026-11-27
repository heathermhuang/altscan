import { afterEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { positiveIntEnv } from './env'

afterEach(() => { vi.unstubAllEnvs() })

describe('positiveIntEnv', () => {
  it('reads a positive whole number', () => {
    vi.stubEnv('X_TEST_INT', '42')
    expect(positiveIntEnv('X_TEST_INT', 7)).toBe(42)
  })

  it('falls back on unset, empty, zero, negative, fractional and garbage', () => {
    expect(positiveIntEnv('X_TEST_UNSET', 7)).toBe(7)
    for (const v of ['', '0', '-5', '1.5', 'abc', '2h', 'NaN']) {
      vi.stubEnv('X_TEST_INT', v)
      expect(positiveIntEnv('X_TEST_INT', 7), v).toBe(7)
    }
  })
})

// The guard: env tunables go through positiveIntEnv. A hand-rolled parse is how
// BODY_CACHE_TTL_MS=2h became a 2 ms TTL.
const ROOT = join(__dirname, '..')
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) return []
    if (statSync(p).isDirectory()) return sources(p)
    return /\.(ts|tsx|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}

describe('one env number parser in apps/explorer', () => {
  it('nothing else parses a number out of process.env', () => {
    const parse = /\b(?:Number|parseInt|parseFloat)\(\s*process\.env\b|positiveInt\(\s*process\.env\b/
    const hits = sources(ROOT).filter((f) => parse.test(readFileSync(f, 'utf8'))).map((f) => f.slice(ROOT.length + 1))
    expect(hits).toEqual(['lib/env.ts'])   // itself: the scan sees what it bans
    for (const s of ['Number(process.env.X)', 'parseInt(process.env.X ?? "1", 10)', 'positiveInt(process.env.X, 5)']) expect(parse.test(s)).toBe(true)
  })
})

// Each environment variable has one owning module, which reads it and exports what it means.
// That is why the explorer has no env registry: every variable is already read in exactly one
// place, and a registry would only forward the read. A second reader is where two parses of
// one variable start to disagree. NODE_ENV and NEXT_RUNTIME are the framework's, read freely.
describe('one owner per environment variable in apps/explorer', () => {
  it('no variable is read in two files', () => {
    const read = /process\.env\.([A-Z_0-9]+)|positiveIntEnv\('([A-Z_0-9]+)'/g
    const owners = new Map<string, Set<string>>()
    for (const f of sources(ROOT)) {
      for (const m of readFileSync(f, 'utf8').matchAll(read)) {
        const name = m[1] ?? m[2]
        if (name === 'NODE_ENV' || name === 'NEXT_RUNTIME') continue
        owners.set(name, (owners.get(name) ?? new Set()).add(f.slice(ROOT.length + 1)))
      }
    }
    const shared = [...owners].filter(([, files]) => files.size > 1).map(([name, files]) => `${name}: ${[...files].join(', ')}`)
    expect(shared).toEqual([])
    expect(owners.has('BODY_CACHE_TTL_MS') && owners.has('OAUTH_SECRET')).toBe(true) // the scan sees both read styles
  })
})

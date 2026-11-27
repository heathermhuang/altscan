import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { rateLimitResponse } from './api-rate-limit'

describe('rateLimitResponse', () => {
  it('is the documented 429 body', async () => {
    const res = rateLimitResponse()
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'Rate limit exceeded' })
  })

  it('carries extra headers when given', () => {
    expect(rateLimitResponse({ 'cache-control': 'no-store' }).headers.get('cache-control')).toBe('no-store')
  })
})

// The guard: the 429 body is one definition. Fourteen routes spelled it out.
const ROOT = join(__dirname, '..')
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) return []
    if (statSync(p).isDirectory()) return sources(p)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}

describe('one 429 body in apps/explorer', () => {
  it('no other module builds it', () => {
    const body = /error:\s*'Rate limit exceeded'/
    const hits = sources(ROOT).filter((f) => body.test(readFileSync(f, 'utf8'))).map((f) => f.slice(ROOT.length + 1))
    expect(hits).toEqual(['lib/api-rate-limit.ts'])
  })
})

import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { API_SURFACE } from '@/lib/api-surface'

const appDir = fileURLToPath(new URL('../app', import.meta.url))

/** '/api/v1/tokens/:contract' -> 'app/api/v1/tokens/[address]/route.ts' */
function routeFileFor(path: string): string {
  const segments = path.replace(/^\//, '').split('/')
    .map(s => (s.startsWith(':') ? '[address]' : s))
  return `${appDir}/${segments.join('/')}/route.ts`
}

describe('API_SURFACE', () => {
  it('is not empty', () => {
    expect(API_SURFACE.length).toBeGreaterThan(0)
  })

  // The guard. Three documents drifted from the route tree independently and
  // shipped five 404s, because nothing checked them.
  it.each(API_SURFACE)('$path has a route handler on disk', ({ path, routeFile }) => {
    const file = routeFile ? `${appDir}/${routeFile}` : routeFileFor(path)
    expect(existsSync(file), `${path} advertised but ${file} does not exist`).toBe(true)
  })
})

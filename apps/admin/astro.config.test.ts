import { describe, expect, it } from 'vitest'
import config from './astro.config.mjs'

/**
 * The admin console's PUT/POST endpoints authenticate with a Cloudflare Access
 * cookie, which a cross-site request would carry. Astro's `security.checkOrigin`
 * is the only CSRF defence in front of them, and it is a default that a framework
 * upgrade or a careless edit could change without any diff here. Pin it.
 */
describe('apps/admin astro.config', () => {
  it('states security.checkOrigin: true explicitly instead of relying on the default', () => {
    expect(config.security).toEqual({ checkOrigin: true })
  })

  it('serves everything per-request, which is what makes checkOrigin apply', () => {
    // Astro only enables the origin-check middleware for `server` output.
    expect(config.output).toBe('server')
  })
})

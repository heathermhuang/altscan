import { describe, it, expect } from 'vitest'
import { resolveAllowOrigin, corsHeaders } from '@/lib/cors'

const ALLOWED = ['https://bnbscan.com', 'https://ethscan.io']

describe('resolveAllowOrigin', () => {
  it('echoes an allowed origin', () => {
    expect(resolveAllowOrigin('https://ethscan.io', ALLOWED)).toBe('https://ethscan.io')
  })

  it('returns null for an origin not on the list', () => {
    expect(resolveAllowOrigin('https://evil.example', ALLOWED)).toBeNull()
  })

  it('returns null when there is no Origin header', () => {
    expect(resolveAllowOrigin(null, ALLOWED)).toBeNull()
  })

  it('never returns a comma-joined list — the shipped bug', () => {
    for (const origin of [...ALLOWED, 'https://evil.example', null]) {
      const got = resolveAllowOrigin(origin, ALLOWED)
      if (got !== null) expect(got).not.toContain(',')
    }
  })

  it('does not match on prefix', () => {
    expect(resolveAllowOrigin('https://bnbscan.com.evil.example', ALLOWED)).toBeNull()
  })
})

describe('corsHeaders', () => {
  it('sets Vary: Origin so caches cannot serve one site the other’s header', () => {
    const h = corsHeaders('https://ethscan.io', ALLOWED)
    expect(h['Vary']).toBe('Origin')
    expect(h['Access-Control-Allow-Origin']).toBe('https://ethscan.io')
  })

  it('omits the allow-origin header entirely for a disallowed origin', () => {
    const h = corsHeaders('https://evil.example', ALLOWED)
    expect(h['Access-Control-Allow-Origin']).toBeUndefined()
    expect(h['Vary']).toBe('Origin')
  })
})

import { describe, expect, it } from 'vitest'
import { redactAuditPayload, redactRpcValue, redactSettingsPayload } from './redact'

const KEYED = 'https://bnb-mainnet.core.chainstack.com/SECRETKEY123'

describe('redactRpcValue', () => {
  it('strips everything but the host from a keyed RPC URL', () => {
    const out = redactRpcValue({ webRpcUrl: KEYED, rpcTimeoutMs: 9000 }) as Record<string, unknown>
    expect(String(out.webRpcUrl)).not.toContain('SECRETKEY123')
    expect(String(out.webRpcUrl)).toContain('bnb-mainnet.core.chainstack.com')
    expect(out.rpcTimeoutMs).toBe(9000) // non-secret fields survive
  })

  it('produces a non-URL placeholder so it cannot be round-tripped into a save', () => {
    const out = redactRpcValue({ webRpcUrl: KEYED }) as { webRpcUrl: string }
    expect(() => new URL(out.webRpcUrl)).toThrow()
  })

  it('passes through values with no url, and non-objects', () => {
    expect(redactRpcValue({ rpcTimeoutMs: 5000 })).toEqual({ rpcTimeoutMs: 5000 })
    expect(redactRpcValue(null)).toBeNull()
    expect(redactRpcValue('nope')).toBe('nope')
    expect(redactRpcValue([1, 2])).toEqual([1, 2])
  })

  it('does not throw on a malformed stored url', () => {
    const out = redactRpcValue({ webRpcUrl: 'not a url' }) as { webRpcUrl: string }
    expect(out.webRpcUrl).toContain('invalid')
  })
})

describe('redactSettingsPayload', () => {
  it('redacts only the rpc namespace and leaves the rest intact', () => {
    const body = {
      chain: 'bnb',
      settings: {
        footer: { value: { tagline: 'hi' }, version: 2 },
        rpc: { value: { webRpcUrl: KEYED }, version: 3 },
      },
    }
    const out = redactSettingsPayload(body) as typeof body
    expect(JSON.stringify(out)).not.toContain('SECRETKEY123')
    expect(out.settings.footer.value).toEqual({ tagline: 'hi' })
    expect(out.settings.rpc.version).toBe(3) // metadata preserved
    expect(out.chain).toBe('bnb')
  })

  it('is a no-op when there is no rpc row', () => {
    const body = { settings: { footer: { value: {}, version: 1 } } }
    expect(redactSettingsPayload(body)).toEqual(body)
  })
})

describe('redactAuditPayload', () => {
  it('redacts every historical value, not just the newest', () => {
    const body = {
      entries: [
        { id: 2, version: 2, value: { webRpcUrl: KEYED } },
        { id: 1, version: 1, value: { webRpcUrl: 'https://old.test/OTHERKEY' } },
      ],
    }
    const out = JSON.stringify(redactAuditPayload(body))
    expect(out).not.toContain('SECRETKEY123')
    expect(out).not.toContain('OTHERKEY')
    expect(out).toContain('old.test')
  })

  it('is a no-op without an entries array', () => {
    expect(redactAuditPayload({ error: 'nope' })).toEqual({ error: 'nope' })
  })
})

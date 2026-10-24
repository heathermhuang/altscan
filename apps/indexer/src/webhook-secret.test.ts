import { describe, expect, it } from 'vitest'
import crypto from 'crypto'
import { openSigningKey, parseWebhookSecretKey, sealSigningKey } from './webhook-secret'

const KEY = crypto.randomBytes(32)
const SIGNING_KEY = crypto.createHash('sha256').update('raw secret').digest('hex') // what webhooks.secret holds

describe('parseWebhookSecretKey', () => {
  it('is null when unset or blank: sealing is opt-in', () => {
    expect(parseWebhookSecretKey('')).toBeNull()
    expect(parseWebhookSecretKey('   ')).toBeNull()
  })
  it('accepts 64 hex characters as a 32-byte key', () => {
    expect(parseWebhookSecretKey('ab'.repeat(32))).toEqual(Buffer.from('ab'.repeat(32), 'hex'))
  })
  it.each([
    ['63 characters', 'a'.repeat(63)],
    ['65 characters', 'a'.repeat(65)],
    ['non-hex', 'z'.repeat(64)],
    ['base64', crypto.randomBytes(32).toString('base64')],
  ])('rejects %s rather than deriving some other key', (_label, raw) => {
    expect(() => parseWebhookSecretKey(raw)).toThrow(/64 hex/)
  })
})

describe('sealSigningKey / openSigningKey', () => {
  it('round-trips the signing key exactly', () => {
    expect(openSigningKey(sealSigningKey(SIGNING_KEY, KEY, 7), KEY, 7)).toBe(SIGNING_KEY)
  })

  it('never stores the signing key itself, and seals it differently each time', () => {
    const a = sealSigningKey(SIGNING_KEY, KEY, 7)
    const b = sealSigningKey(SIGNING_KEY, KEY, 7)
    expect(a).not.toContain(SIGNING_KEY)
    expect(a).not.toBe(b)
    expect(a.startsWith('v1.')).toBe(true)
  })

  it('fails under the wrong key', () => {
    expect(() => openSigningKey(sealSigningKey(SIGNING_KEY, KEY, 7), crypto.randomBytes(32), 7)).toThrow()
  })

  it('fails for another webhook: a sealed key cannot be moved to a different row', () => {
    expect(() => openSigningKey(sealSigningKey(SIGNING_KEY, KEY, 7), KEY, 8)).toThrow()
  })

  it('fails when the ciphertext or tag is altered or the tag is truncated', () => {
    const [v, iv, tag, ct] = sealSigningKey(SIGNING_KEY, KEY, 7).split('.')
    const flip = (s: string) => {
      const b = Buffer.from(s, 'base64url'); b[0] ^= 1; return b.toString('base64url')
    }
    expect(() => openSigningKey([v, iv, tag, flip(ct)].join('.'), KEY, 7)).toThrow()
    expect(() => openSigningKey([v, iv, flip(tag), ct].join('.'), KEY, 7)).toThrow()
    const short = Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url')
    expect(() => openSigningKey([v, iv, short, ct].join('.'), KEY, 7)).toThrow()
  })

  it('refuses an unknown format version', () => {
    const sealed = sealSigningKey(SIGNING_KEY, KEY, 7).replace(/^v1\./, 'v9.')
    expect(() => openSigningKey(sealed, KEY, 7)).toThrow(/version/)
  })
})

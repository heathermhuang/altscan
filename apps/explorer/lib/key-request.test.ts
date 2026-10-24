import { describe, expect, it } from 'vitest'
import { keyRequestTimestampError, SIG_MAX_SKEW_MS } from './key-request'

const NOW = 1_760_000_000_000

describe('keyRequestTimestampError', () => {
  it('accepts a timestamp within the skew window either way', () => {
    expect(keyRequestTimestampError(NOW, NOW)).toBeNull()
    expect(keyRequestTimestampError(NOW - SIG_MAX_SKEW_MS, NOW)).toBeNull()
    expect(keyRequestTimestampError(NOW + SIG_MAX_SKEW_MS, NOW)).toBeNull()
  })

  it('rejects a timestamp older than the window', () => {
    expect(keyRequestTimestampError(NOW - SIG_MAX_SKEW_MS - 1, NOW)).toBe('Signature expired')
  })

  it('rejects a timestamp ahead of the window, which would otherwise never expire', () => {
    expect(keyRequestTimestampError(NOW + SIG_MAX_SKEW_MS + 1, NOW)).toMatch(/ahead/)
    expect(keyRequestTimestampError(NOW + 86_400_000 * 365, NOW)).toMatch(/ahead/)
  })

  // JSON bodies are untyped. "never" made `Date.now() - timestamp` NaN, and
  // `NaN > limit` is false, so the old check let that signature live forever.
  it.each([
    ['a non-numeric string', 'never'],
    ['a numeric string', String(NOW)],
    ['a fraction', NOW + 0.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null],
    ['an object', { valueOf: () => NOW }],
  ])('rejects %s', (_label, value) => {
    expect(keyRequestTimestampError(value, NOW)).toMatch(/integer/)
  })
})

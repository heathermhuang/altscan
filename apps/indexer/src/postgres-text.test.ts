import { describe, expect, it } from 'vitest'
import { sanitizeNullableText, sanitizeTokenMetadata } from './postgres-text'

describe('sanitizeTokenMetadata', () => {
  it('removes NUL/control bytes that Postgres text columns reject', () => {
    expect(sanitizeTokenMetadata('Bad\u0000Token\u0007', 'Unknown', 255)).toBe('BadToken')
  })

  it('falls back when metadata becomes empty after sanitization', () => {
    expect(sanitizeTokenMetadata('\u0000\u0007', '???', 50)).toBe('???')
  })

  it('truncates sanitized metadata to the target column length', () => {
    expect(sanitizeTokenMetadata('abcdef', 'Unknown', 3)).toBe('abc')
  })
})

describe('sanitizeNullableText', () => {
  it('removes the NUL byte that makes Postgres reject the whole INSERT', () => {
    expect(sanitizeNullableText('Bad\u0000Token\u0007', 64)).toBe('BadToken')
  })

  it('preserves a genuine absence as NULL instead of inventing a placeholder', () => {
    // token_symbol / category / summary / value_formatted are legitimately
    // absent on plenty of rows. sanitizeTokenMetadata's fallback would
    // fabricate a '???' symbol for every one of them, so the nullable columns
    // need their own sibling rather than a reused fallback.
    expect(sanitizeNullableText(null, 64)).toBeNull()
    expect(sanitizeNullableText(undefined, 64)).toBeNull()
  })

  it('returns NULL when the value sanitizes away to nothing', () => {
    expect(sanitizeNullableText('\u0000\u0007', 64)).toBeNull()
    expect(sanitizeNullableText('   ', 64)).toBeNull()
  })

  it('truncates to the column width — VARCHAR(64) rejects an over-long symbol', () => {
    expect(sanitizeNullableText('x'.repeat(100), 64)).toHaveLength(64)
  })

  it('does NOT truncate when no width is given — TEXT has none to respect', () => {
    // Capping an unbounded column is not free safety. value_formatted is a
    // decimal string: a token with very high decimals pushes the first
    // significant digit far right, so a cap would silently render a real
    // amount as zero.
    const tiny = '0.' + '0'.repeat(200) + '17'
    expect(sanitizeNullableText(tiny)).toBe(tiny)
    expect(sanitizeNullableText('x'.repeat(5000))).toHaveLength(5000)
  })

  it('keeps tab/newline/carriage-return, which Postgres text stores fine', () => {
    expect(sanitizeNullableText('a\tb\nc', 64)).toBe('a\tb\nc')
  })
})

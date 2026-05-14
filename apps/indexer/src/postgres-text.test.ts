import { describe, expect, it } from 'vitest'
import { sanitizeTokenMetadata } from './postgres-text'

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

import { describe, expect, it } from 'vitest'
import { isUndefinedTable, normalizeAddresses } from './watch-addresses'

const A = '0x' + 'A'.repeat(40)
const b = '0x' + 'b'.repeat(40)

describe('normalizeAddresses', () => {
  it('lowercases and dedupes', () => {
    expect(normalizeAddresses([A, A.toLowerCase(), b])).toEqual({ ok: true, addresses: ['0x' + 'a'.repeat(40), b] })
  })
  it('names every invalid entry', () => {
    expect(normalizeAddresses([A, '0x123', 7])).toEqual({ ok: false, invalid: ['0x123', '7'] })
  })
  it('refuses an empty or non-array input', () => {
    expect(normalizeAddresses([])).toEqual({ ok: false, invalid: [] })
    expect(normalizeAddresses('0xabc')).toEqual({ ok: false, invalid: [] })
  })
})

describe('isUndefinedTable', () => {
  it('finds SQLSTATE 42P01 on the error or its cause (drizzle wraps driver errors)', () => {
    expect(isUndefinedTable({ code: '42P01' })).toBe(true)
    expect(isUndefinedTable({ message: 'Failed query', cause: { code: '42P01' } })).toBe(true)
    expect(isUndefinedTable({ cause: { code: '23505' } })).toBe(false)
    expect(isUndefinedTable(undefined)).toBe(false)
  })
})

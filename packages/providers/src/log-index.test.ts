import { describe, expect, it } from 'vitest'
import { normalizeLogIndex } from './moralis'

/**
 * A4b (R3) keys backfilled token transfers on (scope_address, tx_hash, log_index).
 * Anything this function lets through becomes a primary-key component, so the
 * contract is narrow on purpose: a non-negative integer, canonicalized, or null.
 */
describe('normalizeLogIndex', () => {
  it('accepts a number and a decimal string identically', () => {
    expect(normalizeLogIndex(7)).toBe('7')
    expect(normalizeLogIndex('7')).toBe('7')
  })

  it('canonicalizes so padded and unpadded forms share one key', () => {
    // '007' and 7 are the same log — they must not become two PK rows.
    expect(normalizeLogIndex('007')).toBe('7')
    expect(normalizeLogIndex(' 42 ')).toBe('42')
  })

  it('accepts zero (a genuine first-log position)', () => {
    expect(normalizeLogIndex(0)).toBe('0')
    expect(normalizeLogIndex('0')).toBe('0')
  })

  it('rejects absence rather than inventing a sentinel', () => {
    // The old code returned '' here, which type-checks as a usable key and
    // silently collides for two absent rows in the same tx.
    expect(normalizeLogIndex(undefined)).toBeNull()
    expect(normalizeLogIndex(null)).toBeNull()
    expect(normalizeLogIndex('')).toBeNull()
    expect(normalizeLogIndex('   ')).toBeNull()
  })

  it('rejects values that are not non-negative integers', () => {
    expect(normalizeLogIndex(-1)).toBeNull()
    expect(normalizeLogIndex('-1')).toBeNull()
    expect(normalizeLogIndex(1.5)).toBeNull()
    expect(normalizeLogIndex('1.5')).toBeNull()
    expect(normalizeLogIndex('abc')).toBeNull()
    expect(normalizeLogIndex('0x7')).toBeNull()
    expect(normalizeLogIndex(NaN)).toBeNull()
    expect(normalizeLogIndex(Infinity)).toBeNull()
  })

  it('rejects values beyond safe integer precision', () => {
    // Past 2^53 the decimal string and Number() disagree, so the canonical form
    // would not round-trip — refuse rather than emit a lossy key.
    expect(normalizeLogIndex('9007199254740993')).toBeNull()
  })
})

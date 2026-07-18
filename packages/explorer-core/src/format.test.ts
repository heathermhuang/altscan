import { describe, expect, it } from 'vitest'
import { sanitizeSymbol } from './format'

/**
 * sanitizeSymbol is a display-safety control: token symbols come straight off
 * chain and are attacker-chosen. The important property is that it NEVER hands
 * back a character it was asked to strip — the previous `|| raw.trim()` fallback
 * did exactly that whenever every character was rejected.
 */
describe('sanitizeSymbol', () => {
  it('passes clean ASCII through unchanged', () => {
    expect(sanitizeSymbol('USDT')).toBe('USDT')
    expect(sanitizeSymbol('  WBNB  ')).toBe('WBNB')
  })

  it('folds Cyrillic and Greek homoglyphs to ASCII', () => {
    // U+0410 U+0412 U+0421 — visually identical to "ABC"
    expect(sanitizeSymbol('АВС')).toBe('ABC')
    // Greek capital Alpha/Beta
    expect(sanitizeSymbol('ΑΒ')).toBe('AB')
  })

  it('returns empty — NOT the raw input — when nothing survives', () => {
    // This is the regression the old fallback caused: these inputs cleaned to
    // '' and were then handed back verbatim, restoring the exact characters
    // the sanitizer exists to remove.
    expect(sanitizeSymbol('‮')).toBe('')       // bidi override
    expect(sanitizeSymbol('​')).toBe('')       // zero-width space
    expect(sanitizeSymbol('💩')).toBe('')
    expect(sanitizeSymbol('💩🔥')).toBe('')
    expect(sanitizeSymbol('')).toBe('')
    expect(sanitizeSymbol('   ')).toBe('')
  })

  it('strips rejected characters out of mixed input', () => {
    expect(sanitizeSymbol('A💩B')).toBe('AB')
    expect(sanitizeSymbol('US‮DT')).toBe('USDT')
  })

  it('bounds the work on oversized input', () => {
    const huge = 'A'.repeat(10_000)
    const out = sanitizeSymbol(huge)
    expect(out.length).toBeLessThanOrEqual(128)
    expect(out).toBe('A'.repeat(128))
  })

  it('bounds oversized input that is entirely confusable', () => {
    expect(sanitizeSymbol('💩'.repeat(5_000))).toBe('')
  })
})

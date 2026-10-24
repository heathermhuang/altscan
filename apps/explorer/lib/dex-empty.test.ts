import { describe, expect, it } from 'vitest'
import { dexEmptyState } from './dex-empty'

describe('dexEmptyState', () => {
  it('a failed read is unavailable, not empty', () => {
    const s = dexEmptyState(true, 'PancakeSwap')
    expect(s.title).toBe('DEX data is temporarily unavailable')
    expect(s.title + s.detail).not.toMatch(/no dex trades/i)
  })

  it('a successful empty read names the primary DEX', () => {
    const s = dexEmptyState(false, 'PancakeSwap')
    expect(s.title).toBe('No DEX trades found')
    expect(s.detail).toContain('PancakeSwap')
  })
})

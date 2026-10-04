import { describe, it, expect } from 'vitest'
import { confirmationWindow } from './confirmation-window'

describe('confirmationWindow', () => {
  it('BNB (0.45s blocks) renders half-second steps, not ~0.45-1.35', () => {
    expect(confirmationWindow(0.45)).toBe('~0.5-1.5 seconds')
  })

  it('ETH (12s blocks) renders integers with no trailing ".0"', () => {
    expect(confirmationWindow(12)).toBe('~12-36 seconds')
  })
})

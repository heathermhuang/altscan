import { describe, it, expect } from 'vitest'
import { computeGasBreakdown } from './gas-breakdown'

describe('computeGasBreakdown', () => {
  // Real values from Ethereum tx 0x0efa479c…e4c4 in block 25736759:
  // gasUsed 656,860 · effective gas price 1 Gwei · block base fee 0.0746 Gwei.
  // Etherscan's total for this tx is 0.00065686 ETH, so burnt + tip must sum
  // to exactly that — this is the arithmetic identity worth pinning.
  it('splits a real fee into burnt + validator tip that sum to the total', () => {
    const b = computeGasBreakdown(656860n, 1_000_000_000n, 74_600_000n)!
    expect(b.total).toBe(656860n * 1_000_000_000n)          // 0.00065686 ETH
    expect(b.burnt).toBe(656860n * 74_600_000n)
    expect(b.priorityTip).toBe(656860n * (1_000_000_000n - 74_600_000n))
    expect(b.burnt + b.priorityTip).toBe(b.total)            // no wei unaccounted for
  })

  it('returns null when the base fee is unknown, rather than guessing zero', () => {
    // A null base fee means pre-EIP-1559 or an un-backfilled block. Treating it
    // as 0 would report the ENTIRE fee as validator tip and zero burnt, which
    // is a confident wrong answer.
    expect(computeGasBreakdown(656860n, 1_000_000_000n, null)).toBeNull()
  })

  it('clamps a base fee above the effective gas price instead of going negative', () => {
    // Should not happen on a well-formed chain, but a bad/backfilled row must
    // not produce a negative tip rendered as "-0.0001 ETH".
    const b = computeGasBreakdown(100n, 5n, 9n)!
    expect(b.priorityTip).toBe(0n)
    expect(b.burnt).toBe(b.total)
  })

  it('handles a zero-tip transaction', () => {
    const b = computeGasBreakdown(21000n, 100n, 100n)!
    expect(b.priorityTip).toBe(0n)
    expect(b.burnt).toBe(21000n * 100n)
  })

  it('returns null for a zero-gas transaction rather than an all-zero breakdown', () => {
    expect(computeGasBreakdown(0n, 1_000_000_000n, 74_600_000n)).toBeNull()
  })

  it('accepts the string forms the DB returns for numeric columns', () => {
    const b = computeGasBreakdown('656860', '1000000000', '74600000')!
    expect(b.burnt + b.priorityTip).toBe(b.total)
  })
})

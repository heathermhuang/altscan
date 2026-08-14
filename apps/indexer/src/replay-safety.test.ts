import { describe, it, expect, vi } from 'vitest'
import type { JsonRpcProvider } from 'ethers'
import {
  fetchBlockReceipts,
  assertReceiptCoverage,
  isUsableLogIndex,
} from './block-processor'

/**
 * Replay safety.
 *
 * processBlock is a first-time indexer, not a repair tool, and three properties
 * made re-processing a block actively destructive:
 *
 *   1. `dex_trades` keyed only on `id serial`, so onConflictDoNothing() could
 *      never match and a replay doubled every trade in the block.
 *   2. `fetchBlockReceipts` read a null RPC response as an empty one, and
 *      `writeTransferBlocks` DELETEs a block's transfers before re-inserting
 *      what it was handed — so replaying against a null response WIPED good rows.
 *   3. Nothing checked that the receipts actually covered the transactions, so a
 *      partial answer produced a block with a full tx_count and missing
 *      derived rows: the exact shape every completeness check calls healthy.
 *
 * These tests pin (2) and (3). (1) is enforced by dex_tx_log_unique, whose
 * buildability is covered in ensure-schema.test.ts.
 */

function providerReturning(value: unknown): JsonRpcProvider {
  return { send: vi.fn(async () => value) } as unknown as JsonRpcProvider
}

describe('fetchBlockReceipts — null is not empty', () => {
  it('throws on a null response instead of reporting zero receipts', async () => {
    // Pre-fix this returned [], which processBlock then enqueued as "this block
    // has no transfers" — and the writer DELETEd the block's real rows.
    await expect(fetchBlockReceipts(providerReturning(null), 115471977))
      .rejects.toThrow(/receipts unavailable/i)
  })

  it('throws on undefined too', async () => {
    await expect(fetchBlockReceipts(providerReturning(undefined), 1))
      .rejects.toThrow(/receipts unavailable/i)
  })

  it('still returns [] for a genuinely empty block', async () => {
    // The distinction is the whole point: an empty ARRAY is a real answer.
    await expect(fetchBlockReceipts(providerReturning([]), 1)).resolves.toEqual([])
  })
})

describe('assertReceiptCoverage', () => {
  it('accepts a fully covered block', () => {
    expect(() => assertReceiptCoverage(1, 120, 120, true)).not.toThrow()
  })

  it('rejects an under-covered block', () => {
    expect(() => assertReceiptCoverage(115471977, 120, 119, true))
      .toThrow(/coverage incomplete: 119 receipt\(s\) for 120 transaction\(s\)/)
  })

  it('rejects the catastrophic case — transactions present, zero receipts', () => {
    // This is the one that silently wipes transfers on replay.
    expect(() => assertReceiptCoverage(115471977, 120, 0, true)).toThrow(/coverage incomplete/)
  })

  it('rejects an OVER-covered block', () => {
    // Not merely noise: more receipts than transactions means the answer is for
    // a different block, so its derived rows would be attributed to this one.
    expect(() => assertReceiptCoverage(1, 10, 11, true)).toThrow(/coverage incomplete/)
  })

  it('accepts an empty block', () => {
    expect(() => assertReceiptCoverage(1, 0, 0, true)).not.toThrow()
  })

  it('is inert when receipts were deliberately not fetched (skipLogs)', () => {
    // backfill --skip-logs asks for no receipts; an empty set is correct there.
    expect(() => assertReceiptCoverage(1, 120, 0, false)).not.toThrow()
  })
})

describe('isUsableLogIndex', () => {
  it('accepts real log indexes including zero', () => {
    expect(isUsableLogIndex(0)).toBe(true)
    expect(isUsableLogIndex(42)).toBe(true)
  })

  it('rejects NaN — the value parseInt returns on a malformed logIndex', () => {
    // A NaN log_index cannot participate in dex_tx_log_unique (every NaN
    // compares unequal), which would silently restore duplicate-on-replay.
    expect(isUsableLogIndex(parseInt('0xzz', 16))).toBe(false)
    expect(isUsableLogIndex(NaN)).toBe(false)
  })

  it('rejects negatives, which are reserved for backfilled legacy rows', () => {
    // dedupeDexTradesForUniqueIndex assigns negative indexes to pre-existing
    // rows; a live write must never land in that space.
    expect(isUsableLogIndex(-1)).toBe(false)
  })

  it('rejects non-integers and non-numbers', () => {
    expect(isUsableLogIndex(1.5)).toBe(false)
    expect(isUsableLogIndex('3')).toBe(false)
    expect(isUsableLogIndex(undefined)).toBe(false)
    expect(isUsableLogIndex(Infinity)).toBe(false)
  })
})

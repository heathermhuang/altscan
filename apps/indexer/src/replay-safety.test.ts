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
 * These tests pin (2) and (3). (1) is enforced by the PARTIAL unique index
 * dex_tx_log_unique ... WHERE log_index IS NOT NULL, whose shape is pinned in
 * ensure-schema.test.ts. log_index is nullable with NO default on purpose: a
 * sentinel default would collide across a deploy overlap (the outgoing binary
 * does not write the column) and the constraint would then silently DROP a real
 * second swap, making the fix worse than the bug.
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
  const h = (n: number) => '0x' + n.toString(16).padStart(64, '0')
  const many = (n: number) => Array.from({ length: n }, (_, i) => h(i))

  it('accepts a fully covered block', () => {
    expect(() => assertReceiptCoverage(1, many(120), many(120), true)).not.toThrow()
  })

  it('rejects an under-covered block', () => {
    expect(() => assertReceiptCoverage(115471977, many(120), many(119), true))
      .toThrow(/coverage incomplete/)
  })

  it('rejects the catastrophic case — transactions present, zero receipts', () => {
    // This is the one that silently wipes transfers on replay.
    expect(() => assertReceiptCoverage(115471977, many(120), [], true)).toThrow(/coverage incomplete/)
  })

  it('rejects an OVER-covered block', () => {
    expect(() => assertReceiptCoverage(1, many(10), many(11), true)).toThrow(/coverage incomplete/)
  })

  // Counts alone cannot see this: 120 receipts for 120 transactions, but one
  // receipt is repeated and another transaction has none. receiptByTx would
  // overwrite the duplicate and default-success the missing one.
  it('rejects a RIGHT-SIZED response that duplicates one receipt and omits another', () => {
    const txs = many(3)
    const receipts = [h(0), h(1), h(1)]
    expect(receipts.length).toBe(txs.length)
    expect(() => assertReceiptCoverage(1, txs, receipts, true)).toThrow(/duplicate receipt/)
  })

  it('rejects a right-sized response for an entirely DIFFERENT block', () => {
    // Same count, disjoint hashes — a reorg splice or a wrong-block answer.
    expect(() => assertReceiptCoverage(1, [h(1), h(2)], [h(8), h(9)], true))
      .toThrow(/no receipt for/)
  })

  it('accepts an empty block', () => {
    expect(() => assertReceiptCoverage(1, [], [], true)).not.toThrow()
  })

  // No early return for the empty block: receipts arriving for a block with no
  // transactions means the endpoint answered about a different block.
  it('rejects receipts arriving for a block with NO transactions', () => {
    expect(() => assertReceiptCoverage(1, [], [h(1)], true)).toThrow(/coverage incomplete/)
  })

  it('is case-insensitive on hashes', () => {
    expect(() => assertReceiptCoverage(1, ['0xABC'], ['0xabc'], true)).not.toThrow()
  })

  it('is inert when receipts were deliberately not fetched (skipLogs)', () => {
    // backfill --skip-logs asks for no receipts; an empty set is correct there.
    expect(() => assertReceiptCoverage(1, many(120), [], false)).not.toThrow()
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

  it('rejects negatives — a real EVM log index is never negative', () => {
    expect(isUsableLogIndex(-1)).toBe(false)
  })

  it('rejects non-integers and non-numbers', () => {
    expect(isUsableLogIndex(1.5)).toBe(false)
    expect(isUsableLogIndex('3')).toBe(false)
    expect(isUsableLogIndex(undefined)).toBe(false)
    expect(isUsableLogIndex(Infinity)).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { summarizeGapRow, completenessStatus, type GapSummary } from './index-gaps'

/**
 * BNB dropped ~92,000 blocks between 2026-08-04 and 08-11 while /api/health
 * reported {"status":"ok"} the entire time. The endpoint had no completeness
 * signal at all: `status` degraded only on memory pressure, and `latestBlock` is
 * max(blocks.number), which sits FROZEN during a gap backfill — so `lagSeconds`
 * read 14,396s while the indexer was in fact healthy and catching up.
 *
 * These pin the reporting half: the indexer records each abandoned range, the
 * explorer surfaces it, and a real gap degrades status so it is alertable.
 */
describe('summarizeGapRow', () => {
  // node-postgres returns COUNT/SUM/MIN over BIGINT as STRINGS, not numbers.
  // Reading them raw yields string concatenation and truthy "0".
  it('coerces postgres bigint strings to numbers', () => {
    expect(summarizeGapRow({ gap_count: '3', missing_blocks: '15300', oldest_from: '115299700', tracked_from: '115000000' }))
      .toEqual({ count: 3, missingBlocks: 15300, oldestFromBlock: 115299700, trackedFromBlock: 115000000 })
  })

  it('treats an empty table as zero, not null', () => {
    expect(summarizeGapRow({ gap_count: '0', missing_blocks: null, oldest_from: null, tracked_from: '42' }))
      .toEqual({ count: 0, missingBlocks: 0, oldestFromBlock: null, trackedFromBlock: 42 })
  })

  it('handles a missing row without throwing', () => {
    const empty = { count: 0, missingBlocks: 0, oldestFromBlock: null, trackedFromBlock: null }
    expect(summarizeGapRow(undefined)).toEqual(empty)
    expect(summarizeGapRow(null)).toEqual(empty)
  })

  it('accepts native numbers and bigints too', () => {
    expect(summarizeGapRow({ gap_count: 2, missing_blocks: 10n, oldest_from: 5n, tracked_from: 1n }))
      .toEqual({ count: 2, missingBlocks: 10, oldestFromBlock: 5, trackedFromBlock: 1 })
  })

  it('never reports a negative or NaN count', () => {
    expect(summarizeGapRow({ gap_count: 'nonsense', missing_blocks: undefined, oldest_from: 'x', tracked_from: 'y' }))
      .toEqual({ count: 0, missingBlocks: 0, oldestFromBlock: null, trackedFromBlock: null })
  })

  // Block 0 is a legitimate baseline (fresh DB) and must survive coercion —
  // toCount() floors at 0, but a BLOCK number of 0 is real, not absent.
  it('preserves a zero tracking baseline as 0, not null', () => {
    expect(summarizeGapRow({ gap_count: '0', missing_blocks: null, oldest_from: null, tracked_from: '0' }).trackedFromBlock)
      .toBe(0)
  })
})

describe('completenessStatus', () => {
  // Default carries a KNOWN baseline; the unverified case is asserted explicitly.
  const s = (o: Partial<GapSummary>): GapSummary =>
    ({ count: 0, missingBlocks: 0, oldestFromBlock: null, trackedFromBlock: 1000, ...o })

  it('is ok with no recorded gaps and a known baseline', () => {
    expect(completenessStatus(s({}))).toBe('ok')
  })

  /**
   * codex P1: an empty table is indistinguishable from "never tracked". The BNB
   * index carries ~92,000 holes recorded by nothing, so a blanket `ok` right
   * after deploy is a false all-clear. `ok` must mean the BOUNDED claim "no gaps
   * at or after trackedFromBlock".
   */
  it('is unverified when the tracking baseline is unknown', () => {
    expect(completenessStatus(s({ trackedFromBlock: null }))).toBe('unverified')
  })

  it('reports degraded over unverified when gaps exist without a baseline', () => {
    expect(completenessStatus(s({ count: 2, trackedFromBlock: null }))).toBe('degraded')
  })

  it('treats a zero baseline as known, not missing', () => {
    expect(completenessStatus(s({ trackedFromBlock: 0 }))).toBe('ok')
  })

  // The whole point: a single unhealed gap must be visible, not averaged away.
  it('degrades on even ONE unhealed gap', () => {
    expect(completenessStatus(s({ count: 1, missingBlocks: 5100 }))).toBe('degraded')
  })

  it('degrades regardless of how few blocks are missing', () => {
    expect(completenessStatus(s({ count: 1, missingBlocks: 1 }))).toBe('degraded')
  })

  it('does not degrade on a count of zero with a stale block total', () => {
    expect(completenessStatus(s({ count: 0, missingBlocks: 0 }))).toBe('ok')
  })
})

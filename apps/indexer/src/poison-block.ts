/**
 * Stop ONE unindexable block from costing thousands.
 *
 * When the block at `lastIndexed + 1` cannot be indexed, the poll loop leaves the
 * cursor pinned and retries it forever while the chain keeps moving. Once lag
 * crosses MAX_LAG_BLOCKS the bulk skip abandons everything from `lastIndexed + 1`
 * to `latest - 200` — on BNB ~4,800 blocks discarded because of one, and the
 * other ~4,799 were perfectly indexable.
 *
 * Measured on prod 2026-08-14: BSC runs at 2.2215 blk/s and chronic lag never
 * drops below 256 (p50 362), so the budget from a pinned cursor to a bulk skip is
 * only ~35 minutes. Quarantining the single blocker converts a 4,800-block hole
 * into a 1-block hole that /api/health reports as `degraded`.
 *
 * ── Why the first implementation was rejected ──────────────────────────────
 *
 * It quarantined on a raw failure COUNT. That count is not evidence of what the
 * mechanism needs to know, because processWithFailover stops failing over the
 * instant writes begin: "block B failed 5 times" can mean five *post-write*
 * aborts, one endpoint each. Such a block is PARTIALLY PERSISTED — a `blocks` row
 * with the right tx_count and no transfers or dex_trades — and the gap healer's
 * work set is ABSENT blocks only, so recording a gap over it produces damage
 * nothing can ever repair and nothing can even see.
 *
 * So this module now demands a POSITIVE PROOF OF ABSENCE, in two independent
 * layers, and quarantines only when both hold:
 *
 *   1. `FailoverFailureKind === 'exhausted-clean'`, N times consecutively — every
 *      endpoint tried, none of them wrote. Cheap, in-memory, and it fails closed:
 *      any other classification (including `unknown`) resets the count instead of
 *      advancing it.
 *   2. A live `blocks` lookup at the moment of quarantine confirming the row is
 *      genuinely absent. This is the load-bearing gate. Layer 1 is in-memory, so
 *      it knows nothing about a half-write left by a previous process generation
 *      — and Render overlaps deploy generations by 60-80s, so that is a state
 *      this indexer really does meet. Layer 2 is stateless and checks the exact
 *      invariant the healer requires.
 *
 * This module is deliberately PURE — no DB, no RPC, no clock. The caller owns the
 * side effects (the absence check, recording the gap, moving the cursor, telling
 * the transfer writer the block will never produce rows).
 */

/**
 * Consecutive whole-failover failures before a block is treated as poison.
 *
 * Not 1: a block can fail for reasons that are real but transient across ALL
 * endpoints at once (a chain-wide reorg mid-batch, a shared upstream blip), and
 * quarantining those would discard blocks the very next attempt would have
 * indexed. Not 50 either: every attempt costs a full failover sweep while the
 * cursor stays pinned and the ~35-minute budget drains.
 */
export const DEFAULT_QUARANTINE_AFTER = 5

/**
 * Per-height consecutive `exhausted-clean` failure counts.
 *
 * Keyed on HEIGHT, which is only sound because `clearAbove()` is wired into reorg
 * recovery — see the method's own note. Consecutive is the other load-bearing
 * word: any success, and any failure that is not provably clean, drops the entry,
 * so only a block that fails every time, across every endpoint, with no writes,
 * can ever accumulate to the threshold.
 */
export class PoisonBlockTracker {
  private readonly fails = new Map<number, number>()

  /**
   * Record one failure in which failover provably exhausted every endpoint
   * without writing. Returns the new consecutive count.
   *
   * ONLY call this for `exhausted-clean`. Every other outcome must go to
   * `recordUnclean()`.
   */
  recordCleanFailure(block: number): number {
    const next = (this.fails.get(block) ?? 0) + 1
    this.fails.set(block, next)
    return next
  }

  /**
   * Record a failure that is NOT proof of absence — `aborted-dirty` (the block
   * may be half-written) or `unknown` (the error never came from failover).
   *
   * This DROPS the count rather than merely declining to raise it. Leaving a
   * stale count in place is the hole: a block that dirty-aborts at count 4 is
   * partially persisted from that moment on, so one further clean failure would
   * push it to the threshold and quarantine a block that already has its row.
   * Resetting means such a block must earn the threshold again from zero — and
   * the absence check will refuse it anyway.
   */
  recordUnclean(block: number): void {
    this.fails.delete(block)
  }

  /** A success proves the block is not poison — drop any history for it. */
  recordSuccess(block: number): void {
    this.fails.delete(block)
  }

  count(block: number): number {
    return this.fails.get(block) ?? 0
  }

  forget(block: number): void {
    this.fails.delete(block)
  }

  /**
   * Invalidate every count above a reorg fork point.
   *
   * MUST be called from reorg recovery. Counts are keyed on height while
   * recoverFromReorg moves the cursor BACKWARDS, so without this a height is
   * silently reused: 4 clean failures against the orphaned block at H, then a
   * single transient failure against its canonical REPLACEMENT at H, reaches the
   * threshold and quarantines a perfectly good block. Above the fork every height
   * now refers to a different block, so every count above it is meaningless.
   *
   * Clearing is used rather than keying the map on block hash — the hash is
   * frequently unavailable in exactly the failure this tracker counts, because
   * the failure IS that the block could not be fetched.
   */
  clearAbove(forkPoint: number): number {
    let cleared = 0
    for (const block of this.fails.keys()) {
      if (block > forkPoint) { this.fails.delete(block); cleared++ }
    }
    return cleared
  }

  /**
   * Drop counts for blocks the cursor has already passed.
   *
   * Without this the map grows for the life of the process: a transient failure
   * on any block leaves an entry, and the retry that eventually succeeds may be
   * counted in a batch that never revisits the same height.
   */
  prune(throughBlock: number): void {
    for (const block of this.fails.keys()) {
      if (block <= throughBlock) this.fails.delete(block)
    }
  }

  /** Test/observability hook. */
  get size(): number {
    return this.fails.size
  }
}

/**
 * Is this block a quarantine CANDIDATE? (Necessary, not sufficient — the caller
 * must still confirm absence against the database before acting.)
 *
 * Deliberately narrow. Quarantine applies ONLY to the block immediately after the
 * cursor, because that is the only block that can pin progress; every other
 * failure in a batch is retried on the next pass at no cost. Quarantining a later
 * block would leave the real blocker in place AND record the hole in the wrong
 * position.
 */
export function shouldQuarantine(
  blockNumber: number,
  lastIndexed: number,
  consecutiveCleanFailures: number,
  quarantineAfter: number = DEFAULT_QUARANTINE_AFTER,
): boolean {
  // A non-positive or non-integer threshold would quarantine on sight, discarding
  // a block on its first transient failure. Fail toward the safe default rather
  // than trusting the configured value.
  const threshold = Number.isInteger(quarantineAfter) && quarantineAfter >= 1
    ? quarantineAfter
    : DEFAULT_QUARANTINE_AFTER
  if (blockNumber !== lastIndexed + 1) return false
  return consecutiveCleanFailures >= threshold
}

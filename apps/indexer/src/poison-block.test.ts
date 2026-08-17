import { describe, it, expect, vi } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { processWithFailover, failoverKind } from './rpc-failover'
import {
  PoisonBlockTracker, shouldQuarantine, DEFAULT_QUARANTINE_AFTER,
  POISON_GAP_REASON_PREFIX, poisonGapReason,
} from './poison-block'

/**
 * Cover for the four defects that got the first quarantine implementation
 * rejected. Each block below names the finding it pins.
 *
 * The classification tests deliberately drive the REAL processWithFailover rather
 * than a stand-in, because the property under test — "which throw means the block
 * is absent?" — is a property of that function's control flow. A reimplementation
 * in the harness could agree with the shipped code today and diverge silently.
 */

describe('(a) failover reports whether it exhausted every endpoint BEFORE any write', () => {
  it('classifies a full sweep with no writes as exhausted-clean', async () => {
    const work = vi.fn().mockRejectedValue(new Error('archive 403'))
    const err = await processWithFailover(100, ['a', 'b', 'c'], 0, work).catch(e => e)
    expect(work).toHaveBeenCalledTimes(3)
    expect(failoverKind(err)).toBe('exhausted-clean')
  })

  it('classifies a post-write abort as aborted-dirty, NOT exhausted-clean', async () => {
    // One endpoint begins writing, then fails. Failover stops here by design, so
    // the block is half-written: a `blocks` row with no transfers or dex_trades.
    const work = vi.fn(async (_b: number, _p: string, onWritesBegan: () => void) => {
      onWritesBegan()
      throw new Error('db died mid-block')
    })
    const err = await processWithFailover(100, ['a', 'b', 'c'], 0, work).catch(e => e)
    expect(work).toHaveBeenCalledTimes(1)          // it did NOT try the other two
    expect(failoverKind(err)).toBe('aborted-dirty')
  })

  it('the count alone cannot distinguish them — which is why the kind exists', async () => {
    // This is the exact confusion that killed the first implementation: five
    // failures that LOOK identical to a counter, but only one kind is safe.
    const dirty = vi.fn(async (_b: number, _p: string, onWritesBegan: () => void) => {
      onWritesBegan()
      throw new Error('boom')
    })
    const kinds: string[] = []
    for (let i = 0; i < 5; i++) {
      kinds.push(failoverKind(await processWithFailover(100, ['a', 'b'], 0, dirty).catch(e => e)))
    }
    expect(kinds).toEqual(Array(5).fill('aborted-dirty'))
    expect(kinds.some(k => k === 'exhausted-clean')).toBe(false)
  })

  // ── The guardrail must be able to FAIL, not merely observed passing ──────────
  it('FAILS CLOSED: an error that never went through failover is unknown', () => {
    expect(failoverKind(new Error('thrown from somewhere else'))).toBe('unknown')
  })

  it('FAILS CLOSED: non-object throws are unknown, never exhausted-clean', () => {
    expect(failoverKind('a string')).toBe('unknown')
    expect(failoverKind(undefined)).toBe('unknown')
    expect(failoverKind(null)).toBe('unknown')
    expect(failoverKind({ kind: 'exhausted-clean' })).toBe('unknown')  // a look-alike is not the symbol
  })

  it('FAILS CLOSED: a misconfigured empty provider list is unknown, not clean', async () => {
    const err = await processWithFailover(100, [], 0, vi.fn()).catch(e => e)
    expect(failoverKind(err)).toBe('unknown')
  })

  it('a frozen error degrades to unknown rather than throwing', async () => {
    const work = vi.fn().mockRejectedValue(Object.freeze(new Error('frozen')))
    const err = await processWithFailover(100, ['a'], 0, work).catch(e => e)
    expect(failoverKind(err)).toBe('unknown')
  })
})

describe('tracker only advances on provably-clean failures', () => {
  it('counts consecutive clean failures', () => {
    const t = new PoisonBlockTracker()
    expect(t.recordCleanFailure(10)).toBe(1)
    expect(t.recordCleanFailure(10)).toBe(2)
    expect(t.count(10)).toBe(2)
  })

  it('an unclean failure RESETS the count rather than leaving it stale', () => {
    // The hole this closes: a block that dirty-aborts at 4 is partially persisted
    // from that moment, so merely "not incrementing" would let one further clean
    // failure carry it to the threshold and quarantine a block that has its row.
    const t = new PoisonBlockTracker()
    t.recordCleanFailure(10); t.recordCleanFailure(10)
    t.recordCleanFailure(10); t.recordCleanFailure(10)
    expect(t.count(10)).toBe(4)
    t.recordUnclean(10)
    expect(t.count(10)).toBe(0)
    t.recordCleanFailure(10)
    expect(shouldQuarantine(10, 9, t.count(10), 5)).toBe(false)
  })

  it('a success clears the block', () => {
    const t = new PoisonBlockTracker()
    t.recordCleanFailure(10); t.recordCleanFailure(10)
    t.recordSuccess(10)
    expect(t.count(10)).toBe(0)
  })
})

describe('(c) reorg invalidates height-keyed counts', () => {
  it('clearAbove drops counts above the fork point and keeps those below', () => {
    const t = new PoisonBlockTracker()
    t.recordCleanFailure(98)
    t.recordCleanFailure(100); t.recordCleanFailure(100)
    t.recordCleanFailure(101)
    expect(t.clearAbove(99)).toBe(2)
    expect(t.count(100)).toBe(0)
    expect(t.count(101)).toBe(0)
    expect(t.count(98)).toBe(1)      // at/below the fork the block is unchanged
  })

  it('without the clear, a good replacement block would be quarantined', () => {
    // 4 clean failures against the ORPHANED block at height 100, then a reorg
    // replaces it, then ONE transient failure against the canonical replacement.
    const t = new PoisonBlockTracker()
    for (let i = 0; i < 4; i++) t.recordCleanFailure(100)

    // Demonstrate the bug is real if the clear is skipped...
    t.recordCleanFailure(100)
    expect(shouldQuarantine(100, 99, t.count(100), 5)).toBe(true)   // would quarantine a GOOD block

    // ...and that clearing on reorg prevents exactly that.
    const t2 = new PoisonBlockTracker()
    for (let i = 0; i < 4; i++) t2.recordCleanFailure(100)
    t2.clearAbove(99)                                                // recoverFromReorg(forkPoint=99)
    t2.recordCleanFailure(100)
    expect(shouldQuarantine(100, 99, t2.count(100), 5)).toBe(false)
  })
})

describe('shouldQuarantine is narrow and fails safe', () => {
  it('only ever applies to the block immediately after the cursor', () => {
    expect(shouldQuarantine(101, 100, 99)).toBe(true)
    expect(shouldQuarantine(102, 100, 99)).toBe(false)   // not the blocker
    expect(shouldQuarantine(100, 100, 99)).toBe(false)   // already indexed
  })

  it('respects the threshold', () => {
    expect(shouldQuarantine(101, 100, 4, 5)).toBe(false)
    expect(shouldQuarantine(101, 100, 5, 5)).toBe(true)
  })

  it('a nonsense threshold falls back to the safe default instead of quarantining on sight', () => {
    for (const bad of [0, -1, NaN, 1.5]) {
      expect(shouldQuarantine(101, 100, 1, bad)).toBe(false)
      expect(shouldQuarantine(101, 100, DEFAULT_QUARANTINE_AFTER, bad)).toBe(true)
    }
  })
})

describe('tracker stays bounded', () => {
  it('prune drops everything the cursor has passed', () => {
    const t = new PoisonBlockTracker()
    for (const b of [10, 11, 12, 13]) t.recordCleanFailure(b)
    t.prune(12)
    expect(t.size).toBe(1)
    expect(t.count(13)).toBe(1)
  })
})

describe('the poison gap reason is descriptive, not identity', () => {
  // It briefly WAS identity: the resume scan matched `reason LIKE 'poison_block%'`.
  // That could be erased by an unrelated max_lag_skip merging onto the same
  // from_block, silently reintroducing the restart deadlock — so identity moved to
  // its own poison_blocks row. These pin the remaining, weaker contract: the text
  // stays recognisable to a human reading index_gaps.
  it('always carries the prefix and the threshold actually used', () => {
    for (const n of [1, 5, 50, DEFAULT_QUARANTINE_AFTER]) {
      expect(poisonGapReason(n).startsWith(POISON_GAP_REASON_PREFIX)).toBe(true)
      expect(poisonGapReason(n)).toContain(String(n))
    }
  })

  it('does not collide with the bulk skip\'s reason', () => {
    expect('max_lag_skip(5000)'.startsWith(POISON_GAP_REASON_PREFIX)).toBe(false)
  })

  it('no code path makes a DECISION from this string', () => {
    // Guards the regression directly: if someone reintroduces reason-matching, the
    // deadlock comes back silently. poison_blocks is the only identity.
    // vitest roots at the repo root. Assert the path resolves rather than letting
    // a miss turn this guard into a silent no-op.
    const indexPath = resolve(process.cwd(), 'apps/indexer/src/index.ts')
    expect(existsSync(indexPath)).toBe(true)
    const src = readFileSync(indexPath, 'utf8')
    expect(src).not.toContain('POISON_GAP_REASON_PREFIX')
    expect(src).toContain('poison_blocks')
  })
})

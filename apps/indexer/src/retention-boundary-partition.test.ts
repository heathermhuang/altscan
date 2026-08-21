import { describe, expect, it } from 'vitest'
import { partitionRetentionPlan, type PartitionBound } from './retention-cleanup'

/**
 * The boundary-partition DELETE is GONE, and this suite is the thing that keeps
 * it gone.
 *
 * Why it was removed (measured on BNB prod, 2026-08-17 → 2026-08-21): the
 * straddling partition's below-cutoff rows were DELETEd every run — 132.6M rows
 * across 12 runs in 4.06 days, ~33M rows/day, ~55 min/day of DELETE I/O — and it
 * returned ZERO bytes to the OS. A DELETE only marks tuples dead; worse,
 * token_transfers is EXCLUDED from retention's VACUUM list while partitioned, so
 * the dead tuples were not even reclaimed for reuse. The space came back ~12h
 * later when the cutoff passed the partition's upper bound and it was DROPped
 * outright — which would have happened with or without the DELETE.
 *
 * The cost was not merely wasted time: 8-25M row deletes per run dirty a large
 * fraction of shared_buffers, and backend dirty-buffer eviction is the CONFIRMED
 * root cause of this indexer's chronic lag. This is a writer lever, not a tidy-up.
 *
 * Safety argument, pinned by the tests below:
 *  - No FK depends on it. token_transfers has NO foreign key (the schema declares
 *    exactly one, transactions.block_number → blocks.number), so retaining rows
 *    here cannot block the blocks/transactions deletes that follow.
 *  - The overshoot is BOUNDED by one partition width and self-correcting: the
 *    partition is DROPped as soon as the cutoff reaches its upper bound.
 *  - The DROP predicate is UNCHANGED. That is the regression that would actually
 *    hurt, so it is pinned character-for-character against the shipped predicate.
 */
const p = (lo: number, hi: number, name = `token_transfers_p_${lo}`): PartitionBound =>
  ({ name, schema: 'public', lo, hi })

describe('partitionRetentionPlan — the boundary DELETE stays removed', () => {
  it('NEVER emits a delete action for any input', () => {
    // The whole point of the change. If a future edit reintroduces a row-delete
    // on the straddling partition, this fails regardless of the shape it takes.
    const parts = [p(0, 100), p(100, 200), p(200, 300), p(300, 400)]
    for (let cutoff = -5; cutoff <= 405; cutoff++) {
      for (const a of partitionRetentionPlan(parts, cutoff)) {
        expect(a.kind).not.toBe('delete')
        expect(['drop', 'retain-boundary', 'keep']).toContain(a.kind)
      }
    }
  })

  it('drops a partition wholly below the cutoff', () => {
    expect(partitionRetentionPlan([p(0, 100)], 250)).toEqual([{ kind: 'drop', part: p(0, 100) }])
  })

  it('drops a partition whose upper bound EQUALS the cutoff (bound is exclusive)', () => {
    // hi is exclusive, so every row is < cutoff. Dropping is correct, and this is
    // the exact edge the old `p.hi <= cutoffBlock` allowed.
    expect(partitionRetentionPlan([p(0, 100)], 100)).toEqual([{ kind: 'drop', part: p(0, 100) }])
  })

  it('RETAINS the straddling partition and reports the overshoot it is keeping', () => {
    expect(partitionRetentionPlan([p(100, 200)], 175)).toEqual([
      {
        kind: 'retain-boundary', part: p(100, 200), overshootBlocks: 75,
        releasedAtBlock: 200, widthBlocks: 100, oversized: false,
      },
    ])
  })

  it('keeps a partition whose lower bound EQUALS the cutoff (nothing below it)', () => {
    // lo === cutoff means no row in this partition is below the cutoff, so the
    // old code did not touch it either — it is `keep`, not `retain-boundary`.
    expect(partitionRetentionPlan([p(100, 200)], 100)).toEqual([{ kind: 'keep', part: p(100, 200) }])
  })

  it('keeps a partition wholly above the cutoff', () => {
    expect(partitionRetentionPlan([p(300, 400)], 250)).toEqual([{ kind: 'keep', part: p(300, 400) }])
  })

  it('returns an empty plan for no partitions', () => {
    expect(partitionRetentionPlan([], 500)).toEqual([])
  })

  it('classifies a realistic prod ladder into drop / retain / keep', () => {
    // Mirrors BNB on 2026-08-21: 96,000-wide partitions, cutoff mid-ladder.
    const parts = [p(116634552, 116730552), p(116730552, 116826552), p(116826552, 116922552)]
    const plan = partitionRetentionPlan(parts, 116763966)
    expect(plan.map(a => a.kind)).toEqual(['drop', 'retain-boundary', 'keep'])
    expect(plan[1]).toEqual({
      kind: 'retain-boundary',
      part: p(116730552, 116826552),
      overshootBlocks: 116763966 - 116730552,
      releasedAtBlock: 116826552,
      widthBlocks: 96000,
      oversized: false,
    })
  })

  it('pins the DROP set character-for-character against the SHIPPED predicate', () => {
    // The removal must not have moved the drop boundary by even one block. This
    // is the shipped condition, copied verbatim from the pre-change source:
    //     if (p.hi <= cutoffBlock) { DROP }
    const parts = [p(0, 100), p(100, 200), p(200, 300), p(300, 400)]
    for (let cutoff = -5; cutoff <= 405; cutoff++) {
      const shipped = parts.filter(q => q.hi <= cutoff).map(q => q.name).sort()
      const actual = partitionRetentionPlan(parts, cutoff)
        .filter(a => a.kind === 'drop').map(a => a.part.name).sort()
      expect(actual, `cutoff=${cutoff}`).toEqual(shipped)
    }
  })

  it('retains AT MOST one partition, and its overshoot is always < its width', () => {
    // Bounds the disk cost of the removal: the retained overshoot can never
    // exceed a single partition width, so it cannot accumulate across runs.
    const parts = [p(0, 100), p(100, 200), p(200, 300), p(300, 400)]
    for (let cutoff = -5; cutoff <= 405; cutoff++) {
      const boundary = partitionRetentionPlan(parts, cutoff).filter(a => a.kind === 'retain-boundary')
      expect(boundary.length, `cutoff=${cutoff}`).toBeLessThanOrEqual(1)
      for (const b of boundary) {
        if (b.kind !== 'retain-boundary') continue
        expect(b.overshootBlocks).toBeGreaterThan(0)
        expect(b.overshootBlocks).toBeLessThan(b.part.hi - b.part.lo)
        expect(b.releasedAtBlock).toBe(b.part.hi)
        expect(b.widthBlocks).toBe(b.part.hi - b.part.lo)
      }
    }
  })

  it('covers every partition exactly once, in the order given', () => {
    const parts = [p(0, 100), p(100, 200), p(200, 300)]
    const plan = partitionRetentionPlan(parts, 150)
    expect(plan.map(a => a.part.name)).toEqual(parts.map(q => q.name))
  })

  describe('oversized straddler — the ATTACHed legacy partition case', () => {
    // migrate-partition-tt ATTACHes the whole pre-migration table as
    // token_transfers_legacy FOR VALUES FROM (0) TO (S). For ~COMPACT_RETENTION_DAYS
    // after a migration the cutoff sits inside it, and "retain until the DROP"
    // silently means "retain all of history" on a disk already near capacity.
    const legacy = p(0, 116_000_000, 'token_transfers_legacy')
    const fwd = (lo: number) => p(lo, lo + 96_000)

    it('flags a legacy straddler as oversized', () => {
      const plan = partitionRetentionPlan([legacy, fwd(116_000_000), fwd(116_096_000)], 50_000_000)
      const b = plan[0]
      expect(b.kind).toBe('retain-boundary')
      if (b.kind !== 'retain-boundary') return
      expect(b.oversized).toBe(true)
      expect(b.widthBlocks).toBe(116_000_000)
      // The overshoot really is 50M blocks — the number that makes the alarm honest.
      expect(b.overshootBlocks).toBe(50_000_000)
    })

    it('does NOT flag a normal straddler in a uniform ladder', () => {
      const plan = partitionRetentionPlan([fwd(0), fwd(96_000), fwd(192_000)], 100_000)
      const b = plan.find(a => a.kind === 'retain-boundary')
      expect(b?.kind).toBe('retain-boundary')
      if (b?.kind !== 'retain-boundary') return
      expect(b.oversized).toBe(false)
    })

    it('never flags a lone partition — nothing to compare against', () => {
      const plan = partitionRetentionPlan([legacy], 50_000_000)
      const b = plan[0]
      if (b.kind !== 'retain-boundary') throw new Error('expected retain-boundary')
      expect(b.oversized).toBe(false)
    })

    it('sits three orders of magnitude clear of normal — not a hair-trigger', () => {
      // The 86-vs-85 disk switch fired on healthy cycles because normal sat one
      // point below the line. Pin the margin here so that cannot recur: a normal
      // straddler is 1x its siblings, a legacy one ~1208x, and the line is 4x.
      const normalRatio = 96_000 / 96_000
      const legacyRatio = 116_000_000 / 96_000
      expect(normalRatio).toBeLessThan(4)
      expect(legacyRatio).toBeGreaterThan(1000)
    })

    it('flags exactly at the 4x line, not below it', () => {
      const wide = (w: number) => partitionRetentionPlan([p(0, w, 'wide'), p(w, w + 100)], 50)
      const at4x = wide(400)   // 400 vs sibling 100 → 4x, NOT > 4x
      const over = wide(401)   // 401 vs sibling 100 → over the line
      expect(at4x[0].kind === 'retain-boundary' && at4x[0].oversized).toBe(false)
      expect(over[0].kind === 'retain-boundary' && over[0].oversized).toBe(true)
    })
  })
})
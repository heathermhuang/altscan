import { describe, it, expect, vi } from 'vitest'
import {
  healNextGap, positiveIntEnv, LAG_RECHECK_EVERY,
  DEFAULT_HEAL_BATCH, DEFAULT_HEAL_MAX_LAG,
} from './gap-healer'

/**
 * #94 recorded abandoned ranges but nothing ever healed them, so a repaired
 * range stayed `degraded` forever. These pin the properties that make the healer
 * safe to run next to a live indexer:
 *
 *   - it NEVER runs while behind (healing while lagging drives the loop toward
 *     the MAX_LAG skip, which abandons blocks — it would create the very gaps it
 *     exists to close),
 *   - it NEVER stamps healed_at on faith, only off a fresh proof, and
 *   - heal_cursor advances ONLY past blocks that were re-indexed, flushed and
 *     re-verified, so a crash cannot leave a block whose transfers were lost in
 *     the in-memory queue looking complete.
 *
 * Statement order per tick: gap lookup, work-set query, [re-index], flush,
 * re-verify window, advance cursor, and — only when the window reaches to_block —
 * the conditional stamp.
 */

/** Returns queued results in call order and records the statements it saw. */
function stubDb(results: unknown[]) {
  const calls: unknown[] = []
  let i = 0
  return {
    calls,
    db: {
      execute: async (query: unknown) => {
        calls.push(query)
        return results[i++] ?? []
      },
    },
  }
}

/** 101 blocks — larger than a default batch, so one tick cannot finish it. */
const GAP = [{ from_block: '100', to_block: '200', heal_from: '100', verify_from: '100', retention_floor: '50' }]
/** 11 blocks — fits in one batch, so a tick can reach the stamp. */
const SMALL = [{ from_block: '100', to_block: '110', heal_from: '100', verify_from: '100', retention_floor: '50' }]

const okFlush = async () => {}

describe('healNextGap', () => {
  it('refuses to run while the indexer is behind', async () => {
    const { db, calls } = stubDb([GAP])
    const reindexBlock = vi.fn()
    const out = await healNextGap({ owner: 'test', resumeWindow: 20000,
      db, reindexBlock, readLag: async () => DEFAULT_HEAL_MAX_LAG + 1,
    })
    expect(out).toEqual({ status: 'skipped', lag: DEFAULT_HEAL_MAX_LAG + 1 })
    // The guard must come BEFORE any query — healing must cost nothing at all
    // while behind, not merely skip the re-index.
    expect(calls).toHaveLength(0)
    expect(reindexBlock).not.toHaveBeenCalled()
  })

  it('treats a non-finite lag as behind (fails closed)', async () => {
    const { db } = stubDb([GAP])
    const out = await healNextGap({ owner: 'test', resumeWindow: 20000, db, reindexBlock: vi.fn(), readLag: async () => NaN })
    expect(out.status).toBe('skipped')
  })

  it('treats an unreadable tip as behind, not as caught up', async () => {
    const { db, calls } = stubDb([GAP])
    const out = await healNextGap({ owner: 'test', resumeWindow: 20000,
      db, reindexBlock: vi.fn(), readLag: async () => { throw new Error('rpc down') },
    })
    expect(out.status).toBe('skipped')
    expect(calls).toHaveLength(0)
  })

  it('is idle when nothing unhealed intersects the retained window', async () => {
    const { db } = stubDb([[]])
    const reindexBlock = vi.fn()
    const out = await healNextGap({ owner: 'test', resumeWindow: 20000, db, reindexBlock, readLag: async () => 0 })
    expect(out).toEqual({ status: 'idle' })
    expect(reindexBlock).not.toHaveBeenCalled()
  })

  /**
   * processBlock has no partial mode — it decodes every receipt and re-runs every
   * side effect — and it is not idempotent: dex_trades has only a serial primary
   * key so onConflictDoNothing() cannot dedupe, webhooks re-fire for every
   * transaction, and writeTransferBlocks DELETEs a block's transfers before
   * re-inserting (destroying them outright if the receipt fetch returns empty).
   * So ONLY absent blocks may be processed — for those it is a first write, not a
   * replay. That is exactly the damage a MAX_LAG skip produces.
   * (codex P1, rounds 5 and 6.)
   */
  it('processes ONLY absent blocks — whatever the work query returns', async () => {
    const { db, calls } = stubDb([SMALL, [{ n: '104' }, { n: '105' }], [], []])
    const reindexBlock = vi.fn(async (_n: number) => {})
    await healNextGap({ owner: 'test', resumeWindow: 20000, db, reindexBlock, readLag: async () => 0, flushTransfers: okFlush })
    expect(reindexBlock.mock.calls.map(c => c[0])).toEqual([104, 105])
    // The work query must not admit present-but-wrong blocks at all.
    const workSql = JSON.stringify(calls[1])
    expect(workSql).toContain('NOT EXISTS')
    expect(workSql).not.toContain('tx_count')
  })

  it('advances the cursor but does NOT stamp while the range is unfinished', async () => {
    // gap, re-verify(clean), advance-cursor. Window is 100..124 of a 100..200
    // range, so there is no stamp.
    const { db, calls } = stubDb([GAP, [{ n: '110' }], [], []])
    const reindexBlock = vi.fn(async (_n: number) => {})
    const out = await healNextGap({ owner: 'test', resumeWindow: 20000, db, reindexBlock, readLag: async () => 0, flushTransfers: okFlush })
    expect(out).toMatchObject({ status: 'progressed', fromBlock: 100, toBlock: 200 })
    expect(reindexBlock).toHaveBeenCalledTimes(1)
    // gap, work-set, verify, advance — no stamp, the window ends at 124 of 200.
    expect(calls).toHaveLength(4)
  })

  it('stamps healed_at only once the whole range is confirmed', async () => {
    // gap, re-verify(clean), advance-cursor, stamp(RETURNING a row = it applied).
    const { db, calls } = stubDb([SMALL, [], [], [], [{ from_block: '100' }]])
    const out = await healNextGap({ owner: 'test', resumeWindow: 20000,
      db, reindexBlock: vi.fn(async (_n: number) => {}), readLag: async () => 0, flushTransfers: okFlush,
    })
    expect(out).toMatchObject({ status: 'healed', fromBlock: 100, toBlock: 110 })
    expect(calls).toHaveLength(5)
  })

  it('does not stamp healed when the conditional UPDATE matches nothing', async () => {
    // The range changed under us (grew, or lost rows to a reorg). Zero rows
    // updated is NOT a heal — that would be the same false all-clear, quietly.
    const { db } = stubDb([SMALL, [], [], [], []])
    const out = await healNextGap({ owner: 'test', resumeWindow: 20000,
      db, reindexBlock: vi.fn(async (_n: number) => {}), readLag: async () => 0, flushTransfers: okFlush,
    })
    expect(out.status).toBe('progressed')
  })

  it('holds the cursor when the window still verifies as incomplete', async () => {
    // The cursor must never advance past blocks that did not verify — that is the
    // entire reason it is durable.
    // Verification uses EXACT equality, so it also catches overfull blocks the
    // work set deliberately skipped — those cannot be repaired by replay.
    const { db, calls } = stubDb([SMALL, [], [{ n: '105' }]])
    const out = await healNextGap({ owner: 'test', resumeWindow: 20000,
      db, reindexBlock: vi.fn(async (_n: number) => {}), readLag: async () => 0, flushTransfers: okFlush,
    })
    expect(out.status).toBe('progressed')
    // gap + work-set + verify: no cursor advance, no stamp.
    expect(calls).toHaveLength(3)
  })

  it('does not advance the cursor if the transfer flush fails', async () => {
    // processBlock only ENQUEUES transfers, and the skip already moved the durable
    // watermark past this range, so an undrained queue means these transfers may
    // never be replayed.
    const { db, calls } = stubDb([SMALL, [], [], [{ from_block: '100' }]])
    const out = await healNextGap({ owner: 'test', resumeWindow: 20000,
      db, reindexBlock: vi.fn(async (_n: number) => {}), readLag: async () => 0,
      flushTransfers: async () => { throw new Error('writer stuck') },
    })
    expect(out.status).toBe('progressed')
    expect(calls).toHaveLength(2) // gap + work-set, then bailed at the flush
  })

  it('stops the tick on a failed block and leaves the range unhealed', async () => {
    const { db, calls } = stubDb([SMALL, [{ n: '100' }, { n: '101' }, { n: '102' }, { n: '103' }]])
    const reindexBlock = vi.fn(async (n: number) => {
      if (n === 102) throw new Error('archive 403')
    })
    const out = await healNextGap({ owner: 'test', resumeWindow: 20000, db, reindexBlock, readLag: async () => 0, flushTransfers: okFlush })
    expect(out.status).toBe('failed')
    expect(out).toMatchObject({ fromBlock: 100, toBlock: 110, repaired: 2 })
    // Bailed at 102 — did not grind the rest against a bad endpoint.
    expect(reindexBlock.mock.calls.map(c => c[0])).toEqual([100, 101, 102])
    // gap + work-set only: no verify, no cursor advance, no stamp.
    expect(calls).toHaveLength(2)
  })

  it('never issues a destructive cleanup on a failed re-index', async () => {
    // An earlier cut deleted the partial `blocks` row to "roll back". That was
    // unreliable AND unsafe: once transactions exist the non-cascading FK rejects
    // it, and another writer can legitimately insert the same block between the
    // absence check and the delete, so it could destroy data it never owned.
    const { db, calls } = stubDb([SMALL, [{ n: '100' }]])
    const reindexBlock = vi.fn(async (_n: number) => { throw new Error('archive 403') })
    const out = await healNextGap({ owner: 'test', resumeWindow: 20000, db, reindexBlock, readLag: async () => 0, flushTransfers: okFlush })
    expect(out.status).toBe('failed')
    expect(calls).toHaveLength(2)
  })

  it('heals from the CLAMPED start, not the recorded start', async () => {
    // Retention has eaten up to 150, so work begins there. Healing from 100 would
    // chase blocks Postgres deletes faster than we can write them.
    const clamped = [{ from_block: '100', to_block: '155', heal_from: '150', verify_from: '150' }]
    const { db } = stubDb([clamped, [{ n: '150' }], [], [], [{ from_block: '100' }]])
    const reindexBlock = vi.fn(async (_n: number) => {})
    const out = await healNextGap({ owner: 'test', resumeWindow: 20000, db, reindexBlock, readLag: async () => 0, flushTransfers: okFlush })
    expect(reindexBlock.mock.calls[0][0]).toBe(150)
    // healed_at is still keyed on the RECORDED start — that is the primary key.
    expect(out).toMatchObject({ fromBlock: 100, toBlock: 155 })
  })

  it('coerces BIGINT-as-string rows rather than trusting them', async () => {
    // node-postgres hands back BIGINT as a string; untreated, block arithmetic
    // becomes string concatenation.
    const { db } = stubDb([[{ from_block: '100', to_block: '101', heal_from: '100', verify_from: '100' }], [{ n: '100' }], [], [], []])
    const reindexBlock = vi.fn(async (_n: number) => {})
    await healNextGap({ owner: 'test', resumeWindow: 20000, db, reindexBlock, readLag: async () => 0, flushTransfers: okFlush })
    expect(reindexBlock).toHaveBeenCalledWith(100)
    expect(typeof reindexBlock.mock.calls[0][0]).toBe('number')
  })
})

describe('healNextGap — fail-closed properties', () => {
  it('does not let batch 0 collapse the window into an instant false heal', async () => {
    // A zero batch must not produce an empty work set that sails through to the
    // stamp. The batch is re-clamped no matter which caller supplied it.
    const { db } = stubDb([SMALL, [{ n: '100' }], [], [], [{ from_block: '100' }]])
    const reindexBlock = vi.fn(async (_n: number) => {})
    await healNextGap({ owner: 'test', resumeWindow: 20000, db, reindexBlock, readLag: async () => 0, flushTransfers: okFlush }, 0)
    expect(reindexBlock).toHaveBeenCalled()
  })

  it('does not let a NaN lag ceiling disable the never-run-while-behind guard', async () => {
    // `lag > NaN` is false, so an unvalidated ceiling would silently stop the
    // guard firing and let healing compete with an indexer that is losing blocks.
    const { db } = stubDb([GAP, []])
    const out = await healNextGap({ owner: 'test', resumeWindow: 20000,
      db, reindexBlock: vi.fn(), readLag: async () => 10_000,
    }, 25, NaN)
    expect(out.status).toBe('skipped')
  })

  it('yields mid-tick when the indexer falls behind during the batch', async () => {
    // The tip moves while a tick runs, so one check at the start is not enough.
    let call = 0
    const work = Array.from({ length: 3 * LAG_RECHECK_EVERY }, (_, k) => ({ n: String(100 + k) }))
    const { db } = stubDb([GAP, work, [], []])
    const reindexBlock = vi.fn(async (_n: number) => {})
    const out = await healNextGap({ owner: 'test', resumeWindow: 20000,
      db, reindexBlock,
      // Reads: entry guard, then a recheck every LAG_RECHECK_EVERY blocks.
      readLag: async () => (++call <= 3 ? 0 : 9999),
      flushTransfers: okFlush,
    })
    expect(out.status).toBe('progressed')
    expect(reindexBlock.mock.calls.length).toBe(2 * LAG_RECHECK_EVERY)
  })
})

describe('positiveIntEnv', () => {
  it('falls back on the values that would fail open', () => {
    for (const bad of ['0', '-1', 'nonsense', '', '  ', '1.5', 'NaN', undefined]) {
      expect(positiveIntEnv(bad as string | undefined, 25)).toBe(25)
    }
  })

  it('accepts a genuine positive integer', () => {
    expect(positiveIntEnv('7', 25)).toBe(7)
    expect(positiveIntEnv('1', 25)).toBe(1)
  })
})

/**
 * healInflight is process-LOCAL, and Render rolling deploys overlap generations
 * for ~60-80s (measured, background workers included). Two healers selecting the
 * same absent block would both run processBlock — duplicating dex_trades,
 * double-firing webhooks, and racing the transfer writer's delete-then-reinsert.
 * That is corruption strictly worse than having no healer at all, so the claim
 * has to be atomic and every later write has to be fenced. (codex P1, round 7.)
 */
describe('gap lease', () => {
  it('idles when the claim wins no row (another process holds the gap)', async () => {
    // The claim is an UPDATE ... RETURNING: the loser simply sees zero rows.
    const { db, calls } = stubDb([[]])
    const reindexBlock = vi.fn()
    const out = await healNextGap({ owner: 'b', resumeWindow: 20000, db, reindexBlock, readLag: async () => 0 })
    expect(out).toEqual({ status: 'idle' })
    expect(reindexBlock).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
  })

  it('claims with THIS owner and fences both writes on it', async () => {
    const { db, calls } = stubDb([SMALL, [], [], [], [{ from_block: '100' }]])
    await healNextGap({
      owner: 'owner-abc', resumeWindow: 20000, db, reindexBlock: vi.fn(async (_n: number) => {}),
      readLag: async () => 0, flushTransfers: okFlush,
    })
    const claim = JSON.stringify(calls[0])
    expect(claim).toContain('owner-abc')
    expect(claim).toContain('heal_lease_until')
    // The cursor advance (3) and the stamp (4) must both require the lease still
    // be ours. 0=claim, 1=work-set, 2=verify.
    for (const idx of [3, 4]) {
      const q = JSON.stringify(calls[idx])
      expect(q).toContain('heal_lease_owner')
      expect(q).toContain('owner-abc')
    }
  })

  it('rejects a lease too short to outlast its own safety margin', async () => {
    // A lease shorter than the abort margin would bail on every tick before doing
    // any work — healing would silently never progress.
    const { db } = stubDb([SMALL, [{ n: '100' }], [], [], [{ from_block: '100' }]])
    const reindexBlock = vi.fn(async (_n: number) => {})
    await healNextGap({
      owner: 't', resumeWindow: 20000, db, reindexBlock, readLag: async () => 0, flushTransfers: okFlush,
    }, 25, 50, 1000)
    expect(reindexBlock).toHaveBeenCalled()
  })
})

import { describe, it, expect, vi } from 'vitest'
import { healNextGap, DEFAULT_HEAL_BATCH, DEFAULT_HEAL_MAX_LAG } from './gap-healer'

/**
 * #94 recorded abandoned ranges but nothing ever healed them, so a repaired
 * range stayed `degraded` forever. These pin the two properties that make the
 * healer safe to run next to a live indexer:
 *   - it NEVER runs while behind (healing while lagging drives the loop toward
 *     the MAX_LAG skip, which abandons blocks — it would create the very gaps
 *     it exists to close), and
 *   - it NEVER stamps healed_at on faith, only off a fresh read showing the
 *     retained window is dense.
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

const GAP = [{ from_block: '100', to_block: '200', heal_from: '100', retention_floor: '50' }]


describe('healNextGap', () => {
  it('refuses to run while the indexer is behind', async () => {
    const { db, calls } = stubDb([GAP])
    const reindexBlock = vi.fn()
    const out = await healNextGap({
      db, reindexBlock, lagBlocks: () => DEFAULT_HEAL_MAX_LAG + 1,
    })
    expect(out).toEqual({ status: 'skipped', lag: DEFAULT_HEAL_MAX_LAG + 1 })
    // The guard must come BEFORE any query — healing must cost nothing at all
    // while behind, not merely skip the re-index.
    expect(calls).toHaveLength(0)
    expect(reindexBlock).not.toHaveBeenCalled()
  })

  it('treats a non-finite lag as behind (fails closed)', async () => {
    const { db } = stubDb([GAP])
    const out = await healNextGap({ db, reindexBlock: vi.fn(), lagBlocks: () => NaN })
    expect(out.status).toBe('skipped')
  })

  it('is idle when nothing unhealed intersects the retained window', async () => {
    const { db } = stubDb([[]])
    const reindexBlock = vi.fn()
    const out = await healNextGap({ db, reindexBlock, lagBlocks: () => 0 })
    expect(out).toEqual({ status: 'idle' })
    expect(reindexBlock).not.toHaveBeenCalled()
  })

  it('re-indexes missing blocks and does NOT stamp healed_at while holes remain', async () => {
    const missing = [{ n: '150' }, { n: '151' }]
    const { db, calls } = stubDb([GAP, missing])
    const reindexBlock = vi.fn(async (_n: number) => {})
    const out = await healNextGap({ db, reindexBlock, lagBlocks: () => 0 })
    expect(out).toEqual({ status: 'progressed', fromBlock: 100, toBlock: 200, repaired: 2 })
    expect(reindexBlock.mock.calls.map(c => c[0])).toEqual([150, 151])
    // gap lookup + missing lookup only — no UPDATE.
    expect(calls).toHaveLength(2)
  })

  it('stamps healed_at only once the retained window reads back dense', async () => {
    const { db, calls } = stubDb([GAP, []])
    const reindexBlock = vi.fn()
    const out = await healNextGap({ db, reindexBlock, lagBlocks: () => 0 })
    expect(out).toEqual({ status: 'healed', fromBlock: 100, toBlock: 200, repaired: 0 })
    expect(reindexBlock).not.toHaveBeenCalled()
    expect(calls).toHaveLength(3) // gap lookup + missing lookup + UPDATE
  })

  it('stops the tick on a failed block and leaves the range unhealed', async () => {
    const missing = [{ n: '150' }, { n: '151' }, { n: '152' }]
    const { db, calls } = stubDb([GAP, missing])
    const reindexBlock = vi.fn(async (n: number) => {
      if (n === 151) throw new Error('archive 403')
    })
    const out = await healNextGap({ db, reindexBlock, lagBlocks: () => 0 })
    expect(out.status).toBe('failed')
    expect(out).toMatchObject({ fromBlock: 100, toBlock: 200, repaired: 1 })
    // Bailed at 151 — did not grind the rest of the batch against a bad endpoint.
    expect(reindexBlock.mock.calls.map(c => c[0])).toEqual([150, 151])
    // Critically: no UPDATE. A partially-repaired range must stay degraded.
    expect(calls).toHaveLength(2)
  })

  it('heals from the CLAMPED start, not the recorded start', async () => {
    // The gap begins at 100 but retention has already eaten up to 150, so
    // heal_from is 150. Healing from 100 would chase blocks Postgres deletes
    // faster than we can write them, and the range would never close.
    // (The clamp itself is SQL — verified against real Postgres separately.)
    const clamped = [{ from_block: '100', to_block: '200', heal_from: '150', retention_floor: '150' }]
    const { db } = stubDb([clamped, [{ n: '150' }]])
    const reindexBlock = vi.fn(async (_n: number) => {})
    const out = await healNextGap({ db, reindexBlock, lagBlocks: () => 0 })
    expect(reindexBlock).toHaveBeenCalledWith(150)
    // healed_at is still keyed on the RECORDED start — that is the primary key.
    expect(out).toMatchObject({ fromBlock: 100, toBlock: 200 })
    expect(DEFAULT_HEAL_BATCH).toBeGreaterThan(0)
  })

  it('coerces BIGINT-as-string rows rather than trusting them', async () => {
    // node-postgres hands back BIGINT as a string; untreated, block arithmetic
    // becomes string concatenation.
    const { db } = stubDb([[{ from_block: '100', to_block: '200', heal_from: '100' }], [{ n: '150' }]])
    const reindexBlock = vi.fn(async (_n: number) => {})
    await healNextGap({ db, reindexBlock, lagBlocks: () => 0 })
    expect(reindexBlock).toHaveBeenCalledWith(150)
    expect(typeof reindexBlock.mock.calls[0][0]).toBe('number')
  })
})

import { describe, it, expect } from 'vitest'
import {
  initTransferWriter, setDurableFloor, markTransfersUnavailable,
  purgeTransferQueueAbove, getTransferQueueDepth,
} from './block-processor'

/**
 * Finding (d): quarantine must not carry the durable watermark over blocks whose
 * transfers are not yet committed.
 *
 * Isolated in its OWN file for the same reason as block-processor-rollback.test.ts:
 * initTransferWriter seeds module-level state and a seeded writer drains on every
 * enqueue, so the seed must not leak into other files' unseeded tests.
 *
 * These cases are built from a NON-CONTIGUOUS prefix rather than from a failing
 * database write. That is deliberate: whether a write succeeds here depends on a
 * local apps/indexer/.env being present, so any test keyed on write failure would
 * pass or fail by accident of the machine. Contiguity is the actual invariant, and
 * it holds identically with or without a database.
 *
 * The gap being modelled is the real one. Workers advance lastIndexed when
 * processBlock RETURNS, and processBlock only ENQUEUES transfers — so at the
 * instant quarantine fires, blocks below the blocker are routinely indexed but
 * not yet drained, and therefore not yet settled.
 */
describe('quarantine and the durable watermark', () => {
  it('markTransfersUnavailable does NOT move W when the block beneath is unsettled', () => {
    initTransferWriter(100)
    // 101 has not committed its transfers. Quarantine lands on 102, above it.
    markTransfersUnavailable(102)

    // W must stay put. Advancing to 102 would assert "every block ≤ 102 has all
    // its transfers committed" while 101's are still outstanding — and a crash
    // there loses them permanently, because resume replays from W upward.
    expect(getTransferQueueDepth().durableBlock).toBe(100)
    expect(getTransferQueueDepth().skipped).toBe(1)   // recorded, just not folded
  })

  it('setDurableFloor DOES move it — the hazard this replaces', () => {
    // Same state, old mechanism. Not hypothetical: the rejected implementation
    // called setDurableFloor(blocker) on exactly this path.
    expect(getTransferQueueDepth().durableBlock).toBe(100)
    setDurableFloor(102)
    expect(getTransferQueueDepth().durableBlock).toBe(102)   // ← claims 101 is durable
  })

  it('a reorg clears the skip mark, so the fold cannot step over a replacement block', () => {
    initTransferWriter(200)
    markTransfersUnavailable(202)
    expect(getTransferQueueDepth().skipped).toBe(1)

    // Above the fork the height now refers to a DIFFERENT block, which may well
    // carry transfers. Keeping the mark would let the fold pass over a canonical
    // block that never drained.
    purgeTransferQueueAbove(201)
    expect(getTransferQueueDepth().skipped).toBe(0)
  })

  it('a mark at or below W is ignored rather than resurrecting settled state', () => {
    initTransferWriter(300)
    markTransfersUnavailable(299)
    markTransfersUnavailable(300)
    expect(getTransferQueueDepth().skipped).toBe(0)
  })
})

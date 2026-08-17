import { describe, it, expect } from 'vitest'
import {
  enqueueTransferWrite, enqueueQuarantinedBlock,
  purgeTransferQueueAbove, getTransferQueueDepth,
} from './block-processor'

/**
 * The quarantine batch state machine.
 *
 * initTransferWriter is NEVER called in this file, so the writer stays unseeded and
 * runTransferWriter() returns immediately — every call below only mutates the
 * in-memory queue. That is deliberate: apps/indexer/.env supplies DATABASE_URL under
 * vitest, so a seeded writer here would run real DELETE/INSERT and persist the
 * watermark against whatever database that points at. codex flagged exactly that as
 * a hazard in an earlier version of these tests.
 *
 * The one property this file CANNOT reach is the payoff of the design — that a
 * quarantine batch is excluded from writeTransferBlocks' DELETE, so a stale retry
 * cannot destroy rows a heal wrote. That needs a live drain and was verified against
 * a disposable database (qtest_quarantine); see the commit message.
 */
describe('quarantine batches in the transfer queue', () => {
  const row = (n: number) => ({
    txHash: `0x${n}`, logIndex: 0, tokenAddress: '0xt', fromAddress: '0xf',
    toAddress: '0xto', value: '1', tokenId: null, blockNumber: n,
    timestamp: new Date(0), tokenType: 'BEP20' as const,
  })

  it('a quarantine batch queues the height while contributing no rows', () => {
    enqueueQuarantinedBlock(500)
    const q = getTransferQueueDepth()
    expect(q.blocks).toBe(1)     // the height is queued, so the fold will see it
    expect(q.rows).toBe(0)       // but it asserts nothing about transfers
  })

  it('a real decode REVOKES a quarantine for the same height', () => {
    // The revocation that earlier designs tracked by hand. Here it falls out of
    // "latest decode of a block wins" — there is no separate flag to update.
    enqueueTransferWrite(500, [row(500)])
    expect(getTransferQueueDepth().rows).toBe(1)
  })

  it('a quarantine does NOT clobber a real decode already queued', () => {
    // The reverse order matters too: downgrading a queued real batch to a no-op
    // would silently drop rows that were already decoded.
    enqueueTransferWrite(501, [row(501)])
    enqueueQuarantinedBlock(501)
    expect(getTransferQueueDepth().rows).toBe(2)   // 500 + 501 both still real
  })

  it('row accounting stays correct when a quarantine replaces a real batch', () => {
    enqueueTransferWrite(502, [row(502), row(502)])
    expect(getTransferQueueDepth().rows).toBe(4)
    purgeTransferQueueAbove(501)                   // drops 502's two rows
    expect(getTransferQueueDepth().rows).toBe(2)
  })

  it('a reorg purge drops quarantine batches above the fork', () => {
    // Above the fork the height refers to a DIFFERENT block, so a decision made
    // about the orphan must not let the fold step over its canonical replacement.
    enqueueQuarantinedBlock(600)
    expect(getTransferQueueDepth().blocks).toBe(3)  // 500, 501, 600
    purgeTransferQueueAbove(599)
    expect(getTransferQueueDepth().blocks).toBe(2)  // 600 gone
  })
})

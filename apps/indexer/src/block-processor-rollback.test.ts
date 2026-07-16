import { describe, it, expect } from 'vitest'
import {
  initTransferWriter, rollbackTransferWriterTo, purgeTransferQueueAbove,
  enqueueTransferWrite, getTransferQueueDepth,
} from './block-processor'

// Isolated in its OWN test file: initTransferWriter seeds module-level state, and a
// seeded writer drains on every enqueue — vitest gives each test file a fresh module
// instance, so the seed can't leak into block-processor.test.ts's unseeded tests.
//
// With no DATABASE_URL, the seeded drain's DB write rejects and enters the writer's
// 250ms requeue-retry loop — a real in-flight drainer. rollbackTransferWriterTo must
// quiesce it (pause + wait), purge the requeued stale rows, and rewind W. That is
// exactly codex P1+P2 on PR #67. persistDurableBlock also rejects here; the rollback
// logs that loudly and keeps the in-memory rewind (documented persist-failure path).
describe('rollbackTransferWriterTo (codex P1+P2 on PR #67)', () => {
  const row = (n: number) => ({
    txHash: `0x${n}`, logIndex: 0, tokenAddress: '0xt', fromAddress: '0xf',
    toAddress: '0xto', value: '1', tokenId: null, blockNumber: n,
    timestamp: new Date(0), tokenType: 'BEP20' as const,
  })

  it('quiesces an in-flight (failing) drain, purges stale rows above the fork, rewinds W', async () => {
    initTransferWriter(100)
    expect(getTransferQueueDepth().durableBlock).toBe(100)

    // Seeded writer starts draining immediately; the write fails and retry-loops.
    enqueueTransferWrite(99, [row(99)])

    await rollbackTransferWriterTo(98)

    const after = getTransferQueueDepth()
    expect(after.durableBlock).toBe(98)   // rewound in memory despite persist failure
    expect(after.blocks).toBe(0)          // stale block-99 decode purged
    expect(after.rows).toBe(0)
  })

  it('never advances W: a rollback to a point above W is a no-op on the watermark', async () => {
    await rollbackTransferWriterTo(150)
    expect(getTransferQueueDepth().durableBlock).toBe(98)
  })

  it('purgeTransferQueueAbove alone never touches W', () => {
    purgeTransferQueueAbove(0)
    expect(getTransferQueueDepth().durableBlock).toBe(98)
  })
})

/**
 * Tests for local-history completeness detection.
 *
 * Regression context: a retention-pruned wallet (e.g. heatherm.eth — 118 lifetime
 * txns but only 1 row retained) must be recognized as "incomplete" so the address
 * page serves the full Moralis history instead of a partial local slice with bogus
 * pagination ("Page 1 of 5", pages 2-5 empty). Conversely, a fully-indexed active
 * wallet (first_seen within the retention window) must NOT be flagged, so it keeps
 * the fast local path with zero extra Moralis calls.
 *
 * The signal is exact because the indexer prunes high-volume tables to a rolling
 * window but NEVER touches the addresses table — so addresses.first_seen is the
 * frozen timestamp of the first indexed tx, and first_seen < oldest-retained-block
 * means that earliest tx (and likely more) has been deleted from the local index.
 */
import { describe, it, expect } from 'vitest'
import { isLocalHistoryIncomplete } from './retention'

describe('isLocalHistoryIncomplete', () => {
  // Retention floor = timestamp of the oldest block still in the local index.
  const floor = new Date('2026-05-31T00:00:00Z')

  it('flags a wallet whose first_seen predates the retention floor (history pruned)', () => {
    // heatherm.eth shape: first indexed ~35d ago, retention window ~4d.
    const firstSeen = new Date('2026-04-26T00:00:00Z')
    expect(isLocalHistoryIncomplete(firstSeen, floor)).toBe(true)
  })

  it('does not flag a fully-indexed active wallet (first_seen within the window)', () => {
    const firstSeen = new Date('2026-06-02T00:00:00Z')
    expect(isLocalHistoryIncomplete(firstSeen, floor)).toBe(false)
  })

  it('treats first_seen exactly at the floor as complete (oldest tx still retained)', () => {
    expect(isLocalHistoryIncomplete(new Date(floor), floor)).toBe(false)
  })

  it('returns false when first_seen is unknown — avoids spurious Moralis calls', () => {
    expect(isLocalHistoryIncomplete(null, floor)).toBe(false)
    expect(isLocalHistoryIncomplete(undefined, floor)).toBe(false)
  })

  it('returns false when the retention floor is unknown — degrades to prior empty-only behavior', () => {
    expect(isLocalHistoryIncomplete(new Date('2020-01-01T00:00:00Z'), null)).toBe(false)
  })
})

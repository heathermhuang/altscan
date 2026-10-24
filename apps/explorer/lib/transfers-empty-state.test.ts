import { describe, it, expect } from 'vitest'
import { TRANSFERS_EMPTY_TEXT, transfersEmptyState } from './transfers-empty-state'

// "No transfers yet." is a claim about the token: only a query that succeeded and found nothing may make it.
const ROW = {}
describe('transfersEmptyState', () => {
  it('a query that failed or timed out (null) is unavailable, whatever the count says', () => {
    for (const count of [-1, 0, 5]) expect(transfersEmptyState({ rows: null, count, offset: 0 }), String(count)).toBe('unavailable')
  })

  it('rows are rows', () => {
    expect(transfersEmptyState({ rows: [ROW], count: 1, offset: 0 })).toBe('rows')
    expect(transfersEmptyState({ rows: [ROW], count: -1, offset: 0 })).toBe('rows')
  })

  it('a successful empty result with a count of zero is "none"', () => {
    expect(transfersEmptyState({ rows: [], count: 0, offset: 0 })).toBe('none')
  })

  it('a successful empty result whose count is unknown is "none": the rows query did answer', () => {
    expect(transfersEmptyState({ rows: [], count: -1, offset: 0 })).toBe('none')
  })

  it('an empty page when the count says there are rows at this offset is unavailable', () => {
    expect(transfersEmptyState({ rows: [], count: 7, offset: 0 })).toBe('unavailable')
    expect(transfersEmptyState({ rows: [], count: 30, offset: 25 })).toBe('unavailable')
  })

  it('an empty page past the last row is "none", not an outage', () => {
    expect(transfersEmptyState({ rows: [], count: 7, offset: 25 })).toBe('none')
    expect(transfersEmptyState({ rows: [], count: 25, offset: 25 })).toBe('none')
  })

  it('has one line of text for each state with no rows', () => {
    expect(TRANSFERS_EMPTY_TEXT.none).toBe('No transfers yet.')
    expect(TRANSFERS_EMPTY_TEXT.unavailable).toBe('Transfers are temporarily unavailable. Try again shortly.')
  })
})

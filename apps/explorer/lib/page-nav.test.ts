import { describe, expect, it } from 'vitest'
import { pageNav } from '@/lib/page-nav'
import { MAX_LIST_ROWS } from '@/lib/list-depth'

describe('pageNav', () => {
  it('prints an exact "of N" for an estimate under the depth limit', () => {
    expect(pageNav({ page: 1, total: 1_000, perPage: 25 })).toEqual({ label: 'Page 1 of 40', hasPrev: false, hasNext: true })
    expect(pageNav({ page: 40, total: 1_000, perPage: 25 })).toEqual({ label: 'Page 40 of 40', hasPrev: true, hasNext: false })
  })

  it('a total at the depth limit is "at least" that many: "of 400+", with the last served page as its end', () => {
    expect(pageNav({ page: 1, total: MAX_LIST_ROWS, perPage: 25 })).toEqual({ label: 'Page 1 of 400+', hasPrev: false, hasNext: true })
    expect(pageNav({ page: 399, total: MAX_LIST_ROWS, perPage: 25 })?.hasNext).toBe(true)
    // The 400th page is the deepest the list serves; a next link would only land on it again.
    expect(pageNav({ page: 400, total: MAX_LIST_ROWS, perPage: 25 })).toEqual({ label: 'Page 400 of 400+', hasPrev: true, hasNext: false })
    expect(pageNav({ page: 1, total: MAX_LIST_ROWS, perPage: 50 })?.label).toBe('Page 1 of 200+')
  })

  it('a total just under the depth limit is still exact', () => {
    expect(pageNav({ page: 1, total: MAX_LIST_ROWS - 1, perPage: 25 })?.label).toBe('Page 1 of 400')
  })

  it('groups the numbers, and does not guess a cap for totals the lists never pass (the component is generic)', () => {
    expect(pageNav({ page: 1, total: 15_469 * 50, perPage: 50 })?.label).toBe('Page 1 of 15,469')
    expect(pageNav({ page: 1234, total: 1_288_067 * 50, perPage: 50 })?.label).toBe('Page 1,234 of 1,288,067')
  })

  it('nothing to page through is null', () => {
    expect(pageNav({ page: 1, total: 25, perPage: 25 })).toBeNull()
    expect(pageNav({ page: 1, total: 0, perPage: 25 })).toBeNull()
    expect(pageNav({ page: 1, total: 0, perPage: 25, rowsOnPage: 0 })).toBeNull()
    expect(pageNav({ page: 1, total: 0, perPage: 25, rowsOnPage: 7 })).toBeNull()
  })

  describe('an estimate behind the table (pg_class says 0)', () => {
    it('a full page with an estimate of 0 still offers the next link, with no total to claim', () => {
      expect(pageNav({ page: 1, total: 0, perPage: 25, rowsOnPage: 25 })).toEqual({ label: 'Page 1', hasPrev: false, hasNext: true })
    })

    it('the same holds on a later page the estimate does not reach, and keeps the way back', () => {
      expect(pageNav({ page: 3, total: 50, perPage: 25, rowsOnPage: 25 })).toEqual({ label: 'Page 3', hasPrev: true, hasNext: true })
    })

    it('a page fuller than the estimate allows for proves the estimate is behind, even inside its range', () => {
      // 40 rows is 25 + 15: page 2 holding 25 rows has 10 the estimate did not count.
      expect(pageNav({ page: 2, total: 40, perPage: 25, rowsOnPage: 25 })).toEqual({ label: 'Page 2', hasPrev: true, hasNext: true })
    })

    it('a full last page the estimate does account for proves nothing: it keeps its "of N" and its end', () => {
      expect(pageNav({ page: 2, total: 50, perPage: 25, rowsOnPage: 25 })).toEqual({ label: 'Page 2 of 2', hasPrev: true, hasNext: false })
    })

    it('a partial page is the end: no next link, whatever the estimate', () => {
      expect(pageNav({ page: 3, total: 50, perPage: 25, rowsOnPage: 10 })?.hasNext).toBe(false)
      expect(pageNav({ page: 1, total: 0, perPage: 25, rowsOnPage: 10 })).toBeNull()
    })

    it('never offers a page past the deepest the list serves', () => {
      expect(pageNav({ page: 400, total: 0, perPage: 25, rowsOnPage: 25 })).toEqual({ label: 'Page 400', hasPrev: true, hasNext: false })
    })

    // Following the next link off an estimate of 0 (30 rows) lands on a partial page 2: it must keep the way
    // back, and a stale estimate of 2 pages must not come back as "Page 4 of 2" on page 4.
    it('the partial page a next link led to keeps its previous link and claims no total', () => {
      expect(pageNav({ page: 2, total: 0, perPage: 25, rowsOnPage: 5 })).toEqual({ label: 'Page 2', hasPrev: true, hasNext: false })
      expect(pageNav({ page: 4, total: 50, perPage: 25, rowsOnPage: 10 })).toEqual({ label: 'Page 4', hasPrev: true, hasNext: false })
      expect(pageNav({ page: 4, total: 50, perPage: 25, rowsOnPage: 0 })).toEqual({ label: 'Page 4', hasPrev: true, hasNext: false })
    })

    it('a caller that does not pass rowsOnPage keeps the estimate as the whole story', () => {
      expect(pageNav({ page: 1, total: 0, perPage: 25 })).toBeNull()
    })
  })
})

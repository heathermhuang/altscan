import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Pagination } from './Pagination'

const html = (props: { page: number; total: number; perPage?: number; baseUrl?: string; rowsOnPage?: number }) =>
  renderToStaticMarkup(createElement(Pagination, { perPage: 50, baseUrl: '/blocks', ...props }))

describe('Pagination', () => {
  it('groups both numbers in "Page X of Y"', () => {
    // /blocks read "Page 1 of 15469" while its block numbers were grouped.
    expect(html({ page: 1, total: 15_469 * 50 })).toContain('Page 1 of 15,469')
    expect(html({ page: 1234, total: 1_288_067 * 50 })).toContain('Page 1,234 of 1,288,067')
  })

  it('keeps the raw number in the links', () => {
    const h = html({ page: 1234, total: 20_000 * 50 })
    expect(h).toContain('href="/blocks?page=1233"')
    expect(h).toContain('href="/blocks?page=1235"')
    expect(h).not.toMatch(/page=1,/)
  })

  it('renders nothing for a single page', () => {
    expect(html({ page: 1, total: 50 })).toBe('')
  })

  it('reads "of 400+" at the depth limit: the 400th page is where the list stops serving, not where the data ends', () => {
    // The lists pass Math.min(total, MAX_LIST_ROWS), so the cap arrives as exactly 10,000.
    const h = html({ page: 1, total: 10_000, perPage: 25, baseUrl: '/txs' })
    expect(h).toContain('Page 1 of 400+')
    expect(h).toContain('href="/txs?page=2"')
    const last = html({ page: 400, total: 10_000, perPage: 25, baseUrl: '/txs' })
    expect(last).toContain('Page 400 of 400+')
    expect(last).not.toContain('Next page')
  })

  it('still links to the next page when the row estimate is 0 but the page came back full', () => {
    const h = html({ page: 1, total: 0, perPage: 25, baseUrl: '/txs', rowsOnPage: 25 })
    expect(h).toContain('href="/txs?page=2"')
    expect(h).toContain('Page 1')
    expect(h).not.toContain(' of ')
    expect(html({ page: 1, total: 0, perPage: 25, baseUrl: '/txs', rowsOnPage: 3 })).toBe('')
  })
})

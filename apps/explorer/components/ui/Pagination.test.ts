import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Pagination } from './Pagination'

const html = (props: { page: number; total: number; perPage?: number; baseUrl?: string }) =>
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
})

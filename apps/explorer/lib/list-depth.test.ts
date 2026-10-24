import { describe, expect, it } from 'vitest'
import { apiListPage, clampListPage, lastListPage, MAX_LIST_ROWS } from './list-depth'

const q = (s: string) => new URLSearchParams(s)

describe('list depth', () => {
  it('serves the newest 10,000 rows: 400 pages of 25, 200 of 50', () => {
    expect(MAX_LIST_ROWS).toBe(10_000)
    expect(lastListPage(25)).toBe(400)
    expect(lastListPage(50)).toBe(200)
  })

  it('clamps a page into the served range', () => {
    expect(clampListPage(7, 25)).toBe(7)
    expect(clampListPage(400, 25)).toBe(400)
    expect(clampListPage(401, 25)).toBe(400)
    expect(clampListPage(9_999_999, 25)).toBe(400)
    expect(clampListPage(0, 25)).toBe(1)
  })
})

describe('apiListPage', () => {
  it('keeps the documented defaults and limit clamping', () => {
    expect(apiListPage(q(''))).toEqual({ page: 1, limit: 20, offset: 0 })
    expect(apiListPage(q('page=3&limit=50'))).toEqual({ page: 3, limit: 50, offset: 100 })
    expect(apiListPage(q('limit=999'))).toEqual({ page: 1, limit: 50, offset: 0 })
    expect(apiListPage(q('page=0&limit=0'))).toEqual({ page: 1, limit: 1, offset: 0 })
  })

  it('floors fractions instead of handing Postgres a fractional OFFSET or LIMIT', () => {
    expect(apiListPage(q('page=2.9&limit=20.5'))).toEqual({ page: 2, limit: 20, offset: 20 })
  })

  it.each(['page=abc', 'page=Infinity', 'limit=Infinity', 'page=1e999'])('refuses %s', (s) => {
    expect(apiListPage(q(s))).toEqual({ error: 'Invalid pagination parameters' })
  })

  it('serves the last page that starts inside the newest 10,000 rows, and refuses the next', () => {
    expect(apiListPage(q('page=500&limit=20'))).toEqual({ page: 500, limit: 20, offset: 9_980 })
    expect(apiListPage(q('page=501&limit=20'))).toMatchObject({ error: expect.stringMatching(/beyond the newest 10000 records/) })
    expect(apiListPage(q('page=200&limit=50'))).toEqual({ page: 200, limit: 50, offset: 9_950 })
    expect(apiListPage(q('page=201&limit=50'))).toHaveProperty('error')
    expect(apiListPage(q('page=1000000000'))).toHaveProperty('error')
  })
})

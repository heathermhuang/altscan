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

// One rule for a `?page=` value: parsePageParam (lib/list-pages.ts). The address and token pages
// parsed it with parseInt, so `?page=3abc` served page 3 there and page 1 everywhere else.
describe('page params are parsed in one place', () => {
  it('no page or component parses a ?page= value by hand', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const root = join(__dirname, '..')
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n)
      if (n === 'node_modules' || n.startsWith('.')) return []
      if (statSync(p).isDirectory()) return walk(p)
      return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : []
    })
    const handParse = /\b(?:parseInt|Number)\(\s*(?:pageStr|page|sp\.page|searchParams\.page|params\.page)\b/
    const hits = [...walk(join(root, 'app')), ...walk(join(root, 'components'))]
      .filter((f) => handParse.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1))
    expect(hits).toEqual([])
    expect(handParse.test("parseInt(pageStr ?? '1', 10)")).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The pages that document the API's limits quote lib/api-limits.ts (and WATCH_MAX_ADDRESSES)
// rather than spelling numbers out. Each limit used to live as a literal in the enforcing code
// and again in several pages, so a change had to find them all.
const ROOT = join(__dirname, '..')
const DOC_SURFACES = [
  'app/api-docs/page.tsx',
  'app/developer/page.tsx',
  'app/auth.md/route.ts',
  'app/llms.txt/route.ts',
  'lib/openapi.ts',
]
// A digit run directly before "requests" (a rate), or a limit phrase with a literal number.
const LITERAL_LIMIT = /\b\d+ requests\b|\bup to \d+ addresses\b|\bAt most \d+ per owner\b|\bmax: \d+\)|\b1–\d+\b|\bmaximum: \d+\b|\(default: \d+, max: \d/

describe('documented API limits come from lib/api-limits.ts', () => {
  it.each(DOC_SURFACES)('%s spells out no limit', (file) => {
    const offenders = readFileSync(join(ROOT, file), 'utf8').split('\n')
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => LITERAL_LIMIT.test(line))
      .map(({ line, i }) => `${file}:${i + 1}: ${line.trim().slice(0, 90)}`)
    expect(offenders).toEqual([])
  })

  it('the scan recognises the spellings it bans', () => {
    for (const s of ['limited to 100 requests per minute', 'a watchlist of up to 50 addresses', 'At most 50 per owner', '(default: 20, max: 50)', 'Values outside 1–50 are clamped', 'maximum: 50, default', '(default: 25, max: 100)']) {
      expect(LITERAL_LIMIT.test(s), s).toBe(true)
    }
  })
})

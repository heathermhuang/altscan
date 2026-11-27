import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * docs/architecture/README.md's "Canonical modules" table is the inventory of concepts and
 * the one module that owns each. This makes it machine-checked: every repo path it names, as
 * the canonical module or as the guard test, must exist. Rename or delete a canonical module
 * without updating the inventory and this fails.
 */
const ROOT = join(__dirname, '..')
const doc = readFileSync(join(ROOT, 'docs/architecture/README.md'), 'utf8')
const table = doc.slice(doc.indexOf('## Canonical modules'), doc.indexOf('## State ownership'))
const rows = table.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Concern') && !l.startsWith('|---'))
const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n'))
const PATH = /`((?:apps|packages|scripts)\/[^`\s]+\.(?:ts|tsx))`/g

describe('the canonical-module inventory', () => {
  it('lists concepts (cannot pass vacuously)', () => {
    expect(rows.length).toBeGreaterThan(20)
  })

  it('every concept names at least one canonical module by path', () => {
    const unnamed = rows.filter((r) => ![...r.split('|')[2].matchAll(PATH)].length).map((r) => r.split('|')[1].trim())
    expect(unnamed).toEqual([])
  })

  it('every path it names exists', () => {
    const missing = rows.flatMap((r) => [...r.matchAll(PATH)].map((m) => m[1])).filter((p) => !tracked.has(p))
    expect(missing).toEqual([])
  })
})

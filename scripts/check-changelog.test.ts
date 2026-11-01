import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain ESM script, no type declarations.
import { addedLines, checkPr, isExemptTitle, unreleasedLines } from './check-changelog.mjs'

const FILE = `# Changelog

## [Unreleased]

### Fixed
- Old fix (#100).
- New fix (#299).

## [0.4.0.0] - 2026-10-12

### Fixed
- Released fix (#298).
`
const diffAdding = (...lines: string[]) =>
  ['diff --git a/CHANGELOG.md b/CHANGELOG.md', '--- a/CHANGELOG.md', '+++ b/CHANGELOG.md', '@@ -1 +1 @@', ...lines.map((l) => `+${l}`)].join('\n')
const pr = (over = {}) => ({ title: 'fix(explorer): a thing', number: 299, labels: [], changelog: FILE, diff: '', ...over })

describe('isExemptTitle', () => {
  it.each(['chore: x', 'ci: x', 'test: x', 'docs: x', 'refactor: x', 'style: x', 'chore(deps): bump y', 'docs(changelog): z', 'ci!: x'])(
    'exempts %s',
    (title) => expect(isExemptTitle(title)).toBe(true),
  )
  it.each(['fix: x', 'feat(site): x', 'perf: x', 'fix(deps): patch', 'security: x', 'chores: x', 'docs x', 'update docs: x'])(
    'does not exempt %s',
    (title) => expect(isExemptTitle(title)).toBe(false),
  )
})

describe('unreleasedLines', () => {
  it('returns only the Unreleased section', () => {
    const lines = unreleasedLines(FILE)
    expect(lines).toContain('- New fix (#299).')
    expect(lines).not.toContain('- Released fix (#298).')
  })
  it('returns nothing without the heading', () => {
    expect(unreleasedLines('# Changelog\n')).toEqual([])
  })
  it('finds the heading in the real file', () => {
    expect(unreleasedLines(readFileSync('CHANGELOG.md', 'utf8')).length).toBeGreaterThan(0)
  })
})

describe('addedLines', () => {
  it('returns added lines without the marker, and skips the file header', () => {
    expect(addedLines(diffAdding('- New fix (#299).'))).toEqual(['- New fix (#299).'])
  })
  it('ignores removed and context lines', () => {
    expect(addedLines('@@ -1 +1 @@\n-gone\n kept')).toEqual([])
  })
})

describe('checkPr', () => {
  it('passes an exempt title with no entry', () => {
    expect(checkPr(pr({ title: 'test(explorer): pin x' })).ok).toBe(true)
  })
  it('passes the no-changelog label', () => {
    expect(checkPr(pr({ labels: ['bug', 'no-changelog'] })).ok).toBe(true)
  })
  it('passes an added Unreleased bullet citing this PR', () => {
    expect(checkPr(pr({ diff: diffAdding('- New fix (#299).') })).ok).toBe(true)
  })
  it('passes when the number sits among several', () => {
    const changelog = FILE.replace('- New fix (#299).', '- New fix (#120, #299, #300).')
    expect(checkPr(pr({ changelog, diff: diffAdding('- New fix (#120, #299, #300).') })).ok).toBe(true)
  })
  it('fails with no entry, and says what to add', () => {
    const out = checkPr(pr())
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('(#299)')
    expect(out.reason).toContain('no-changelog')
  })
  it('fails an entry citing a different PR', () => {
    expect(checkPr(pr({ number: 301, diff: diffAdding('- New fix (#299).') })).ok).toBe(false)
  })
  it('does not match a longer number', () => {
    const changelog = FILE.replace('(#299)', '(#2990)')
    expect(checkPr(pr({ changelog, diff: diffAdding('- New fix (#2990).') })).ok).toBe(false)
  })
  it('fails a bullet added under a released version', () => {
    expect(checkPr(pr({ number: 298, diff: diffAdding('- Released fix (#298).') })).ok).toBe(false)
  })
  it('fails a line in Unreleased that was not added by this PR', () => {
    expect(checkPr(pr({ diff: diffAdding('- Something else.') })).ok).toBe(false)
  })
  it('fails an added line that is not a bullet', () => {
    const changelog = FILE.replace('- New fix (#299).', 'Prose (#299).')
    expect(checkPr(pr({ changelog, diff: diffAdding('Prose (#299).') })).ok).toBe(false)
  })
})

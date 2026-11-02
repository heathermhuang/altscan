import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { changelogProblems, parseChangelog } from '../apps/altscan-site/src/lib/changelog'
// @ts-expect-error — plain ESM script, no type declarations.
import { foldFragments, parseFragmentName } from './changelog-fragments.mjs'

const FILE = `# Changelog

## [Unreleased]

### Added
- Old feature (#100).

### Fixed
- Old fix (#101).

## [0.4.0.0] - 2026-10-12

### Fixed
- Released fix (#98).
`
const fragment = (name: string, text: string) => ({ name, text })

describe('parseFragmentName', () => {
  it('reads the PR number and section', () => {
    expect(parseFragmentName('312.fixed.md')).toEqual({ number: 312, section: 'Fixed' })
  })
  it.each(['README.md', 'fixed.md', '312.md', '312.bugfix.md', '312.Fixed.md', '312.fixed.txt', 'x312.fixed.md'])('rejects %s', (name) => {
    expect(parseFragmentName(name)).toBeNull()
  })
})

describe('foldFragments', () => {
  it('leaves the file alone with no fragments', () => {
    expect(foldFragments(FILE, [])).toBe(FILE)
  })
  it('puts an entry at the top of its section', () => {
    const out = foldFragments(FILE, [fragment('312.fixed.md', '- New fix (#312).\n')])
    expect(out).toContain('### Fixed\n- New fix (#312).\n- Old fix (#101).')
  })
  it('never touches a released version', () => {
    const out = foldFragments(FILE, [fragment('312.fixed.md', '- New fix (#312).\n')])
    expect(out).toContain('## [0.4.0.0] - 2026-10-12\n\n### Fixed\n- Released fix (#98).')
  })
  it('orders entries newest first', () => {
    const out = foldFragments(FILE, [fragment('312.fixed.md', '- First (#312).'), fragment('320.fixed.md', '- Second (#320).')])
    expect(out).toContain('### Fixed\n- Second (#320).\n- First (#312).\n- Old fix (#101).')
  })
  it('sorts by number, not by name', () => {
    const out = foldFragments(FILE, [fragment('99.fixed.md', '- Low (#99).'), fragment('100.fixed.md', '- High (#100).')])
    expect(out.indexOf('High')).toBeLessThan(out.indexOf('Low'))
  })
  it('adds a missing section in Keep a Changelog order', () => {
    const out = foldFragments(FILE, [fragment('312.changed.md', '- Reworked (#312).')])
    expect(out).toContain('- Old feature (#100).\n\n### Changed\n- Reworked (#312).\n\n### Fixed')
  })
  it('adds a final section inside Unreleased', () => {
    const out = foldFragments(FILE, [fragment('312.security.md', '- Patched (#312).')])
    expect(out).toContain('- Old fix (#101).\n\n### Security\n- Patched (#312).\n\n## [0.4.0.0]')
  })
  it('refuses a file with no Unreleased section', () => {
    expect(() => foldFragments('# Changelog\n', [fragment('312.fixed.md', '- x (#312).')])).toThrow('Unreleased')
  })
  it('keeps the real file readable by the page', () => {
    const real = readFileSync('CHANGELOG.md', 'utf8')
    const folded = parseChangelog(foldFragments(real, [fragment('9999.fixed.md', '- **A fix** for visitors (#9999).')]))
    expect(changelogProblems(folded)).toEqual([])
    expect(folded.unreleased?.sections.find((s) => s.title === 'Fixed')?.bullets[0]?.lead).not.toBeNull()
  })
})

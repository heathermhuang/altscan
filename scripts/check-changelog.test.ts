import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain ESM script, no type declarations.
import { checkPr, isExemptTitle } from './check-changelog.mjs'

const entry = (name = '299.fixed.md', text = '- New fix (#299).\n') => ({ name, text })
const pr = (over = {}) => ({ title: 'fix(explorer): a thing', number: 299, labels: [], fragments: [], ...over })

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

describe('checkPr', () => {
  it('passes an exempt title with no entry', () => {
    expect(checkPr(pr({ title: 'test(explorer): pin x' })).ok).toBe(true)
  })
  it('passes the no-changelog label', () => {
    expect(checkPr(pr({ labels: ['bug', 'no-changelog'] })).ok).toBe(true)
  })
  it('passes an added entry file citing this PR', () => {
    expect(checkPr(pr({ fragments: [entry()] })).ok).toBe(true)
  })
  it('passes when the number arrives as a string, as it does from env', () => {
    expect(checkPr(pr({ number: '299', fragments: [entry()] })).ok).toBe(true)
  })
  it('passes when the number sits among several', () => {
    expect(checkPr(pr({ fragments: [entry('299.fixed.md', '- New fix (#120, #299, #300).')] })).ok).toBe(true)
  })
  it('fails with no entry, and says what to add', () => {
    const out = checkPr(pr())
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('changelog.d/299.fixed.md')
    expect(out.reason).toContain('no-changelog')
  })
  it('fails a file named for a different PR', () => {
    expect(checkPr(pr({ number: 301, fragments: [entry()] })).ok).toBe(false)
  })
  it('fails a file whose bullet cites a different PR', () => {
    expect(checkPr(pr({ fragments: [entry('299.fixed.md', '- New fix (#300).')] })).ok).toBe(false)
  })
  it('does not match a longer number', () => {
    expect(checkPr(pr({ fragments: [entry('299.fixed.md', '- New fix (#2990).')] })).ok).toBe(false)
  })
  it('fails an unknown section', () => {
    expect(checkPr(pr({ fragments: [entry('299.bugfix.md')] })).ok).toBe(false)
  })
  it('fails text that is not a bullet', () => {
    expect(checkPr(pr({ fragments: [entry('299.fixed.md', 'Prose (#299).')] })).ok).toBe(false)
  })
})

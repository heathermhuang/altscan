/**
 * Unreleased changelog entries live one per file in changelog.d/, so parallel
 * PRs never edit the same lines of CHANGELOG.md.
 *
 *   --stdout  prints CHANGELOG.md with the entries folded into [Unreleased].
 *             publish-changelog.yml publishes this for altscan.io/changelog.
 *   --write   folds them into CHANGELOG.md and deletes the files, for a release.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'changelog.d'
const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']
const NAME = /^(\d+)\.(added|changed|deprecated|removed|fixed|security)\.md$/

export function parseFragmentName(name) {
  const m = NAME.exec(name)
  return m ? { number: Number(m[1]), section: m[2][0].toUpperCase() + m[2].slice(1) } : null
}

export function foldFragments(changelog, fragments) {
  const lines = changelog.split('\n')
  const start = lines.findIndex((l) => l.startsWith('## [Unreleased]'))
  if (start < 0) throw new Error('CHANGELOG.md has no [Unreleased] section')
  const next = lines.findIndex((l, i) => i > start && l.startsWith('## ['))
  let end = next < 0 ? lines.length : next
  const find = (headings) => lines.findIndex((l, i) => i > start && i < end && headings.includes(l))

  const entries = fragments
    .map((f) => ({ ...parseFragmentName(f.name), text: f.text.trim() }))
    .sort((a, b) => b.number - a.number)
  for (const [i, section] of SECTIONS.entries()) {
    const texts = entries.filter((e) => e.section === section).map((e) => e.text)
    if (!texts.length) continue
    const heading = find([`### ${section}`])
    if (heading >= 0) {
      lines.splice(heading + 1, 0, ...texts)
      end += texts.length
      continue
    }
    const later = find(SECTIONS.slice(i + 1).map((s) => `### ${s}`))
    const block = [`### ${section}`, ...texts, '']
    lines.splice(later < 0 ? end : later, 0, ...block)
    end += block.length
  }
  return lines.join('\n')
}

function main() {
  const fragments = readdirSync(DIR)
    .filter((name) => parseFragmentName(name))
    .map((name) => ({ name, text: readFileSync(join(DIR, name), 'utf8') }))
  const folded = foldFragments(readFileSync('CHANGELOG.md', 'utf8'), fragments)
  const mode = process.argv[2]
  if (mode === '--stdout') {
    process.stdout.write(folded)
  } else if (mode === '--write') {
    writeFileSync('CHANGELOG.md', folded)
    for (const { name } of fragments) rmSync(join(DIR, name))
  } else {
    console.error('Usage: node scripts/changelog-fragments.mjs --stdout | --write')
    process.exitCode = 1
  }
}

// Only run when executed directly, so the test can import the pure helpers.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()

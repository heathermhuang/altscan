/**
 * PR check: a user-facing change carries its own line in CHANGELOG.md, which is
 * what altscan.io/changelog publishes.
 *
 * Passes when the title's type is exempt, the PR has the `no-changelog` label,
 * or the PR adds a bullet under `## [Unreleased]` citing its own number.
 *
 * Runs on `pull_request`: a read-only token and no secrets. Title and labels
 * arrive through env, and the title is never printed, so it cannot inject
 * workflow commands.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const EXEMPT_TITLE = /^(chore|ci|test|docs|refactor|style)(\([^)]*\))?!?:/
const SKIP_LABEL = 'no-changelog'

export const isExemptTitle = (title) => EXEMPT_TITLE.test(title)

export function unreleasedLines(changelog) {
  const lines = changelog.split('\n')
  const start = lines.findIndex((l) => l.startsWith('## [Unreleased]'))
  if (start < 0) return []
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => l.startsWith('## ['))
  return end < 0 ? rest : rest.slice(0, end)
}

/** The lines a unified diff adds, without their `+`. */
export function addedLines(diff) {
  return diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
}

export function checkPr({ title, number, labels, changelog, diff }) {
  if (isExemptTitle(title)) return { ok: true, reason: 'Exempt title type.' }
  if (labels.includes(SKIP_LABEL)) return { ok: true, reason: `Labelled ${SKIP_LABEL}.` }
  const added = new Set(addedLines(diff))
  const cites = new RegExp(`#${number}(?!\\d)`)
  const entry = unreleasedLines(changelog).some((l) => l.startsWith('- ') && added.has(l) && cites.test(l))
  if (entry) return { ok: true, reason: 'Changelog entry found.' }
  return {
    ok: false,
    reason:
      `Add a bullet under [Unreleased] in CHANGELOG.md ending in (#${number}), ` +
      `or add the ${SKIP_LABEL} label if nothing changes for users.`,
  }
}

function main() {
  const { ok, reason } = checkPr({
    title: process.env.PR_TITLE ?? '',
    number: process.env.PR_NUMBER ?? '',
    labels: JSON.parse(process.env.PR_LABELS ?? '[]'),
    changelog: readFileSync('CHANGELOG.md', 'utf8'),
    diff: execFileSync('git', ['diff', 'HEAD^1', 'HEAD', '--', 'CHANGELOG.md'], { encoding: 'utf8' }),
  })
  console.log(ok ? reason : `::error file=CHANGELOG.md::${reason}`)
  if (!ok) process.exitCode = 1
}

// Only run when executed directly, so the test can import the pure helpers.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()

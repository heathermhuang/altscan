/**
 * PR check: a user-facing change carries its own entry file in changelog.d/,
 * which altscan.io/changelog publishes.
 *
 * Passes when the title's type is exempt, the PR has the `no-changelog` label,
 * or the PR adds changelog.d/<number>.<section>.md with a bullet citing its
 * own number.
 *
 * Runs on `pull_request`: a read-only token and no secrets. Title and labels
 * arrive through env, and the title is never printed, so it cannot inject
 * workflow commands.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseFragmentName } from './changelog-fragments.mjs'

const EXEMPT_TITLE = /^(chore|ci|test|docs|refactor|style)(\([^)]*\))?!?:/
const SKIP_LABEL = 'no-changelog'

export const isExemptTitle = (title) => EXEMPT_TITLE.test(title)

export function checkPr({ title, number, labels, fragments }) {
  if (isExemptTitle(title)) return { ok: true, reason: 'Exempt title type.' }
  if (labels.includes(SKIP_LABEL)) return { ok: true, reason: `Labelled ${SKIP_LABEL}.` }
  const cites = new RegExp(`#${number}(?!\\d)`)
  const entry = fragments.some(
    ({ name, text }) =>
      parseFragmentName(name)?.number === Number(number) &&
      text.split('\n').some((l) => l.startsWith('- ') && cites.test(l)),
  )
  if (entry) return { ok: true, reason: 'Changelog entry found.' }
  return {
    ok: false,
    reason:
      `Add changelog.d/${number}.fixed.md (or .added, .changed, .security) with a bullet ending in (#${number}), ` +
      `or add the ${SKIP_LABEL} label if nothing changes for users.`,
  }
}

function main() {
  const added = execFileSync('git', ['diff', '--name-only', '--diff-filter=A', 'HEAD^1', 'HEAD', '--', 'changelog.d'], { encoding: 'utf8' })
  const { ok, reason } = checkPr({
    title: process.env.PR_TITLE ?? '',
    number: process.env.PR_NUMBER ?? '',
    labels: JSON.parse(process.env.PR_LABELS ?? '[]'),
    fragments: added
      .split('\n')
      .filter(Boolean)
      .map((path) => ({ name: basename(path), text: readFileSync(path, 'utf8') })),
  })
  console.log(ok ? reason : `::error::${reason}`)
  if (!ok) process.exitCode = 1
}

// Only run when executed directly, so the test can import the pure helpers.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()

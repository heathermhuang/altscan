import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Production installs must be lockfile-frozen. `--no-frozen-lockfile` lets a
 * Render build resolve whatever the registry serves that day instead of the
 * versions CI tested, so a freshly published (or hijacked) dependency version
 * reaches production without ever appearing in a reviewed lockfile diff.
 *
 * Both blueprints are checked as text rather than parsed YAML: the commands sit
 * in plain and folded (`>-`) scalars, and a regex over `pnpm install` finds
 * every occurrence in either form without a YAML dependency at the repo root.
 */
const BLUEPRINTS = [
  { file: 'render.yaml', installs: 4 },
  { file: 'deploy/render/blueprint.yaml', installs: 2 },
]

/** Every `pnpm install` invocation with its flags (up to the next `&&`, `;`, `|`, `"`, `'` or newline). */
function installCommands(text: string): string[] {
  return [...text.matchAll(/pnpm install\b[^&|;"'\n]*/g)].map((m) => m[0].trim())
}

describe.each(BLUEPRINTS)('$file', ({ file, installs }) => {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  const commands = installCommands(text)

  it('still has the installs this test guards (so it cannot pass vacuously)', () => {
    expect(commands).toHaveLength(installs)
  })

  it('freezes the lockfile on every pnpm install', () => {
    for (const cmd of commands) {
      expect(cmd, cmd).toMatch(/(^|\s)--frozen-lockfile(\s|$)/)
    }
  })

  it('never opts out with --no-frozen-lockfile', () => {
    expect(text).not.toContain('--no-frozen-lockfile')
  })
})

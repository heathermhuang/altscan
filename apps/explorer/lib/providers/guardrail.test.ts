import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// apps/explorer root, from lib/providers/
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const SCAN_DIRS = ['app', 'components', 'lib']
const PROVIDERS_PREFIX = join('lib', 'providers') + sep

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '.next') continue
      walk(p, out)
    } else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

describe('provider guardrail — the vendor API stays behind the adapter', () => {
  const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)))

  it('scans a sane number of source files (walker is not silently broken)', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('no source outside lib/providers/ touches the Moralis API or the old module', () => {
    const offenders: string[] = []
    for (const f of files) {
      const rel = relative(ROOT, f)
      if (rel.startsWith(PROVIDERS_PREFIX)) continue
      const src = readFileSync(f, 'utf8')
      if (src.includes('deep-index.moralis.io')) offenders.push(`${rel} (vendor URL)`)
      if (/from ['"](@\/lib\/moralis|\.\.?\/moralis)['"]/.test(src)) offenders.push(`${rel} (old lib/moralis import)`)
    }
    expect(offenders).toEqual([])
  })
})

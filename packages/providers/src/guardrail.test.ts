import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// repo root, from packages/providers/src/
const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
// A4b-0 widened the scan from apps/explorer to BOTH consumers: the indexer now
// imports the adapter too, so the vendor must stay behind it there as well.
const SCAN = [join(REPO, 'apps', 'explorer'), join(REPO, 'apps', 'indexer')].filter(existsSync)
const VENDOR = 'deep-index.moralis.io'

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

describe('provider guardrail — the vendor API stays behind @altscan/providers', () => {
  const files = SCAN.flatMap((d) => walk(d))

  it('scans a sane number of source files (walker is not silently broken)', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('no app source touches the vendor API or the old provider modules', () => {
    const offenders: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      if (src.includes(VENDOR)) offenders.push(`${relative(REPO, f)} (vendor URL)`)
      if (/from ['"](@\/lib\/moralis|\.\.?\/moralis|@\/lib\/providers\/moralis|@\/lib\/providers\/types)['"]/.test(src)) {
        offenders.push(`${relative(REPO, f)} (old provider module import)`)
      }
    }
    expect(offenders).toEqual([])
  })
})

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The approved dependency graph between workspaces, and the check that the code obeys it.
 *
 * Arrows point from a workspace to the workspaces it may import. Packages are layered: a
 * package never imports an app, and apps never import each other. A new edge is an
 * architecture decision, so it is made here, in review, not by an import that happens to
 * resolve. See docs/architecture/README.md for what each workspace owns.
 *
 * Checked from three sides, because each one alone has passed while the graph drifted:
 *  - every `@altscan/*` import is declared in that workspace's package.json (an undeclared
 *    one resolves through the hoisted node_modules locally and breaks a filtered deploy);
 *  - every declared `@altscan/*` dependency is imported (@altscan/types sat declared by two
 *    apps, imported by nothing, for months);
 *  - every declared edge is approved below.
 */
const APPROVED: Record<string, string[]> = {
  // Leaf packages: no workspace dependencies.
  '@altscan/chain-config': [],
  '@altscan/db': [],
  '@altscan/explorer-core': [],
  '@altscan/oauth': [],
  '@altscan/settings-schema': [],
  // Moralis client: reads chain config, caches through explorer-core's Redis/kv layer.
  '@altscan/providers': ['@altscan/chain-config', '@altscan/explorer-core'],
  // Apps.
  '@altscan/explorer': ['@altscan/chain-config', '@altscan/db', '@altscan/explorer-core', '@altscan/oauth', '@altscan/providers', '@altscan/settings-schema'],
  '@altscan/indexer': ['@altscan/chain-config', '@altscan/db', '@altscan/providers'],
  '@altscan/admin': ['@altscan/chain-config', '@altscan/settings-schema'],
  '@altscan/site': ['@altscan/oauth'],
  '@altscan/status': [],
}

/**
 * Relative imports from production source that reach into another workspace. Each needs a
 * reason a package import cannot serve. Test files are exempt: a contract test reads both
 * sides of a boundary on purpose (the webhook docs sample against the indexer's payload,
 * altscan.io's agent policy against the explorer's). So are raw text assets (`?raw`).
 */
const APPROVED_RELATIVE: Record<string, string> = {
  // Tailwind loads its config before Next transpiles workspace packages, and
  // @altscan/chain-config's entry is its compiled dist, which a clean clone has not built.
  'apps/explorer/tailwind.config.ts': 'packages/chain-config/src/index',
}

const ROOT = join(__dirname, '..')
const tracked = (glob: string) =>
  execFileSync('git', ['ls-files', glob], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)

const workspaces = tracked('*/*/package.json')
  .filter((p) => /^(apps|packages)\/[^/]+\/package\.json$/.test(p))
  .map((p) => {
    const pkg = JSON.parse(readFileSync(join(ROOT, p), 'utf8'))
    const dir = dirname(p)
    const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => d.startsWith('@altscan/')).sort()
    return { name: pkg.name as string, dir, declared }
  })

const SOURCE = /\.(ts|tsx|mts|mjs|js|astro)$/
const IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm

function importsOf(dir: string): { file: string; spec: string }[] {
  return tracked(`${dir}/*`)
    .filter((f) => SOURCE.test(f) && !f.includes('/node_modules/'))
    .flatMap((file) => [...readFileSync(join(ROOT, file), 'utf8').matchAll(IMPORT)].map((m) => ({ file, spec: m[1] })))
}

describe('workspace dependency graph', () => {
  it('knows every workspace, and every workspace is in the approved graph', () => {
    expect(workspaces.map((w) => w.name).sort()).toEqual(Object.keys(APPROVED).sort())
  })

  describe.each(workspaces)('$name', ({ name, dir, declared }) => {
    const imports = importsOf(dir)
    const used = [...new Set(imports.map((i) => i.spec.match(/^@altscan\/[^/]+/)?.[0]).filter((s): s is string => !!s && s !== name))].sort()

    it('declares exactly the workspaces it imports', () => {
      expect({ used, declared }).toEqual({ used: declared, declared })
    })

    it('depends only on approved workspaces', () => {
      expect(declared.filter((d) => !APPROVED[name].includes(d))).toEqual([])
    })

    it('reaches into no other workspace by relative path, except where approved', () => {
      const crossings = imports
        .filter((i) => i.spec.startsWith('.') && !i.spec.endsWith('?raw') && !/\.test\.[a-z]+$/.test(i.file))
        .map((i) => ({ file: i.file, target: normalize(join(dirname(i.file), i.spec)) }))
        .filter(({ target }) => relative(dir, target).startsWith('..'))
        .filter(({ file, target }) => APPROVED_RELATIVE[file] !== target)
        .map(({ file, target }) => `${file} -> ${target}`)
      expect(crossings).toEqual([])
    })
  })

  it('the import scan sees the edges it guards (cannot pass vacuously)', () => {
    const explorer = importsOf('apps/explorer').map((i) => i.spec)
    expect(explorer).toContain('@altscan/db')
    expect(explorer.some((s) => s.startsWith('@altscan/explorer-core/'))).toBe(true)
    const tailwind = importsOf('apps/explorer').find((i) => i.file === 'apps/explorer/tailwind.config.ts' && i.spec.includes('chain-config'))
    expect(tailwind).toBeDefined()
  })
})

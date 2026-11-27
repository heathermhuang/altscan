import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The machine-checked half of "one implementation per concept": within a workspace, no two
 * modules export a function or value under the same name. Two exports with one name are
 * either a parallel implementation of one concept (consolidate it) or two concepts that
 * deserve two names. A real exception is listed below with its reason, so it gets a review.
 *
 * Framework-convention exports (Next.js route handlers and segment config) are skipped, as
 * are tests and test support.
 */
const ALLOWED: Record<string, { files: string[]; reason: string }> = {
  'apps/explorer:chainConfig': {
    files: ['apps/explorer/lib/chain-client.ts', 'apps/explorer/lib/chain.ts'],
    reason: 'server (CHAIN) and client (NEXT_PUBLIC_CHAIN, inlined at build) views of chain-config',
  },
  'apps/explorer:encodeCursor': {
    files: ['apps/explorer/lib/backfill-serve.ts', 'apps/explorer/lib/watch-cursor.ts'],
    reason: 'two cursor formats: backfill-serve falls back to "head" on junk, the wallet-watch feed rejects it',
  },
  'apps/explorer:decodeCursor': {
    files: ['apps/explorer/lib/backfill-serve.ts', 'apps/explorer/lib/watch-cursor.ts'],
    reason: 'see encodeCursor',
  },
}

const CONVENTION = new Set([
  'default', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'revalidate', 'dynamic',
  'metadata', 'generateMetadata', 'generateStaticParams', 'runtime', 'config', 'viewport',
  'prerender', 'dynamicParams', 'alt', 'size', 'contentType', 'onRequest', 'maxDuration',
])
const EXPORT = /^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm

const ROOT = join(__dirname, '..')
const files = execFileSync('git', ['ls-files', 'apps/*', 'packages/*'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(ts|tsx|mjs)$/.test(f) && !/\.test\.tsx?$/.test(f) && !/\/(test|test-support)\//.test(f))

function exportsByWorkspace(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const f of files) {
    const ws = f.split('/').slice(0, 2).join('/')
    for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(EXPORT)) {
      if (CONVENTION.has(m[1])) continue
      const key = `${ws}:${m[1]}`
      out.set(key, [...(out.get(key) ?? []), f])
    }
  }
  return out
}

describe('one module per exported name, per workspace', () => {
  const all = exportsByWorkspace()

  it('no name is exported by two modules, except the listed ones', () => {
    const repeated = [...all].filter(([, fs]) => fs.length > 1)
    const unexplained = repeated
      .filter(([key, fs]) => JSON.stringify([...fs].sort()) !== JSON.stringify([...(ALLOWED[key]?.files ?? [])].sort()))
      .map(([key, fs]) => `${key}: ${fs.join(', ')}`)
    expect(unexplained).toEqual([])
  })

  it('every listed exception still exists (so the list cannot rot)', () => {
    for (const key of Object.keys(ALLOWED)) expect(all.get(key)?.length ?? 0, key).toBeGreaterThan(1)
  })

  it('the scan sees the repo (cannot pass vacuously)', () => {
    expect(all.get('apps/explorer:isHexAddress')).toEqual(['apps/explorer/lib/hex.ts'])
    expect(all.get('apps/indexer:processBlock')).toEqual(['apps/indexer/src/block-processor.ts'])
  })
})

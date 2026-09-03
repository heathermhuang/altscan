/**
 * Regression guard: 'use client' components must NOT import the server-only
 * '@/lib/chain' module.
 *
 * Why: getChainConfig() in '@/lib/chain' reads process.env.CHAIN. Next.js only
 * inlines NEXT_PUBLIC_* env vars into the client bundle at build time, so in a
 * client component process.env.CHAIN is undefined and getChainConfig() silently
 * falls back to the default chain ('bnb'). On the ETH build (ethscan.io) that
 * renders BNB currency / theme / brand inside client components.
 *
 * Client components must import from '@/lib/chain-client', which resolves via
 * NEXT_PUBLIC_CHAIN (inlined per-deployment at build time).
 *
 * This guard catches the class of bug that hit TxnsLazy/TransfersLazy/
 * HoldingsLazy ("Value (BNB)" + yellow theme on ethscan.io) and WebMcpProvider
 * (advertising "BNBScan.com" / "BNB Chain" to AI agents on the ETH site).
 *
 * The check is TRANSITIVE. A module with no "use client" directive of its own
 * still ends up in the client bundle if a client component imports it, so
 * checking only files that declare the directive left a blind spot: a shared
 * presentational component (AddressLink) imported by three client components
 * pulled '@/lib/chain' into the browser, where it resolved to 'bnb' and made
 * ethscan.io label addresses off the BSC table again.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'

const EXPLORER_ROOT = join(__dirname, '..')
const SCAN_DIRS = ['app', 'components'].map((d) => join(EXPLORER_ROOT, d))

function walk(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) files.push(full)
  }
  return files
}

/** True if the module's first real statement is the "use client" directive. */
function isClientComponent(src: string): boolean {
  for (const raw of src.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue
    return /^['"]use client['"];?$/.test(line)
  }
  return false
}

/** The one module that must never reach the browser. */
const SERVER_CHAIN = join(EXPLORER_ROOT, 'lib', 'chain.ts')

const EXTS = ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts']

/**
 * Resolve an import specifier to a real file. Handles BOTH the '@/' alias and
 * relative specifiers — matching only the alias missed lib/known-addresses.ts,
 * which reached the server config as './chain'.
 */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = join(EXPLORER_ROOT, spec.slice(2))
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec)
  else return null
  for (const ext of EXTS) {
    const candidate = base + ext
    if (existsSync(candidate) && !candidate.endsWith('/')) {
      try { if (readFileSync(candidate)) return candidate } catch { /* dir */ }
    }
  }
  return null
}

/**
 * Value-import specifiers only. `import type { X } from '...'` is erased by the
 * compiler and never reaches the bundle, so counting it produced false
 * positives (lib/db, lib/providers) that would have trained everyone to ignore
 * this guard.
 */
function importSpecifiers(src: string): string[] {
  const withoutTypeImports = src.replace(/import\s+type\s+[^;\n]*?from\s+['"][^'"]+['"];?/g, '')
  return [...withoutTypeImports.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
}

/** True if this module imports the server-only chain config, by any specifier form. */
function importsServerChain(file: string, src: string): boolean {
  return importSpecifiers(src).some((spec) => resolveSpecifier(file, spec) === SERVER_CHAIN)
}

/** Local modules this file imports, resolved to real paths. */
function localImports(file: string, src: string): string[] {
  return importSpecifiers(src)
    .map((spec) => resolveSpecifier(file, spec))
    .filter((f): f is string => f !== null)
}

/**
 * Every module reachable from a "use client" entry point — i.e. everything that
 * actually ships in the client bundle, not just the files carrying the directive.
 */
function clientReachable(all: string[]): Set<string> {
  const seen = new Set<string>()
  const queue = all.filter((f) => isClientComponent(readFileSync(f, 'utf8')))
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const dep of localImports(file, readFileSync(file, 'utf8'))) {
      if (!seen.has(dep)) queue.push(dep)
    }
  }
  return seen
}

describe('client components use the build-safe chain config', () => {
  const all = SCAN_DIRS.flatMap(walk)

  const directOffenders = all
    .filter((f) => {
      const src = readFileSync(f, 'utf8')
      return isClientComponent(src) && importsServerChain(f, src)
    })
    .map((f) => relative(EXPLORER_ROOT, f))
    .sort()

  const bundleOffenders = [...clientReachable(all)]
    .filter((f) => importsServerChain(f, readFileSync(f, 'utf8')))
    .map((f) => relative(EXPLORER_ROOT, f))
    .sort()

  it("no 'use client' component imports the server-only @/lib/chain", () => {
    expect(directOffenders).toEqual([])
  })

  it('no module reachable from a client component imports the server-only @/lib/chain', () => {
    expect(bundleOffenders).toEqual([])
  })
})

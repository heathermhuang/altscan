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
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

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

/** Matches an import from '@/lib/chain' exactly — NOT '@/lib/chain-client'. */
function importsServerChain(src: string): boolean {
  return /from\s+['"]@\/lib\/chain['"]/.test(src)
}

describe('client components use the build-safe chain config', () => {
  const offenders = SCAN_DIRS.flatMap(walk)
    .filter((f) => {
      const src = readFileSync(f, 'utf8')
      return isClientComponent(src) && importsServerChain(src)
    })
    .map((f) => relative(EXPLORER_ROOT, f))
    .sort()

  it("no 'use client' component imports the server-only @/lib/chain", () => {
    expect(offenders).toEqual([])
  })
})

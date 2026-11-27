import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * config.ts is where the indexer reads its environment: typed, validated, and printed at
 * boot, so the log says what the process is running with. A `process.env` read anywhere
 * else is invisible to that log, which is how a metered feature once ran live for nine
 * days while the code and the docs both said it was off.
 *
 * The files below may still read `process.env`, each for a stated reason. Adding one is a
 * review decision; prefer a new field in config.ts.
 */
const ALLOWED: Record<string, string> = {
  'config-instance.ts': 'hands process.env to the pure parser',
  'provider.ts': 'the canonical RPC endpoint lists; the env var name is per chain, and boot logs them redacted',
  'migrate-partition-tt.ts': 'one-off CLI: its own connection string for a maintenance connection',
}

const SRC = __dirname
const sources = readdirSync(SRC).filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f) && f !== 'config.ts')
const READ = /\bprocess\.env\b/

describe('the indexer reads its environment in config.ts', () => {
  it('no other module reads process.env, except the listed ones', () => {
    const readers = sources.filter((f) => {
      // Comments that mention process.env are not reads.
      const code = readFileSync(join(SRC, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      return READ.test(code)
    })
    expect(readers.filter((f) => !(f in ALLOWED))).toEqual([])
  })

  it('every listed exception still needs its exemption (so the list cannot rot)', () => {
    for (const f of Object.keys(ALLOWED)) {
      const code = readFileSync(join(SRC, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      expect(READ.test(code), f).toBe(true)
    }
  })
})

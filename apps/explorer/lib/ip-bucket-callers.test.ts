import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Every per-IP rate limit keys on clientIpBucket (an IPv6 client's whole /64), never on the raw address, which a
// client rotates through for free. clientIpFromHeaders stays for logging and the denylist, not for a bucket.
const ROOT = join(__dirname, '..')
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) return []
    if (statSync(p).isDirectory()) return sources(p)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}

describe('per-IP rate-limit keys', () => {
  it('no checkRateLimit key is built from the raw client address', () => {
    const offenders = sources(ROOT).flatMap((file) =>
      readFileSync(file, 'utf8').split('\n')
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => line.includes('checkRateLimit(') && line.includes('clientIpFromHeaders('))
        .map(({ i }) => `${file.slice(ROOT.length + 1)}:${i + 1}`))
    expect(offenders).toEqual([])
  })

  it('the scan sees the callers it guards', () => {
    const all = sources(ROOT).map((f) => readFileSync(f, 'utf8')).join('\n')
    expect(all.match(/checkRateLimit\(`(verify|suggest|oauth|internal):\$\{clientIpBucket\(/g)).toHaveLength(4)
  })
})

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ADDRESS_PATTERN, HASH_PATTERN, isHexAddress, isHexHash, isLowerHexAddress, isLowerHexHash } from './hex'

const LOWER = '0x' + 'ab'.repeat(20)
const MIXED = '0x' + 'aB'.repeat(20)
const HASH = '0x' + 'cd'.repeat(32)

describe('hex shapes', () => {
  it('any-case address', () => {
    expect(isHexAddress(LOWER)).toBe(true)
    expect(isHexAddress(MIXED)).toBe(true)
    expect(isHexAddress(LOWER.slice(0, -1))).toBe(false)
    expect(isHexAddress(LOWER + 'a')).toBe(false)
    expect(isHexAddress(LOWER.slice(2))).toBe(false)
    expect(isHexAddress(`${LOWER}\n`)).toBe(false)
    expect(isHexAddress('0x' + 'g'.repeat(40))).toBe(false)
  })

  it('lowercase address rejects any uppercase letter', () => {
    expect(isLowerHexAddress(LOWER)).toBe(true)
    expect(isLowerHexAddress(MIXED)).toBe(false)
    expect(isLowerHexAddress('0X' + 'ab'.repeat(20))).toBe(false)
  })

  it('32-byte hash, any case and lowercase', () => {
    expect(isHexHash(HASH)).toBe(true)
    expect(isHexHash(HASH.toUpperCase().replace('0X', '0x'))).toBe(true)
    expect(isHexHash(LOWER)).toBe(false)
    expect(isLowerHexHash(HASH)).toBe(true)
    expect(isLowerHexHash('0x' + 'CD'.repeat(32))).toBe(false)
  })

  it('the JSON-Schema patterns agree with the predicates', () => {
    expect(new RegExp(ADDRESS_PATTERN).test(MIXED)).toBe(true)
    expect(new RegExp(HASH_PATTERN).test(HASH)).toBe(true)
  })
})

// The guard: these shapes are defined once. A new inline regex for an address or a 32-byte
// hash drifts on case (some sites accepted only lowercase, some any case, and nothing said
// which was meant), so every other copy in apps/explorer fails here. Route-path patterns
// (middleware's `/^\/tx\/0x…$/`) and the un-prefixed search shorthand are not this shape.
const ROOT = join(__dirname, '..')
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) return []
    if (statSync(p).isDirectory()) return sources(p)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}
const SHAPE = /\^0x\[(?:0-9a-fA-F|a-fA-F0-9|0-9a-f)\]\{(?:40|64)\}\$/

describe('one definition of the address and hash shapes', () => {
  it('no other explorer source spells them out', () => {
    const offenders = sources(ROOT)
      .filter((f) => !f.endsWith(join('lib', 'hex.ts')))
      .flatMap((file) => readFileSync(file, 'utf8').split('\n')
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => SHAPE.test(line))
        .map(({ i }) => `${file.slice(ROOT.length + 1)}:${i + 1}`))
    expect(offenders).toEqual([])
  })

  it('the scan recognises every spelling it bans', () => {
    for (const s of ['/^0x[0-9a-fA-F]{40}$/', '/^0x[a-fA-F0-9]{40}$/', '/^0x[0-9a-f]{40}$/i', "'^0x[0-9a-fA-F]{64}$'", '/^0x[0-9a-f]{64}$/']) {
      expect(SHAPE.test(s)).toBe(true)
    }
    expect(readFileSync(join(__dirname, 'hex.ts'), 'utf8')).toMatch(SHAPE)
  })
})

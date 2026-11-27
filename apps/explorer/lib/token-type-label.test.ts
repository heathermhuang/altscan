import { describe, it, expect } from 'vitest'
import { tokenTypeLabel } from './token-type-label'
import { getChainConfig } from '@altscan/chain-config'

// tokens.type is the DB enum 'BEP20' | 'BEP721' | 'BEP1155' on BOTH chains (packages/db/schema.ts);
// only the label a visitor sees is chain-specific.
describe('tokenTypeLabel', () => {
  it('labels the three enum values with the chain standard prefix', () => {
    expect(tokenTypeLabel('BEP20', 'ERC-20')).toBe('ERC-20')
    expect(tokenTypeLabel('BEP721', 'ERC-20')).toBe('ERC-721')
    expect(tokenTypeLabel('BEP1155', 'ERC-20')).toBe('ERC-1155')
    expect(tokenTypeLabel('BEP20', 'BEP-20')).toBe('BEP-20')
    expect(tokenTypeLabel('BEP721', 'BEP-20')).toBe('BEP-721')
    expect(tokenTypeLabel('BEP1155', 'BEP-20')).toBe('BEP-1155')
  })

  it('reads the prefix from the real chain configs, never a hardcoded BEP', () => {
    expect(tokenTypeLabel('BEP20', getChainConfig('eth').tokenStandard)).toBe('ERC-20')
    expect(tokenTypeLabel('BEP20', getChainConfig('bnb').tokenStandard)).toBe('BEP-20')
  })

  it('passes through a type that is not one of the enum values', () => {
    expect(tokenTypeLabel('ERC20', 'ERC-20')).toBe('ERC20')
    expect(tokenTypeLabel('', 'ERC-20')).toBe('')
  })
})

// The standards are the DB enum (packages/db/schema.ts tokenTypeEnum), read through TOKEN_TYPES.
// The tokens API, the token list page and the OpenAPI spec each re-typed the three values.
describe('the token standards are listed once', () => {
  it('TOKEN_TYPES is the schema enum', async () => {
    const { TOKEN_TYPES, parseTokenType } = await import('./token-type-label')
    expect([...TOKEN_TYPES]).toEqual(['BEP20', 'BEP721', 'BEP1155'])
    expect(parseTokenType('BEP721')).toBe('BEP721')
    expect(parseTokenType('ERC20')).toBeNull()
    expect(parseTokenType(null)).toBeNull()
  })

  it('no explorer source re-lists them', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const root = join(__dirname, '..')
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n)
      if (n === 'node_modules' || n.startsWith('.')) return []
      if (statSync(p).isDirectory()) return walk(p)
      return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : []
    })
    const relist = /['"]BEP20['"],\s*['"]BEP721['"]/
    expect(walk(root).filter((f) => relist.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1))).toEqual([])
    expect(relist.test("['BEP20', 'BEP721', 'BEP1155']")).toBe(true)
  })
})

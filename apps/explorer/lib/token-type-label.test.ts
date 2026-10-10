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

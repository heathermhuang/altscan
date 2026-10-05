import { describe, expect, it } from 'vitest'
import { blocksIn24h, blocksProduced, minerCounts } from '@/lib/validator-blocks'

describe('blocksIn24h', () => {
  it('is 24h of blocks at the chain block time', () => {
    expect(blocksIn24h(0.45)).toBe(192_000) // BNB
    expect(blocksIn24h(12)).toBe(7_200)     // ETH
  })

  it('rounds to a whole number of blocks', () => {
    expect(Number.isInteger(blocksIn24h(3))).toBe(true)
    expect(blocksIn24h(3)).toBe(28_800)
    expect(Number.isInteger(blocksIn24h(0.7))).toBe(true)
  })
})

describe('minerCounts / blocksProduced', () => {
  it('joins by lowercase address, so a checksummed miner still matches', () => {
    const counts = minerCounts([{ miner: '0xABCdef', n: 12 }, { miner: '0x123', n: '7' }])
    expect(blocksProduced(counts, '0xabcdef')).toBe(12)
    expect(blocksProduced(counts, '0xABCDEF')).toBe(12)
    expect(blocksProduced(counts, '0x123')).toBe(7) // count(*) can arrive as a string
  })

  it('merges rows whose miners differ only by case', () => {
    expect(blocksProduced(minerCounts([{ miner: '0xAA', n: 2 }, { miner: '0xaa', n: 3 }]), '0xaa')).toBe(5)
  })

  it('is 0 for a validator that produced nothing, and null when the query failed', () => {
    expect(blocksProduced(minerCounts([{ miner: '0xaa', n: 4 }]), '0xbb')).toBe(0)
    expect(blocksProduced(null, '0xaa')).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { blocksProduced, minerCounts, validatorBlocksQuery } from '@/lib/validator-blocks'

describe('validatorBlocksQuery', () => {
  const { sql: text, params } = new PgDialect().sqlToQuery(validatorBlocksQuery())
  const flat = text.replace(/\s+/g, ' ')

  it('windows by timestamp: 24 hours before the NEWEST block, not before now() and not a block count', () => {
    expect(flat).toContain("(SELECT timestamp FROM blocks ORDER BY number DESC LIMIT 1) - INTERVAL '24 hours'")
    expect(flat).not.toMatch(/now\(\)/i)
    expect(flat).not.toMatch(/max\(number\)/i)
    expect(params).toEqual([])   // no block-time constant reaches the statement
  })

  it('resolves the lower bound with one probe of the timestamp index, ties broken by block number', () => {
    expect(flat).toContain('WHERE timestamp >= ')
    expect(flat).toContain('ORDER BY timestamp ASC, number ASC LIMIT 1')
  })

  it('counts over the primary-key range from that block up, grouped by miner', () => {
    expect(flat).toContain('WHERE number >= (SELECT number FROM first_block) GROUP BY miner')
    expect(flat).toContain('count(*)::int AS n')
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

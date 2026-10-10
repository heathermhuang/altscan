import { beforeEach, describe, expect, it, vi } from 'vitest'

const { limit } = vi.hoisted(() => ({ limit: vi.fn() }))
vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  return { schema, db: { select: () => ({ from: () => ({ orderBy: () => ({ limit }) }) }) } }
})

import { queryGasTape } from './gas-tape-query'
import { TAPE_LATEST } from '@/lib/tape'

const block = (number: number, baseFeePerGas: string | null) => ({
  number, txCount: 5, gasUsed: 10n, gasLimit: 100n, baseFeePerGas,
})

// Braces: an arrow that RETURNS the mock would be run by vitest as the test's teardown.
beforeEach(() => { limit.mockReset() })

describe('queryGasTape (what the page cache wraps)', () => {
  it('asks for the same fixed count of newest blocks as every other tape, on both chains', async () => {
    limit.mockResolvedValue([block(2, '7')])
    await queryGasTape()
    expect(limit).toHaveBeenCalledWith(TAPE_LATEST)
  })

  it('returns plain numbers: no BigInt, so the page cache can store it', async () => {
    limit.mockResolvedValue([block(2, '1000000000'), block(1, null)])
    const rows = await queryGasTape()
    expect(rows).toEqual([{ n: 2, txs: 5, used: 10, fee: 1_000_000_000 }, { n: 1, txs: 5, used: 10, fee: null }])
    expect(() => JSON.stringify(rows)).not.toThrow()
  })

  it('THROWS on a failed query, so a cache around it never stores an empty tape', async () => {
    limit.mockRejectedValue(new Error('connection closed'))
    await expect(queryGasTape()).rejects.toThrow('connection closed')
  })

  it('gives an empty list for no blocks (the page draws no strip)', async () => {
    limit.mockResolvedValue([])
    expect(await queryGasTape()).toEqual([])
  })
})

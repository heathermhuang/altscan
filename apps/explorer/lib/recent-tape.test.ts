import { beforeEach, describe, expect, it, vi } from 'vitest'

const { limit, swallow } = vi.hoisted(() => ({ limit: vi.fn(), swallow: vi.fn() }))
vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  return { schema, db: { select: () => ({ from: () => ({ orderBy: () => ({ limit }) }) }) } }
})
vi.mock('@/lib/observability', () => ({ swallow }))

import { fetchRecentTape, queryRecentTape } from './recent-tape'
import { TAPE_LATEST } from '@/lib/tape'

const row = (number: number, secs: number) => ({
  number, timestamp: new Date(secs * 1000), gasUsed: 10n, gasLimit: 100n, txCount: 3,
})

beforeEach(() => { limit.mockReset(); swallow.mockReset() })

describe('queryRecentTape (what a cache wraps)', () => {
  it('encodes the newest blocks', async () => {
    limit.mockResolvedValue([row(12, 1_000_002), row(11, 1_000_001), row(10, 1_000_000)])
    const tape = await queryRecentTape()
    expect(tape).toMatch(/^12,1000002\|/)
  })

  it('asks for the fixed latest-blocks count, the same on both chains (not a window of chain time)', async () => {
    limit.mockResolvedValue([row(10, 1_000_000)])
    await queryRecentTape()
    expect(limit).toHaveBeenCalledWith(TAPE_LATEST)
  })

  it('draws a lone block (nothing is spent anchoring a timeline)', async () => {
    limit.mockResolvedValue([row(10, 1_000_000)])
    expect(await queryRecentTape()).toBe('10,1000000|0,0,3,10')
  })

  it('is null when there are no blocks to draw', async () => {
    limit.mockResolvedValue([])
    await expect(queryRecentTape()).resolves.toBeNull()
  })

  it('THROWS on a failed query, so a cache around it never stores the failure', async () => {
    limit.mockRejectedValue(new Error('db down'))
    await expect(queryRecentTape()).rejects.toThrow('db down')
    expect(swallow).not.toHaveBeenCalled()
  })
})

describe('fetchRecentTape (the charts fallback, no cache of its own)', () => {
  it('returns the same tape', async () => {
    limit.mockResolvedValue([row(12, 1_000_002), row(11, 1_000_001), row(10, 1_000_000)])
    await expect(fetchRecentTape()).resolves.toBe(await queryRecentTape())
  })

  it('logs a failure under its tag and reads as "no tape"', async () => {
    limit.mockRejectedValue(new Error('db down'))
    await expect(fetchRecentTape()).resolves.toBeNull()
    expect(swallow).toHaveBeenCalledWith('recent-tape', expect.any(Error))
  })
})

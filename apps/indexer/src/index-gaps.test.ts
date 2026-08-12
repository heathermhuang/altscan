import { describe, it, expect, vi } from 'vitest'
import { recordIndexGap } from './index-gaps'

/**
 * The MAX_LAG_BLOCKS skip has always existed and always recorded nothing, so
 * falling behind cost CORRECTNESS rather than freshness — and did so silently:
 * ~92,000 blocks abandoned between 2026-08-04 and 08-11 while /api/health
 * reported {"status":"ok"} throughout.
 */
describe('recordIndexGap', () => {
  const fakeDb = () => {
    const execute = vi.fn().mockResolvedValue(undefined)
    return { db: { execute }, execute }
  }

  it('records a valid abandoned range', async () => {
    const { db, execute } = fakeDb()
    await expect(recordIndexGap(db, 100, 5200, 'max_lag_skip(5000)')).resolves.toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('records a single-block range (from === to)', async () => {
    const { db, execute } = fakeDb()
    await expect(recordIndexGap(db, 100, 100, 'x')).resolves.toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  // The caller computes from/to arithmetically; an inverted range means the skip
  // did not actually abandon anything, and writing it would violate the table's
  // CHECK constraint and throw inside the poll loop.
  it('is a no-op for an inverted range rather than writing a bad row', async () => {
    const { db, execute } = fakeDb()
    await expect(recordIndexGap(db, 500, 499, 'x')).resolves.toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })

  it('is a no-op for non-finite inputs', async () => {
    const { db, execute } = fakeDb()
    await expect(recordIndexGap(db, NaN, 10, 'x')).resolves.toBe(false)
    await expect(recordIndexGap(db, 10, NaN, 'x')).resolves.toBe(false)
    await expect(recordIndexGap(db, Infinity, 10, 'x')).resolves.toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })

  // The caller swallows-and-logs so a bookkeeping failure can never stop the
  // skip itself — the skip is what breaks the fall-behind death spiral. That
  // only works if the error actually surfaces here.
  it('propagates a database error to the caller', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('relation "index_gaps" does not exist'))
    await expect(recordIndexGap({ execute }, 1, 2, 'x')).rejects.toThrow(/index_gaps/)
  })
})

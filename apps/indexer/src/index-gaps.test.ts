import { describe, it, expect, vi } from 'vitest'
import { recordIndexGap, isPoisonBlock, recordPoisonGapIfAbsent } from './index-gaps'

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

describe('driver result shapes are read strictly, never guessed', () => {
  // These helpers gate quarantine, and callers read `false` as the positive claim
  // "the block already exists". A shape we do not genuinely understand must not be
  // flattened into that answer — an earlier version accepted anything with a numeric
  // `length`, which quietly admitted '' and { length: 0 } as "zero rows". Throwing
  // instead lands in the caller's catch, which declines to skip and retries.
  const db = (result: unknown) => ({ execute: async () => result })

  it('reads a real row set', async () => {
    expect(await isPoisonBlock(db([{ '?column?': 1 }]) as never, 5)).toBe(true)
    expect(await isPoisonBlock(db([]) as never, 5)).toBe(false)
  })

  it('accepts an array-like AND iterable RowList (what postgres-js returns)', async () => {
    const rowList = Object.assign(Object.create(null), {
      length: 1, 0: { x: 1 }, [Symbol.iterator]: function* () { yield { x: 1 } },
    })
    expect(await isPoisonBlock(db(rowList) as never, 5)).toBe(true)
  })

  it('THROWS on shapes that merely look array-like', async () => {
    // '' is array-like and iterable, but iterating it yields characters, not rows.
    await expect(isPoisonBlock(db('') as never, 5)).rejects.toThrow(/unrecognised/)
    await expect(isPoisonBlock(db({ length: 0 }) as never, 5)).rejects.toThrow(/unrecognised/)
    await expect(isPoisonBlock(db(undefined) as never, 5)).rejects.toThrow(/unrecognised/)
    await expect(isPoisonBlock(db(null) as never, 5)).rejects.toThrow(/unrecognised/)
    await expect(isPoisonBlock(db(42) as never, 5)).rejects.toThrow(/unrecognised/)
  })

  it('a non-finite block number is rejected before any query runs', async () => {
    const execute = vi.fn()
    expect(await isPoisonBlock({ execute } as never, NaN)).toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('recordPoisonGapIfAbsent reads shapes as strictly as isPoisonBlock', () => {
  // Round 5 caught rowCount() being DEFINED but adopted at only one of its two call
  // sites — the classic "fix is not wired" miss. Both are covered now so the gap
  // cannot reopen silently.
  const db = (result: unknown) => ({ execute: async () => result })
  const REASON = 'poison_block(5 clean failovers)'

  it('a returned row means recorded', async () => {
    expect(await recordPoisonGapIfAbsent(db([{ block_number: 5 }]) as never, 5, REASON, 5)).toBe(true)
  })

  it('no rows means the block was present — the ONE meaning of false', async () => {
    expect(await recordPoisonGapIfAbsent(db([]) as never, 5, REASON, 5)).toBe(false)
  })

  it('THROWS rather than reporting a confident, wrong "block present"', async () => {
    await expect(recordPoisonGapIfAbsent(db('') as never, 5, REASON, 5)).rejects.toThrow(/unrecognised/)
    await expect(recordPoisonGapIfAbsent(db({ length: 0 }) as never, 5, REASON, 5)).rejects.toThrow(/unrecognised/)
    await expect(recordPoisonGapIfAbsent(db(undefined) as never, 5, REASON, 5)).rejects.toThrow(/unrecognised/)
  })

  it('rejects a non-finite failure count before querying', async () => {
    const execute = vi.fn()
    expect(await recordPoisonGapIfAbsent({ execute } as never, 5, REASON, NaN)).toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })
})

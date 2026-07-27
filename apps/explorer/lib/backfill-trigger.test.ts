import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock BEFORE importing the module under test. `./chain` stands in for an ETH
// deployment (dbEnvVar = ETH_DATABASE_URL) so the regression test below can prove
// the trigger asks for THAT pool, not the DATABASE_URL default.
vi.mock('./chain', () => ({ chainConfig: { dbEnvVar: 'ETH_DATABASE_URL' } }))

const onConflictDoNothing = vi.fn().mockResolvedValue(undefined)
const values = vi.fn(() => ({ onConflictDoNothing }))
const insert = vi.fn(() => ({ values }))
const getDb = vi.fn(() => ({ insert }))
vi.mock('@altscan/db', () => ({
  getDb: (...args: unknown[]) => getDb(...(args as [])),
  schema: { backfillWatermarks: 'backfill_watermarks_table' },
}))

import { enqueueBackfill, shouldEnqueueBackfill } from './backfill-trigger'

/**
 * The trigger's job under the R1 serve model is to WARM THE CACHE FOR
 * PAGINATION — enqueue on a first human view so that by the time the user pages
 * past the live head, the deep tail is already local. It is deliberately not
 * "enqueue when the view is unservable": under R1 page 1 always comes live from
 * the provider, so no view is ever unservable in that sense.
 */
describe('shouldEnqueueBackfill', () => {
  const base = { backfillEnabled: true, isBot: false, watermarkExists: false }

  it('enqueues when enabled, human, and not already queued', () => {
    expect(shouldEnqueueBackfill(base)).toBe(true)
  })

  it('never enqueues when the flag is off — this is what makes A4b-1 ship dark', () => {
    expect(shouldEnqueueBackfill({ ...base, backfillEnabled: false })).toBe(false)
  })

  it('never enqueues for bots — crawlers must not trigger provider spend', () => {
    expect(shouldEnqueueBackfill({ ...base, isBot: true })).toBe(false)
  })

  it('does not re-enqueue when a watermark already exists', () => {
    expect(shouldEnqueueBackfill({ ...base, watermarkExists: true })).toBe(false)
  })

  it('every negative condition independently vetoes', () => {
    // Guards against someone refactoring `&&` into `||`.
    const combos = [
      { backfillEnabled: false, isBot: false, watermarkExists: false },
      { backfillEnabled: true, isBot: true, watermarkExists: false },
      { backfillEnabled: true, isBot: false, watermarkExists: true },
      { backfillEnabled: false, isBot: true, watermarkExists: true },
    ]
    for (const c of combos) expect(shouldEnqueueBackfill(c)).toBe(false)
  })
})

/**
 * REGRESSION (prod P0, 2026-07-23): enqueueBackfill called bare `getDb()`, which
 * defaults to DATABASE_URL. That var is UNSET on eth-web (it uses
 * ETH_DATABASE_URL), so getDb THREW in production, the best-effort catch
 * swallowed it, and NO watermark was ever written on ETH — the backfill worker
 * booted "ON" and then sat idle forever with nothing to claim. Nothing failed
 * loudly; the only symptom was an empty backfill_watermarks table.
 *
 * These tests pin the two properties that make the write actually land.
 */
describe('enqueueBackfill — writes to the CHAIN-AWARE pool', () => {
  beforeEach(() => {
    getDb.mockClear(); insert.mockClear(); values.mockClear(); onConflictDoNothing.mockClear()
  })

  it("asks for the chain's dbEnvVar, never the bare DATABASE_URL default", async () => {
    await enqueueBackfill('address_txs', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
    expect(getDb).toHaveBeenCalledTimes(1)
    expect(getDb).toHaveBeenCalledWith('ETH_DATABASE_URL')
    // The bug was calling it with NO argument (→ DATABASE_URL default).
    expect(getDb).not.toHaveBeenCalledWith()
  })

  it('lowercases the entity id and inserts a pending watermark', async () => {
    await enqueueBackfill('token_transfers', '0xAbCdEfABCDEF0123456789abcdef0123456789AB')
    expect(values).toHaveBeenCalledWith({
      entityType: 'token_transfers',
      entityId: '0xabcdefabcdef0123456789abcdef0123456789ab',
      status: 'pending',
    })
    expect(onConflictDoNothing).toHaveBeenCalled()
  })

  it('still never throws into the request path when the insert fails', async () => {
    onConflictDoNothing.mockRejectedValueOnce(new Error('db down'))
    await expect(enqueueBackfill('address_txs', '0xabc')).resolves.toBeUndefined()
  })
})

import { describe, expect, it, vi } from 'vitest'

/**
 * REGRESSION (prod P0, 2026-07-23), serve-side half.
 *
 * `backfill-serve.ts` reached the database through a bare `getDb()`, which
 * defaults to DATABASE_URL — unset on eth-web, which uses ETH_DATABASE_URL. In
 * production that THREW, the route caught it, `wm` became null, and the cache
 * was permanently "unusable" on ETH. Combined with the trigger half (see
 * backfill-trigger.test.ts) the whole of A4b was inert on that chain, silently.
 *
 * All five serve-side DB calls now share the module's `chainDb()` helper, so
 * pinning one of them pins the routing for all five. This file is deliberately
 * separate from backfill-serve.test.ts: mocking @altscan/db is file-wide, and
 * the pure codec/carry tests there must keep running against the real module.
 */
vi.mock('./chain', () => ({ chainConfig: { dbEnvVar: 'ETH_DATABASE_URL' } }))

const execute = vi.fn().mockResolvedValue([])
const getDb = vi.fn(() => ({ execute }))
vi.mock('@altscan/db', () => ({
  getDb: (...args: unknown[]) => getDb(...(args as [])),
  schema: {},
}))

import { readWatermark } from './backfill-serve'

describe('backfill-serve — resolves the CHAIN-AWARE pool', () => {
  it("asks for the chain's dbEnvVar, never the bare DATABASE_URL default", async () => {
    getDb.mockClear()
    await readWatermark('address_txs', '0xd8da6bf26964af9d7eed9e03e53415d37aa96045')
    expect(getDb).toHaveBeenCalledWith('ETH_DATABASE_URL')
    // The bug was calling it with NO argument (→ DATABASE_URL default).
    expect(getDb).not.toHaveBeenCalledWith()
  })

  it('resolves LAZILY — importing the module creates no pool', async () => {
    // If chainDb were a module-level const (or an import of ./db's eager `db`),
    // the pool would bind at import time — which is exactly what would break
    // backfill-serve.pg.test.ts's ability to redirect it at a fixture, since ESM
    // hoists imports above the line that sets the env var.
    vi.resetModules()
    getDb.mockClear()
    await import('./backfill-serve')
    expect(getDb).not.toHaveBeenCalled()
  })
})

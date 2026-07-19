import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  buildClaimSql,
  mapHistoryRows,
  mapTransferRows,
  processOnePage,
  backfillPressure,
  sharedBucketOverHeadroom,
  type ClaimedEntity,
  type WorkerDb,
} from './backfill-worker'
import { cfg } from './backfill-budget'
import type { ProviderAdapter, ProviderTx, ProviderTokenTransfer } from '@altscan/providers'

/**
 * String-level pins for the claim statement (Task 2.2). These are the
 * CI-runnable half: they pin the exact predicates and ordering the design
 * requires (R2 lease, R6 fairness), byte-for-byte from the shipped builder —
 * not a reimplementation. The behavioral half (one winner under concurrency,
 * lease reclaim against a real clock) runs in backfill-worker.pg.test.ts,
 * gated on a local Postgres.
 */
describe('buildClaimSql — the shipped claim statement', () => {
  const text = buildClaimSql()

  it('is single-flight: FOR UPDATE SKIP LOCKED on a LIMIT 1 subquery', () => {
    expect(text).toContain('FOR UPDATE SKIP LOCKED')
    expect(text).toContain('LIMIT 1')
    expect(text).toContain('SELECT id FROM backfill_watermarks')
  })

  it('claims pending and partial work', () => {
    expect(text).toContain(`status IN ('pending','partial')`)
  })

  it('R2: reclaims a running row only after a full lease has elapsed', () => {
    expect(text).toContain(
      `(status = 'running' AND last_attempt_at < now() - (${cfg.leaseSec} * INTERVAL '1 second'))`,
    )
  })

  it('errored rows wait out an exponential cooldown capped at 1800s', () => {
    expect(text).toContain(
      `(status = 'error' AND (last_attempt_at IS NULL OR last_attempt_at < now() - (LEAST(pow(2, attempts), 1800) * INTERVAL '1 second')))`,
    )
  })

  it('R6: drains partial work before pending, whose NULL last_attempt_at would otherwise preempt', () => {
    expect(text).toContain(
      `ORDER BY (status = 'partial') DESC, last_attempt_at ASC NULLS FIRST, created_at ASC`,
    )
  })

  it('claiming renews the lease and returns the full row', () => {
    expect(text).toMatch(
      /UPDATE backfill_watermarks SET status = 'running', last_attempt_at = now\(\), updated_at = now\(\)/,
    )
    expect(text).toContain('RETURNING *')
  })
})

// ── Task 2.3: pure row mappers — where the O1 worker invariants live ──

const ADDR = '0x' + 'Aa'.repeat(20)
const HASH = '0x' + 'Bc'.repeat(32)

const tx = (over: Partial<ProviderTx> = {}): ProviderTx => ({
  hash: HASH,
  blockNumber: '123',
  blockTimestamp: '2026-07-01T00:00:00.000Z',
  fromAddress: '0xfrom',
  toAddress: '0xto',
  value: '1000',
  gasPrice: '0',
  gasUsed: '0',
  category: 'send',
  summary: 's',
  possibleSpam: false,
  erc20Transfers: [],
  ...over,
})

const transfer = (over: Partial<ProviderTokenTransfer> = {}): ProviderTokenTransfer => ({
  txHash: HASH,
  logIndex: '7',
  blockNumber: '123',
  blockTimestamp: '2026-07-01T00:00:00.000Z',
  fromAddress: '0xfrom',
  toAddress: '0xto',
  tokenAddress: '0xToken',
  tokenName: 'T',
  tokenSymbol: 'TKN',
  tokenDecimals: '18',
  value: '5',
  valueFormatted: '0.000005',
  ...over,
})

describe('mapHistoryRows — O1: identity fields are stored lowercase', () => {
  it('lowercases the scope address and tx hash, preserving payload fields', () => {
    const [row] = mapHistoryRows(ADDR, [tx()])
    expect(row.address).toBe(ADDR.toLowerCase())
    expect(row.txHash).toBe(HASH.toLowerCase())
    expect(row.fromAddress).toBe('0xfrom')
    expect(row.value).toBe('1000')
    expect(row.possibleSpam).toBe(false)
  })

  it('parses ISO and epoch-second timestamps and numeric block numbers', () => {
    const [iso] = mapHistoryRows(ADDR, [tx()])
    expect(iso.blockNumber).toBe(123)
    expect(iso.blockTimestamp.toISOString()).toBe('2026-07-01T00:00:00.000Z')
    const [epoch] = mapHistoryRows(ADDR, [tx({ blockTimestamp: '1782864000' })])
    expect(epoch.blockTimestamp.getTime()).toBe(1782864000_000)
  })
})

describe('mapTransferRows — O1: skip rows with no usable log_index, never invent one', () => {
  it('skips null, empty, and non-integer logIndex rows and counts them', () => {
    const { rows, skipped } = mapTransferRows(ADDR, [
      transfer({ logIndex: null }),
      transfer({ logIndex: '' }),
      transfer({ logIndex: 'abc' }),
      transfer({ logIndex: '-1' }),
      transfer({ logIndex: '1.5' }),
      transfer({ logIndex: '0' }),
      transfer({ logIndex: '292' }),
    ])
    expect(skipped).toBe(5)
    expect(rows.map((r) => r.logIndex)).toEqual([0, 292])
  })

  it('lowercases scope + tx hash and parses decimals, leaving payload untouched', () => {
    const { rows } = mapTransferRows(ADDR, [transfer()])
    expect(rows[0].scopeAddress).toBe(ADDR.toLowerCase())
    expect(rows[0].txHash).toBe(HASH.toLowerCase())
    expect(rows[0].tokenAddress).toBe('0xToken')
    expect(rows[0].tokenDecimals).toBe(18)
    const { rows: noDec } = mapTransferRows(ADDR, [transfer({ tokenDecimals: null as unknown as string })])
    expect(noDec[0].tokenDecimals).toBeNull()
  })
})

// ── Task 2.3: processOnePage status machine (fake db — effects proven in the PG suite) ──

function fakeDb() {
  const executed: unknown[] = []
  const db = {
    execute: vi.fn(async (q: unknown) => {
      executed.push(q)
      return []
    }),
    transaction: vi.fn(async (fn: (txx: { execute: (q: unknown) => Promise<unknown[]> }) => Promise<unknown>) =>
      fn({
        execute: async (q: unknown) => {
          executed.push(q)
          return []
        },
      }),
    ),
  }
  return { db: db as unknown as WorkerDb, executed, raw: db }
}

const entity = (over: Partial<ClaimedEntity> = {}): ClaimedEntity => ({
  id: 1,
  entity_type: 'address_txs',
  entity_id: ADDR.toLowerCase(),
  status: 'running',
  backfilled_through_block: null,
  oldest_cursor: null,
  rows_written: 0,
  attempts: 0,
  last_attempt_at: null,
  last_error: null,
  ...over,
})

const providerOf = (impl: Partial<ProviderAdapter>): ProviderAdapter =>
  ({ kind: 'fake', ...impl }) as ProviderAdapter

describe('processOnePage — status machine', () => {
  it('returns complete when the provider cursor is exhausted', async () => {
    const { db } = fakeDb()
    const provider = providerOf({
      getAddressHistory: async () => ({ ok: true, data: { txs: [tx()], cursor: null, totalTxs: 1 } }),
    })
    expect(await processOnePage(db, provider, entity())).toBe('complete')
  })

  it('returns partial while a cursor remains under the cap', async () => {
    const { db } = fakeDb()
    const provider = providerOf({
      getAddressHistory: async () => ({ ok: true, data: { txs: [tx()], cursor: 'next', totalTxs: 999 } }),
    })
    expect(await processOnePage(db, provider, entity())).toBe('partial')
  })

  it('returns capped once total rows reach the per-entity cap', async () => {
    const { db } = fakeDb()
    const provider = providerOf({
      getAddressHistory: async () => ({
        ok: true,
        data: { txs: Array.from({ length: 25 }, (_, i) => tx({ hash: `0xh${i}` })), cursor: 'next', totalTxs: 9999 },
      }),
    })
    expect(await processOnePage(db, provider, entity({ rows_written: cfg.maxRowsPerEntity - 10 }))).toBe('capped')
  })

  it('a rate-limited page releases the claim back to pending/partial without burning attempts', async () => {
    const provider = providerOf({
      getAddressHistory: async () => ({ ok: false, reason: 'rate_limited' }),
    })
    const a = fakeDb()
    expect(await processOnePage(a.db, provider, entity())).toBe('pending')
    const b = fakeDb()
    expect(await processOnePage(b.db, provider, entity({ rows_written: 50 }))).toBe('partial')
  })

  it('an upstream failure or thrown provider error marks the watermark error', async () => {
    const a = fakeDb()
    expect(
      await processOnePage(
        a.db,
        providerOf({ getAddressHistory: async () => ({ ok: false, reason: 'upstream_error' }) }),
        entity(),
      ),
    ).toBe('error')
    const b = fakeDb()
    expect(
      await processOnePage(
        b.db,
        providerOf({
          getAddressHistory: async () => {
            throw new Error('boom')
          },
        }),
        entity(),
      ),
    ).toBe('error')
    expect(b.raw.execute).toHaveBeenCalled()
  })

  it('routes token_transfers entities to getAddressTokenTransfers', async () => {
    const { db } = fakeDb()
    const getAddressTokenTransfers = vi.fn(async () => ({
      ok: true as const,
      data: { transfers: [transfer()], cursor: null },
    }))
    const provider = providerOf({ getAddressTokenTransfers })
    expect(await processOnePage(db, provider, entity({ entity_type: 'token_transfers' }))).toBe('complete')
    expect(getAddressTokenTransfers).toHaveBeenCalledWith(ADDR.toLowerCase(), undefined)
  })
})

// ── Task 2.3: R5 pressure + BNB headroom politeness ──

describe('backfillPressure (R5)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const dbReturning = (bfBytes: number, dbBytes: number) =>
    ({
      execute: async () => [{ bf_bytes: String(bfBytes), db_bytes: String(dbBytes) }],
      transaction: async () => null,
    }) as unknown as WorkerDb

  it('is quiet under both bounds', async () => {
    vi.stubEnv('DB_DISK_GB', '150')
    expect(await backfillPressure(dbReturning(1 * 1024 ** 3, 50 * 1024 ** 3))).toBeNull()
  })

  it('stops at the backfill byte ceiling', async () => {
    const msg = await backfillPressure(dbReturning(cfg.maxTotalGb * 1024 ** 3, 50 * 1024 ** 3))
    expect(msg).toMatch(/ceiling/)
  })

  it('stops at the disk percentage bound when DB_DISK_GB is known', async () => {
    vi.stubEnv('DB_DISK_GB', '100')
    expect(await backfillPressure(dbReturning(0, 71 * 1024 ** 3))).toMatch(/disk/)
    expect(await backfillPressure(dbReturning(0, 69 * 1024 ** 3))).toBeNull()
  })

  it('skips the disk bound when DB_DISK_GB is unset', async () => {
    expect(await backfillPressure(dbReturning(0, 900 * 1024 ** 3))).toBeNull()
  })
})

describe('sharedBucketOverHeadroom — BNB politeness, inert without a fleet signal', () => {
  const healthWith = (history: Record<string, unknown> | undefined) => async () =>
    ({ buckets: history ? { history } : {} }) as Record<string, unknown>

  it('yields once the shared history bucket crosses headroom × cap', async () => {
    expect(await sharedBucketOverHeadroom(healthWith({ hourly: 280, hourlyMax: 700 }))).toBe(true)
    expect(await sharedBucketOverHeadroom(healthWith({ hourly: 279, hourlyMax: 700 }))).toBe(false)
  })

  it('returns false when there is no counter (no Redis — ETH), no bucket, or a health error', async () => {
    expect(await sharedBucketOverHeadroom(healthWith({ hourly: null, hourlyMax: 700 }))).toBe(false)
    expect(await sharedBucketOverHeadroom(healthWith(undefined))).toBe(false)
    expect(
      await sharedBucketOverHeadroom(async () => {
        throw new Error('redis blip')
      }),
    ).toBe(false)
  })
})

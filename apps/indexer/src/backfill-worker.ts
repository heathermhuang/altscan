/**
 * Lazy provider-backfill worker (Track A4b, Phase A4b-2).
 *
 * A DB-polled loop that drains `backfill_watermarks` one provider page at a
 * time, writing immortal history rows the explorer's cached-tail serve path
 * (apps/explorer/lib/backfill-serve.ts) reads. Crash-safety model (R2): every
 * page commits its rows AND its watermark advance in ONE transaction, and a
 * claimed row's lease (`last_attempt_at`) makes crashed claims reclaimable.
 *
 * O1 worker invariants (plan §O1 — the serve-side seam exclusions depend on
 * both):
 *   1. provider rows without a usable `log_index` are SKIPPED, never invented —
 *      two synthesized indexes in one tx would collide on the PK, and a null
 *      can never duplicate a cached row because the column is NOT NULL;
 *   2. identity fields (scope address, tx hash) are written LOWERCASE — cursor
 *      seam-exclusion hashes are lowercase, and a mixed-case cached hash would
 *      break both the keyset ordering and the dedup compare.
 */
import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { Db } from '@altscan/db'
import { getChainConfig } from '@altscan/chain-config'
import { resolveDataProvider, getDataProviderHealth } from '@altscan/providers'
import type {
  AddressHistoryPage,
  ProviderAdapter,
  ProviderResult,
  ProviderTokenTransfer,
  ProviderTx,
  TokenTransfersPage,
} from '@altscan/providers'
import { cfg } from './backfill-budget'
import { getMaintenanceDb } from './db'

/** The two db shapes the worker needs — structurally satisfied by drizzle's
 *  Db and its transaction handle, and cheap to fake in unit tests. */
export type Executor = Pick<Db, 'execute'>
export type WorkerDb = Pick<Db, 'execute' | 'transaction'>

/** `lease_lost` is a return value only, never a stored watermark status: the
 *  fence refused a write because a newer claim owns the row. */
type PageStatus = 'partial' | 'pending' | 'complete' | 'capped' | 'error' | 'lease_lost'

/** A `backfill_watermarks` row as RETURNING * hands it back (snake_case; BIGINT
 *  columns arrive as strings from postgres-js). */
export type ClaimedEntity = {
  id: number
  entity_type: 'address_txs' | 'token_transfers'
  entity_id: string
  status: string
  backfilled_through_block: string | number | null
  oldest_cursor: string | null
  rows_written: number
  attempts: number
  last_attempt_at: Date | null
  last_error: string | null
}

/**
 * The single-flight claim (Task 2.2). Exported as a pure string builder so the
 * CI suite pins the exact predicates byte-for-byte (same pattern as
 * retention-cleanup's `sizeReportSql`). `cfg.leaseSec` is an env-parsed
 * positive integer, safe to inline.
 *
 * - R2: a 'running' row untouched for a full lease is a crashed worker —
 *   reclaimable. Claiming sets last_attempt_at = now(), which renews the lease.
 * - R6: drain in-flight 'partial' work before starting new 'pending' work,
 *   whose NULL last_attempt_at would otherwise sort first and preempt
 *   everything. A reclaimed 'running' row keeps its stale clock, so it sorts
 *   ahead of recently-touched rows but behind fresh 'pending' NULLs — R6
 *   deliberately lifts only 'partial'.
 * - Errored rows re-enter after an exponential cooldown capped at 1800s,
 *   mirroring backoffMs().
 */
export function buildClaimSql(): string {
  return `
    UPDATE backfill_watermarks SET status = 'running', last_attempt_at = date_trunc('milliseconds', now()), updated_at = now()
    WHERE id = (
      SELECT id FROM backfill_watermarks
      WHERE status IN ('pending','partial')
         OR (status = 'running' AND last_attempt_at < now() - (${cfg.leaseSec} * INTERVAL '1 second'))
         OR (status = 'error' AND (last_attempt_at IS NULL OR last_attempt_at < now() - (LEAST(pow(2, attempts), 1800) * INTERVAL '1 second')))
      ORDER BY (status = 'partial') DESC, last_attempt_at ASC NULLS FIRST, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *`
}

export async function claimNextEntity(db: WorkerDb): Promise<ClaimedEntity | null> {
  const res = await db.execute(sql.raw(buildClaimSql()))
  return (Array.from(res)[0] as ClaimedEntity | undefined) ?? null
}

// ── Pure row mappers (Task 2.3) — the O1 invariants live here ──

/** Moralis emits ISO-8601 block timestamps; accept epoch-seconds too so the
 *  mapper never mints `new Date(NaN)` from a merely-different valid format. */
function parseBlockTimestamp(ts: string): Date {
  return /^\d+$/.test(ts) ? new Date(Number(ts) * 1000) : new Date(ts)
}

export type HistoryInsertRow = {
  address: string
  txHash: string
  blockNumber: number
  blockTimestamp: Date
  fromAddress: string
  toAddress: string | null
  value: string
  category: string | null
  summary: string | null
  possibleSpam: boolean
}

export function mapHistoryRows(address: string, txs: ProviderTx[]): HistoryInsertRow[] {
  const scope = address.toLowerCase()
  return txs.map((t) => ({
    address: scope,
    txHash: t.hash.toLowerCase(), // O1 invariant 2
    blockNumber: Number(t.blockNumber),
    blockTimestamp: parseBlockTimestamp(t.blockTimestamp),
    fromAddress: t.fromAddress,
    toAddress: t.toAddress,
    value: t.value,
    category: t.category ?? null,
    summary: t.summary ?? null,
    possibleSpam: !!t.possibleSpam,
  }))
}

export type TransferInsertRow = {
  scopeAddress: string
  txHash: string
  logIndex: number
  tokenAddress: string
  fromAddress: string
  toAddress: string
  value: string
  valueFormatted: string | null
  tokenSymbol: string | null
  tokenDecimals: number | null
  blockNumber: number
  blockTimestamp: Date
}

/** R3 + O1 invariant 1: identity is the provider's own log_index; rows without
 *  a usable one are SKIPPED, never synthesized. Usable = a non-negative
 *  integer strictly below the int4-max serve sentinel (TOP_LOG_INDEX), which
 *  is reserved for cursor boundaries. Verified 2026-07-18: Moralis supplies it
 *  on 25/25 rows on both chains, so `skipped` should stay 0; the worker logs
 *  if it ever fires. */
export function mapTransferRows(
  scope: string,
  transfers: ProviderTokenTransfer[],
): { rows: TransferInsertRow[]; skipped: number } {
  const scopeLc = scope.toLowerCase()
  const rows: TransferInsertRow[] = []
  let skipped = 0
  for (const r of transfers) {
    const idx = String(r.logIndex ?? '')
    if (!/^\d+$/.test(idx) || Number(idx) >= 2147483647) {
      skipped++
      continue
    }
    const dec = String(r.tokenDecimals ?? '')
    rows.push({
      scopeAddress: scopeLc,
      txHash: r.txHash.toLowerCase(), // O1 invariant 2
      logIndex: Number(idx),
      tokenAddress: r.tokenAddress,
      fromAddress: r.fromAddress,
      toAddress: r.toAddress,
      value: r.value,
      valueFormatted: r.valueFormatted ?? null,
      tokenSymbol: r.tokenSymbol ?? null,
      tokenDecimals: /^\d+$/.test(dec) ? Number(dec) : null,
      blockNumber: Number(r.blockNumber),
      blockTimestamp: parseBlockTimestamp(r.blockTimestamp),
    })
  }
  return { rows, skipped }
}

// ── Upserts — ON CONFLICT DO NOTHING makes re-paging after a crash idempotent ──

async function upsertAddressTxs(ex: Executor, rows: HistoryInsertRow[]): Promise<number> {
  if (rows.length === 0) return 0
  const values = sql.join(
    rows.map(
      // Date params crash drizzle's raw-sql path (postgres-js Bind gets the
      // object unserialized) — bind ISO text and cast.
      (r) => sql`(
        ${r.address}, ${r.txHash}, ${r.blockNumber}, ${r.blockTimestamp.toISOString()}::timestamptz,
        ${r.fromAddress}, ${r.toAddress}, ${r.value}, ${r.category}, ${r.summary}, ${r.possibleSpam}
      )`,
    ),
    sql`, `,
  )
  await ex.execute(sql`
    INSERT INTO backfill_address_txs
      (address, tx_hash, block_number, block_timestamp, from_address, to_address, value, category, summary, possible_spam)
    VALUES ${values}
    ON CONFLICT (address, tx_hash) DO NOTHING
  `)
  return rows.length
}

async function upsertTokenTransfers(ex: Executor, rows: TransferInsertRow[]): Promise<number> {
  if (rows.length === 0) return 0
  const values = sql.join(
    rows.map(
      (r) => sql`(
        ${r.scopeAddress}, ${r.txHash}, ${r.logIndex}, ${r.tokenAddress},
        ${r.fromAddress}, ${r.toAddress}, ${r.value}, ${r.valueFormatted},
        ${r.tokenSymbol}, ${r.tokenDecimals}, ${r.blockNumber}, ${r.blockTimestamp.toISOString()}::timestamptz
      )`,
    ),
    sql`, `,
  )
  await ex.execute(sql`
    INSERT INTO backfill_token_transfers
      (scope_address, tx_hash, log_index, token_address, from_address, to_address,
       value, value_formatted, token_symbol, token_decimals, block_number, block_timestamp)
    VALUES ${values}
    ON CONFLICT (scope_address, tx_hash, log_index) DO NOTHING
  `)
  return rows.length
}

// ── Fenced watermark transitions ──
//
// The lease (claim stamp) is also a FENCING TOKEN: a worker that stalls past
// `leaseSec` loses the row to a reclaim, and every one of its later writes must
// be refused or it would overwrite the newer claim's cursor/status. The claim
// stamps `last_attempt_at` at millisecond precision (date_trunc) precisely so
// the stamp survives the postgres-js Date round-trip and can be presented back
// verbatim.

class LeaseLostError extends Error {}

const stampOf = (entity: ClaimedEntity): string | null =>
  entity.last_attempt_at ? new Date(entity.last_attempt_at).toISOString() : null

/** Apply `set` only if this claim still holds the lease. True = the row moved. */
async function fencedUpdate(ex: Executor, entity: ClaimedEntity, set: SQL): Promise<boolean> {
  const stamp = stampOf(entity)
  if (!stamp) return false
  const res = await ex.execute(sql`
    UPDATE backfill_watermarks SET ${set}
    WHERE id=${entity.id} AND status='running' AND last_attempt_at=${stamp}::timestamptz
    RETURNING id
  `)
  return Array.from(res).length > 0
}

// ── One page of work (Task 2.3) — atomic per page (R2), fenced per lease ──

export async function processOnePage(
  db: WorkerDb,
  provider: ProviderAdapter,
  entity: ClaimedEntity,
): Promise<PageStatus> {
  const idle: PageStatus = entity.rows_written > 0 ? 'partial' : 'pending'

  // The provider call is deliberately OUTSIDE the transaction — never hold a DB
  // transaction open across a network round-trip.
  let res: ProviderResult<AddressHistoryPage | TokenTransfersPage>
  try {
    const cursor = entity.oldest_cursor ?? undefined
    res =
      entity.entity_type === 'address_txs'
        ? await provider.getAddressHistory(entity.entity_id, cursor)
        : await provider.getAddressTokenTransfers(entity.entity_id, cursor)
  } catch (err) {
    // last_attempt_at=now(): the retry cooldown must measure from the FAILURE,
    // not the claim — a slow failed request would otherwise eat its own cooldown.
    const moved = await fencedUpdate(
      db,
      entity,
      sql`status='error', attempts=attempts+1, last_error=${String(err)}, last_attempt_at=now(), updated_at=now()`,
    )
    return moved ? 'error' : 'lease_lost'
  }

  if (!res.ok) {
    // rate_limited is not a failure — release the claim and retry on a later
    // pass (the fresh stamp also sorts it behind entities not yet throttled).
    const status: PageStatus = res.reason === 'rate_limited' ? idle : 'error'
    const moved = await fencedUpdate(
      db,
      entity,
      sql`status=${status}, attempts=attempts+${status === 'error' ? 1 : 0},
          last_error=${res.reason}, last_attempt_at=now(), updated_at=now()`,
    )
    return moved ? status : 'lease_lost'
  }

  const page = res.data

  // Map OUTSIDE the transaction — pure work, and the all-or-skip decision below
  // must happen before anything is written.
  let historyRows: HistoryInsertRow[] = []
  let transferRows: TransferInsertRow[] = []
  if ('txs' in page) {
    historyRows = mapHistoryRows(entity.entity_id, page.txs)
  } else {
    const { rows, skipped } = mapTransferRows(entity.entity_id, page.transfers)
    if (skipped > 0) {
      // ALL-OR-SKIP (worker-side twin of the A4b-1 serve seam rule): caching
      // the usable rows and advancing the cursor would leave the skipped
      // transfer permanently missing from the cached tail — serve resumes from
      // oldest_cursor (or stops entirely at 'complete'), so the hole would be
      // invisible and unfixable. Instead the page is left UNCACHED and the
      // entity capped with its cursor un-advanced: local pages drain to the
      // previous page's last row, then the provider serves this page onward.
      console.warn(
        `[backfill] page for scope ${entity.entity_id} has ${skipped} transfer row(s) with no usable ` +
          `log_index — leaving the page uncached and capping (tail serves live from the provider)`,
      )
      const moved = await fencedUpdate(
        db,
        entity,
        sql`status='capped', last_error=${`uncacheable page: ${skipped} row(s) without usable log_index`}, updated_at=now()`,
      )
      return moved ? 'capped' : 'lease_lost'
    }
    transferRows = rows
  }

  // ── R2: rows AND watermark advance commit together, or neither does. ──
  // A crash anywhere inside rolls back both, so oldest_cursor never points past
  // uncommitted rows; the re-claim re-pages this exact page and the PK dedups
  // it. A refused fence inside the transaction throws, rolling the rows back
  // with it — a zombie's page leaves no trace.
  try {
    return await db.transaction(async (tx) => {
      const written =
        'txs' in page
          ? await upsertAddressTxs(tx, historyRows)
          : await upsertTokenTransfers(tx, transferRows)

      // rows_written counts rows RETURNED by the provider path (mapped), not rows
      // newly inserted — an overlapping re-page the PK dedups still advances the
      // count, which is intentional: the cap bounds provider work, and treating a
      // duplicate page as progress is what stops a pathological loop paging forever.
      const total = entity.rows_written + written
      const provRows: { blockNumber: string }[] = 'txs' in page ? page.txs : page.transfers
      const minBlock = provRows.length
        ? Math.min(...provRows.map((r) => Number(r.blockNumber)))
        : entity.backfilled_through_block
      const status: PageStatus =
        total >= cfg.maxRowsPerEntity ? 'capped' : !page.cursor ? 'complete' : 'partial'

      const moved = await fencedUpdate(
        tx,
        entity,
        sql`status=${status}, rows_written=${total}, oldest_cursor=${page.cursor ?? null},
            backfilled_through_block=${minBlock}, attempts=0, last_error=NULL, updated_at=now()`,
      )
      if (!moved) throw new LeaseLostError('lease lost mid-page')
      return status
    })
  } catch (err) {
    if (err instanceof LeaseLostError) return 'lease_lost'
    throw err
  }
}

// ── Budget + bounds (Task 2.3, steps R4/R5) ──

/** R4 — reserve-or-deny in ONE statement. Race-safe across the rolling-deploy
 *  two-instance overlap, where a SELECT-then-bump would let both instances page.
 *  Deliberately conservative: a reserved page that then fails is NOT refunded —
 *  the cap bounds attempts, not successes, which is the property you want when
 *  guarding a shared provider quota against a hot retry loop. */
export async function reservePage(db: WorkerDb): Promise<boolean> {
  const res = await db.execute(sql`
    INSERT INTO backfill_budget (bucket_hour, pages_used) VALUES (date_trunc('hour', now()), 1)
    ON CONFLICT (bucket_hour) DO UPDATE SET pages_used = backfill_budget.pages_used + 1
      WHERE backfill_budget.pages_used < ${cfg.maxPagesPerHour}
    RETURNING pages_used
  `)
  return Array.from(res).length > 0 // a row means reserved; none means at cap
}

/** R5 — backfill is immortal and retention-exempt, so it must stop growing well
 *  before the 85% disk-emergency path would start sacrificing the LIVE index. */
export async function backfillPressure(db: WorkerDb): Promise<string | null> {
  const res = await db.execute(sql`
    SELECT
      COALESCE(pg_total_relation_size(to_regclass('backfill_address_txs')), 0)
    + COALESCE(pg_total_relation_size(to_regclass('backfill_token_transfers')), 0) AS bf_bytes,
      pg_database_size(current_database()) AS db_bytes
  `)
  const row = Array.from(res)[0] as { bf_bytes: string | number; db_bytes: string | number }
  const GB = 1024 ** 3
  const bfGb = Number(row.bf_bytes) / GB
  if (bfGb >= cfg.maxTotalGb) return `backfill ${bfGb.toFixed(2)}GB >= ${cfg.maxTotalGb}GB ceiling`
  const diskGb = Number(process.env.DB_DISK_GB ?? 0)
  if (diskGb > 0) {
    const pct = (Number(row.db_bytes) / GB / diskGb) * 100
    if (pct >= cfg.diskStopPct) return `disk ${pct.toFixed(1)}% >= ${cfg.diskStopPct}% stop`
  }
  return null
}

/** Release a claim we took but decided not to spend a page on (fenced — only
 *  if we still hold it). */
export async function releaseClaim(db: WorkerDb, entity: ClaimedEntity): Promise<void> {
  await fencedUpdate(
    db,
    entity,
    sql`status=${entity.rows_written > 0 ? 'partial' : 'pending'}, updated_at=now()`,
  )
}

/** The provider bucket an entity's page will actually spend from: address
 *  history acquires `history`, token transfers acquire `assets` (see the
 *  Moralis adapter). Politeness must watch the matching counter. */
export type ProviderBucket = 'history' | 'assets'
export function bucketFor(entityType: ClaimedEntity['entity_type']): ProviderBucket {
  return entityType === 'address_txs' ? 'history' : 'assets'
}

/** BNB politeness: yield while the fleet-shared bucket this page would spend
 *  from is already busy serving humans. Reads the same counters /api/health
 *  reads (plain GETs, no INCR, so it never consumes budget). Without a live
 *  Redis the counter is null (ETH, or a blip) → false: there is no fleet
 *  signal to be polite to, and the standalone hourly cap (R4) is the sole
 *  gate. */
export async function sharedBucketOverHeadroom(
  bucket: ProviderBucket,
  healthFn: () => Promise<Record<string, unknown>> = getDataProviderHealth,
): Promise<boolean> {
  try {
    const health = await healthFn()
    const buckets = health?.buckets as
      | Record<string, { hourly?: number | null; hourlyMax?: number }>
      | undefined
    const b = buckets?.[bucket]
    if (!b || b.hourly == null || !b.hourlyMax) return false
    return b.hourly >= cfg.budgetHeadroom * b.hourlyMax
  } catch {
    return false
  }
}

// ── The loop (Task 2.3, step 3) ──

export async function startBackfillWorker(): Promise<void> {
  const chain = getChainConfig()
  if (cfg.enabledEnvOff || chain.provider?.backfill?.enabled !== true) {
    console.log('[backfill] disabled — worker not started')
    return
  }
  const provider = resolveDataProvider(chain.provider, { currency: chain.currency })
  if (!provider) {
    console.log('[backfill] no provider — worker not started')
    return
  }
  console.log(
    `[backfill] worker ON — cap ${cfg.maxRowsPerEntity} rows/entity, ${cfg.maxPagesPerHour} pages/hr, ` +
      `${cfg.pageSleepMs}ms pacing, ceiling ${cfg.maxTotalGb}GB, disk-stop ${cfg.diskStopPct}%`,
  )

  const db = getMaintenanceDb()
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  let lastPressure: string | null = null

  for (;;) {
    try {
      // R5 first — a frozen backfill must not even claim work.
      const pressure = await backfillPressure(db)
      if (pressure) {
        if (pressure !== lastPressure) {
          console.warn(`[backfill] STOPPED — ${pressure}`)
          lastPressure = pressure
        }
        await sleep(cfg.pollMs)
        continue
      }
      if (lastPressure) {
        console.log('[backfill] resumed — pressure cleared')
        lastPressure = null
      }

      const entity = await claimNextEntity(db)
      if (!entity) {
        await sleep(cfg.pollMs)
        continue
      }

      // BNB politeness AFTER the claim, so the check watches the bucket THIS
      // entity's page would spend from (transfers hit `assets`, not `history`).
      // No-op on ETH (no fleet counter).
      if (await sharedBucketOverHeadroom(bucketFor(entity.entity_type))) {
        await releaseClaim(db, entity)
        await sleep(cfg.pollMs)
        continue
      }

      // Claim BEFORE reserve, so a denied reserve never burns a budget slot on a
      // no-op poll. If the reserve is denied we hand the entity straight back.
      if (!(await reservePage(db))) {
        await releaseClaim(db, entity)
        await sleep(cfg.pollMs)
        continue
      }

      await processOnePage(db, provider, entity)
      await sleep(cfg.pageSleepMs) // pacing between provider calls
    } catch (err) {
      console.warn('[backfill] loop error:', err instanceof Error ? err.message : err)
      await sleep(cfg.pollMs)
    }
  }
}

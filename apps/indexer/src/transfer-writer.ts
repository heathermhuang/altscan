/**
 * The async token_transfers writer: block workers enqueue a block's transfers, one writer
 * commits them in coalesced batches and advances the durable watermark
 * (indexer_cursor.transfers_durable_block) that crash resume and wallet watch read.
 *
 * Moved verbatim out of block-processor.ts, with which it shared nothing but the transfer
 * row shape and the inline-path write (writeTransferBlocks, used when ASYNC_TT_WRITER is off).
 * The contract it keeps is spelled out at the top of the writer section below; processBlock's
 * replay safety (AGENTS.md) depends on it.
 */
import { sql } from 'drizzle-orm'
import { indexerConfig } from './config-instance'
import { getDb, getWriterDb, schema, dbErrorMessage, unwrapDbError, SQL_BATCH_CHUNK } from './db'
import { ensureForwardPartitions } from './ensure-schema'
import { recordIndexGapIfAbsent } from './index-gaps'
import { enqueueHolderBalanceUpdate } from './holder-balances'

// ── Async token_transfers writer flag ────────────────────────────────
// When ON, token_transfers INSERTs move off the per-block hot path into a single
// crash-safe coalescing writer (below, and the
// indexer_cursor watermark). Default ON for BNB (0.45s blocks need it), OFF for
// ETH (12s blocks are fine on the synchronous inline path). Override with
// ASYNC_TT_WRITER=1/0. When OFF, behavior is byte-for-byte today's inline path.
export const ASYNC_TT_WRITER = indexerConfig.transferWriter.async

export type TokenTransferRow = {
  txHash: string
  logIndex: number
  tokenAddress: string
  fromAddress: string
  toAddress: string
  value: string
  tokenId: string | null
  blockNumber: number
  timestamp: Date
  tokenType: 'BEP20' | 'BEP721' | 'BEP1155'
}

// ── Async token_transfers writer (crash-safe, coalescing) ───────────
// token_transfers is PRIMARY data, so unlike the holder/address coalescers we
// must NOT lose the queue on crash. The contract (mirrored by index.ts resume):
//
//   • Single writer.   Only this writer INSERTs token_transfers — block workers
//     just enqueue. That removes the 8-worker index contention that made the
//     inline insert ~50% of BNB block time.
//   • Durable watermark. indexer_cursor.transfers_durable_block = W means every
//     block ≤ W has ALL its transfers committed. It is the crash-resume point.
//   • W advances only AFTER a commit, through the contiguous prefix of written
//     blocks. Writing ahead of W is fine — replay re-writes idempotently.
//   • Each drain is written DELETE+INSERT inside one transaction, targeting
//     EXACTLY the drained block numbers. Reads never see a half-written block;
//     replay is a clean overwrite (no dupes, no reliance on a unique constraint,
//     so it works identically on the block-range-partitioned table — Part B).
// Backpressure bound on pending rows. Robust to unset/NaN/zero/negative → default
// 50000: a malformed env must fall back to a finite bound, never disable backpressure
// (the 838k-row OOM is why this exists). It must also never stay NaN — the dual-bound
// loops below break on `rows <= bound`, and `x <= NaN` is always false, so a NaN bound
// would throttle forever even on an empty queue (codex P2). Was a bare parseInt with a
// `?? '50000'` that only defaulted on unset, leaving empty/garbage env → NaN.
const TT_QUEUE_HIGH_WATER_ROWS = indexerConfig.transferWriter.queueHighWaterRows
// Parallel backpressure bound on the pending BLOCK COUNT (transferPending.size), not
// just rows. The rows bound above never engages for an all-transfer-less block range
// with a stalled writer — rows stays ~0 while the pending Map grows unbounded (codex
// P2 deferred from PR #43/#44). Bounding blocks caps that Map (and the W↔tip crash
// replay window) regardless of how few transfers the range carries. Robust to
// unset/NaN/zero/negative → default 2000. Backpressure only — the high-water ALERT
// (TT_QUEUE_ALERT_ROWS) stays rows-only; a genuinely stuck writer is already caught by
// the consecutive-write-failure alert, which is failure-count- not row-driven.
const TT_QUEUE_HIGH_WATER_BLOCKS = indexerConfig.transferWriter.queueHighWaterBlocks
// Pending-rows threshold for the high-water ALERT, decoupled from the backpressure
// bound above. PR #43 reused TT_QUEUE_HIGH_WATER_ROWS for both, so the WARN tripped on
// every momentary ride along the backpressure ceiling (13 benign fires the first day,
// all ~50,000–50,200 rows with W advancing). The alert must mean "backpressure is
// FAILING to contain the queue" (the 838k June incident), not "the queue is busy" — so
// it gets its own, higher bound: default 2× the backpressure bound, floored AT the bound
// so a misconfigured override can never make the alert noisier than PR #43 was. Pairs
// with the lower recovery edge in evaluateTransferQueueHighWater() to form a hysteresis
// band that can't flap.
const TT_QUEUE_ALERT_ROWS = indexerConfig.ttQueueAlertRows
// Consecutive failed drains before the writer escalates from a per-attempt warn to a
// loud error alert (and again every Nth failure after). Mirrors webhook-notifier's
// "deactivate after 5 consecutive failures" pattern — here we never give up (transfers
// are primary data), we just get loud so log-based monitoring fires.
const TT_WRITER_FAILURE_ALERT_THRESHOLD = indexerConfig.transferWriter.failureAlertThreshold
/**
 * A queued write for one block.
 *
 * `quarantine` marks a batch that asserts NOTHING about the block's transfers —
 * it exists only so the watermark fold can advance past a height the indexer has
 * given up on. Such a batch must never DELETE and never INSERT.
 *
 * The flag rides WITH the batch rather than living in a parallel set, and that is
 * deliberate. It has to survive the drain, the 250ms requeue-retry, and the reorg
 * purge, and every earlier attempt at holding quarantine state alongside the queue
 * drifted out of sync in a way review caught only after the fact. Carried inline,
 * there is nothing to keep in sync: a later real decode simply replaces the entry
 * (see enqueueTransferWrite), which revokes the quarantine as a side effect of the
 * existing "latest decode of a block wins" rule.
 */
type PendingBatch = { rows: TokenTransferRow[]; quarantine: boolean }

let transferPending = new Map<number, PendingBatch>()
let transferPendingRows = 0
const transferWritten = new Set<number>()   // committed, not yet folded into W
let durableBlock = 0
let transferWriterSeeded = false
let transferWriterRunning = false
let transferWriterPaused = false            // reorg rollback quiesce (see rollbackTransferWriterTo)
let ttWriterDrainCount = 0

// ── produce/drain overlap diagnostics (TT_WRITER_PROFILE=1) ──────────────────
//
// Measured 2026-08-17: the writer sustains 919 rows/s while block workers are
// parked on backpressure, but the system averages only ~594 rows/s — and 919
// already exceeds the ~701 rows/s needed to match chain. So the deficit is NOT
// write capacity; it is that producing and draining do not overlap. Three
// mechanisms explain that and they are distinguishable only by measuring AT the
// event, which is the whole reason this exists (a sampled queue depth was what
// produced the wrong root cause earlier that day):
//
//   M1 connection starvation — the writer is the 9th consumer of a
//      DB_POOL_SIZE=8 pool and holds one slot for a whole transaction.
//   M2 event-loop starvation — 8 decoding workers saturate the single Node
//      thread.
//   M3 pure rate mismatch — oscillation is inherent.
//
// ⚠ READ THIS BEFORE DRAWING A CONCLUSION FROM THESE NUMBERS.
//
// The metrics below are HINTS, not the verdict. Review established that the
// acq/lag split cannot cleanly separate M1 from M2/M3 from inside the process:
//   • `tEnter - tStart` also contains connection setup, network RTT and the
//     server-side BEGIN, none of which shows up as event-loop lag — so high acq
//     with low lag can mean a busy DATABASE rather than a starved local pool;
//   • the `none` bucket counts workers that are alive and unparked, but those
//     may all be awaiting RPC inside processBlock and holding no DB slot at all,
//     so `none` mixes real contention with idle periods.
//
// The VERDICT comes from the A/B on TT_WRITER_DEDICATED_POOL against the
// measured baseline (1.880 blk/s indexed, 64.7% of wall clock stalled), because
// that removes the contention instead of trying to observe it. Treating one of
// these observational numbers as proof is exactly the error that produced a
// confidently wrong root cause earlier the same day, from a queue depth that was
// only ever a lower bound. Use them to explain a result, never to establish one.
//
// Diagnostic only: nothing here changes behaviour, and it is off unless
// TT_WRITER_PROFILE=1 so the default path pays only a boolean test.
const TT_WRITER_PROFILE = indexerConfig.transferWriter.profile
const TT_PROFILE_WINDOW_MS = indexerConfig.transferWriter.profileWindowMs
/** Block workers currently parked in the backpressure poll loop (index.ts). */
let parkedWorkers = 0
/**
 * Worker-pool size, so "all parked" is a real state rather than a guess.
 * 0 = unset, which collapses ALL and PARTIAL into one bucket and is reported as
 * such — an unset pool size must not silently masquerade as a clean measurement.
 */
let profWorkerCount = 0
/**
 * Three phases, not two. (codex P2.)
 *
 * A binary `parkedWorkers > 0` labels a drain "blocked" even when only 1 of 8
 * workers has parked and the other 7 are still decoding and holding pool slots.
 * Those transition periods are exactly where contention is HIGHEST, so folding
 * them into the blocked bucket drags the blocked rate down toward the running
 * rate — i.e. it makes M1 (connection starvation) look like M3 (inherent
 * oscillation), which is the one confusion this experiment exists to resolve.
 *
 *   NONE    — every worker decoding. Full competition for the pool.
 *   PARTIAL — some parked. Transitional; reported but never used to conclude.
 *   ALL     — every worker parked. The writer has the pool to itself.
 *
 * The verdict comes from NONE vs ALL. PARTIAL is printed so a run where most
 * drains land there is visibly inconclusive rather than quietly wrong.
 */
type DrainPhase = 'none' | 'partial' | 'all'
const ttProf = {
  since: 0,
  rows: { none: 0, partial: 0, all: 0 },
  ms: { none: 0, partial: 0, all: 0 },
  acq: { none: 0, partial: 0, all: 0 },
  passesBy: { none: 0, partial: 0, all: 0 },
  acquireMaxMs: 0, sqlMs: 0, passes: 0,
  blocks: { none: 0, partial: 0, all: 0 },
  // NOT "pool starvation count". postgres.js `connect_timeout` covers TCP,
  // protocol and auth startup — NOT waiting on an occupied local pool slot — and
  // this catch sees every pre-callback throw, so a network or auth failure lands
  // here too. Reported as a neutral "preCbFail" and never as M1 evidence on its
  // own; a spike here means "go read the writer's error logs", not "starvation
  // confirmed". (codex P2.)
  preCbFail: 0,
  // Lag is bucketed BY PHASE. A window-wide average lets a lag spike during
  // `all` make high `none` acquisition look scheduler-bound, and lets low-lag
  // `all` samples dilute genuine event-loop starvation during `none` — which
  // reintroduces exactly the M1/M2 confusion the probe was added to remove.
  // (codex P2.)
  lagSum: { none: 0, partial: 0, all: 0 },
  lagN: { none: 0, partial: 0, all: 0 },
  lagMax: { none: 0, partial: 0, all: 0 },
}

/**
 * Event-loop lag probe. (codex P1.)
 *
 * `tEnter - tStart` around db.transaction() CANNOT be read as pool-acquisition
 * time on its own: when the event loop is saturated, the transaction callback is
 * scheduled late even after a connection was already available, so M2 inflates
 * exactly the number that was supposed to identify M1. Measuring loop lag
 * independently makes the two separable:
 *
 *   high acquire + LOW lag  -> real pool wait          (M1)
 *   high acquire + HIGH lag -> scheduling delay        (M2)
 *
 * A timer scheduled for `interval` that fires at `interval + d` has observed
 * `d` ms of loop lag. Unref'd so it can never hold the process open at shutdown.
 */
const LOOP_LAG_INTERVAL_MS = 500
function startLoopLagProbe(): void {
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    const lag = Math.max(0, now - last - LOOP_LAG_INTERVAL_MS)
    last = now
    // Attribute each sample to the phase in effect right now, so lag is
    // comparable against that phase's acquisition time.
    const p = phaseFor(parkedWorkers, activeWorkers, profWorkerCount)
    ttProf.lagSum[p] += lag
    ttProf.lagN[p]++
    if (lag > ttProf.lagMax[p]) ttProf.lagMax[p] = lag
    // Emission is driven from HERE, not from a completed drain. If transactions
    // keep failing before callback entry, no drain ever completes — so a
    // drain-driven emitter would print nothing for the entire failure period and
    // then start a fresh window on the first recovery, hiding the failure by
    // another full interval. This ticks regardless. (codex P2.)
    maybeEmitProfile()
  }, LOOP_LAG_INTERVAL_MS)
  timer.unref?.()
}

/**
 * Tell the profile how many block workers exist, so ALL is distinguishable from
 * PARTIAL. Called from index.ts with CONCURRENCY.
 */
export function setProfileWorkerCount(n: number): void {
  profWorkerCount = Number.isFinite(n) && n > 0 ? n : 0
}

/** Block workers currently alive in the batch loop (index.ts). */
let activeWorkers = 0

/**
 * Report a block worker entering (+1) or leaving (-1) the batch loop.
 *
 * NOT redundant with noteWorkerParked. A worker that reaches the tail of a batch
 * hits `claimNext() === -1` and RETURNS without ever parking, so `parked === 0`
 * happens both when all 8 workers are hammering the pool and when 7 have gone
 * home and one straggler remains. Those are opposite contention regimes, and
 * conflating them drags the `none` bucket toward the `all` bucket — concealing
 * connection starvation, the exact thing being tested for. (codex P2, round 2.)
 */
export function noteWorkerActive(delta: number): void {
  activeWorkers = Math.max(0, activeWorkers + delta)
}

/**
 * Classify a drain pass. Pure and exported so the mapping is tested by CALLING
 * it — a previous version asserted only that the source contained the right
 * literals, which would have passed even with the branch dead. (codex P2.)
 *
 * `none` demands a FULL pool of active workers and none parked; anything else
 * short of a full park is `partial`, i.e. reported but never concluded from.
 */
export function phaseFor(parked: number, active: number, workerCount: number): DrainPhase {
  // Without a known pool size nothing can be classified; say so rather than
  // guessing, and let the log line label the window inconclusive.
  if (!(workerCount > 0)) return 'partial'
  // `>=` not `===`: if the count ever over-reports, the safe reading is "the
  // writer had the pool to itself", which weakens the contention conclusion
  // rather than inventing one.
  if (parked >= workerCount) return 'all'
  if (parked === 0 && active >= workerCount) return 'none'
  return 'partial'
}

/**
 * Report a block worker entering (+1) or leaving (-1) the backpressure wait.
 *
 * Called from the poll loop in index.ts. This is what lets the writer attribute
 * each drain pass to a PHASE — the single number that discriminates M3 (rates
 * equal) from M1/M2 (rates differ). Cheap and monotonic; never let it drift
 * negative, since a stuck negative count would silently mislabel every
 * subsequent pass as "running".
 */
export function noteWorkerParked(delta: number): void {
  parkedWorkers = Math.max(0, parkedWorkers + delta)
}

function recordDrainPass(rows: number, blocks: number, acquireMs: number, sqlMs: number, phase: DrainPhase): void {
  const now = Date.now()
  if (ttProf.since === 0) ttProf.since = now
  ttProf.passes++
  if (acquireMs > ttProf.acquireMaxMs) ttProf.acquireMaxMs = acquireMs
  ttProf.sqlMs += sqlMs
  ttProf.rows[phase] += rows
  ttProf.blocks[phase] += blocks
  ttProf.ms[phase] += acquireMs + sqlMs
  ttProf.acq[phase] += acquireMs
  ttProf.passesBy[phase]++
  maybeEmitProfile()
}

function maybeEmitProfile(): void {
  const now = Date.now()
  if (ttProf.since === 0) ttProf.since = now
  if (now - ttProf.since < TT_PROFILE_WINDOW_MS) return
  // Nothing observed at all — don't emit an empty line every window.
  if (ttProf.passes === 0 && ttProf.preCbFail === 0) { ttProf.since = now; return }
  // Every denominator is guarded: a window can legitimately contain zero passes
  // in a phase (e.g. no worker ever parked), and a NaN in the one line the whole
  // experiment is read from would be indistinguishable from a real reading.
  // Mean rows AND blocks per pass are printed alongside the rate because the two
  // phases drain differently shaped batches — an `all` pass empties a backlog
  // accumulated at the high-water bound, a `none` pass is usually small — and
  // fixed per-transaction overhead alone makes those rates differ at identical
  // resource availability. Without the shape, a rate gap cannot be attributed.
  // (codex P2.)
  // acq and lag are printed TOGETHER per phase — that pairing is the whole
  // discriminator. High acq with LOW lag in the same phase is a real pool wait
  // (M1); high acq with HIGH lag is scheduling delay (M2).
  const per = (p: DrainPhase) => {
    const n = ttProf.passesBy[p]
    const ln = ttProf.lagN[p]
    const lag = ln > 0 ? `${(ttProf.lagSum[p] / ln).toFixed(0)}/${ttProf.lagMax[p].toFixed(0)}ms` : '—'
    if (n === 0) return `${p} — (lag ${lag})`
    const ms = ttProf.ms[p]
    const rate = ms > 0 ? (ttProf.rows[p] / (ms / 1000)).toFixed(0) : '—'
    return `${p} ${rate} rows/s (n=${n}, ${(ttProf.rows[p] / n).toFixed(0)}r+${(ttProf.blocks[p] / n).toFixed(0)}blk/pass, acq ${(ttProf.acq[p] / n).toFixed(0)}ms, lag ${lag})`
  }
  const verdict =
    profWorkerCount === 0 ? ' [pool size UNSET — inconclusive]'
    : ttProf.passesBy.none === 0 || ttProf.passesBy.all === 0 ? ' [need both none+all passes to conclude]'
    : ''
  console.log(
    `[tt-writer] PROFILE ${((now - ttProf.since) / 1000).toFixed(0)}s: ` +
    `${per('none')} | ${per('partial')} | ${per('all')} | ` +
    `sql avg ${ttProf.passes > 0 ? (ttProf.sqlMs / ttProf.passes).toFixed(0) : '—'}ms, ` +
    `acq max ${ttProf.acquireMaxMs.toFixed(0)}ms, ` +
    // Deliberately NOT called a starvation count — see the field comment. A
    // spike means "read the writer's error logs", not "M1 confirmed".
    `preCbFail ${ttProf.preCbFail}, passes ${ttProf.passes}${verdict}`,
  )
  ttProf.since = now
  for (const p of ['none', 'partial', 'all'] as const) {
    ttProf.rows[p] = ttProf.blocks[p] = ttProf.ms[p] = ttProf.acq[p] = ttProf.passesBy[p] = 0
    ttProf.lagSum[p] = ttProf.lagN[p] = ttProf.lagMax[p] = 0
  }
  ttProf.acquireMaxMs = ttProf.sqlMs = ttProf.passes = 0
  ttProf.preCbFail = 0
}
let ttQueueOverHighWater = false      // edge-trigger so the high-water alert fires once per breach
let ttWriterConsecutiveFailures = 0   // resets on a successful drain; drives the write-failing alert

/**
 * Seed the in-memory watermark from indexer_cursor at startup. MUST be called by
 * index.ts before the indexing loop — without a seed the writer refuses to run
 * (so it can never persist a bogus W=0 over a real cursor).
 */
export function initTransferWriter(seedDurableBlock: number): void {
  durableBlock = seedDurableBlock
  transferWriterSeeded = true
  console.log(`[tt-writer] seeded durable watermark = ${durableBlock} (backpressure bounds ${TT_QUEUE_HIGH_WATER_ROWS} rows / ${TT_QUEUE_HIGH_WATER_BLOCKS} blocks, alert bound ${TT_QUEUE_ALERT_ROWS} rows)`)
  // State the resolved value, not the intent. An env-gated diagnostic that is
  // silently off looks identical to one that is on and finding nothing, and this
  // codebase has shipped an inert fix that way before (#92). Grep this line.
  console.log(
    TT_WRITER_PROFILE
      ? `[tt-writer] produce/drain PROFILE ON (window ${TT_PROFILE_WINDOW_MS}ms) — emits "[tt-writer] PROFILE" lines`
      : `[tt-writer] produce/drain profile OFF (set TT_WRITER_PROFILE=1 to diagnose backpressure oscillation)`,
  )
  // The A/B arm. Printed unconditionally and from the RESOLVED env value, so a
  // run can never be attributed to the wrong arm after the fact.
  console.log(
    indexerConfig.transferWriter.dedicatedPool
      ? `[tt-writer] dedicated writer pool ON (TT_WRITER_POOL_SIZE=${indexerConfig.transferWriter.poolSize}) — not competing with block workers for slots`
      : `[tt-writer] dedicated writer pool OFF — sharing the ingestion pool with block workers`,
  )
  if (TT_WRITER_PROFILE) startLoopLagProbe()
  runTransferWriter()  // flush anything enqueued during startup
}

/**
 * Ranges a MAX_LAG skip abandoned, in skip order: W may jump from `after` (the cursor
 * before the skip) to `to` once the fold has reached `after`. See setDurableFloor.
 */
let pendingFloors: Array<{ after: number; to: number }> = []

/** The next abandoned range is ready to be stepped over: everything below it is durable. */
function floorReady(): boolean {
  return pendingFloors.length > 0 && durableBlock >= pendingFloors[0].after
}

/**
 * Let the watermark step over a range the indexer deliberately abandoned (the MAX_LAG
 * "skip to tip" path in index.ts). Without this, W would freeze at the skip boundary
 * because the skipped blocks are never enqueued. Accepts the same gap the skip creates
 * in `blocks`; the resume gap-scan heals recent holes on restart.
 *
 * It does not move W itself. W used to jump to `to` at once, over (W, after] too, and
 * those blocks are routinely processed but still queued: a crash then lost their rows
 * for good, because crash-resume replays only from W upward (the same reason the
 * quarantine path uses a quarantine batch). And W moved in memory before a fire-and-
 * forget persist that swallowed failure. Now the writer's fold steps over the range once
 * it reaches `after`, and persists before it advances, retrying a failed persist like
 * any other.
 */
export function setDurableFloor(floor: { after: number; to: number }): void {
  if (!transferWriterSeeded || floor.to <= floor.after) return
  pendingFloors.push(floor)
  runTransferWriter()
}

/**
 * Reorg support (A3): drop queued-but-unwritten transfer decodes for blocks ABOVE
 * the fork point, so the writer can't insert orphaned-chain rows after unwindFrom()
 * deleted them. Rows at or below the fork are canonical — kept. Also clears
 * transferWritten above the fork so a later fold can't re-advance W over blocks
 * whose rows were just unwound. Call via rollbackTransferWriterTo (which quiesces
 * the writer first — a purge alone can't see a batch an active drain already moved
 * into its local map; codex P2 on PR #67).
 */
export function purgeTransferQueueAbove(forkPoint: number): void {
  let dropped = 0
  for (const [n, batch] of transferPending) {
    if (n > forkPoint) {
      // Quarantine batches are dropped here too, and must be: above the fork the
      // height refers to a DIFFERENT block, so a decision made about the orphan
      // must not let the fold step over its canonical replacement.
      transferPending.delete(n)
      transferPendingRows -= batch.rows.length
      dropped += batch.rows.length
    }
  }
  for (const n of transferWritten) if (n > forkPoint) transferWritten.delete(n)
  // A failure above the fork was about the orphaned block, not its replacement.
  for (const n of blockWriteFailures.keys()) if (n > forkPoint) blockWriteFailures.delete(n)
  if (dropped > 0) {
    console.warn(`[tt-writer] reorg purge: dropped ${dropped} queued rows above block ${forkPoint}`)
    evaluateTransferQueueHighWater()
  }
}

/**
 * Full reorg rollback for the async transfer writer (A3; codex P1+P2 on PR #67):
 *  1. QUIESCE — pause new drains and wait out an in-flight one, so a batch already
 *     moved into the drainer's local map can't commit stale rows after unwindFrom()
 *     deletes them (or fold W forward past the fork again).
 *  2. PURGE — drop queued decodes + transferWritten entries above the fork.
 *  3. REWIND W — durableBlock claims "every block ≤ W has all transfers committed",
 *     which is false above the fork once rows are unwound. Crash-resume takes
 *     min(MAX(blocks.number), W), which only covers a crash BEFORE reprocessing;
 *     if we crash mid-reprocess (block row inserted, transfers not yet drained),
 *     a stale W resumes past that block and its transfers are lost forever. So W
 *     must be rewound and persisted. A persist failure is logged loudly but not
 *     fatal: the in-memory rewind stands, and the next successful drain-fold
 *     re-persists a correct W (only a crash inside that window is exposed).
 * Always resumes the writer, even on persist failure.
 */
export async function rollbackTransferWriterTo(forkPoint: number): Promise<void> {
  transferWriterPaused = true
  try {
    while (transferWriterRunning) await new Promise(r => setTimeout(r, 25))
    purgeTransferQueueAbove(forkPoint)
    // Heights above the fork are re-indexed, so an abandoned range ends at the fork.
    pendingFloors = pendingFloors
      .map(f => ({ after: f.after, to: Math.min(f.to, forkPoint) }))
      .filter(f => f.to > f.after)
    transferHighestQueued = Math.min(transferHighestQueued, forkPoint)
    if (transferWriterSeeded && durableBlock > forkPoint) {
      const prev = durableBlock
      durableBlock = forkPoint
      try {
        await persistDurableBlock(forkPoint)
        console.warn(`[tt-writer] reorg rollback: durable watermark rewound ${prev} → ${forkPoint}`)
      } catch (err) {
        console.error(`[tt-writer] ALERT reorg rollback: watermark rewound in memory (${prev} → ${forkPoint}) but persist FAILED — a crash before the next drain-fold persists would resume past the fork:`, dbErrorMessage(err))
      }
    }
  } finally {
    transferWriterPaused = false
    runTransferWriter()
  }
}

export function getTransferQueueDepth(): { blocks: number; rows: number; durableBlock: number } {
  return { blocks: transferPending.size, rows: transferPendingRows, durableBlock }
}

// Edge-triggered high-water alert for the pending queue (warn once on the way up,
// log once on the way back down) so a sustained breach doesn't spam every enqueue.
// The June 2026 incident saw the queue blow past the bound (~838k rows) with no signal.
// MUST be called after every DURABLE change to transferPendingRows — enqueue,
// post-failure requeue, and a completed drain — otherwise the flag desyncs: the
// writer draining a breach to empty (or a requeue re-crossing the bound) happens
// outside enqueue, so without this the recovery log is missed and the flag can stick
// true. Deliberately NOT called at the transient top-of-loop reset to 0, which would
// flap warn/recovered every 250ms during a write-failure retry storm.
// Hysteresis band: WARN above TT_QUEUE_ALERT_ROWS (the high edge, only reached when
// backpressure has lost containment) and recover at/under TT_QUEUE_HIGH_WATER_ROWS (the
// backpressure bound the live + backfill loops throttle on). Warning at the higher edge
// keeps normal busy-load oscillation along the backpressure ceiling silent; recovering
// at the lower edge means "recovered" = backpressure pulled the queue back to target.
function evaluateTransferQueueHighWater(): void {
  if (!ttQueueOverHighWater && transferPendingRows > TT_QUEUE_ALERT_ROWS) {
    ttQueueOverHighWater = true
    console.warn(`[tt-writer] ALERT queue over high-water: ${transferPendingRows} rows > ${TT_QUEUE_ALERT_ROWS} alert bound — backpressure bound ${TT_QUEUE_HIGH_WATER_ROWS} not containing the queue (${transferPending.size} blocks pending, W=${durableBlock})`)
  } else if (ttQueueOverHighWater && transferPendingRows <= TT_QUEUE_HIGH_WATER_ROWS) {
    ttQueueOverHighWater = false
    console.log(`[tt-writer] queue recovered: ${transferPendingRows} rows ≤ ${TT_QUEUE_HIGH_WATER_ROWS} backpressure bound`)
  }
}

export function enqueueTransferWrite(blockNumber: number, rows: TokenTransferRow[]): void {
  const prev = transferPending.get(blockNumber)
  if (prev) transferPendingRows -= prev.rows.length
  // latest decode of a block wins — and because this always writes quarantine:false,
  // a real decode arriving for a quarantined height revokes the quarantine for free.
  transferPending.set(blockNumber, { rows, quarantine: false })
  transferPendingRows += rows.length
  if (blockNumber > transferHighestQueued) transferHighestQueued = blockNumber
  evaluateTransferQueueHighWater()
  runTransferWriter()
}

/**
 * Let the watermark advance past a block the indexer has quarantined.
 *
 * NOT `enqueueTransferWrite(n, [])`. An empty batch is indistinguishable from a
 * transfer-less block, and writeTransferBlocks DELETEs every block it drains — so
 * an empty batch is empty-by-OMISSION and would delete rows it never decoded. That
 * is the same failure that made `--skip-logs` backfills lose data (see the comment
 * above the enqueue in processBlock, and PR #42). The window is real here: this
 * batch can sit in the 250ms requeue-retry loop, or in an outgoing deploy
 * generation, while a heal writes the block's real transfers — and the stale retry
 * would then delete them.
 *
 * A quarantine batch instead carries no claim about the block at all. It is never
 * deleted and never inserted, so a stale retry is a complete no-op; it only ever
 * contributes its height to the fold. If a real decode shows up first, it replaces
 * this entry and normal semantics resume.
 */
export function enqueueQuarantinedBlock(blockNumber: number): void {
  const prev = transferPending.get(blockNumber)
  // A real decode already queued for this height OUTRANKS the quarantine — it
  // carries actual rows, and downgrading it to a no-op would drop them.
  if (prev && !prev.quarantine) return
  // Keep the row counter honest. Today `prev` can only be another quarantine batch
  // (zero rows), so this subtracts nothing — but transferPendingRows drives both the
  // backpressure bound and the high-water ALERT, and leaving the only thing that
  // protects it as the guard above means a future edit there corrupts the counter
  // silently. It also makes that guard testable: without the subtraction, replacing
  // a real batch leaves the count unchanged, so nothing observable would change.
  if (prev) transferPendingRows -= prev.rows.length
  transferPending.set(blockNumber, { rows: [], quarantine: true })
  if (blockNumber > transferHighestQueued) transferHighestQueued = blockNumber
  evaluateTransferQueueHighWater()
  runTransferWriter()
}

/**
 * Why one block's write failed, from its SQLSTATE, so the writer knows what may move W.
 *
 *  - `data` (class 22, e.g. 22P02): the block's own rows are bad, and every replay fails
 *    the same way. After TT_BLOCK_REJECT_AFTER attempts the block is rejected.
 *  - `missing-partition` (23514 "no partition of relation … found for row"): the range
 *    has no token_transfers partition yet. Partitions are made and the block retried;
 *    it never counts toward rejection.
 *  - `infra` (classes 08, 40, 57, or a socket or connection error from the driver):
 *    nothing is wrong with the block. The whole drain is retried quietly.
 *  - `unknown`: anything else. Retried alone, forever, and never moves W, so a failure
 *    mode nobody has seen cannot step W over a block.
 */
export type WriteFailureKind = 'data' | 'missing-partition' | 'infra' | 'unknown'

export function classifyWriteFailure(err: unknown): { kind: WriteFailureKind; sqlstate: string } {
  const e = unwrapDbError(err) as { name?: unknown; code?: unknown; message?: unknown } | null
  const code = typeof e?.code === 'string' ? e.code : ''
  if (e?.name !== 'PostgresError') {
    // Not from the server. A socket or connection code (ECONNRESET, CONNECT_TIMEOUT,
    // CONNECTION_CLOSED) is the connection, not the block; any other driver error
    // (UNDEFINED_VALUE, MAX_PARAMETERS_EXCEEDED) may well be the block's own.
    if (/^(E[A-Z]+|CONNECT_TIMEOUT|CONNECTION_[A-Z]+)$/.test(code)) return { kind: 'infra', sqlstate: code }
    return { kind: 'unknown', sqlstate: code || 'none' }
  }
  if (code === '23514' && /no partition of relation/i.test(String(e.message))) return { kind: 'missing-partition', sqlstate: code }
  if (code.startsWith('22')) return { kind: 'data', sqlstate: code }
  if (/^(08|40|57)/.test(code)) return { kind: 'infra', sqlstate: code }
  return { kind: 'unknown', sqlstate: code || 'none' }
}

/** Data failures before a block is rejected: recorded as a gap, then stepped over. */
export const TT_BLOCK_REJECT_AFTER = 5
const TT_BLOCK_RETRY_BASE_MS = 250
const TT_BLOCK_RETRY_MAX_MS = 30_000

/**
 * Heights whose own write failed. Each is retried ALONE, after a capped backoff, while
 * the blocks around it commit: W folds contiguously, so it stays below the failing
 * block, and a restart replays from there, which is replay-safe. `rejections` counts
 * only data failures; `attempts` drives the backoff.
 */
const blockWriteFailures = new Map<number, { rejections: number; attempts: number; retryAt: number; sqlstate: string }>()
let blockRetryTimer: ReturnType<typeof setTimeout> | null = null
let transferHighestQueued = 0
let watermarkLagAlerting = false

/** Take every queued batch that is not waiting out a backoff. */
function takeDueBatches(now: number): Map<number, PendingBatch> {
  const due = new Map<number, PendingBatch>()
  for (const [n, batch] of transferPending) {
    const f = blockWriteFailures.get(n)
    if (!f || f.retryAt <= now) due.set(n, batch)
  }
  for (const [n, batch] of due) {
    transferPending.delete(n)
    transferPendingRows -= batch.rows.length
  }
  return due
}

/** One transaction for these batches. A quarantine batch is never deleted or inserted. */
async function writeBatches(batches: Map<number, PendingBatch>): Promise<void> {
  const deleteNums: number[] = []
  const rows: TokenTransferRow[] = []
  for (const [n, batch] of batches) {
    if (!batch.quarantine) deleteNums.push(n)
    for (const r of batch.rows) rows.push(r)
  }
  if (deleteNums.length === 0 && rows.length === 0) return
  // Sort by (block_number, log_index): keeps tt_block_idx writes sequential
  // and clusters same-block rows for better index-leaf locality.
  rows.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
  await writeTransferBlocks(deleteNums, rows)
}

function requeueBatch(n: number, batch: PendingBatch): void {
  // Don't clobber a newer decode of the same block.
  if (transferPending.has(n)) return
  transferPending.set(n, batch)
  transferPendingRows += batch.rows.length
}

/**
 * Write a drained set and return the heights that are now durable. The set goes in one
 * transaction; if that fails for a reason that is not infrastructure, each block is
 * written alone, in order, so one bad block no longer holds back every block after it.
 * Blocks already failing go alone from the start. Throws only for an infrastructure
 * failure, which the caller retries as a whole.
 */
async function writeDrained(drained: Map<number, PendingBatch>): Promise<number[]> {
  const healthy = new Map([...drained].filter(([n]) => !blockWriteFailures.has(n)))
  const alone = [...drained.keys()].filter(n => blockWriteFailures.has(n))
  const written: number[] = []
  if (healthy.size > 0) {
    try {
      await writeBatches(healthy)
      written.push(...healthy.keys())
    } catch (err) {
      const c = classifyWriteFailure(err)
      if (c.kind === 'infra') throw err
      console.warn(`[tt-writer] write of ${healthy.size} block(s) failed (${c.sqlstate}); writing each alone to find the one that fails`)
      alone.push(...healthy.keys())
    }
  }
  alone.sort((a, b) => a - b)
  let partitionsMade = false
  for (const n of alone) {
    const batch = drained.get(n)!
    try {
      await writeBatches(new Map([[n, batch]]))
      written.push(n)
      blockWriteFailures.delete(n)
    } catch (err) {
      const c = classifyWriteFailure(err)
      if (c.kind === 'infra') throw err
      requeueBatch(n, batch)
      const prev = blockWriteFailures.get(n)
      const attempts = (prev?.attempts ?? 0) + 1
      const rejections = (prev?.rejections ?? 0) + (c.kind === 'data' ? 1 : 0)
      blockWriteFailures.set(n, {
        rejections,
        attempts,
        retryAt: Date.now() + Math.min(TT_BLOCK_RETRY_BASE_MS * 2 ** (attempts - 1), TT_BLOCK_RETRY_MAX_MS),
        sqlstate: c.sqlstate,
      })
      const msg = dbErrorMessage(err).slice(0, 300)
      if (c.kind === 'missing-partition') {
        console.error(`[tt-writer] ALERT block ${n} has no token_transfers partition (${c.sqlstate}): making partitions and retrying`)
        if (!partitionsMade) {
          partitionsMade = true
          const covered = await ensureForwardPartitions({ anchor: n }).catch(e => {
            console.warn('[tt-writer] ensureForwardPartitions warning:', dbErrorMessage(e))
            return n
          })
          // Covered now: no reason to wait out the backoff.
          if (covered === null || covered > n) blockWriteFailures.get(n)!.retryAt = Date.now()
        }
      } else if (c.kind === 'data') {
        console.error(`[tt-writer] ALERT block ${n} rejected: ${c.sqlstate} (${rejections}/${TT_BLOCK_REJECT_AFTER}), W held at ${durableBlock}: ${msg}`)
        if (rejections >= TT_BLOCK_REJECT_AFTER) await rejectBlock(n, batch, c.sqlstate)
      } else {
        console.error(`[tt-writer] ALERT block ${n} write failed with unrecognised ${c.sqlstate}, retrying alone, W held at ${durableBlock}: ${msg}`)
      }
    }
  }
  return written
}

/**
 * A block whose own rows fail the same way every time: record it as a 1-block gap
 * (`tt_rejected(<sqlstate>)`, /api/health then reports degraded), and only once that
 * row has committed, replace its batch with a quarantine batch so the fold can carry W
 * past it. If the gap write fails, nothing is replaced and W stays: the block is
 * retried and rejected again later. A restart before the fold replays the block, which
 * fails again and finds its gap row already there.
 */
async function rejectBlock(n: number, batch: PendingBatch, sqlstate: string): Promise<void> {
  try {
    await recordIndexGapIfAbsent(getDb(), n, `tt_rejected(${sqlstate})`)
  } catch (err) {
    console.error(`[tt-writer] ALERT block ${n}: could not record its gap, so it is kept and W stays at ${durableBlock}: ${dbErrorMessage(err)}`)
    return
  }
  // Only the batch that failed: a newer decode of the block gets its own attempts.
  if (transferPending.get(n) !== batch) return
  transferPending.set(n, { rows: [], quarantine: true })
  transferPendingRows -= batch.rows.length
  blockWriteFailures.delete(n)
  console.error(`[tt-writer] ALERT block ${n} rejected ${TT_BLOCK_REJECT_AFTER} times (${sqlstate}): recorded as a 1-block index gap; its transfers are left out and W may pass it`)
}

/** Edge-triggered: W pinned below a failing block while the blocks above it keep committing. */
function evaluateWatermarkLag(): void {
  const lag = transferHighestQueued - durableBlock
  if (!watermarkLagAlerting && lag > TT_QUEUE_HIGH_WATER_BLOCKS) {
    watermarkLagAlerting = true
    const held = [...blockWriteFailures.entries()].sort((a, b) => a[0] - b[0])[0]
    console.error(`[tt-writer] ALERT W trails cursor by ${lag} blocks (W=${durableBlock}, newest queued ${transferHighestQueued}${held ? `, held at block ${held[0]} by ${held[1].sqlstate}` : ''})`)
  } else if (watermarkLagAlerting && lag <= TT_QUEUE_HIGH_WATER_BLOCKS) {
    watermarkLagAlerting = false
    console.log(`[tt-writer] W caught up: trails by ${lag} blocks`)
  }
}

/** Come back for the earliest block waiting out a backoff. */
function scheduleBlockRetry(): void {
  let next = Infinity
  for (const n of transferPending.keys()) {
    const f = blockWriteFailures.get(n)
    if (f) next = Math.min(next, f.retryAt)
  }
  if (blockRetryTimer) clearTimeout(blockRetryTimer)
  blockRetryTimer = null
  if (next === Infinity) return
  blockRetryTimer = setTimeout(() => { blockRetryTimer = null; runTransferWriter() }, Math.max(0, next - Date.now()))
  blockRetryTimer.unref?.()
}

function runTransferWriter(): void {
  if (!transferWriterSeeded) return        // never write/persist before the seed
  if (transferWriterPaused) return         // reorg rollback in progress — resumed by rollbackTransferWriterTo
  if (transferWriterRunning) return
  if (transferPending.size === 0 && !floorReady()) return
  transferWriterRunning = true
  // Fire-and-forget single drainer — coalesces the due queue per pass.
  ;(async () => {
    try {
      // Checking paused per iteration lets an in-flight drain finish its current
      // batch (commit or requeue) and then yield to a waiting reorg rollback.
      while (!transferWriterPaused) {
        // A block waiting out a backoff stays queued and is not taken. A ready floor
        // alone runs a pass with nothing to write, so W steps over the abandoned range
        // even when no block is queued.
        const drained = takeDueBatches(Date.now())
        if (drained.size === 0 && !floorReady()) break

        try {
          const written = await writeDrained(drained)

          // Fold written blocks into W through the contiguous prefix. Compute the new
          // watermark first and only advance durableBlock / clear transferWritten AFTER
          // persistDurableBlock() commits. The old order advanced in memory before the
          // persist, so a failed persist was never retried (the next cycle saw nothing to
          // move) AND the in-memory watermark ran ahead of the durable one — masking a
          // sustained indexer_cursor outage. Holding state until the persist lands makes
          // the failure recur every cycle, so it both retries and feeds the failure ALERT.
          // An abandoned range is stepped over only once the prefix has reached its
          // `after`, and the floors are dropped only after the persist lands. A block
          // that failed is not in `written`, so W stops below it.
          for (const n of written) if (n > durableBlock) transferWritten.add(n)
          let newDurable = durableBlock
          let floorsUsed = 0
          for (;;) {
            while (transferWritten.has(newDurable + 1)) newDurable++
            const floor = pendingFloors[floorsUsed]
            if (!floor || newDurable < floor.after) break
            newDurable = Math.max(newDurable, floor.to)
            floorsUsed++
          }
          if (newDurable > durableBlock) {
            await persistDurableBlock(newDurable)
            for (const n of transferWritten) if (n <= newDurable) transferWritten.delete(n)
            durableBlock = newDurable
          }
          pendingFloors.splice(0, floorsUsed)

          // Rows are durable now — let holder-balance tracking see them.
          // (no-op while SKIP_HOLDER_BALANCES is true, but keeps the path correct).
          const rows = written.flatMap(n => drained.get(n)!.rows)
          if (rows.length > 0) enqueueHolderBalanceUpdate(rows)

          // Only clear the failure streak after the FULL cycle succeeded (write AND
          // watermark persist). Resetting right after writeTransferBlocks would mask a
          // persistDurableBlock() failure: the catch re-increments from 0 each retry, so a
          // frozen-watermark loop (write OK, persist failing while new blocks arrive) would
          // never reach the ALERT threshold. Announce recovery if we'd previously alerted.
          if (ttWriterConsecutiveFailures >= TT_WRITER_FAILURE_ALERT_THRESHOLD) {
            console.log(`[tt-writer] writer recovered after ${ttWriterConsecutiveFailures} consecutive failure(s)`)
          }
          ttWriterConsecutiveFailures = 0
          evaluateWatermarkLag()

          if (++ttWriterDrainCount % 200 === 0) {
            console.log(`[tt-writer] W=${durableBlock} pending=${transferPending.size}blk/${transferPendingRows}rows ahead=${transferWritten.size}`)
          }
        } catch (err) {
          // Infrastructure, or the W persist: nothing here is about one block, so nothing
          // counts toward a rejection.
          ttWriterConsecutiveFailures++
          const msg = dbErrorMessage(err)
          // Re-queue (don't clobber a newer decode of the same block). The
          // quarantine flag travels inside the batch, so a requeued quarantine
          // stays a no-op and a requeued real batch stays a real write — no
          // separate bookkeeping to fall out of step across the retry.
          for (const [n, batch] of drained) requeueBatch(n, batch)
          // A requeue can push the pending count back over the bound without an enqueue —
          // re-evaluate so a breach during a failure storm still surfaces. No-op when the
          // flag is already set, so it won't flap against the per-retry failure alert below.
          evaluateTransferQueueHighWater()
          // token_transfers is primary data, so the writer retries forever rather than
          // dropping the queue. But a sustained failure streak means the durable watermark
          // is frozen and rows are piling up unwritten — escalate from the per-attempt warn
          // to a loud error at the threshold (and every Nth after) so monitoring fires.
          if (
            ttWriterConsecutiveFailures >= TT_WRITER_FAILURE_ALERT_THRESHOLD &&
            ttWriterConsecutiveFailures % TT_WRITER_FAILURE_ALERT_THRESHOLD === 0
          ) {
            console.error(`[tt-writer] ALERT write failing: ${ttWriterConsecutiveFailures} consecutive failure(s), queue not draining (W=${durableBlock}, ${transferPendingRows} rows pending): ${msg}`)
          } else {
            console.warn('[tt-writer] write failed, re-queueing:', msg)
          }
          await new Promise(r => setTimeout(r, 250))
        }
      }
      // Fire the recovery log if we'd alerted (the writer cleared it, not an enqueue).
      evaluateTransferQueueHighWater()
    } finally {
      transferWriterRunning = false
      scheduleBlockRetry()
    }
  })()
}

/**
 * Persist a set of blocks atomically: DELETE the target blocks, then INSERT the
 * decoded rows, in one transaction. DELETE makes replay idempotent without any
 * unique constraint; on the first-write path it matches zero rows and is cheap.
 * Targets EXACTLY the drained block numbers (never a min..max span) so a
 * non-contiguous drain can't wipe an already-written neighbour.
 */
async function writeTransferBlocks(blockNums: number[], rows: TokenTransferRow[]): Promise<void> {
  // Shared ingestion pool unless TT_WRITER_DEDICATED_POOL=1. When enabled, the
  // writer stops competing for slots with the 8 block workers whose output it is
  // draining — the direct test of the connection-starvation hypothesis, and its
  // fix if confirmed.
  const db = getWriterDb()
  // Phase is snapshotted BEFORE the await: attributing the pass by the state at
  // completion would label every pass "blocked", because a long drain is exactly
  // what parks the workers. The question is what the writer was competing with
  // when it STARTED.
  const phase = TT_WRITER_PROFILE ? phaseFor(parkedWorkers, activeWorkers, profWorkerCount) : 'none'
  const tStart = TT_WRITER_PROFILE ? performance.now() : 0
  let tEnter = 0
  try {
  await db.transaction(async (tx) => {
    // First statement inside the callback — the gap from tStart to here is
    // connection-acquisition time, which is what separates M1 from M2.
    if (TT_WRITER_PROFILE && tEnter === 0) tEnter = performance.now()
    for (let i = 0; i < blockNums.length; i += SQL_BATCH_CHUNK) {
      const chunk = blockNums.slice(i, i + SQL_BATCH_CHUNK)
      await tx.execute(sql`
        DELETE FROM token_transfers
        WHERE block_number IN (${sql.join(chunk.map(n => sql`${n}`), sql`, `)})
      `)
    }
    for (let i = 0; i < rows.length; i += SQL_BATCH_CHUNK) {
      const chunk = rows.slice(i, i + SQL_BATCH_CHUNK)
      await tx.insert(schema.tokenTransfers).values(chunk.map(r => ({
        txHash: r.txHash,
        logIndex: r.logIndex,
        tokenAddress: r.tokenAddress,
        fromAddress: r.fromAddress,
        toAddress: r.toAddress,
        value: r.value,
        tokenId: r.tokenId,
        blockNumber: r.blockNumber,
        timestamp: r.timestamp,
      })))
      // Gracefully skip the rare cross-block collision the DELETE can't cover:
      // during a deploy rollover the old (synchronous) instance briefly co-writes
      // the tip, so a (tx_hash, log_index) can already exist under another block.
      // Skipping matches the prior inline-insert behavior; on the future
      // partitioned table (no unique) this is a harmless no-op. DELETE-first
      // still provides the primary per-block idempotency.
      .onConflictDoNothing()
    }
  })
  } catch (err) {
    // A throw BEFORE the callback ran means acquisition itself failed — a pool
    // timeout (connect_timeout) is exactly that, and it is the single strongest
    // signal for M1. On the success path it can never be observed, so counting
    // it here is the difference between "no evidence of starvation" and "never
    // looked". Rethrow untouched: the writer's retry/alerting owns this error.
    if (TT_WRITER_PROFILE && tEnter === 0) ttProf.preCbFail++
    throw err
  }
  if (TT_WRITER_PROFILE) {
    const end = performance.now()
    // tEnter can still be 0 if the transaction resolved without ever invoking
    // the callback; attribute the whole span to acquisition rather than
    // reporting a negative sqlMs.
    const enter = tEnter === 0 ? end : tEnter
    recordDrainPass(rows.length, blockNums.length, enter - tStart, end - enter, phase)
  }
}

async function persistDurableBlock(block: number): Promise<void> {
  // MUST be the writer pool, not getDb(). Every successful drain awaits this
  // UPDATE before the writer can continue, so leaving it on the shared pool
  // would leave the writer queued behind the very block workers the dedicated
  // arm exists to escape — and a "no improvement" result would then fail to rule
  // out connection starvation, silently invalidating the whole A/B. (codex P2.)
  const db = getWriterDb()
  await db.execute(sql`UPDATE indexer_cursor SET transfers_durable_block = ${block} WHERE id = 1`)
}

/** Drain the queue to empty — used for graceful shutdown + backpressure. */
export async function flushTransferWriter(): Promise<void> {
  runTransferWriter()
  while (transferPending.size > 0 || transferWriterRunning) {
    await new Promise(r => setTimeout(r, 25))
  }
}

export { TT_QUEUE_HIGH_WATER_ROWS, TT_QUEUE_HIGH_WATER_BLOCKS }

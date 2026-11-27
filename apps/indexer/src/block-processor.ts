import { getChainConfig } from '@altscan/chain-config'
import { decodeV2Swap, resolveV2Pair, SWAP_V2_TOPIC, V2_FACTORIES, type V2Pair, type V2PairReader } from './dex-swap'
import { indexerConfig } from './config-instance'
import { JsonRpcProvider, AbiCoder, Contract, id as keccak256id, isError } from 'ethers'
import { sql } from 'drizzle-orm'
import { getDb, schema, dbErrorMessage, unwrapDbError, isDeadlock, SQL_BATCH_CHUNK } from './db'
import { ASYNC_TT_WRITER, enqueueTransferWrite, type TokenTransferRow } from './transfer-writer'
import { enqueueHolderBalanceUpdate } from './holder-balances'
import { enqueueAddressActivity } from './address-activity'
import { fetchBlockReceipts, type NormalizedLog, type NormalizedReceipt } from './receipts'
import { withTimeout } from './rpc-failover'
import { notifyWebhooks } from './webhook-notifier'
import { safeRpcError } from './provider'
import { fetchTokenMetadata, isTransportError, UNKNOWN_NAME, UNKNOWN_SYMBOL } from './token-metadata'
import { createFanoutStats } from './fanout-stats'
import { boundedRead, createLimiter, PAIR_RESOLVE_PER_BLOCK, POST_WRITE_CONCURRENCY, TOKEN_FETCH_PER_BLOCK, WARM_PAIR_BLOCKS, WARM_PAIR_MAX, warmPairs, withinBudget, type WarmPairRow } from './post-write-budget'
import { fetchBlockTraces, MAX_TRACE_ADDRESS_LEN, prepareInternalTxRows, type InternalTxRow, type RawTraceTx } from './internal-tx'

// ── Topic signatures ────────────────────────────────────────────────
const TRANSFER_TOPIC = keccak256id('Transfer(address,address,uint256)')
const TRANSFER_SINGLE_TOPIC = keccak256id('TransferSingle(address,address,address,uint256,uint256)')
// Every V2-shaped swap is recorded under the chain's best-known AMM: "PancakeSwap
// V2" on BNB, "Uniswap V2" on Ethereum. It was hard-coded to PancakeSwap, which
// would have labelled every Ethereum trade as a BNB Chain DEX.

const abi = AbiCoder.defaultAbiCoder()

// ── Per-phase profiling (opt-in) ─────────────────────────────────────
// Enable with PROFILE_BLOCKS=N (e.g. 30) — logs a phase breakdown every
// N blocks to find the dominant cost center. Zero overhead when disabled.
const PROFILE_BLOCKS = indexerConfig.indexing.profileBlocks

// Ceiling on pure RPC acquisition per block.
//
// Measured rpcBlockWait in production averages 275-428ms, so 8s is ~20x the mean
// and a comfortable ceiling for a dense block under load. Sized deliberately
// tight: bsc.publicnode.com rejects EVERY archive request, so with 4 endpoints
// roughly a quarter of attempts start there and pay this timeout before failing
// over. At 90s that cost the batch ~90s; at 8s it costs ~8s. A false timeout on
// a merely-slow endpoint is harmless — this bounds a PURE READ, so failover just
// re-fetches elsewhere.
const RPC_FETCH_TIMEOUT_MS = indexerConfig.rpc.fetchTimeoutMs
const PROFILE_ENABLED = PROFILE_BLOCKS > 0

type PhaseTimings = {
  rpcBlockWait: number
  rpcReceiptsWait: number
  dbInsertBlock: number
  dbInsertTxs: number
  dbUpsertAddresses: number
  dbUpdateTxStatus: number
  dbInsertTokenTransfers: number
  rpcEnsureTokens: number
  dbUpdateHolderBalances: number
  rpcPairTokens: number
  dbInsertDexTrades: number
  txCount: number
  transferCount: number
  dexCount: number
  totalMs: number
}

const PROFILE_PHASES = [
  'rpcBlockWait', 'rpcReceiptsWait', 'dbInsertBlock', 'dbInsertTxs',
  'dbUpsertAddresses', 'dbUpdateTxStatus', 'dbInsertTokenTransfers',
  'rpcEnsureTokens', 'dbUpdateHolderBalances', 'rpcPairTokens', 'dbInsertDexTrades',
] as const

type PhaseKey = typeof PROFILE_PHASES[number]

type PhaseStat = { total: number; count: number; rows: number }

let profileAgg: Record<string, PhaseStat> = {}
let profileBlocksSinceReport = 0
let profileWindowStart = Date.now()

function resetProfile() {
  profileAgg = { __total: { total: 0, count: 0, rows: 0 } }
  for (const p of PROFILE_PHASES) profileAgg[p] = { total: 0, count: 0, rows: 0 }
  profileBlocksSinceReport = 0
  profileWindowStart = Date.now()
}
if (PROFILE_ENABLED) {
  resetProfile()
  console.log(`[profile] Per-phase timing enabled — reports every ${PROFILE_BLOCKS} blocks`)
}

function newTimings(): PhaseTimings {
  return {
    rpcBlockWait: 0, rpcReceiptsWait: 0, dbInsertBlock: 0, dbInsertTxs: 0,
    dbUpsertAddresses: 0, dbUpdateTxStatus: 0, dbInsertTokenTransfers: 0,
    rpcEnsureTokens: 0, dbUpdateHolderBalances: 0, rpcPairTokens: 0, dbInsertDexTrades: 0,
    txCount: 0, transferCount: 0, dexCount: 0, totalMs: 0,
  }
}

function recordTimings(t: PhaseTimings) {
  profileAgg.__total.total += t.totalMs
  profileAgg.__total.count += 1
  profileAgg.__total.rows += t.txCount

  for (const p of PROFILE_PHASES) {
    const ms = t[p]
    if (ms > 0) {
      profileAgg[p].total += ms
      profileAgg[p].count += 1
    }
  }
  profileAgg.dbInsertTxs.rows += t.txCount
  profileAgg.dbInsertTokenTransfers.rows += t.transferCount
  profileAgg.dbUpdateHolderBalances.rows += t.transferCount
  profileAgg.dbInsertDexTrades.rows += t.dexCount

  profileBlocksSinceReport += 1
  if (profileBlocksSinceReport >= PROFILE_BLOCKS) {
    reportProfile()
    resetProfile()
  }
}

function reportProfile() {
  const windowMs = Date.now() - profileWindowStart
  const blocks = profileAgg.__total.count
  if (blocks === 0) return
  const totalBlockMs = profileAgg.__total.total
  const wallSec = windowMs / 1000
  const blkPerSec = (blocks / wallSec).toFixed(2)
  const avgBlockMs = (totalBlockMs / blocks).toFixed(1)

  const ranked = PROFILE_PHASES
    .map(p => ({ phase: p as PhaseKey, ...profileAgg[p] }))
    .sort((a, b) => b.total - a.total)

  console.log(`[profile] === ${blocks} blocks in ${wallSec.toFixed(1)}s wall — ${blkPerSec} blk/s aggregate, avg ${avgBlockMs}ms in-block (sum of phases ≠ wall clock due to parallelism across ${blocks > 0 ? 'workers' : '?'}) ===`)
  for (const r of ranked) {
    const pct = totalBlockMs > 0 ? (r.total / totalBlockMs * 100).toFixed(1) : '0.0'
    const avg = r.count > 0 ? (r.total / r.count).toFixed(1) : '-'
    const rowsPerBlk = r.count > 0 && r.rows > 0 ? `, ${(r.rows / r.count).toFixed(1)} rows/blk` : ''
    console.log(`[profile]   ${r.phase.padEnd(26)} ${r.total.toFixed(0).padStart(7)}ms  ${pct.padStart(5)}%  avg ${avg}ms/blk (n=${r.count}${rowsPerBlk})`)
  }
}

// ── Types ───────────────────────────────────────────────────────────
type DexTradeRow = {
  txHash: string
  /**
   * Position of the Swap log within the block. Together with blockNumber this is the
   * event's natural key — the thing that makes a dex_trade re-insertable.
   *
   * Without it the table had only `id serial PRIMARY KEY`, so every row was
   * unique by construction and onConflictDoNothing() could never match: replaying
   * a block silently doubled its trades. That is why rpc-failover.ts refuses to
   * fail over past the first write, and why the gap healer restricts itself to
   * ABSENT blocks.
   */
  logIndex: number
  dex: string
  pairAddress: string
  tokenIn: string
  tokenOut: string
  amountIn: string
  amountOut: string
  maker: string
  blockNumber: number
  timestamp: Date
}

// ── Caches ──────────────────────────────────────────────────────────
const tokenCache = new Set<string>()
const TOKEN_CACHE_MAX = 50_000

// null: not a listed factory's pair (dex-swap.ts V2_FACTORIES), remembered so it is not re-read every block.
const pairCache = new Map<string, V2Pair | null>()
// Measures the post-write fan-out per block, to size its budgets (lib: fanout-stats.ts). Counts only.
const fanoutStats = createFanoutStats()
const PAIR_CACHE_MAX = 10_000
// Post-write metadata reads in flight, across every block (post-write-budget.ts).
const tokenReads = createLimiter(POST_WRITE_CONCURRENCY)
const pairReads = createLimiter(POST_WRITE_CONCURRENCY)
const readTimeoutMs = () => indexerConfig.rpc.readTimeoutMs

// ── Main entry ──────────────────────────────────────────────────────
/**
 * `onWritesBegan` is invoked exactly once, immediately before the first durable
 * write. Everything above that call is pure RPC acquisition and is safe to retry
 * on another endpoint; everything below it persists incrementally, so another endpoint is not tried once writes
 * began (a replay of the block repairs its missing rows instead: dex_trades dedupes on block_number, log_index). RPC
 * failover uses this boundary — see rpc-failover.ts. Optional: callers that
 * never retry (backfill.ts) can ignore it.
 */
/**
 * Is this log index usable as part of a natural key?
 *
 * `NormalizedLog.index` is `parseInt(logIndex, 16)`, which yields NaN on a
 * malformed or missing value. NaN cannot participate in a unique constraint
 * (every NaN compares unequal), so admitting one silently restores the
 * duplicate-on-replay bug for exactly the rows an odd endpoint returns.
 */
export function isUsableLogIndex(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0
}

/**
 * Refuse a block whose receipt set does not cover all of its transactions.
 *
 * Every token_transfer and dex_trade is derived from receipts, and the transfer
 * writer persists a block by DELETEing its rows and re-inserting whatever it was
 * handed (writeTransferBlocks). So an under-covered receipt set does not merely
 * under-report — on REPLAY it destroys rows that were previously correct, and
 * the block still ends up carrying a full tx_count, which is precisely the shape
 * every completeness check (including the gap healer's own verification) treats
 * as healthy. That combination is what turns a visible gap into invisible bad
 * data reporting `ok`.
 *
 * `eth_getBlockReceipts` is all-or-nothing — one receipt per transaction — so
 * any other count means the endpoint returned a partial answer. Throwing hands
 * the block back to rpc-failover for a retry elsewhere.
 *
 * Exported and pure so the invariant can be asserted directly; the shipped call
 * site passes the same four values.
 */
export function assertReceiptCoverage(
  blockNumber: number,
  txHashes: readonly string[],
  receiptHashes: readonly string[],
  wantReceipts: boolean,
): void {
  // skipLogs deliberately fetches no receipts — an empty set is correct there,
  // and processBlock already refuses to enqueue transfers in that mode.
  if (!wantReceipts) return

  // Matching COUNTS are not coverage. A response can return one receipt twice
  // and omit another and still be the right length; receiptByTx would then
  // overwrite the duplicate and silently supply default-success data for the
  // transaction that never arrived. So compare the SETS, not the sizes.
  const want = new Set(txHashes.map(h => h.toLowerCase()))
  const got = new Set<string>()
  for (const h of receiptHashes) {
    const k = h.toLowerCase()
    // A repeated hash means the response is malformed, or is a splice of two
    // different versions of this block observed across a reorg.
    if (got.has(k)) {
      throw new Error(`Block ${blockNumber} receipt set invalid: duplicate receipt for ${k}`)
    }
    got.add(k)
  }

  // Checked in BOTH directions and without an early return for the empty block:
  // receipts arriving for a block with no transactions means the endpoint
  // answered about a DIFFERENT block, and attributing its derived rows here
  // would be worse than missing them.
  if (want.size !== got.size) {
    throw new Error(
      `Block ${blockNumber} receipt coverage incomplete: ${got.size} receipt(s) for ` +
      `${want.size} transaction(s)`,
    )
  }
  for (const h of want) {
    if (!got.has(h)) {
      throw new Error(`Block ${blockNumber} receipt coverage incomplete: no receipt for ${h}`)
    }
  }
}

// Internal-transaction failures are reported, never thrown: the trace endpoint is
// a second provider that is not in the failover pool, so a throw would retry the
// same dead endpoint from every block provider and stall indexing for a secondary
// table. First failure reports immediately; then at most once a minute with the
// count accumulated since, so a sick endpoint cannot bury the progress line.
let itxProblemsSinceReport = 0
let itxLastReportAt = 0
function reportInternalTxProblem(phase: 'trace' | 'insert', blockNumber: number, err: unknown): void {
  itxProblemsSinceReport++
  const now = Date.now()
  if (itxLastReportAt !== 0 && now - itxLastReportAt < 60_000) return
  console.warn(`[internal-tx] ${phase} failed at block ${blockNumber} (${itxProblemsSinceReport} since last report): ${safeRpcError(err)}`)
  itxProblemsSinceReport = 0
  itxLastReportAt = now
}

/**
 * A trace gets its own deadline, inside the block's acquisition timeout. It used to
 * share that timeout, and because the trace endpoint is not in the failover pool, one
 * that stopped answering failed every block on every block endpoint until the poison
 * tracker quarantined them. 60% leaves the block and receipt fetches the rest.
 */
export const TRACE_DEADLINE_MS = Math.floor(RPC_FETCH_TIMEOUT_MS * 0.6)

/**
 * Nothing cancels an abandoned trace call. withTimeout only stops waiting, and on Node
 * ethers' own timeout neither destroys the socket nor aborts it, which is also why it
 * is not used here: it would let a timed-out socket escape this count. So the count
 * covers the whole call, including ethers' internal retries, until it settles.
 * Two per worker allows the normal call plus one abandoned one.
 */
export const TRACE_MAX_IN_FLIGHT = 2 * indexerConfig.indexing.concurrency
let traceCallsInFlight = 0
export function tracesInFlight(): number { return traceCallsInFlight }

/**
 * Trace a block within the deadline and the in-flight cap. Never throws: null means
 * the block is stored without internal transactions, and the reason is reported.
 */
export async function traceWithinBudget(
  provider: JsonRpcProvider,
  blockNumber: number,
  { deadlineMs = TRACE_DEADLINE_MS, maxInFlight = TRACE_MAX_IN_FLIGHT } = {},
): Promise<RawTraceTx[] | null> {
  if (traceCallsInFlight >= maxInFlight) {
    reportInternalTxProblem('trace', blockNumber, new Error(`not started: ${traceCallsInFlight} trace calls still in flight (cap ${maxInFlight})`))
    return null
  }
  traceCallsInFlight++
  const call = fetchBlockTraces(provider, blockNumber).finally(() => { traceCallsInFlight-- })
  try {
    return await withTimeout(call, deadlineMs, `block ${blockNumber} trace`)
  } catch (err) {
    reportInternalTxProblem('trace', blockNumber, err)
    return null
  }
}

/** Decode a block's traces and report what the decoder refused. Null: nothing usable. */
function decodeTraces(raw: readonly RawTraceTx[], blockNumber: number, timestamp: Date, txHashes: readonly string[]): InternalTxRow[] | null {
  const prepared = prepareInternalTxRows(raw, blockNumber, timestamp, txHashes)
  if (prepared.problem) {
    reportInternalTxProblem('trace', blockNumber, prepared.problem)
    return null
  }
  if (prepared.dropped > 0) {
    reportInternalTxProblem('trace', blockNumber, new Error(`${prepared.dropped} trace entr(ies) do not belong to the block, dropped`))
  }
  if (prepared.overlong > 0) {
    reportInternalTxProblem('trace', blockNumber, new Error(`${prepared.overlong} frame(s) nested too deep to store (trace address over ${MAX_TRACE_ADDRESS_LEN} characters), skipped`))
  }
  return prepared.rows
}

/** Natural key + ON CONFLICT DO NOTHING, so a replay or a re-trace never duplicates. Never throws. */
async function insertInternalTxRows(db: ReturnType<typeof getDb>, rows: InternalTxRow[], blockNumber: number): Promise<boolean> {
  for (let i = 0; i < rows.length; i += SQL_BATCH_CHUNK) {
    try {
      await db.insert(schema.internalTransactions).values(rows.slice(i, i + SQL_BATCH_CHUNK)).onConflictDoNothing()
    } catch (err) {
      reportInternalTxProblem('insert', blockNumber, err)
      return false
    }
  }
  return true
}

/**
 * A block stored without internal transactions because its trace failed gets a few
 * more tries, a few blocks later: a trace node a block or two behind the tip says
 * "not found" for the newest block and has it moments later. The main loop drives it
 * (retraceMissedBlocks) and never waits on it, so indexing stays decoupled from the
 * trace service.
 *
 * Bounded three ways: at most RETRACE_BACKLOG_MAX blocks (the oldest goes first), at
 * most RETRACE_MAX_ATTEMPTS re-traces each (RETRACE_AFTER_BLOCKS, then doubling), and
 * only while the block is within INTERNAL_TX_MAX_LAG of the tip, the same window the
 * first trace uses.
 *
 * In memory only: a restart drops it, and those blocks keep no internal transactions.
 * The shutdown line counts them.
 */
export const RETRACE_AFTER_BLOCKS = 4
export const RETRACE_MAX_ATTEMPTS = 4
export const RETRACE_BACKLOG_MAX = 256
/** Re-traces start only while this many trace calls or fewer are open: the spare half of the cap. */
export const RETRACE_MAX_IN_FLIGHT = indexerConfig.indexing.concurrency

type TraceMiss = { timestamp: Date; txHashes: string[]; attempts: number; dueAt: number; tracing: boolean }
const traceMisses = new Map<number, TraceMiss>()
const retraces = new Set<Promise<void>>()
let retracesRecovered = 0
let retracesDropped = 0

function dropTraceMiss(blockNumber: number, why: string): void {
  // Already gone means a reorg unwind forgot it mid-retrace: nothing to count.
  if (!traceMisses.delete(blockNumber)) return
  retracesDropped++
  reportInternalTxProblem('trace', blockNumber, new Error(`re-trace abandoned (${why}); the block keeps no internal transactions`))
}

function noteTraceMiss(blockNumber: number, timestamp: Date, txHashes: string[]): void {
  if (!traceMisses.has(blockNumber) && traceMisses.size >= RETRACE_BACKLOG_MAX) {
    // Map order is insertion order, so the first key is the block that missed first.
    dropTraceMiss(traceMisses.keys().next().value as number, `backlog full at ${RETRACE_BACKLOG_MAX}`)
  }
  traceMisses.set(blockNumber, { timestamp, txHashes, attempts: 0, dueAt: blockNumber + RETRACE_AFTER_BLOCKS, tracing: false })
}

async function retrace(provider: JsonRpcProvider, blockNumber: number, miss: TraceMiss): Promise<void> {
  const raw = await traceWithinBudget(provider, blockNumber, { maxInFlight: RETRACE_MAX_IN_FLIGHT })
  // A reorg unwind forgot this block while the trace was open: its rows are not wanted.
  if (traceMisses.get(blockNumber) !== miss) return
  if (raw) {
    const rows = decodeTraces(raw, blockNumber, miss.timestamp, miss.txHashes)
    if (rows === null) return dropTraceMiss(blockNumber, 'traces did not decode')
    if (await insertInternalTxRows(getDb(), rows, blockNumber)) {
      traceMisses.delete(blockNumber)
      retracesRecovered++
      return
    }
  }
  miss.attempts++
  if (miss.attempts >= RETRACE_MAX_ATTEMPTS) return dropTraceMiss(blockNumber, `${miss.attempts} re-traces failed`)
  miss.dueAt = blockNumber + (RETRACE_AFTER_BLOCKS << miss.attempts)
}

/**
 * Called once per main-loop batch with the tip just read. Starts the due re-traces in
 * the background and returns at once; never throws.
 */
export function retraceMissedBlocks(provider: JsonRpcProvider, latest: number, maxLag: number): void {
  for (const [blockNumber, miss] of traceMisses) {
    if (miss.tracing) continue
    if (latest - blockNumber > maxLag) { dropTraceMiss(blockNumber, `more than ${maxLag} blocks behind the tip`); continue }
    if (latest < miss.dueAt || tracesInFlight() >= RETRACE_MAX_IN_FLIGHT) continue
    // Held until the whole retrace ends, insert included: a slow insert must not let
    // the next batch start the same block again, outside the cap and the attempt count.
    miss.tracing = true
    const task = retrace(provider, blockNumber, miss).finally(() => { miss.tracing = false; retraces.delete(task) })
    retraces.add(task)
  }
}

/**
 * Before a reorg unwind: wait for open re-traces, so none inserts rows after the
 * unwind's delete, and forget the blocks the unwind removes. The re-index traces
 * them again.
 */
export async function forgetTraceMissesFrom(fromBlock: number): Promise<void> {
  for (const blockNumber of [...traceMisses.keys()]) if (blockNumber >= fromBlock) traceMisses.delete(blockNumber)
  await Promise.all([...retraces])
}

export function retraceBacklogStats(): { pending: number; recovered: number; dropped: number } {
  return { pending: traceMisses.size, recovered: retracesRecovered, dropped: retracesDropped }
}

export async function processBlock(
  blockNumber: number,
  provider: JsonRpcProvider,
  skipLogs = false,
  onWritesBegan?: () => void,
  /** When given, the block is traced on THIS provider and its internal transactions stored. */
  traceProvider: JsonRpcProvider | null = null,
) {
  const t: PhaseTimings | null = PROFILE_ENABLED ? newTimings() : null
  const blockStart = PROFILE_ENABLED ? performance.now() : 0
  const db = getDb()

  // Fire both RPC calls in parallel and await both up-front so we can merge
  // receipt data (status, gasUsed) directly into the tx INSERT — avoids a
  // second UPDATE round-trip that previously ran against freshly-inserted
  // rows and caused row-lock contention across 8 concurrent block workers.
  const wantReceipts = !skipLogs
  const rpcStart = PROFILE_ENABLED ? performance.now() : 0
  const blockPromise = provider.getBlock(blockNumber, true)
  const receiptsPromise = wantReceipts
    ? fetchBlockReceipts(provider, blockNumber)
    : Promise.resolve([] as Array<{ txHash: string; receipt: NormalizedReceipt }>)

  // Bound the acquisition. An archive-refusing or throttled endpoint does NOT
  // fail fast — bsc.publicnode.com took ~85-90s to reject an archive request,
  // and since a failed attempt never reaches recordTimings, that wait was
  // invisible to the profiler while stalling the batch. 7 such failures lined up
  // 1:1 with 7 >60s stall windows.
  //
  // Placed HERE, strictly above the first write (onWritesBegan below), so a
  // timeout can only ever abandon pure reads — rpc-failover then retries the
  // block on another endpoint with no risk of a half-written replay.
  // Traces ride in the same pure-read phase, in parallel (measured 0.6-0.8s median
  // per block on both chains), under their own shorter deadline and an in-flight
  // cap. Soft: a failure, a timeout or a full cap yields null and is reported, so
  // the block still lands. See traceWithinBudget.
  const tracesPromise: Promise<RawTraceTx[] | null> = traceProvider
    ? traceWithinBudget(traceProvider, blockNumber)
    : Promise.resolve(null)
  const [block, receipts, rawTraces] = await withTimeout(
    Promise.all([blockPromise, receiptsPromise, tracesPromise]),
    RPC_FETCH_TIMEOUT_MS,
    `block ${blockNumber} acquisition`,
  )
  if (t) {
    t.rpcBlockWait = performance.now() - rpcStart
    t.rpcReceiptsWait = 0
  }
  if (!block) throw new Error(`Block ${blockNumber} not found`)
  if (!block.hash) throw new Error(`Block ${blockNumber} has no hash (pending block?)`)
  // An endpoint that answers a DIFFERENT height must not be believed: the async
  // transfer writer DELETEs the rows of the block number it is handed and then
  // inserts what it decoded, so a block N+1 response processed as N would wipe
  // N+1's transfers and label them N. Strictly above the first write, so
  // rpc-failover retries the block on another endpoint.
  if (block.number !== blockNumber) {
    throw new Error(`Block ${blockNumber} response is for height ${block.number}`)
  }

  // Refuse a partially-covered block BEFORE the first write, so rpc-failover can
  // retry it on another endpoint with nothing half-written. See the function.
  assertReceiptCoverage(
    blockNumber,
    block.prefetchedTransactions.map(tx => tx.hash),
    receipts.map(r => r.txHash),
    wantReceipts,
  )

  const timestamp = new Date(Number(block.timestamp) * 1000)

  // Decode the traces HERE, above the first write: the decoder walks untrusted
  // JSON and used to run after the block insert with nothing around it, so one
  // malformed frame threw with the block half-persisted (pinning the cursor and
  // blocking quarantine). It is also where traces for transactions that are not
  // in this block are dropped. Never throws — see prepareInternalTxRows.
  const itxRows = rawTraces
    ? decodeTraces(rawTraces, blockNumber, timestamp, block.prefetchedTransactions.map(tx => tx.hash)) ?? []
    : []

  // Map tx hash → receipt so we can populate tx.status / tx.gasUsed at INSERT
  // time instead of via a follow-up UPDATE pass.
  // Keyed lowercase on both sides — see fetchBlockReceipts. Defensive even though
  // the fetch normalizes, because this map is what silently substitutes default
  // receipt data on a miss.
  const receiptByTx = new Map<string, NormalizedReceipt>()
  for (const r of receipts) receiptByTx.set(r.txHash.toLowerCase(), r.receipt)

  // ── 1. Insert block ────────────────────────────────────────────
  // Point of no return: past here the block is partially persisted, so this
  // attempt can no longer be replayed on a different endpoint.
  onWritesBegan?.()
  const s1 = PROFILE_ENABLED ? performance.now() : 0
  await db.insert(schema.blocks).values({
    number: block.number,
    hash: block.hash,
    parentHash: block.parentHash,
    timestamp,
    miner: block.miner.toLowerCase(),
    gasUsed: block.gasUsed,
    gasLimit: block.gasLimit,
    baseFeePerGas: block.baseFeePerGas?.toString() ?? null,
    txCount: block.transactions.length,
    size: 0,
  }).onConflictDoNothing()
  if (t) t.dbInsertBlock = performance.now() - s1

  // ── 2. Bulk insert transactions (with receipt data baked in) ───
  const txValues = block.prefetchedTransactions.map((tx, idx) => {
    const rec = receiptByTx.get(tx.hash.toLowerCase())
    return {
      hash: tx.hash,
      blockNumber: block.number,
      fromAddress: tx.from.toLowerCase(),
      toAddress: tx.to?.toLowerCase() ?? null,
      value: tx.value.toString(),
      gas: tx.gasLimit,
      gasPrice: rec?.effectiveGasPrice?.toString() ?? tx.gasPrice?.toString() ?? '0',
      gasUsed: rec?.gasUsed ?? 0n,
      input: tx.data.length > 500 ? tx.data.slice(0, 500) : tx.data,
      // `rec` is absent only under skipLogs (no receipts fetched); a fetched receipt
      // always carries a proven status — see parseReceiptStatus.
      status: rec?.status ?? true,
      methodId: tx.data.length >= 10 ? tx.data.slice(0, 10) : null,
      txIndex: idx,
      nonce: tx.nonce,
      txType: tx.type ?? 0,
      timestamp,
    }
  })
  if (t) t.txCount = txValues.length

  let insertedAddrs: Array<{ fromAddress: string; toAddress: string | null }> = []
  if (txValues.length > 0) {
    const s2 = PROFILE_ENABLED ? performance.now() : 0
    insertedAddrs = await db.insert(schema.transactions)
      .values(txValues)
      .onConflictDoNothing()
      .returning({
        fromAddress: schema.transactions.fromAddress,
        toAddress: schema.transactions.toAddress,
      })
    if (t) t.dbInsertTxs = performance.now() - s2

    if (insertedAddrs.length > 0) {
      // Fire-and-forget coalesced flush — see enqueueAddressActivity below.
      // Keeps hot-path block time bounded; the `addresses` table is metadata
      // (tx_count / last_seen), eventual consistency across a few seconds is fine.
      enqueueAddressActivity(insertedAddrs, timestamp)
    }
  }

  // ── 2b. Internal transactions (traces already awaited and decoded above) ───
  // Natural key (block_number, tx_hash, trace_address) + onConflictDoNothing:
  // a replay is a no-op, never a duplicate. Degrades rather than throws — writes
  // have begun, and a throw here would hand a partially persisted block to the
  // poison path over a secondary table.
  await insertInternalTxRows(db, itxRows, blockNumber)
  // A failed trace (not an empty one) gets a few more tries in the background.
  if (traceProvider && rawTraces === null) {
    noteTraceMiss(blockNumber, timestamp, block.prefetchedTransactions.map(tx => tx.hash))
  }

  // ── 3. Decode receipts (already awaited above) ─────────────────
  let decodedTransfers: TokenTransferRow[] = []
  if (wantReceipts && block.prefetchedTransactions.length > 0 && receipts.length > 0) {
    decodedTransfers = await processReceiptsBatch(receipts, blockNumber, timestamp, provider, t)
  }

  // ── 3b. Async transfer-writer enqueue ──────────────────────────
  // Hand decoded transfers to the single coalescing writer. Enqueue EVERY block —
  // including transfer-less ones (empty array) — so the durable watermark can
  // advance past it. The writer persists these rows and only then advances
  // indexer_cursor.transfers_durable_block, the crash-safe resume point.
  //
  // EXCEPT when skipLogs: receipts weren't decoded, so decodedTransfers is empty
  // by-omission, not empty-by-fact. The writer would DELETE the block's existing
  // token_transfers (writeTransferBlocks always DELETEs the drained blocks) and
  // re-insert nothing — silent data loss for `--skip-logs` backfills such as the
  // documented `backfill.js 1 N --skip-logs`. The live indexer never sets skipLogs,
  // so its watermark-advance behavior (transfer-less blocks still enqueue []) is
  // unchanged.
  if (ASYNC_TT_WRITER && !skipLogs) {
    enqueueTransferWrite(block.number, decodedTransfers)
  }

  // ── 4. Webhooks (non-blocking) ─────────────────────────────────
  if (!skipLogs && txValues.length > 0) {
    notifyWebhooks(
      txValues.map(tx => ({ hash: tx.hash, fromAddress: tx.fromAddress, toAddress: tx.toAddress ?? null, value: tx.value })),
      block.number,
      timestamp,
      block.hash,
    ).catch(err => console.error('[webhook-notifier] delivery error:', unwrapDbError(err)))
  }

  if (t) {
    t.totalMs = performance.now() - blockStart
    recordTimings(t)
  }
}

// ── Receipt batch processing ────────────────────────────────────────
/**
 * Decode receipt logs for a block into token_transfers and dex_trades.
 * Tx status / gasUsed are populated at INSERT time in processBlock, so this
 * function no longer runs a separate UPDATE pass.
 */
async function processReceiptsBatch(
  receipts: Array<{ txHash: string; receipt: NormalizedReceipt }>,
  blockNumber: number,
  timestamp: Date,
  provider: JsonRpcProvider,
  t: PhaseTimings | null = null,
): Promise<TokenTransferRow[]> {
  const db = getDb()

  // Decoded transfer rows for this block. In async mode these are returned to the
  // caller to enqueue on the writer instead of being INSERTed inline here.
  let decodedTransfers: TokenTransferRow[] = []
  const fanout = { tokens: 0, pairs: 0, pairDrops: 0 }

  // Note: tx.status / tx.gasUsed are now populated at INSERT time in processBlock
  // (receipts awaited up-front and merged into txValues). No second UPDATE pass.
  if (t) t.dbUpdateTxStatus = 0

  // ── B. Pre-filter logs by topic ─────────────────────────────────
  const transferLogs: Array<{ txHash: string; log: NormalizedLog }> = []
  const dexSwapLogs: Array<{ txHash: string; log: NormalizedLog }> = []

  for (const { txHash, receipt } of receipts) {
    for (const log of receipt.logs) {
      const topic0 = log.topics[0]
      if (topic0 === TRANSFER_TOPIC || topic0 === TRANSFER_SINGLE_TOPIC) {
        transferLogs.push({ txHash, log })
      } else if (topic0 === SWAP_V2_TOPIC) {
        dexSwapLogs.push({ txHash, log })
      }
    }
  }

  // ── C. Decode & bulk-insert token transfers ─────────────────────
  if (transferLogs.length > 0) {
    const rows: TokenTransferRow[] = []
    const tokensToEnsure = new Map<string, 'BEP20' | 'BEP721' | 'BEP1155'>()

    for (const { txHash, log } of transferLogs) {
      try {
        const topic0 = log.topics[0]
        let from: string, to: string, value: bigint, tokenId: bigint | null = null
        let tokenType: 'BEP20' | 'BEP721' | 'BEP1155'

        if (topic0 === TRANSFER_TOPIC && log.topics.length === 3) {
          tokenType = 'BEP20'
          from = '0x' + log.topics[1].slice(26)
          to = '0x' + log.topics[2].slice(26)
          value = abi.decode(['uint256'], log.data)[0] as bigint
        } else if (topic0 === TRANSFER_TOPIC && log.topics.length === 4) {
          tokenType = 'BEP721'
          from = '0x' + log.topics[1].slice(26)
          to = '0x' + log.topics[2].slice(26)
          tokenId = BigInt(log.topics[3])
          value = 1n
        } else if (topic0 === TRANSFER_SINGLE_TOPIC) {
          tokenType = 'BEP1155'
          from = '0x' + log.topics[2].slice(26)
          to = '0x' + log.topics[3].slice(26)
          const decoded = abi.decode(['uint256', 'uint256'], log.data)
          tokenId = decoded[0] as bigint
          value = decoded[1] as bigint
        } else {
          continue
        }

        const tokenAddress = log.address.toLowerCase()
        rows.push({
          txHash,
          logIndex: log.index,
          tokenAddress,
          fromAddress: from.toLowerCase(),
          toAddress: to.toLowerCase(),
          value: value.toString(),
          tokenId: tokenId?.toString() ?? null,
          blockNumber,
          timestamp,
          tokenType,
        })

        if (!tokenCache.has(tokenAddress) && !tokensToEnsure.has(tokenAddress)) {
          tokensToEnsure.set(tokenAddress, tokenType)
        }
      } catch {
        // Skip malformed logs
      }
    }

    if (t) t.transferCount = rows.length

    // Ensure unknown tokens exist (batched RPC lookups)
    if (tokensToEnsure.size > 0) {
      const sT = PROFILE_ENABLED ? performance.now() : 0
      fanout.tokens = await ensureTokensBatch(tokensToEnsure, provider)
      if (t) t.rpcEnsureTokens = performance.now() - sT
    }

    // Token transfer persistence. In async mode the rows are returned to the
    // caller and written by the single coalescing writer (removing the 8-worker
    // index contention that made this ~50% of BNB block time). In sync mode
    // (ETH / ASYNC_TT_WRITER=0) they are INSERTed inline exactly as before.
    if (rows.length > 0) {
      if (ASYNC_TT_WRITER) {
        decodedTransfers = rows
        // dbInsertTokenTransfers intentionally stays ~0 here — the write happens
        // off the hot path in the writer; t.transferCount above still records volume.
      } else {
        // Bulk insert token transfers — chunked to avoid stack overflow in Drizzle
        const sI = PROFILE_ENABLED ? performance.now() : 0
        let totalInserted = 0
        for (let i = 0; i < rows.length; i += SQL_BATCH_CHUNK) {
          const chunk = rows.slice(i, i + SQL_BATCH_CHUNK)
          const inserted = await db.insert(schema.tokenTransfers)
            .values(chunk.map(r => ({
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
            .onConflictDoNothing()
            // Count inserted rows only (gates the holder-balance enqueue below). We
            // return block_number (NOT NULL) purely so `.length` is correct — there is
            // no `id` column anymore (dropped 2026-06-20 after int4 seq overflow).
            .returning({ b: schema.tokenTransfers.blockNumber })
          totalInserted += inserted.length
        }
        if (t) t.dbInsertTokenTransfers = performance.now() - sI

        // Holder balance updates are queued for a single dedicated worker.
        // Profiling showed inline UPSERTs took ~38% of in-block time (~2.5s/block)
        // due to row-lock contention across 8 workers hammering the same hot tokens.
        // Serializing through one worker eliminates cross-worker contention and
        // unblocks block processing. Eventually consistent — queue drains during
        // low-activity windows. Order doesn't matter (addition is commutative).
        if (totalInserted > 0) {
          const sH = PROFILE_ENABLED ? performance.now() : 0
          enqueueHolderBalanceUpdate(rows)
          if (t) t.dbUpdateHolderBalances = performance.now() - sH
        }
      }
    }
  }

  // ── D. Decode & bulk-insert DEX trades ──────────────────────────
  if (dexSwapLogs.length > 0) {
    const dexRows: DexTradeRow[] = []

    // Collect unknown pairs and fetch their tokens in parallel
    const unknownPairs = new Set<string>()
    for (const { log } of dexSwapLogs) {
      const pairAddress = log.address.toLowerCase()
      if (!pairCache.has(pairAddress)) unknownPairs.add(pairAddress)
    }
    fanout.pairs = unknownPairs.size
    if (unknownPairs.size > 0) {
      const sP = PROFILE_ENABLED ? performance.now() : 0
      // Past the budget a pair is not read, and its swaps are dropped below and counted (fanout-stats.ts): a stated loss.
      const { now: resolveNow, over } = withinBudget(Array.from(unknownPairs), PAIR_RESOLVE_PER_BLOCK)
      if (over.length > 0) console.warn(`[dex] pair budget exceeded in block ${blockNumber}: ${over.length} of ${unknownPairs.size} unknown pairs not read`)
      // A read that times out is a failed read: nothing is cached, and the pair is read again when it next swaps.
      await Promise.all(resolveNow.map(pair =>
        boundedRead(pairReads, () => fetchPairTokens(pair, provider), readTimeoutMs(), `pair ${pair}`).catch(() => {})))
      if (t) t.rpcPairTokens = performance.now() - sP
    }

    for (const { txHash, log } of dexSwapLogs) {
      try {
        // log_index is the natural key now, so an unusable one is not cosmetic.
        if (!isUsableLogIndex(log.index)) continue
        const pairAddress = log.address.toLowerCase()
        const pair = pairCache.get(pairAddress)
        if (!pair) {
          // Not in the cache at all: its read failed, so this trade is dropped. A cached null is "not a pair".
          if (!pairCache.has(pairAddress)) fanout.pairDrops++
          continue
        }

        const swap = decodeV2Swap(log, pair.tokens)
        if (!swap) continue

        dexRows.push({
          txHash,
          logIndex: log.index,
          dex: pair.dex,
          pairAddress,
          ...swap,
          blockNumber,
          timestamp,
        })
      } catch {
        // Skip malformed swaps
      }
    }

    if (t) t.dexCount = dexRows.length
    if (dexRows.length > 0) {
      const sD = PROFILE_ENABLED ? performance.now() : 0
      for (let i = 0; i < dexRows.length; i += SQL_BATCH_CHUNK) {
        await db.insert(schema.dexTrades).values(dexRows.slice(i, i + SQL_BATCH_CHUNK)).onConflictDoNothing()
      }
      if (t) t.dbInsertDexTrades = performance.now() - sD
    }
  }

  fanoutStats.record(fanout)
  return decodedTransfers
}

// ── Token metadata lookup ───────────────────────────────────────────
/**
 * Deterministic ascending lock order for a multi-row upsert.
 *
 * Exported so the deadlock guard is testable against the SHIPPED sort rather than
 * a re-implementation in the test — a fix that is only defined, never wired, stays
 * green forever (that is exactly how #92 shipped inert).
 *
 * Byte order, not locale: `localeCompare` is locale-sensitive and can order two
 * hex strings differently than Postgres does. Only mutual consistency between
 * concurrent inserters matters, so the comparison must not depend on ambient
 * locale. Returns a NEW array — the caller's array is reused for cache warming.
 */
export function orderByAddress<T extends { address: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))
}

/** Returns how many tokens it read metadata for (fanout-stats.ts). */
async function ensureTokensBatch(
  tokensToEnsure: Map<string, 'BEP20' | 'BEP721' | 'BEP1155'>,
  provider: JsonRpcProvider,
): Promise<number> {
  const db = getDb()
  const addresses = Array.from(tokensToEnsure.keys())
  if (addresses.length === 0) return 0

  // Check which already exist in DB — chunked to avoid stack overflow.
  // Uses IN (literal list) instead of ANY(arr) because Drizzle serializes JS arrays
  // as record literals which fail the ::text[] cast.
  const existingResults: Array<{ address: string }> = []
  for (let i = 0; i < addresses.length; i += SQL_BATCH_CHUNK) {
    const chunk = addresses.slice(i, i + SQL_BATCH_CHUNK)
    const result = await db.execute(sql`
      SELECT address FROM tokens WHERE address IN (${sql.join(
        chunk.map(a => sql`${a}`),
        sql`, `
      )})
    `)
    existingResults.push(...(Array.from(result) as Array<{ address: string }>))
  }
  const existing = existingResults
  const existingSet = new Set(existing.map(r => r.address))

  const toFetch = addresses.filter(a => !existingSet.has(a))
  for (const a of existingSet) {
    tokenCache.add(a)
    if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear()
  }

  if (toFetch.length === 0) return 0

  // Read metadata for at most TOKEN_FETCH_PER_BLOCK, POST_WRITE_CONCURRENCY at a time across every block. The rest, and
  // any read that times out, get the placeholder row a failed read always got (Unknown / ??? / 18 / '0'), which the
  // metadata healer selects and repairs, decimals included (token-metadata-healer.ts).
  const placeholder = (addr: string) => ({
    address: addr,
    name: UNKNOWN_NAME,
    symbol: UNKNOWN_SYMBOL,
    decimals: 18,
    type: tokensToEnsure.get(addr)!,
    totalSupply: '0',
    holderCount: 0,
  })
  const { now: readNow, over } = withinBudget(toFetch, TOKEN_FETCH_PER_BLOCK)
  if (over.length > 0) console.warn(`[tokens] metadata budget exceeded: ${over.length} of ${toFetch.length} new tokens left to the healer`)
  const results = [
    ...await Promise.all(readNow.map(async (addr) => {
      try {
        const meta = await boundedRead(tokenReads, () => fetchTokenMetadata(provider, addr), readTimeoutMs(), `token ${addr}`)
        return {
          ...placeholder(addr),
          name: meta.name ?? UNKNOWN_NAME,
          symbol: meta.symbol ?? UNKNOWN_SYMBOL,
          decimals: meta.decimals ?? 18,
          totalSupply: meta.totalSupply ?? '0',
        }
      } catch {
        return placeholder(addr)
      }
    })),
    ...over.map(placeholder),
  ]

  const valid = results
  if (valid.length > 0) {
    // Sort by address → consistent lock order, same discipline as flushAddresses.
    //
    // Without this, `valid` inherits per-block token DISCOVERY order (Promise.all
    // preserves input order, and `toFetch` is filtered from block-scan order). Two
    // workers indexing different blocks that touch an overlapping token set then
    // insert those rows in DIFFERENT orders, and each waits on the index tuple the
    // other already holds — a textbook circular wait. Postgres confirmed exactly
    // that shape on 2026-08-12 06:23Z: both processes in `insert into "tokens" …
    // on conflict do nothing`, each blocked on the other's transaction, CONTEXT
    // "while inserting index tuple … in relation \"tokens\"".
    //
    // It is NOT a resource problem — a deadlock is a lock-ORDER property, so no
    // amount of RAM or disk removes it. Ascending address order on every inserter
    // makes a cycle impossible.
    //
    // It recurred 6 times in the 7 days to 2026-08-12 (Aug 5 ×3, 8, 10, 12). Each
    // one aborts a whole block, and the resulting catch-up lag is what pushes the
    // loop toward the MAX_LAG skip — which abandons blocks for real. Cheap fix,
    // prevents the expensive failure downstream.
    const ordered = orderByAddress(valid)
    for (let i = 0; i < ordered.length; i += SQL_BATCH_CHUNK) {
      const chunk = ordered.slice(i, i + SQL_BATCH_CHUNK)
      // Retry the residual: ordering removes same-statement cycles, but a
      // concurrent writer on another path can still collide. Safe to retry because
      // this insert is its own implicit transaction (no enclosing db.transaction)
      // and ON CONFLICT DO NOTHING makes it idempotent.
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await db.insert(schema.tokens).values(chunk).onConflictDoNothing()
          break
        } catch (err) {
          if (isDeadlock(err) && attempt < 3) {
            await new Promise(r => setTimeout(r, 50 * attempt))
            continue
          }
          throw err
        }
      }
    }
    for (const v of valid) {
      tokenCache.add(v.address)
      if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear()
    }
  }
  return toFetch.length
}

// ── DEX pair token lookup ───────────────────────────────────────────
const PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function factory() view returns (address)',
]
const FACTORY_ABI = ['function getPair(address, address) view returns (address)']

/**
 * A revert, or an empty return ethers cannot decode: the contract answered that it has no such function.
 * Not a call the node refused: ethers reports a rate limit as CALL_EXCEPTION too, and remembering that
 * as "not a pair" skipped every later swap on a real pair until the cache evicted it.
 */
function answeredNo(err: unknown): boolean {
  if (isTransportError(err)) return false
  return isError(err, 'CALL_EXCEPTION') || (isError(err, 'BAD_DATA') && err.value === '0x')
}

function v2PairReader(provider: JsonRpcProvider): V2PairReader {
  return {
    async pairInfo(pairAddress) {
      const pair = new Contract(pairAddress, PAIR_ABI, provider)
      try {
        const [token0, token1, factory] = await Promise.all([pair.token0(), pair.token1(), pair.factory()])
        return { token0: String(token0), token1: String(token1), factory: String(factory) }
      } catch (err) {
        if (answeredNo(err)) return null
        throw err
      }
    },
    async getPair(factory, tokenA, tokenB) {
      return String(await new Contract(factory, FACTORY_ABI, provider).getPair(tokenA, tokenB))
    },
  }
}

/**
 * Seed the pair cache from recent dex_trades (post-write-budget.ts warmPairs). Runs once at boot, in the background;
 * a failure only means the cache starts cold, as it always did.
 */
export async function warmPairCache(): Promise<number> {
  try {
    const rows = Array.from(await getDb().execute(sql`
      SELECT pair_address, min(LEAST(token_in, token_out)) AS token0, max(GREATEST(token_in, token_out)) AS token1, min(dex) AS dex
      FROM dex_trades
      WHERE block_number > (SELECT max(block_number) FROM dex_trades) - ${WARM_PAIR_BLOCKS}
        AND pair_address IS NOT NULL AND token_in IS NOT NULL AND token_out IS NOT NULL
      GROUP BY pair_address
      LIMIT ${WARM_PAIR_MAX}
    `)) as WarmPairRow[]
    let added = 0
    for (const [address, pair] of warmPairs(rows)) {
      if (pairCache.has(address)) continue
      if (pairCache.size >= PAIR_CACHE_MAX) break
      pairCache.set(address, pair)
      added++
    }
    console.log(`[dex] warmed the pair cache with ${added} pairs from recent dex_trades`)
    return added
  } catch (err) {
    console.warn('[dex] pair cache warm-up failed, starting cold:', dbErrorMessage(err))
    return 0
  }
}

async function fetchPairTokens(pairAddress: string, provider: JsonRpcProvider): Promise<void> {
  try {
    const pair = await resolveV2Pair(pairAddress, V2_FACTORIES[getChainConfig().key], v2PairReader(provider))
    if (pairCache.size >= PAIR_CACHE_MAX) {
      pairCache.delete(pairCache.keys().next().value!)
    }
    pairCache.set(pairAddress, pair)
  } catch {
    // A read failed: nothing is remembered, and the pair is read again when it next swaps.
  }
}

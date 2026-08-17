import { JsonRpcProvider, Log as EthersLog, AbiCoder, Contract, id as keccak256id } from 'ethers'
import { sql } from 'drizzle-orm'
import { getDb, schema } from './db'
import { withTimeout } from './rpc-failover'
import { notifyWebhooks } from './webhook-notifier'
import { getProvider } from './provider'
import { sanitizeTokenMetadata } from './postgres-text'

// ── Topic signatures ────────────────────────────────────────────────
const TRANSFER_TOPIC = keccak256id('Transfer(address,address,uint256)')
const TRANSFER_SINGLE_TOPIC = keccak256id('TransferSingle(address,address,address,uint256,uint256)')
const SWAP_V2_TOPIC = keccak256id('Swap(address,uint256,uint256,uint256,uint256,address)')

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const abi = AbiCoder.defaultAbiCoder()

// Drizzle's sql.join() builds a recursive SQL tree — one level per row.
// Dense blocks (ETH DeFi) can have 3000+ token transfer deltas, which
// blows V8's ~10K call stack limit in buildQueryFromSourceParams().
// Cap all sql.join/insert batches to stay well within the limit.
const SQL_BATCH_CHUNK = 500

// ── Async token_transfers writer flag ────────────────────────────────
// When ON, token_transfers INSERTs move off the per-block hot path into a single
// crash-safe coalescing writer (see "Async token_transfers writer" section + the
// indexer_cursor watermark). Default ON for BNB (0.45s blocks need it), OFF for
// ETH (12s blocks are fine on the synchronous inline path). Override with
// ASYNC_TT_WRITER=1/0. When OFF, behavior is byte-for-byte today's inline path.
const ASYNC_TT_WRITER = (() => {
  const v = process.env.ASYNC_TT_WRITER
  if (v === '1' || v === 'true')  return true
  if (v === '0' || v === 'false') return false
  return (process.env.CHAIN ?? 'bnb') === 'bnb'
})()

// ── Per-phase profiling (opt-in) ─────────────────────────────────────
// Enable with PROFILE_BLOCKS=N (e.g. 30) — logs a phase breakdown every
// N blocks to find the dominant cost center. Zero overhead when disabled.
const PROFILE_BLOCKS = parseInt(process.env.PROFILE_BLOCKS ?? '0', 10)

// Ceiling on pure RPC acquisition per block.
//
// Measured rpcBlockWait in production averages 275-428ms, so 8s is ~20x the mean
// and a comfortable ceiling for a dense block under load. Sized deliberately
// tight: bsc.publicnode.com rejects EVERY archive request, so with 4 endpoints
// roughly a quarter of attempts start there and pay this timeout before failing
// over. At 90s that cost the batch ~90s; at 8s it costs ~8s. A false timeout on
// a merely-slow endpoint is harmless — this bounds a PURE READ, so failover just
// re-fetches elsewhere.
const RPC_FETCH_TIMEOUT_MS = parseInt(process.env.RPC_FETCH_TIMEOUT_MS ?? '8000', 10)
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
export type NormalizedLog = {
  address: string
  topics: string[]
  data: string
  index: number
}

export type NormalizedReceipt = {
  status: boolean
  gasUsed: bigint
  logs: NormalizedLog[]
}

type TokenTransferRow = {
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

type DexTradeRow = {
  txHash: string
  /**
   * Position of the Swap log within the block. Together with txHash this is the
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

const pairCache = new Map<string, [string, string]>()
const PAIR_CACHE_MAX = 10_000

// ── Main entry ──────────────────────────────────────────────────────
/**
 * `onWritesBegan` is invoked exactly once, immediately before the first durable
 * write. Everything above that call is pure RPC acquisition and is safe to retry
 * on another endpoint; everything below it persists incrementally and is NOT
 * (dex_trades has no unique constraint, so a replay duplicates rows). RPC
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

export async function processBlock(
  blockNumber: number,
  provider: JsonRpcProvider,
  skipLogs = false,
  onWritesBegan?: () => void,
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
  const [block, receipts] = await withTimeout(
    Promise.all([blockPromise, receiptsPromise]),
    RPC_FETCH_TIMEOUT_MS,
    `block ${blockNumber} acquisition`,
  )
  if (t) {
    t.rpcBlockWait = performance.now() - rpcStart
    t.rpcReceiptsWait = 0
  }
  if (!block) throw new Error(`Block ${blockNumber} not found`)
  if (!block.hash) throw new Error(`Block ${blockNumber} has no hash (pending block?)`)

  // Refuse a partially-covered block BEFORE the first write, so rpc-failover can
  // retry it on another endpoint with nothing half-written. See the function.
  assertReceiptCoverage(
    blockNumber,
    block.prefetchedTransactions.map(tx => tx.hash),
    receipts.map(r => r.txHash),
    wantReceipts,
  )

  const timestamp = new Date(Number(block.timestamp) * 1000)

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
      gasPrice: tx.gasPrice?.toString() ?? '0',
      gasUsed: rec?.gasUsed ?? 0n,
      input: tx.data.length > 500 ? tx.data.slice(0, 500) : tx.data,
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
    ).catch(err => console.error('[webhook-notifier] delivery error:', err))
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
      await ensureTokensBatch(tokensToEnsure, provider)
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
    if (unknownPairs.size > 0) {
      const sP = PROFILE_ENABLED ? performance.now() : 0
      await Promise.all(Array.from(unknownPairs).map(pair => fetchPairTokens(pair, provider)))
      if (t) t.rpcPairTokens = performance.now() - sP
    }

    for (const { txHash, log } of dexSwapLogs) {
      try {
        // log_index is the natural key now, so an unusable one is not cosmetic.
        if (!isUsableLogIndex(log.index)) continue
        const pairAddress = log.address.toLowerCase()
        const isV2 = log.topics.length === 3 && log.data.length >= 514
        if (!isV2) continue

        const tokens = pairCache.get(pairAddress)
        if (!tokens) continue

        const [token0, token1] = tokens
        const [a0In, a1In, a0Out, a1Out] = abi.decode(
          ['uint256', 'uint256', 'uint256', 'uint256'], log.data
        ) as bigint[]

        let tokenIn: string, tokenOut: string, amountIn: bigint, amountOut: bigint
        if (a0In > 0n) {
          tokenIn = token0; tokenOut = token1
          amountIn = a0In; amountOut = a1Out
        } else {
          tokenIn = token1; tokenOut = token0
          amountIn = a1In; amountOut = a0Out
        }

        const maker = ('0x' + log.topics[2].slice(26)).toLowerCase()

        dexRows.push({
          txHash,
          logIndex: log.index,
          dex: 'PancakeSwap V2',
          pairAddress,
          tokenIn,
          tokenOut,
          amountIn: amountIn.toString(),
          amountOut: amountOut.toString(),
          maker,
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

  return decodedTransfers
}

// ── Async addresses coalescer ───────────────────────────────────────
/**
 * Accumulates address activity (tx_count delta + last_seen) across blocks
 * and flushes in coalesced batches. Previously the upsert ran synchronously
 * per block and was the dominant lock-contention source under 8-worker
 * concurrency — hot rows (WBNB, PancakeSwap router, stablecoins) serialized
 * on row locks, and deadlock retries added 50-150ms stalls to random blocks.
 *
 * Coalescing properties:
 *   - Larger batches → fewer lock acquisition cycles overall
 *   - Single in-flight flush → bounded memory and DB pool pressure
 *   - Deduplicated addresses → one row lock per distinct address per flush
 *   - Fire-and-forget from block loop → block processing never waits on
 *     addresses-table contention
 *
 * The addresses table is metadata (tx_count, last_seen). Eventual consistency
 * across a few seconds is acceptable; firstSeen still populates correctly
 * via the INSERT clause of ON CONFLICT.
 */
type AddressPending = { count: number; ts: Date }
let addressPending = new Map<string, AddressPending>()
let addressFlushInflight: Promise<void> | null = null

function enqueueAddressActivity(
  txs: Array<{ fromAddress: string; toAddress: string | null }>,
  timestamp: Date,
): void {
  const bump = (addr: string) => {
    const prev = addressPending.get(addr)
    if (prev) {
      prev.count += 1
      if (timestamp > prev.ts) prev.ts = timestamp
    } else {
      addressPending.set(addr, { count: 1, ts: timestamp })
    }
  }
  for (const tx of txs) {
    bump(tx.fromAddress)
    if (tx.toAddress) bump(tx.toAddress)
  }
  kickAddressFlush()
}

function kickAddressFlush(): void {
  if (addressFlushInflight) return
  if (addressPending.size === 0) return
  const snapshot = addressPending
  addressPending = new Map()
  addressFlushInflight = flushAddresses(snapshot)
    .catch(err => console.warn('[addresses] flush failed:', err instanceof Error ? err.message : err))
    .finally(() => {
      addressFlushInflight = null
      if (addressPending.size > 0) kickAddressFlush()
    })
}

async function flushAddresses(pending: Map<string, AddressPending>): Promise<void> {
  const db = getDb()
  // Sort by address → consistent lock order, minimizes deadlocks across flushes.
  const entries = Array.from(pending.entries()).sort((a, b) => a[0].localeCompare(b[0]))

  for (let i = 0; i < entries.length; i += SQL_BATCH_CHUNK) {
    const chunk = entries.slice(i, i + SQL_BATCH_CHUNK)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await db.execute(sql`
          INSERT INTO addresses (address, balance, tx_count, is_contract, first_seen, last_seen)
          VALUES ${sql.join(
            chunk.map(([addr, d]) =>
              sql`(${addr}, '0'::numeric, ${d.count}, false, ${d.ts.toISOString()}::timestamptz, ${d.ts.toISOString()}::timestamptz)`,
            ),
            sql`, `,
          )}
          ON CONFLICT (address) DO UPDATE SET
            tx_count  = addresses.tx_count + EXCLUDED.tx_count,
            last_seen = GREATEST(addresses.last_seen, EXCLUDED.last_seen)
        `)
        break
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('deadlock') && attempt < 3) {
          await new Promise(r => setTimeout(r, 50 * attempt))
          continue
        }
        throw err
      }
    }
  }
}

// ── Batched holder balance update ───────────────────────────────────
/**
 * Aggregate per-(token, holder) deltas across all transfers in the block,
 * then apply a single batched upsert to token_balances.
 *
 * Previously this also maintained tokens.holder_count inline via a
 * two-phase CTE (old_state → upsert → aggregate). Under production load
 * on ETH (1000+ deltas per block) that CTE became the dominant bottleneck,
 * scaling negatively with concurrency because of row-lock contention and
 * deadlocks. holder_count is now recomputed periodically by the retention
 * job instead — see recomputeHolderCounts().
 */
// ── Holder balance async queue ──────────────────────────────────────
// Single-worker drainer for balance UPSERTs. Blocks previously awaited
// this inline, which was the dominant per-block cost (~38% / ~2.5s).
// Serializing through one worker removes cross-worker row-lock contention.
const HOLDER_QUEUE_WARN_DEPTH = parseInt(process.env.HOLDER_QUEUE_WARN_DEPTH ?? '500', 10)
const SKIP_HOLDER_BALANCES = true
// Single source of truth for whether per-block holder-balance tracking is live.
// While OFF, token_balances receives no per-block writes, so the periodic
// holder_count recompute (retention-cleanup.ts) has no new input and is skipped —
// it would otherwise full-scan a frozen token_balances for minutes and stall block
// ingestion via disk-I/O contention while updating zero rows.
export const HOLDER_BALANCE_TRACKING_ENABLED = !SKIP_HOLDER_BALANCES
console.warn('[holder-queue] HARDCODED SKIP — token_balances writes DISABLED to save DB from write storm')
const holderQueue: TokenTransferRow[][] = []
let holderWorkerRunning = false
let holderQueueLogCounter = 0

function enqueueHolderBalanceUpdate(rows: TokenTransferRow[]): void {
  if (SKIP_HOLDER_BALANCES) return
  holderQueue.push(rows)
  if (++holderQueueLogCounter >= 100) {
    holderQueueLogCounter = 0
    if (holderQueue.length >= HOLDER_QUEUE_WARN_DEPTH) {
      console.warn(`[holder-queue] depth=${holderQueue.length} batches (warn threshold ${HOLDER_QUEUE_WARN_DEPTH})`)
    } else {
      console.log(`[holder-queue] depth=${holderQueue.length} batches`)
    }
  }
  runHolderWorker()
}

function runHolderWorker(): void {
  if (holderWorkerRunning) return
  holderWorkerRunning = true
  // Fire-and-forget; errors logged per-drain, loop continues.
  // Each drain coalesces the ENTIRE current queue into one merged UPSERT:
  // delta aggregation is commutative, so N batches of deltas can be summed
  // per (token, holder) and applied as a single SQL round-trip. This
  // amortizes per-statement overhead — a queue of 500 batches drains in
  // roughly the same time as 1, bounded only by the merged row count.
  ;(async () => {
    try {
      while (holderQueue.length > 0) {
        const drained = holderQueue.splice(0, holderQueue.length)
        const merged: TokenTransferRow[] = []
        for (const batch of drained) {
          for (const r of batch) merged.push(r)
        }
        try {
          await batchUpdateHolderBalances(merged)
        } catch (err) {
          console.warn(`[holder-queue] merged batch of ${drained.length} failed:`, err instanceof Error ? err.message : err)
        }
      }
    } finally {
      holderWorkerRunning = false
    }
  })()
}

export function getHolderQueueDepth(): number {
  return holderQueue.length
}

async function batchUpdateHolderBalances(rows: TokenTransferRow[]): Promise<void> {
  const db = getDb()

  // Aggregate net deltas: (token, holder) → bigint
  const deltas = new Map<string, bigint>()
  const key = (token: string, holder: string) => `${token}|${holder}`

  for (const r of rows) {
    // Skip NFT holder tracking — BEP721/1155 balances aren't aggregated the same way
    if (r.tokenType !== 'BEP20') continue

    const v = BigInt(r.value)
    if (r.toAddress !== ZERO_ADDRESS) {
      const k = key(r.tokenAddress, r.toAddress)
      deltas.set(k, (deltas.get(k) ?? 0n) + v)
    }
    if (r.fromAddress !== ZERO_ADDRESS) {
      const k = key(r.tokenAddress, r.fromAddress)
      deltas.set(k, (deltas.get(k) ?? 0n) - v)
    }
  }

  if (deltas.size === 0) return

  // Sort by (token, holder) so row locks are acquired in a consistent order,
  // reducing (but not eliminating) deadlocks under concurrent block processors.
  const entries = Array.from(deltas.entries())
    .map(([k, delta]) => {
      const [token, holder] = k.split('|')
      return { token, holder, delta }
    })
    .sort((a, b) => (a.token + a.holder).localeCompare(b.token + b.holder))

  // Simple upsert, with deadlock retry. No CTE, no holder_count tracking.
  // Chunked to avoid V8 call stack overflow in Drizzle's sql.join() recursion.
  for (let i = 0; i < entries.length; i += SQL_BATCH_CHUNK) {
    const chunk = entries.slice(i, i + SQL_BATCH_CHUNK)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await db.execute(sql`
          INSERT INTO token_balances (token_address, holder_address, balance)
          VALUES ${sql.join(
            chunk.map(e => sql`(${e.token}::varchar(42), ${e.holder}::varchar(42), ${e.delta.toString()}::numeric)`),
            sql`, `
          )}
          ON CONFLICT (token_address, holder_address) DO UPDATE
            SET balance = token_balances.balance + EXCLUDED.balance
        `)
        break
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('deadlock') && attempt < 3) {
          await new Promise(r => setTimeout(r, 50 * attempt))
          continue
        }
        throw err
      }
    }
  }
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
const parsedTtQueueHighWaterRows = parseInt(process.env.TT_QUEUE_HIGH_WATER_ROWS ?? '', 10)
const TT_QUEUE_HIGH_WATER_ROWS =
  Number.isFinite(parsedTtQueueHighWaterRows) && parsedTtQueueHighWaterRows > 0
    ? parsedTtQueueHighWaterRows
    : 50000
// Parallel backpressure bound on the pending BLOCK COUNT (transferPending.size), not
// just rows. The rows bound above never engages for an all-transfer-less block range
// with a stalled writer — rows stays ~0 while the pending Map grows unbounded (codex
// P2 deferred from PR #43/#44). Bounding blocks caps that Map (and the W↔tip crash
// replay window) regardless of how few transfers the range carries. Robust to
// unset/NaN/zero/negative → default 2000. Backpressure only — the high-water ALERT
// (TT_QUEUE_ALERT_ROWS) stays rows-only; a genuinely stuck writer is already caught by
// the consecutive-write-failure alert, which is failure-count- not row-driven.
const parsedTtQueueHighWaterBlocks = parseInt(process.env.TT_QUEUE_HIGH_WATER_BLOCKS ?? '', 10)
const TT_QUEUE_HIGH_WATER_BLOCKS =
  Number.isFinite(parsedTtQueueHighWaterBlocks) && parsedTtQueueHighWaterBlocks > 0
    ? parsedTtQueueHighWaterBlocks
    : 2000
// Pending-rows threshold for the high-water ALERT, decoupled from the backpressure
// bound above. PR #43 reused TT_QUEUE_HIGH_WATER_ROWS for both, so the WARN tripped on
// every momentary ride along the backpressure ceiling (13 benign fires the first day,
// all ~50,000–50,200 rows with W advancing). The alert must mean "backpressure is
// FAILING to contain the queue" (the 838k June incident), not "the queue is busy" — so
// it gets its own, higher bound: default 2× the backpressure bound, floored AT the bound
// so a misconfigured override can never make the alert noisier than PR #43 was. Pairs
// with the lower recovery edge in evaluateTransferQueueHighWater() to form a hysteresis
// band that can't flap.
const parsedTtQueueAlertRows = parseInt(process.env.TT_QUEUE_ALERT_ROWS ?? '', 10)
const TT_QUEUE_ALERT_ROWS = Math.max(
  TT_QUEUE_HIGH_WATER_ROWS,
  Number.isFinite(parsedTtQueueAlertRows) && parsedTtQueueAlertRows > 0
    ? parsedTtQueueAlertRows
    : TT_QUEUE_HIGH_WATER_ROWS * 2,
)
// Consecutive failed drains before the writer escalates from a per-attempt warn to a
// loud error alert (and again every Nth failure after). Mirrors webhook-notifier's
// "deactivate after 5 consecutive failures" pattern — here we never give up (transfers
// are primary data), we just get loud so log-based monitoring fires.
const TT_WRITER_FAILURE_ALERT_THRESHOLD = parseInt(process.env.TT_WRITER_FAILURE_ALERT_THRESHOLD ?? '5', 10)
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
  runTransferWriter()  // flush anything enqueued during startup
}

/**
 * Jump the watermark forward when the indexer deliberately abandons a block range
 * (the MAX_LAG "skip to tip" path in index.ts). Without this, W would freeze at the
 * skip boundary because the skipped blocks are never enqueued. Accepts the same gap
 * the pre-existing skip already creates in `blocks`; the resume gap-scan heals
 * recent holes on restart.
 */
export function setDurableFloor(block: number): void {
  if (!transferWriterSeeded || block <= durableBlock) return
  durableBlock = block
  for (const n of transferWritten) if (n <= durableBlock) transferWritten.delete(n)
  persistDurableBlock(durableBlock).catch(err =>
    console.warn('[tt-writer] floor persist failed:', err instanceof Error ? err.message : err))
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
    if (transferWriterSeeded && durableBlock > forkPoint) {
      const prev = durableBlock
      durableBlock = forkPoint
      try {
        await persistDurableBlock(forkPoint)
        console.warn(`[tt-writer] reorg rollback: durable watermark rewound ${prev} → ${forkPoint}`)
      } catch (err) {
        console.error(`[tt-writer] ALERT reorg rollback: watermark rewound in memory (${prev} → ${forkPoint}) but persist FAILED — a crash before the next drain-fold persists would resume past the fork:`, err instanceof Error ? err.message : err)
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
  evaluateTransferQueueHighWater()
  runTransferWriter()
}

function runTransferWriter(): void {
  if (!transferWriterSeeded) return        // never write/persist before the seed
  if (transferWriterPaused) return         // reorg rollback in progress — resumed by rollbackTransferWriterTo
  if (transferWriterRunning) return
  if (transferPending.size === 0) return
  transferWriterRunning = true
  // Fire-and-forget single drainer — coalesces the entire current queue per pass.
  ;(async () => {
    try {
      // Checking paused per iteration lets an in-flight drain finish its current
      // batch (commit or requeue) and then yield to a waiting reorg rollback.
      while (!transferWriterPaused && transferPending.size > 0) {
        const drained = transferPending
        transferPending = new Map()
        transferPendingRows = 0

        // blockNums drives the FOLD (every drained height counts, quarantined or
        // not — that is the whole point of a quarantine batch). deleteNums drives
        // the DELETE, and deliberately excludes quarantined heights so a stale
        // retry can never destroy rows written by a heal in the meantime.
        const blockNums = Array.from(drained.keys())
        const deleteNums: number[] = []
        const rows: TokenTransferRow[] = []
        for (const [n, batch] of drained) {
          if (!batch.quarantine) deleteNums.push(n)
          for (const r of batch.rows) rows.push(r)
        }
        // Sort by (block_number, log_index): keeps tt_block_idx writes sequential
        // and clusters same-block rows for better index-leaf locality.
        rows.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)

        try {
          await writeTransferBlocks(deleteNums, rows)

          // Fold written blocks into W through the contiguous prefix. Compute the new
          // watermark first and only advance durableBlock / clear transferWritten AFTER
          // persistDurableBlock() commits. The old order advanced in memory before the
          // persist, so a failed persist was never retried (the next cycle saw nothing to
          // move) AND the in-memory watermark ran ahead of the durable one — masking a
          // sustained indexer_cursor outage. Holding state until the persist lands makes
          // the failure recur every cycle, so it both retries and feeds the failure ALERT.
          for (const n of blockNums) if (n > durableBlock) transferWritten.add(n)
          let newDurable = durableBlock
          while (transferWritten.has(newDurable + 1)) newDurable++
          if (newDurable > durableBlock) {
            await persistDurableBlock(newDurable)
            for (let n = durableBlock + 1; n <= newDurable; n++) transferWritten.delete(n)
            durableBlock = newDurable
          }

          // Rows are durable now — let holder-balance tracking see them.
          // (no-op while SKIP_HOLDER_BALANCES is true, but keeps the path correct).
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

          if (++ttWriterDrainCount % 200 === 0) {
            console.log(`[tt-writer] W=${durableBlock} pending=${transferPending.size}blk/${transferPendingRows}rows ahead=${transferWritten.size}`)
          }
        } catch (err) {
          ttWriterConsecutiveFailures++
          const msg = err instanceof Error ? err.message : String(err)
          // Re-queue (don't clobber a newer decode of the same block). The
          // quarantine flag travels inside the batch, so a requeued quarantine
          // stays a no-op and a requeued real batch stays a real write — no
          // separate bookkeeping to fall out of step across the retry.
          for (const [n, batch] of drained) {
            if (!transferPending.has(n)) {
              transferPending.set(n, batch)
              transferPendingRows += batch.rows.length
            }
          }
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
      // Loop exits only when transferPending is empty, so the queue is durably drained
      // here — fire the recovery log if we'd alerted (the writer cleared it, not an enqueue).
      evaluateTransferQueueHighWater()
    } finally {
      transferWriterRunning = false
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
  const db = getDb()
  await db.transaction(async (tx) => {
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
}

async function persistDurableBlock(block: number): Promise<void> {
  const db = getDb()
  await db.execute(sql`UPDATE indexer_cursor SET transfers_durable_block = ${block} WHERE id = 1`)
}

/** Drain the queue to empty — used for graceful shutdown + backpressure. */
export async function flushTransferWriter(): Promise<void> {
  runTransferWriter()
  while (transferPending.size > 0 || transferWriterRunning) {
    await new Promise(r => setTimeout(r, 25))
  }
}

export { TT_QUEUE_HIGH_WATER_ROWS, TT_QUEUE_HIGH_WATER_BLOCKS, ASYNC_TT_WRITER }

// ── Token metadata lookup ───────────────────────────────────────────
const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
]

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

async function ensureTokensBatch(
  tokensToEnsure: Map<string, 'BEP20' | 'BEP721' | 'BEP1155'>,
  provider: JsonRpcProvider,
): Promise<void> {
  const db = getDb()
  const addresses = Array.from(tokensToEnsure.keys())
  if (addresses.length === 0) return

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

  if (toFetch.length === 0) return

  // Fetch metadata in parallel
  const results = await Promise.all(
    toFetch.map(async (addr) => {
      try {
        const contract = new Contract(addr, ERC20_ABI, provider)
        const [name, symbol, decimals, totalSupply] = await Promise.all([
          contract.name().catch(() => 'Unknown'),
          contract.symbol().catch(() => '???'),
          contract.decimals().catch(() => 18),
          contract.totalSupply().catch(() => 0n),
        ])
        return {
          address: addr,
          name: sanitizeTokenMetadata(name, 'Unknown', 255),
          symbol: sanitizeTokenMetadata(symbol, '???', 50),
          decimals: Number(decimals),
          type: tokensToEnsure.get(addr)!,
          totalSupply: BigInt(totalSupply).toString(),
          holderCount: 0,
        }
      } catch {
        return null
      }
    })
  )

  const valid = results.filter((r): r is NonNullable<typeof r> => r !== null)
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
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes('deadlock') && attempt < 3) {
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
}

// ── DEX pair token lookup ───────────────────────────────────────────
const PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]

async function fetchPairTokens(pairAddress: string, provider: JsonRpcProvider): Promise<void> {
  try {
    const pair = new Contract(pairAddress, PAIR_ABI, provider)
    const [t0, t1] = await Promise.all([pair.token0(), pair.token1()])
    if (pairCache.size >= PAIR_CACHE_MAX) {
      pairCache.delete(pairCache.keys().next().value!)
    }
    pairCache.set(pairAddress, [String(t0).toLowerCase(), String(t1).toLowerCase()])
  } catch {
    // Not a valid pair, skip
  }
}

// ── eth_getBlockReceipts ─────────────────────────────────────────────
// No auto-disable: all target chains (BSC, ETH mainnet) support this method on
// every RPC we use. A failure here means a transient issue (rate-limit 429,
// network blip) — we throw so the worker-pool catches it, marks the block
// failed, sleeps 1s, and retries. Previously we auto-disabled after 3 failures
// and silently dropped receipts for the rest of the process lifetime, which
// meant token_transfers/dex_trades/tx_status stopped being recorded entirely.
export async function fetchBlockReceipts(
  provider: JsonRpcProvider,
  blockNumber: number,
): Promise<Array<{ txHash: string; receipt: NormalizedReceipt }>> {
  const blockHex = '0x' + blockNumber.toString(16)
  const raw = await provider.send('eth_getBlockReceipts', [blockHex]) as Array<{
    transactionHash: string
    status: string
    gasUsed: string
    logs: Array<{ address: string; topics: string[]; data: string; logIndex: string }>
  }> | null

  // A null response is NOT an empty block. Collapsing the two (`raw ?? []`) made
  // an RPC that answered "I don't have this block" indistinguishable from one
  // that answered "this block has no transactions" — and the difference is
  // destructive, because writeTransferBlocks DELETEs a block's transfers before
  // re-inserting whatever it was handed. Replaying a block against an endpoint
  // that returned null therefore wiped good rows and inserted nothing.
  //
  // Throwing hands the block to rpc-failover, which retries it on another
  // endpoint. This is strictly above the first write, so no partial state exists
  // to roll back.
  if (raw === null || raw === undefined) {
    throw new Error(`Block ${blockNumber} receipts unavailable (null response)`)
  }

  const result: Array<{ txHash: string; receipt: NormalizedReceipt }> = []
  for (const r of raw) {
    result.push({
      // Normalized HERE, once, at the boundary. assertReceiptCoverage compares
      // case-insensitively, so without this a differently-cased hash would PASS
      // coverage and then miss in receiptByTx — handing the transaction the
      // default status=true / gasUsed=0 instead of its real receipt, silently.
      // The raw hash also feeds transfer and dex rows, whose SQL unique keys are
      // case-SENSITIVE, so a case variant could slip past them too.
      txHash: r.transactionHash.toLowerCase(),
      receipt: {
        status: r.status === '0x1',
        gasUsed: BigInt(r.gasUsed),
        logs: r.logs.map(l => ({
          address: l.address.toLowerCase(),
          topics: l.topics,
          data: l.data,
          index: parseInt(l.logIndex, 16),
        })),
      },
    })
  }
  return result
}

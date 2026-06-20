import { JsonRpcProvider, Log as EthersLog, AbiCoder, Contract, id as keccak256id } from 'ethers'
import { sql } from 'drizzle-orm'
import { getDb, schema } from './db'
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
export async function processBlock(blockNumber: number, provider: JsonRpcProvider, skipLogs = false) {
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

  const [block, receipts] = await Promise.all([blockPromise, receiptsPromise])
  if (t) {
    t.rpcBlockWait = performance.now() - rpcStart
    t.rpcReceiptsWait = 0
  }
  if (!block) throw new Error(`Block ${blockNumber} not found`)
  if (!block.hash) throw new Error(`Block ${blockNumber} has no hash (pending block?)`)

  const timestamp = new Date(Number(block.timestamp) * 1000)

  // Map tx hash → receipt so we can populate tx.status / tx.gasUsed at INSERT
  // time instead of via a follow-up UPDATE pass.
  const receiptByTx = new Map<string, NormalizedReceipt>()
  for (const r of receipts) receiptByTx.set(r.txHash, r.receipt)

  // ── 1. Insert block ────────────────────────────────────────────
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
    const rec = receiptByTx.get(tx.hash)
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
const TT_QUEUE_HIGH_WATER_ROWS = parseInt(process.env.TT_QUEUE_HIGH_WATER_ROWS ?? '50000', 10)
// Consecutive failed drains before the writer escalates from a per-attempt warn to a
// loud error alert (and again every Nth failure after). Mirrors webhook-notifier's
// "deactivate after 5 consecutive failures" pattern — here we never give up (transfers
// are primary data), we just get loud so log-based monitoring fires.
const TT_WRITER_FAILURE_ALERT_THRESHOLD = parseInt(process.env.TT_WRITER_FAILURE_ALERT_THRESHOLD ?? '5', 10)
let transferPending = new Map<number, TokenTransferRow[]>()
let transferPendingRows = 0
const transferWritten = new Set<number>()   // committed, not yet folded into W
let durableBlock = 0
let transferWriterSeeded = false
let transferWriterRunning = false
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
  console.log(`[tt-writer] seeded durable watermark = ${durableBlock}`)
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

export function getTransferQueueDepth(): { blocks: number; rows: number; durableBlock: number } {
  return { blocks: transferPending.size, rows: transferPendingRows, durableBlock }
}

// Edge-triggered high-water alert for the pending queue (warn once on the way up,
// log once on the way back down) so a sustained breach doesn't spam every enqueue.
// The June 2026 incident saw the queue blow past this bound with no signal at all.
// MUST be called after every DURABLE change to transferPendingRows — enqueue,
// post-failure requeue, and a completed drain — otherwise the flag desyncs: the
// writer draining a breach to empty (or a requeue re-crossing the bound) happens
// outside enqueue, so without this the recovery log is missed and the flag can stick
// true. Deliberately NOT called at the transient top-of-loop reset to 0, which would
// flap warn/recovered every 250ms during a write-failure retry storm. Reuses
// TT_QUEUE_HIGH_WATER_ROWS — the same bound the live + backfill loops throttle on.
function evaluateTransferQueueHighWater(): void {
  if (!ttQueueOverHighWater && transferPendingRows > TT_QUEUE_HIGH_WATER_ROWS) {
    ttQueueOverHighWater = true
    console.warn(`[tt-writer] ALERT queue over high-water: ${transferPendingRows} rows > ${TT_QUEUE_HIGH_WATER_ROWS} (${transferPending.size} blocks pending, W=${durableBlock})`)
  } else if (ttQueueOverHighWater && transferPendingRows <= TT_QUEUE_HIGH_WATER_ROWS) {
    ttQueueOverHighWater = false
    console.log(`[tt-writer] queue recovered: ${transferPendingRows} rows ≤ ${TT_QUEUE_HIGH_WATER_ROWS}`)
  }
}

export function enqueueTransferWrite(blockNumber: number, rows: TokenTransferRow[]): void {
  const prev = transferPending.get(blockNumber)
  if (prev) transferPendingRows -= prev.length
  transferPending.set(blockNumber, rows)   // latest decode of a block wins
  transferPendingRows += rows.length
  evaluateTransferQueueHighWater()
  runTransferWriter()
}

function runTransferWriter(): void {
  if (!transferWriterSeeded) return        // never write/persist before the seed
  if (transferWriterRunning) return
  if (transferPending.size === 0) return
  transferWriterRunning = true
  // Fire-and-forget single drainer — coalesces the entire current queue per pass.
  ;(async () => {
    try {
      while (transferPending.size > 0) {
        const drained = transferPending
        transferPending = new Map()
        transferPendingRows = 0

        const blockNums = Array.from(drained.keys())
        const rows: TokenTransferRow[] = []
        for (const batch of drained.values()) for (const r of batch) rows.push(r)
        // Sort by (block_number, log_index): keeps tt_block_idx writes sequential
        // and clusters same-block rows for better index-leaf locality.
        rows.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)

        try {
          await writeTransferBlocks(blockNums, rows)

          // Writer is healthy — clear the failure streak (announce recovery if we'd alerted).
          if (ttWriterConsecutiveFailures >= TT_WRITER_FAILURE_ALERT_THRESHOLD) {
            console.log(`[tt-writer] writer recovered after ${ttWriterConsecutiveFailures} consecutive failure(s)`)
          }
          ttWriterConsecutiveFailures = 0

          // Fold written blocks into W through the contiguous prefix.
          for (const n of blockNums) if (n > durableBlock) transferWritten.add(n)
          let moved = false
          while (transferWritten.delete(durableBlock + 1)) { durableBlock++; moved = true }
          if (moved) await persistDurableBlock(durableBlock)

          // Rows are durable now — let holder-balance tracking see them.
          // (no-op while SKIP_HOLDER_BALANCES is true, but keeps the path correct).
          if (rows.length > 0) enqueueHolderBalanceUpdate(rows)

          if (++ttWriterDrainCount % 200 === 0) {
            console.log(`[tt-writer] W=${durableBlock} pending=${transferPending.size}blk/${transferPendingRows}rows ahead=${transferWritten.size}`)
          }
        } catch (err) {
          ttWriterConsecutiveFailures++
          const msg = err instanceof Error ? err.message : String(err)
          // Re-queue (don't clobber a newer decode of the same block).
          for (const [n, batch] of drained) {
            if (!transferPending.has(n)) {
              transferPending.set(n, batch)
              transferPendingRows += batch.length
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

export { TT_QUEUE_HIGH_WATER_ROWS, ASYNC_TT_WRITER }

// ── Token metadata lookup ───────────────────────────────────────────
const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
]

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
    await db.insert(schema.tokens).values(valid).onConflictDoNothing()
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

  const result: Array<{ txHash: string; receipt: NormalizedReceipt }> = []
  for (const r of raw ?? []) {
    result.push({
      txHash: r.transactionHash,
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

import { JsonRpcProvider, Log as EthersLog, AbiCoder, Contract, id as keccak256id } from 'ethers'
import { sql } from 'drizzle-orm'
import { getDb, schema } from './db'
import { notifyWebhooks } from './webhook-notifier'
import { getProvider } from './provider'

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

type TxStatusUpdate = {
  hash: string
  status: boolean
  gasUsed: bigint
}

// ── Caches ──────────────────────────────────────────────────────────
const tokenCache = new Set<string>()
const TOKEN_CACHE_MAX = 50_000

const pairCache = new Map<string, [string, string]>()
const PAIR_CACHE_MAX = 10_000

// ── Main entry ──────────────────────────────────────────────────────
export async function processBlock(blockNumber: number, provider: JsonRpcProvider, skipLogs = false) {
  const db = getDb()

  // Fire both RPC calls in parallel — they're independent and together
  // account for most of the wall-clock time on ETH (where receipts can be >1MB).
  const wantReceipts = !skipLogs && blockReceiptsSupported
  const blockPromise = provider.getBlock(blockNumber, true)
  const receiptsPromise = wantReceipts
    ? fetchBlockReceipts(provider, blockNumber)
    : Promise.resolve([] as Array<{ txHash: string; receipt: NormalizedReceipt }>)

  const block = await blockPromise
  if (!block) throw new Error(`Block ${blockNumber} not found`)
  if (!block.hash) throw new Error(`Block ${blockNumber} has no hash (pending block?)`)

  const timestamp = new Date(Number(block.timestamp) * 1000)

  // ── 1. Insert block ────────────────────────────────────────────
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

  // ── 2. Bulk insert transactions ────────────────────────────────
  const txValues = block.prefetchedTransactions.map((tx, idx) => ({
    hash: tx.hash,
    blockNumber: block.number,
    fromAddress: tx.from.toLowerCase(),
    toAddress: tx.to?.toLowerCase() ?? null,
    value: tx.value.toString(),
    gas: tx.gasLimit,
    gasPrice: tx.gasPrice?.toString() ?? '0',
    gasUsed: 0n,
    input: tx.data.length > 500 ? tx.data.slice(0, 500) : tx.data,
    status: true,
    methodId: tx.data.length >= 10 ? tx.data.slice(0, 10) : null,
    txIndex: idx,
    nonce: tx.nonce,
    txType: tx.type ?? 0,
    timestamp,
  }))

  let insertedAddrs: Array<{ fromAddress: string; toAddress: string | null }> = []
  if (txValues.length > 0) {
    insertedAddrs = await db.insert(schema.transactions)
      .values(txValues)
      .onConflictDoNothing()
      .returning({
        fromAddress: schema.transactions.fromAddress,
        toAddress: schema.transactions.toAddress,
      })

    if (insertedAddrs.length > 0) {
      await upsertAddresses(insertedAddrs, timestamp)
    }
  }

  // ── 3. Await receipts (kicked off in parallel above) + decode ──
  if (wantReceipts && block.prefetchedTransactions.length > 0) {
    const receipts = await receiptsPromise
    if (receipts.length > 0) {
      await processReceiptsBatch(receipts, blockNumber, timestamp, provider)
    }
  } else if (wantReceipts) {
    // Drain the promise so we don't leak an unhandled rejection on empty blocks
    receiptsPromise.catch(() => {})
  }

  // ── 4. Webhooks (non-blocking) ─────────────────────────────────
  if (!skipLogs && txValues.length > 0) {
    notifyWebhooks(
      txValues.map(tx => ({ hash: tx.hash, fromAddress: tx.fromAddress, toAddress: tx.toAddress ?? null, value: tx.value })),
      block.number,
      timestamp,
    ).catch(err => console.error('[webhook-notifier] delivery error:', err))
  }
}

// ── Receipt batch processing ────────────────────────────────────────
/**
 * Process all receipts for a block in bulk:
 *   - Batched tx status/gasUsed UPDATE via unnest
 *   - Batched token_transfers INSERT
 *   - Batched dex_trades INSERT
 *   - Pre-filtered logs by topic to avoid wasted work
 */
async function processReceiptsBatch(
  receipts: Array<{ txHash: string; receipt: NormalizedReceipt }>,
  blockNumber: number,
  timestamp: Date,
  provider: JsonRpcProvider,
) {
  const db = getDb()

  // ── A. Batch update tx status + gasUsed ─────────────────────────
  const statusUpdates: TxStatusUpdate[] = receipts.map(r => ({
    hash: r.txHash,
    status: r.receipt.status,
    gasUsed: r.receipt.gasUsed,
  }))
  await batchUpdateTxStatus(statusUpdates)

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

    // Ensure unknown tokens exist (batched RPC lookups)
    if (tokensToEnsure.size > 0) {
      await ensureTokensBatch(tokensToEnsure, provider)
    }

    // Bulk insert token transfers — chunked to avoid stack overflow in Drizzle
    if (rows.length > 0) {
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
          .returning({ id: schema.tokenTransfers.id })
        totalInserted += inserted.length
      }

      // Only update holder counts if rows were actually inserted (not a replay)
      if (totalInserted > 0) {
        await batchUpdateHolderBalances(rows)
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
      await Promise.all(Array.from(unknownPairs).map(pair => fetchPairTokens(pair, provider)))
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

    if (dexRows.length > 0) {
      for (let i = 0; i < dexRows.length; i += SQL_BATCH_CHUNK) {
        await db.insert(schema.dexTrades).values(dexRows.slice(i, i + SQL_BATCH_CHUNK)).onConflictDoNothing()
      }
    }
  }
}

// ── Batched tx status update ────────────────────────────────────────
/**
 * Update status + gasUsed for N transactions in a single SQL call
 * using a VALUES clause. Previously this was N sequential UPDATEs.
 *
 * Uses VALUES instead of unnest(arr) because Drizzle's sql template
 * serializes JS arrays as record literals (a, b, c) which cannot be
 * cast to text[] at the postgres layer.
 */
async function batchUpdateTxStatus(updates: TxStatusUpdate[]): Promise<void> {
  if (updates.length === 0) return
  const db = getDb()

  for (let i = 0; i < updates.length; i += SQL_BATCH_CHUNK) {
    const chunk = updates.slice(i, i + SQL_BATCH_CHUNK)
    await db.execute(sql`
      UPDATE transactions AS t
      SET status = u.status, gas_used = u.gas_used
      FROM (VALUES ${sql.join(
        chunk.map(u => sql`(${u.hash}, ${u.status}::boolean, ${u.gasUsed.toString()}::bigint)`),
        sql`, `
      )}) AS u(hash, status, gas_used)
      WHERE t.hash = u.hash
    `)
  }
}

// ── Batched addresses upsert ────────────────────────────────────────
async function upsertAddresses(
  txs: Array<{ fromAddress: string; toAddress: string | null }>,
  timestamp: Date,
): Promise<void> {
  const db = getDb()
  const counts = new Map<string, number>()
  for (const tx of txs) {
    counts.set(tx.fromAddress, (counts.get(tx.fromAddress) ?? 0) + 1)
    if (tx.toAddress) counts.set(tx.toAddress, (counts.get(tx.toAddress) ?? 0) + 1)
  }
  if (counts.size === 0) return

  const rows = Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  const ts = timestamp.toISOString()

  for (let i = 0; i < rows.length; i += SQL_BATCH_CHUNK) {
    const chunk = rows.slice(i, i + SQL_BATCH_CHUNK)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await db.execute(sql`
          INSERT INTO addresses (address, balance, tx_count, is_contract, first_seen, last_seen)
          VALUES ${sql.join(
            chunk.map(([addr, cnt]) => sql`(${addr}, '0'::numeric, ${cnt}, false, ${ts}::timestamptz, ${ts}::timestamptz)`),
            sql`, `
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
          name: String(name).slice(0, 255),
          symbol: String(symbol).slice(0, 50),
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
let blockReceiptsSupported = true
let blockReceiptsWarnCount = 0

async function fetchBlockReceipts(
  provider: JsonRpcProvider,
  blockNumber: number,
): Promise<Array<{ txHash: string; receipt: NormalizedReceipt }>> {
  const result: Array<{ txHash: string; receipt: NormalizedReceipt }> = []
  if (!blockReceiptsSupported) return result

  try {
    const blockHex = '0x' + blockNumber.toString(16)
    const raw = await provider.send('eth_getBlockReceipts', [blockHex]) as Array<{
      transactionHash: string
      status: string
      gasUsed: string
      logs: Array<{ address: string; topics: string[]; data: string; logIndex: string }>
    }> | null

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
  } catch (err) {
    blockReceiptsWarnCount++
    if (blockReceiptsWarnCount <= 3) {
      console.warn(`[block-processor] eth_getBlockReceipts failed for block ${blockNumber} (${blockReceiptsWarnCount}/3):`, err instanceof Error ? err.message : err)
    }
    if (blockReceiptsWarnCount >= 3) {
      console.warn('[block-processor] eth_getBlockReceipts failed 3x — disabling batch receipts. Per-tx fallback active (HIGH RPC COST).')
      blockReceiptsSupported = false
    }
  }
  return result
}

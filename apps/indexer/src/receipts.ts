/**
 * eth_getBlockReceipts and the checks that turn a node's answer into NormalizedReceipts:
 * status, effective gas price and log fields are validated here, strictly before
 * processBlock's first write, so a bad endpoint fails over instead of persisting garbage.
 * Moved verbatim out of block-processor.ts. assertReceiptCoverage, which checks the set
 * against the block's transactions, stays with processBlock.
 */
import type { JsonRpcProvider } from 'ethers'

export type NormalizedLog = {
  address: string
  topics: string[]
  data: string
  index: number
}

export type NormalizedReceipt = {
  status: boolean
  gasUsed: bigint
  /**
   * What the transaction actually paid per gas. `tx.gasPrice` is the type-2
   * MAX fee on some nodes (and absent on others), so the receipt is the source of
   * truth; absent here means the node did not report a parseable value.
   */
  effectiveGasPrice?: bigint
  logs: NormalizedLog[]
}

/**
 * A receipt's success flag. `'0x1'` is success, `'0x0'` is failure, and nothing
 * else is guessed at: the old `r.status === '0x1'` stored a missing or garbled
 * status as a FAILED transaction, silently.
 *
 * A receipt with no `status` but a state `root` is pre-Byzantium (before block
 * 4,370,000 on mainnet), which had no failure flag; it counts as success. A
 * receipt with neither proves nothing, so this throws and rpc-failover retries
 * the block on another endpoint (strictly above the first write).
 */
export function parseReceiptStatus(
  r: { transactionHash?: string; status?: string | null; root?: string | null },
  blockNumber: number,
): boolean {
  const s = r.status
  if (s === undefined || s === null) {
    if (typeof r.root === 'string' && r.root.length > 2) return true
    throw new Error(`Block ${blockNumber} receipt for ${r.transactionHash} has neither status nor root`)
  }
  if (typeof s === 'string' && /^0x0*1$/i.test(s)) return true
  if (typeof s === 'string' && /^0x0*$/i.test(s)) return false
  throw new Error(`Block ${blockNumber} receipt for ${r.transactionHash} has unrecognised status ${JSON.stringify(s)}`)
}

/** Secondary field: a missing or malformed value falls back to tx.gasPrice, never throws. */
function parseEffectiveGasPrice(v: unknown): bigint | undefined {
  if (typeof v !== 'string' || !/^0x[0-9a-f]+$/i.test(v)) return undefined
  return BigInt(v)
}

const HEX_QUANTITY = /^0x[0-9a-fA-F]+$/
const TOPIC_RE = /^0x[0-9a-fA-F]{64}$/
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const INT4_MAX = 0x7fffffff

/**
 * Check one receipt log's fields before anything is written. A missing, non-hex or
 * out-of-int4 logIndex, or a topic or address of the wrong shape, used to pass
 * through and only fail at the async transfer writer's INSERT, after the cursor
 * had already moved past the block. The coalesced drain then retried forever with
 * W frozen. Throwing here runs above the first write, so rpc-failover retries the
 * block on another endpoint with nothing to roll back.
 */
function normalizeReceiptLog(l: { address: unknown; topics: unknown; data: string; logIndex: unknown }, where: string) {
  const bad = (field: string, v: unknown) =>
    new Error(`Malformed receipt log (${where}): invalid ${field} ${String(JSON.stringify(v)).slice(0, 80)}`)
  const { address, topics, logIndex } = l
  if (typeof logIndex !== 'string' || !HEX_QUANTITY.test(logIndex) || parseInt(logIndex, 16) > INT4_MAX) {
    throw bad('logIndex', logIndex)
  }
  // EVM logs carry 0–4 topics (LOG0–LOG4), each exactly 32 bytes.
  if (!Array.isArray(topics) || topics.length > 4 || !topics.every(t => typeof t === 'string' && TOPIC_RE.test(t))) {
    throw bad('topics', topics)
  }
  if (typeof address !== 'string' || !ADDRESS_RE.test(address)) throw bad('address', address)
  return { address: address.toLowerCase(), topics: topics as string[], data: l.data, index: parseInt(logIndex, 16) }
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
    status?: string | null
    /** Pre-Byzantium receipts carry a state root instead of a status. */
    root?: string | null
    gasUsed: string
    effectiveGasPrice?: string | null
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
        status: parseReceiptStatus(r, blockNumber),
        gasUsed: BigInt(r.gasUsed),
        effectiveGasPrice: parseEffectiveGasPrice(r.effectiveGasPrice),
        logs: r.logs.map((l, i) => normalizeReceiptLog(l, `block ${blockNumber} tx ${r.transactionHash} log ${i}`)),
      },
    })
  }
  return result
}

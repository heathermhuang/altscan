/**
 * Pure decision for how the tx-detail page should source a transaction. Kept out of
 * the server component so it is unit-testable without a DB or RPC.
 *  - 'local'  : compact row present, body not pruned → render entirely from DB.
 *  - 'pruned' : compact row present but its heavy body (input/logs) was pruned by
 *               retention → render compact from DB, refetch input+logs on demand.
 *  - 'rpc'    : no row at all (predates the local index) → render entirely from RPC.
 *  - 'missing': neither DB nor RPC has it → 404.
 */
export type DbTxLike = { bodyPruned?: boolean | null } | null | undefined
export type RpcTxLike = unknown | null | undefined
export type TxViewKind = 'local' | 'pruned' | 'rpc' | 'missing'

export function resolveTxViewKind(dbTx: DbTxLike, rpcTx: RpcTxLike): TxViewKind {
  if (dbTx) return dbTx.bodyPruned ? 'pruned' : 'local'
  if (rpcTx) return 'rpc'
  return 'missing'
}

export type TxOutcome = 'success' | 'failed' | 'pending'

/**
 * What the page may say a tx did. `pending` (no receipt yet) wins over `status`: rpc-fallback has
 * no receipt to read it from and fills it with `true`, which is a placeholder, not a result.
 */
export function txOutcome(tx: { status: boolean; pending?: boolean }): TxOutcome {
  if (tx.pending) return 'pending'
  return tx.status ? 'success' : 'failed'
}

export const TX_OUTCOME_LABEL: Record<TxOutcome, string> = { success: 'Success', failed: 'Failed', pending: 'Pending' }

/** What the page writes beside a token-transfer row it decoded from calldata rather than read from logs. */
export const CALLDATA_TRANSFER_LABEL = 'from calldata, unverified'

/**
 * May the page synthesize a token-transfer row from transfer(address,uint256) calldata? Only for a tx
 * that succeeded whose logs are UNKNOWN (the body fetch failed), with no real transfers to show. A
 * failed or pending tx moved nothing, and logs that were read and held no Transfer say the call was
 * not a token transfer: a row from its calldata would show a movement that did not happen.
 */
export function mayShowCalldataTransfer(opts: {
  methodId: string | null
  outcome: TxOutcome
  /** The receipt logs could not be obtained (unknown), as opposed to obtained and empty. */
  logsUnavailable: boolean
  knownTransfers: number
}): boolean {
  return opts.methodId === '0xa9059cbb' && opts.outcome === 'success' && opts.logsUnavailable && opts.knownTransfers === 0
}

/**
 * A USD figure for a transaction's value or fee. The page prices it at today's native price (there is no
 * price history), which is not what it was worth when the transaction ran: say so.
 */
export function atCurrentPrice(usd: string): string {
  return `${usd} at current price`
}

/**
 * How much of a transaction's input the indexer keeps: the first 500 characters ('0x' + 249 bytes),
 * with body_pruned left false (apps/indexer/src/block-processor.ts; keep the two in step). An input
 * stored at exactly this length may be the whole input or a cut one: the row cannot say which.
 */
export const STORED_INPUT_CHARS = 500
export const STORED_INPUT_BYTES = (STORED_INPUT_CHARS - 2) / 2

export function inputMayBeTruncated(input: string | null | undefined): boolean {
  return !!input && input.length >= STORED_INPUT_CHARS
}

/** What the page says under an input it could only show the stored prefix of. */
export const TRUNCATED_INPUT_NOTE =
  `Only the first ${STORED_INPUT_BYTES} bytes of this input are stored, and the full input is unavailable right now, so what is shown is cut short.`

/**
 * Does an indexed tx's stored input need the node's copy? Not the 'pruned' and 'rpc' views: the first
 * already refetches input and logs together (getTxBody), and the second is the node's own answer.
 */
export function needsInputRefetch(kind: TxViewKind, storedInput: string | null | undefined): boolean {
  return kind === 'local' && inputMayBeTruncated(storedInput)
}

/**
 * The input of an indexed tx to show, and whether it may still be cut. A fetched copy replaces the
 * stored prefix only if it extends it: a node that answers with something else has not given us this
 * transaction's input.
 */
export function resolveStoredInput(
  stored: string | null | undefined,
  fetched: string | null | undefined,
): { input: string; truncated: boolean } {
  const input = stored ?? '0x'
  if (!inputMayBeTruncated(input)) return { input, truncated: false }
  if (fetched != null && fetched.length >= input.length && fetched.toLowerCase().startsWith(input.toLowerCase())) {
    return { input: fetched, truncated: false }
  }
  return { input, truncated: true }
}

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

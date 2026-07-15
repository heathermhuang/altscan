/**
 * Retention policy manifest — the single source of truth for what the retention
 * job may prune, imported by BOTH retention-cleanup.ts (execution) and
 * retention-policy.test.ts (guardrail). The classification lives here (not inline
 * in the job) so the guardrail verifies shipped behavior, not a parallel copy.
 *
 * Model (design §4):
 *  - COMPACT_TABLES hold permanent, non-refetchable indexes. Rows are immortal on
 *    the default path.
 *  - BODY_PRUNE_OPS remove only refetchable heavy data older than the hot window:
 *    whole-row deletes of logs/dex_trades/gas_history, plus an in-place null of the
 *    heavy transactions.input column (row kept, body_pruned flag set).
 *  - COMPACT_PRUNE_TABLES are pruned ONLY when COMPACT_RETENTION_DAYS is finite
 *    (an explicit per-chain bridge for the heavy legacy chains; default = immortal).
 */

export const COMPACT_TABLES = [
  'transactions', 'token_transfers', 'token_balances',
  'tokens', 'blocks', 'addresses', 'contracts',
] as const
export type CompactTable = typeof COMPACT_TABLES[number]

export type PruneOp =
  | { table: string; kind: 'delete-rows' }
  | { table: string; kind: 'null-column'; column: string; sentinel: string; flagColumn: string }

// The ONLY age-based prunes the default (body-cutoff) path may perform.
export const BODY_PRUNE_OPS: PruneOp[] = [
  { table: 'logs',         kind: 'delete-rows' },
  { table: 'dex_trades',   kind: 'delete-rows' },
  { table: 'gas_history',  kind: 'delete-rows' },
  { table: 'transactions', kind: 'null-column', column: 'input', sentinel: '0x', flagColumn: 'body_pruned' },
]

// Pruned ONLY under a finite COMPACT_RETENTION_DAYS. Order = FK-safe delete order
// (transactions before blocks; token_transfers has no blocks FK). token_transfers
// is dropped by partition when partitioned — the caller special-cases that.
export const COMPACT_PRUNE_TABLES = ['token_transfers', 'transactions', 'blocks'] as const

/** Key / index columns a null-column op must never touch. */
export const PROTECTED_COLUMNS = new Set([
  'hash', 'block_number', 'from_address', 'to_address', 'timestamp',
  'method_id', 'tx_index', 'number', 'token_address', 'log_index', 'body_pruned',
])

/** COMPACT_RETENTION_DAYS as a number; Infinity (immortal) when unset/invalid/≤0. */
export function parseCompactRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const v = env.COMPACT_RETENTION_DAYS
  if (!v) return Infinity
  const n = parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : Infinity
}

/** Compact tables the job will prune for a given env — [] on the default path. */
export function resolveCompactPruneTables(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return Number.isFinite(parseCompactRetentionDays(env)) ? COMPACT_PRUNE_TABLES : []
}

export type RetentionPlan = {
  bodyDeleteTables: string[]
  nullColumnOps: Extract<PruneOp, { kind: 'null-column' }>[]
  compactDeleteTables: string[]
}

/**
 * Resolve the concrete prune actions for a given env + partition state. Pure — no
 * DB. This is exactly what the guardrail asserts against, and what the job iterates.
 */
export function buildRetentionPlan(opts: { env?: NodeJS.ProcessEnv; ttPartitioned: boolean }): RetentionPlan {
  const env = opts.env ?? process.env
  const bodyDeleteTables = BODY_PRUNE_OPS.filter(o => o.kind === 'delete-rows').map(o => o.table)
  const nullColumnOps = BODY_PRUNE_OPS.filter(
    (o): o is Extract<PruneOp, { kind: 'null-column' }> => o.kind === 'null-column',
  )
  const compactDeleteTables = [...resolveCompactPruneTables(env)]
  return { bodyDeleteTables, nullColumnOps, compactDeleteTables }
}

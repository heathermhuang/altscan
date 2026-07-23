import { describe, expect, it } from 'vitest'
import { tableIdent, partitionIdent } from './retention-cleanup'

/**
 * O2 (plan §OPEN DESIGN DECISIONS): the retention job's destructive statements
 * must be constructable ONLY from a whitelisted base table or a real
 * token_transfers partition — never a `backfill_*` table. `tableIdent` and
 * `partitionIdent` are the sole constructors of the `SafeIdent` that every
 * destructive primitive requires, so if they reject backfill names (here) and
 * the primitives accept nothing else (enforced by the compiler), no backfill
 * table can reach a DELETE / DROP / UPDATE / VACUUM. These are the runtime half
 * of that guarantee; the type half is pinned by @ts-expect-error below.
 */

const BACKFILL_TABLES = [
  'backfill_address_txs',
  'backfill_token_transfers',
  'backfill_watermarks',
  'backfill_budget',
]

const ALLOWED = [
  'dex_trades', 'token_transfers', 'transactions', 'gas_history', 'blocks', 'logs', 'token_balances',
] as const

describe('tableIdent — whitelisted base tables only', () => {
  it('accepts every whitelisted table and yields its identifier', () => {
    for (const t of ALLOWED) {
      expect(tableIdent(t)).toBe(t)
    }
  })

  it('rejects every backfill table at runtime (even through an as-any escape)', () => {
    for (const t of BACKFILL_TABLES) {
      expect(() => tableIdent(t as unknown as typeof ALLOWED[number]), t).toThrow(/whitelist/i)
    }
  })

  it('rejects a token_transfers child partition (not a base table)', () => {
    expect(() => tableIdent('token_transfers_p_111000000' as unknown as typeof ALLOWED[number]))
      .toThrow(/whitelist/i)
  })
})

describe('partitionIdent — token_transfers child partitions only', () => {
  it('accepts the real partition names this codebase creates', () => {
    for (const name of ['token_transfers_legacy', 'token_transfers_p_111000000', 'token_transfers_p0']) {
      expect(partitionIdent(name)).toBe(name)
    }
  })

  it('rejects every backfill table', () => {
    for (const t of BACKFILL_TABLES) {
      expect(() => partitionIdent(t), t).toThrow(/partition/i)
    }
  })

  it('rejects a non-token_transfers base table (no prefix)', () => {
    for (const t of ['transactions', 'blocks', 'token_transfers']) {
      expect(() => partitionIdent(t), t).toThrow(/partition/i)
    }
  })

  it('rejects injection-shaped names', () => {
    for (const bad of ['token_transfers_p1; DROP TABLE blocks;--', 'token_transfers_p 1', 'Token_Transfers_p1', '']) {
      expect(() => partitionIdent(bad), JSON.stringify(bad)).toThrow()
    }
  })
})

describe('O2 type wall — a backfill literal cannot even be named as a table', () => {
  it('rejects backfill tables at compile time (union excludes them)', () => {
    // @ts-expect-error 'backfill_address_txs' is not an AllowedTable
    expect(() => tableIdent('backfill_address_txs')).toThrow()
  })
})

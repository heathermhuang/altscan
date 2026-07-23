import { describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { tableIdent, partitionIdent, identSql } from './retention-cleanup'

/**
 * O2 (plan §OPEN DESIGN DECISIONS): the retention job's destructive statements
 * must be constructable ONLY from a whitelisted base table or a real
 * token_transfers partition — never a `backfill_*` table. `tableIdent` and
 * `partitionIdent` are the sole constructors of the `SafeIdent` that every
 * destructive primitive requires, so if they reject backfill names (here) and
 * the primitives accept nothing else (enforced by the compiler), no backfill
 * table can reach a DELETE / DROP / UPDATE / VACUUM. These are the runtime half
 * of that guarantee; the type half is pinned by @ts-expect-error below.
 *
 * O2 P1 (codex round 3): a partition is discovered by OID (pg_inherits) but a
 * bare, unqualified DROP/DELETE re-resolves the name through `search_path` — a
 * same-named table in an earlier schema could be dropped instead. So a partition
 * SafeIdent now carries its discovered schema and `identSql` renders it
 * SCHEMA-QUALIFIED. The rendering tests below pin that: discovery and execution
 * target the same physical relation, no search_path redirection.
 */

const dialect = new PgDialect()
/** The exact identifier SQL a SafeIdent interpolates into a destructive statement. */
const renderIdent = (ident: Parameters<typeof identSql>[0]) => dialect.sqlToQuery(identSql(ident)).sql

const BACKFILL_TABLES = [
  'backfill_address_txs',
  'backfill_token_transfers',
  'backfill_watermarks',
  'backfill_budget',
]

const ALLOWED = [
  'dex_trades', 'token_transfers', 'transactions', 'gas_history', 'blocks', 'logs', 'token_balances',
] as const

describe('tableIdent — whitelisted base tables only, unqualified (search_path)', () => {
  it('accepts every whitelisted table and renders it as a bare quoted identifier', () => {
    for (const t of ALLOWED) {
      const id = tableIdent(t)
      expect(id.name).toBe(t)
      // Base tables stay bare: they are the same names the app writes via
      // search_path, and there is no OID-discovery step to diverge from.
      expect(id.schema).toBeNull()
      expect(renderIdent(id)).toBe(`"${t}"`)
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

describe('partitionIdent — token_transfers child partitions, schema-qualified', () => {
  it('accepts the real partition names this codebase creates and carries the discovered schema', () => {
    for (const name of ['token_transfers_legacy', 'token_transfers_p_111000000', 'token_transfers_p0']) {
      const id = partitionIdent(name, 'public')
      expect(id.name).toBe(name)
      expect(id.schema).toBe('public')
    }
  })

  it('renders SCHEMA-QUALIFIED so DROP/DELETE cannot be redirected by search_path (O2 P1 fix)', () => {
    expect(renderIdent(partitionIdent('token_transfers_p0', 'public')))
      .toBe('"public"."token_transfers_p0"')
    // A non-default schema must be honored exactly — discovery and execution agree.
    expect(renderIdent(partitionIdent('token_transfers_legacy', 'analytics')))
      .toBe('"analytics"."token_transfers_legacy"')
  })

  it('rejects every backfill table', () => {
    for (const t of BACKFILL_TABLES) {
      expect(() => partitionIdent(t, 'public'), t).toThrow(/partition/i)
    }
  })

  it('rejects a non-token_transfers base table (no prefix)', () => {
    for (const t of ['transactions', 'blocks', 'token_transfers']) {
      expect(() => partitionIdent(t, 'public'), t).toThrow(/partition/i)
    }
  })

  it('rejects injection-shaped partition names', () => {
    for (const bad of ['token_transfers_p1; DROP TABLE blocks;--', 'token_transfers_p 1', 'Token_Transfers_p1', '']) {
      expect(() => partitionIdent(bad, 'public'), JSON.stringify(bad)).toThrow(/partition/i)
    }
  })

  it('rejects injection-shaped, empty, or non-lowercase schema names', () => {
    for (const badSchema of ['public; DROP TABLE blocks;--', 'pub lic', 'pu"blic', '', 'Public', '1public']) {
      expect(() => partitionIdent('token_transfers_p0', badSchema), JSON.stringify(badSchema)).toThrow(/schema/i)
    }
  })
})

describe('O2 type wall — a backfill literal cannot even be named as a table', () => {
  it('rejects backfill tables at compile time (union excludes them)', () => {
    // @ts-expect-error 'backfill_address_txs' is not an AllowedTable
    expect(() => tableIdent('backfill_address_txs')).toThrow()
  })
})

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COMPACT_TABLES, BODY_PRUNE_OPS, COMPACT_PRUNE_TABLES, PROTECTED_COLUMNS,
  resolveCompactPruneTables, buildRetentionPlan,
} from './retention-policy'

describe('retention guardrail — compact indexes are immortal on the default path', () => {
  const compact = new Set<string>(COMPACT_TABLES)

  it('no whole-row delete op targets a compact table', () => {
    const rowDeletes = BODY_PRUNE_OPS.filter(o => o.kind === 'delete-rows').map(o => o.table)
    for (const t of rowDeletes) {
      expect(compact.has(t), `body delete must not target compact table ${t}`).toBe(false)
    }
  })

  it('null-column ops only null non-key body columns', () => {
    for (const op of BODY_PRUNE_OPS) {
      if (op.kind !== 'null-column') continue
      expect(PROTECTED_COLUMNS.has(op.column), `must not null protected column ${op.column}`).toBe(false)
      expect(op.column).toBe('input')
    }
  })

  it('default env prunes ZERO compact tables (partitioned or not)', () => {
    expect(resolveCompactPruneTables({})).toEqual([])
    expect(buildRetentionPlan({ env: {}, ttPartitioned: false }).compactDeleteTables).toEqual([])
    expect(buildRetentionPlan({ env: {}, ttPartitioned: true }).compactDeleteTables).toEqual([])
  })

  it('finite COMPACT_RETENTION_DAYS enables exactly the compact bridge tables', () => {
    expect(resolveCompactPruneTables({ COMPACT_RETENTION_DAYS: '180' })).toEqual([...COMPACT_PRUNE_TABLES])
    expect(buildRetentionPlan({ env: { COMPACT_RETENTION_DAYS: '180' }, ttPartitioned: false }).compactDeleteTables)
      .toEqual([...COMPACT_PRUNE_TABLES])
  })

  it('invalid / non-positive COMPACT_RETENTION_DAYS stays immortal (fails safe)', () => {
    for (const v of ['', '0', '-5', 'abc']) {
      expect(resolveCompactPruneTables({ COMPACT_RETENTION_DAYS: v }), `value ${JSON.stringify(v)}`).toEqual([])
    }
  })

  it('body delete tables are the refetchable/secondary ones only', () => {
    expect(buildRetentionPlan({ env: {}, ttPartitioned: true }).bodyDeleteTables)
      .toEqual(['logs', 'dex_trades', 'gas_history'])
  })

  // The compact-bridge block also sweeps body tables to the compact cutoff (so a
  // compact cutoff newer than the body cutoff can't strand orphaned body rows).
  // That sweep iterates plan.bodyDeleteTables — pin that under a finite-compact
  // env it is still exactly the refetchable set and never a compact table.
  it('body sweep input under a finite compact env is still never a compact table', () => {
    const plan = buildRetentionPlan({ env: { COMPACT_RETENTION_DAYS: '4' }, ttPartitioned: false })
    expect(plan.bodyDeleteTables).toEqual(['logs', 'dex_trades', 'gas_history'])
    for (const t of plan.bodyDeleteTables) {
      expect(compact.has(t), `body sweep must not target compact table ${t}`).toBe(false)
    }
  })
})

/**
 * A4b Invariant 1: retention can NEVER touch the backfill_* tables.
 *
 * These tables are immortal by construction — they are simply never added to
 * any retention manifest. That is a stronger guarantee than a conditional
 * flag, but only if it stays true, so it is pinned two ways:
 *
 *  1. a disjointness check against everything buildRetentionPlan() emits, and
 *  2. a SOURCE SCAN, because most of the destructive SQL in retention-cleanup
 *     never goes through buildRetentionPlan at all — the zero-balance delete,
 *     the VACUUM / VACUUM FULL table lists, the partition drop, and the
 *     emergency reruns are all hardcoded. A disjointness test alone would
 *     happily pass while someone hand-wrote `DELETE FROM backfill_address_txs`
 *     into one of those paths.
 */

/** Read a retention source file without `import.meta` (the indexer tsconfig's
 *  module setting rejects it) and without assuming vitest's cwd. */
function readRetentionSource(name: string): string {
  const candidates = [
    resolve(process.cwd(), 'apps/indexer/src', name),   // repo root (normal)
    resolve(process.cwd(), 'src', name),                // run from apps/indexer
    resolve(process.cwd(), name),
  ]
  const hit = candidates.find(existsSync)
  if (!hit) throw new Error(`cannot locate ${name} from cwd ${process.cwd()}`)
  return readFileSync(hit, 'utf8')
}

describe('A4b invariant 1 — backfill tables are retention-exempt by construction', () => {
  const BACKFILL_TABLES = [
    'backfill_address_txs',
    'backfill_token_transfers',
    'backfill_watermarks',
    'backfill_budget',
  ]

  it('no backfill table appears in any retention manifest', () => {
    const manifest = new Set<string>([
      ...COMPACT_TABLES,
      ...COMPACT_PRUNE_TABLES,
      ...BODY_PRUNE_OPS.map(o => o.table),
    ])
    for (const t of BACKFILL_TABLES) expect(manifest.has(t)).toBe(false)
  })

  it('no backfill table appears in any buildRetentionPlan output, under any env', () => {
    const envs: NodeJS.ProcessEnv[] = [
      {},
      { COMPACT_RETENTION_DAYS: '2' },
      { COMPACT_RETENTION_DAYS: '0' },
      { COMPACT_RETENTION_DAYS: 'nonsense' },
      { COMPACT_RETENTION_DAYS: '1', COMPACT_PRUNE_TABLES: 'transactions,blocks' },
    ]
    for (const env of envs) {
      for (const ttPartitioned of [true, false]) {
        const plan = buildRetentionPlan({ env, ttPartitioned })
        const touched = [
          ...plan.bodyDeleteTables,
          ...plan.compactDeleteTables,
          ...plan.nullColumnOps.map(o => o.table),
        ]
        for (const t of BACKFILL_TABLES) expect(touched).not.toContain(t)
      }
    }
  })

  it('a hostile COMPACT_PRUNE_TABLES env cannot smuggle a backfill table in', () => {
    // Note the actual mechanism: resolveCompactPruneTables IGNORES the env var
    // entirely and returns the hardcoded COMPACT_PRUNE_TABLES const whenever
    // the retention days parse finite. So env injection is impossible by
    // construction, not by filtering. This test pins that property — if anyone
    // ever makes that function read the env, this is what catches it.
    const plan = buildRetentionPlan({
      env: { COMPACT_RETENTION_DAYS: '1', COMPACT_PRUNE_TABLES: 'backfill_address_txs,transactions' },
      ttPartitioned: false,
    })
    expect(plan.compactDeleteTables).not.toContain('backfill_address_txs')
  })

  it('SOURCE SCAN: no backfill table appears in a DESTRUCTIVE retention statement', () => {
    // This is the check that actually covers the hardcoded destructive paths —
    // the zero-balance delete, the VACUUM / VACUUM FULL lists, the partition
    // drop, the emergency reruns — none of which go through buildRetentionPlan.
    //
    // Scoped to destructive verbs rather than banning the identifier outright,
    // because reportSizes() legitimately reads backfill sizes for the `bf=`
    // term. Banning every mention would have forced that observability out of
    // the file for no safety gain; what actually must never happen is a
    // backfill table reaching a statement that removes data.
    const DESTRUCTIVE = /\b(DELETE\s+FROM|DROP\s+TABLE|TRUNCATE|VACUUM(\s+FULL)?|ALTER\s+TABLE)\b/i
    const files = ['retention-cleanup.ts', 'retention-policy.ts']

    for (const rel of files) {
      const src = readRetentionSource(rel)
      // Require a real table name after the underscore — a bare `backfill_`
      // appearing in prose is not an identifier.
      const IDENT = /\bbackfill_[a-z]+[a-z_]*\b/g
      const lines = src.split('\n')
      lines.forEach((line, i) => {
        if (!new RegExp(IDENT.source).test(line)) return
        expect(
          DESTRUCTIVE.test(line),
          `${rel}:${i + 1} references a backfill table in a destructive statement: ${line.trim()}`,
        ).toBe(false)
      })

      // Whatever backfill_ references DO exist must be read-only size probes.
      const refs = src.match(IDENT) ?? []
      const allowed = new Set(['backfill_address_txs', 'backfill_token_transfers'])
      for (const r of refs) {
        expect(allowed.has(r), `${rel}: unexpected backfill identifier "${r}"`).toBe(true)
      }
    }
  })

  it('SOURCE SCAN: no backfill table is in retention-cleanup ALLOWED_TABLES', () => {
    // ALLOWED_TABLES is the second, independent gate — every prune identifier
    // is asserted against it. A backfill table landing here would make the
    // hardcoded paths above reachable.
    const src = readRetentionSource('retention-cleanup.ts')
    const block = src.match(/const ALLOWED_TABLES = new Set\(\[([\s\S]*?)\]\)/)
    expect(block, 'ALLOWED_TABLES set not found — did it get renamed?').toBeTruthy()
    expect(block![1]).not.toMatch(/backfill/)
  })
})

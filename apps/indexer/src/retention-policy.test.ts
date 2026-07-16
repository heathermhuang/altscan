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

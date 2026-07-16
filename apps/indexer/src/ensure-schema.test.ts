import { describe, expect, it } from 'vitest'
import { buildConcurrentIndexList } from './ensure-schema'
import { BODY_PRUNE_OPS, type PruneOp } from './retention-policy'

describe('buildConcurrentIndexList', () => {
  it('emits only CREATE INDEX CONCURRENTLY IF NOT EXISTS statements (idempotent, non-blocking boot)', () => {
    for (const ttPartitioned of [false, true]) {
      const stmts = buildConcurrentIndexList(ttPartitioned)
      expect(stmts.length).toBeGreaterThan(0)
      for (const stmt of stmts) {
        expect(stmt).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS /)
      }
    }
  })

  it('skips token_transfers index DDL when partitioned (migration owns those), all else unchanged', () => {
    const mono = buildConcurrentIndexList(false)
    const part = buildConcurrentIndexList(true)
    expect(mono.some(s => s.includes('ON token_transfers('))).toBe(true)
    expect(part.some(s => s.includes('ON token_transfers('))).toBe(false)
    expect(part).toEqual(mono.filter(s => !s.includes('ON token_transfers(')))
  })

  // pruneTransactionBodies batches on `block_number < cutoff AND body_pruned = false`.
  // Through the plain tx_block_idx that scan re-walks the ever-growing pruned prefix
  // on every batch — O(prefix × batches) once COMPACT_RETENTION_DAYS > RETENTION_DAYS
  // lets pruned rows persist. The partial index bounds each batch to unpruned rows,
  // but ONLY if its WHERE predicate is implied by the query's — so pin the exact
  // spelling `<flagColumn> = false` against the retention manifest's flag column.
  it('has the tx_body_unpruned_idx partial index matching the body-prune batch predicate', () => {
    const inputOp = BODY_PRUNE_OPS.find(
      (o): o is Extract<PruneOp, { kind: 'null-column' }> =>
        o.kind === 'null-column' && o.table === 'transactions',
    )
    expect(inputOp).toBeDefined()
    for (const ttPartitioned of [false, true]) {
      const stmts = buildConcurrentIndexList(ttPartitioned)
        .filter(s => s.includes('tx_body_unpruned_idx'))
      expect(stmts, `partitioned=${ttPartitioned}`).toHaveLength(1)
      const normalized = stmts[0].replace(/\s+/g, ' ').trim()
      expect(normalized).toContain('ON transactions(block_number)')
      expect(normalized.endsWith(`WHERE ${inputOp!.flagColumn} = false`)).toBe(true)
    }
  })
})

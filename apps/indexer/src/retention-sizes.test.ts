import { describe, expect, it } from 'vitest'
import { sizeReportSql } from './retention-cleanup'

/**
 * The sizes line is the retention dead-man-switch, so the query behind it must
 * measure what is actually on disk. pg_total_relation_size() on a partitioned
 * PARENT returns only the parent's own storage — zero — which made BNB report
 * tt=0MB while ~55GB of token_transfers partitions (the largest object in the
 * DB) stayed invisible. The fix walks the inheritance tree via pg_inherits and
 * sums every relation under each named root.
 *
 * These tests pin the query's load-bearing properties textually; the
 * behavioral check (partitioned parent sums its children, plain tables are
 * unchanged, missing tables drop out) can only run against a real Postgres —
 * verified against a live PG 16 + prod BNB before this shipped.
 */
describe('sizeReportSql — partition-aware size query', () => {
  const sql = sizeReportSql(['transactions', 'token_transfers'])

  it('walks the inheritance tree instead of sizing only the named parent', () => {
    // Reverting to a bare per-table pg_total_relation_size('name') loses the
    // recursion and reintroduces tt=0MB on any partitioned table.
    expect(sql).toMatch(/WITH RECURSIVE/i)
    expect(sql).toMatch(/pg_inherits/)
    expect(sql).toMatch(/inhparent/)
    expect(sql).toMatch(/inhrelid/)
    expect(sql).toMatch(/SUM\(pg_total_relation_size\(oid\)\)/i)
  })

  it('resolves names null-safely so a missing table cannot throw mid-report', () => {
    // Bare pg_total_relation_size('name') on a nonexistent relation raises and
    // would take the whole retention run's size report down with it.
    expect(sql).toMatch(/to_regclass\(v\.name\) IS NOT NULL/)
    expect(sql).not.toMatch(/pg_total_relation_size\('/)
  })

  it('embeds every requested table exactly once, de-duplicated', () => {
    expect(sql).toContain(`('transactions')`)
    expect(sql).toContain(`('token_transfers')`)
    const dup = sizeReportSql(['blocks', 'blocks'])
    // A duplicated VALUES row would traverse the same tree twice and
    // double-count every byte under it.
    expect(dup.match(/\('blocks'\)/g)).toHaveLength(1)
  })

  it('refuses anything that is not a bare lowercase identifier', () => {
    // The names are embedded via sql.raw — same shape rule as
    // assertAllowedIdentifier, enforced even for compile-time constants.
    for (const bad of [`x'); DROP TABLE blocks;--`, 'Token_Transfers', 'a b', '']) {
      expect(() => sizeReportSql([bad]), JSON.stringify(bad)).toThrow()
    }
  })
})

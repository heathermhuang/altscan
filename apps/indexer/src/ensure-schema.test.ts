import { describe, expect, it } from 'vitest'
import {
  buildConcurrentIndexList,
  buildPartitionedWhaleIndexSql,
  TT_TOKEN_TS_COLUMNS,
  TT_TOKEN_TS_IDX,
  INVALID_INDEX_SWEEP_SQL,
} from './ensure-schema'
import { BODY_PRUNE_OPS, type PruneOp } from './retention-policy'
import { getChainConfig, type ChainKey } from '@altscan/chain-config'

const FLOOR = '1000000000000000000'

describe('buildConcurrentIndexList', () => {
  // The two properties that actually matter for boot: CONCURRENTLY (never takes a
  // blocking lock behind the outgoing instance's writes) and IF NOT EXISTS
  // (idempotent across restarts). UNIQUE is permitted — dex_tx_log_unique is what
  // makes a dex_trades replay dedupable — but nothing else may vary.
  it('emits only CONCURRENTLY + IF NOT EXISTS statements (idempotent, non-blocking boot)', () => {
    for (const ttPartitioned of [false, true]) {
      const stmts = buildConcurrentIndexList(ttPartitioned, FLOOR)
      expect(stmts.length).toBeGreaterThan(0)
      for (const stmt of stmts) {
        expect(stmt).toMatch(/^CREATE (UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS /)
      }
    }
  })

  // The unique index is the one statement here that could FAIL on real data, so
  // its PARTIAL predicate is what keeps the boot path safe on a populated table.
  it('builds dex_tx_log_unique on the natural key, in both partition modes', () => {
    for (const ttPartitioned of [false, true]) {
      const stmts = buildConcurrentIndexList(ttPartitioned, FLOOR)
        .filter(s => s.includes('dex_tx_log_unique'))
      expect(stmts, `partitioned=${ttPartitioned}`).toHaveLength(1)
      expect(stmts[0]).toMatch(/^CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS /)
      expect(stmts[0]).toContain('ON dex_trades(tx_hash, log_index)')
      // PARTIAL is load-bearing: it excludes rows predating the column, so the
      // build cannot fail on legacy data and no migration has to precede it.
      expect(stmts[0]).toContain('WHERE log_index IS NOT NULL')
    }
  })

  it('skips token_transfers index DDL when partitioned (migration owns those), all else unchanged', () => {
    const mono = buildConcurrentIndexList(false, FLOOR)
    const part = buildConcurrentIndexList(true, FLOOR)
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
      const stmts = buildConcurrentIndexList(ttPartitioned, FLOOR)
        .filter(s => s.includes('tx_body_unpruned_idx'))
      expect(stmts, `partitioned=${ttPartitioned}`).toHaveLength(1)
      const normalized = stmts[0].replace(/\s+/g, ' ').trim()
      expect(normalized).toContain('ON transactions(block_number)')
      expect(normalized.endsWith(`WHERE ${inputOp!.flagColumn} = false`)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Whale Tracker composite indexes.
//
// Both were written into scripts/db-optimize.sql in da8e513 (2026-04-08) with
// the comment "for whale tracker page", and NOTHING has ever executed that file
// — the only reference to it is an echo in db-maintenance.sh telling a human to
// run it. Verified 2026-08-27 against both production databases: neither index
// exists on either chain. The queries were consequently sequential scans, 32-37s
// measured on ETH and >60s on BNB, against the page's own 15s timeout — so
// /whales served "Couldn't load whale transfers right now" on 5 of 6
// chain x period combinations while the market was fine.
// ---------------------------------------------------------------------------
describe('whale tracker indexes', () => {
  // The native half: `WHERE timestamp >= cutoff AND value > threshold
  // ORDER BY value DESC LIMIT 25`. transactions is never partitioned, so this
  // one is a plain entry in both modes.
  it('creates tx_ts_value_idx in both partition modes', () => {
    for (const ttPartitioned of [false, true]) {
      const stmts = buildConcurrentIndexList(ttPartitioned, FLOOR)
        .filter(s => s.includes('tx_ts_value_idx'))
      expect(stmts, `partitioned=${ttPartitioned}`).toHaveLength(1)
      expect(stmts[0]).toContain('ON transactions(timestamp DESC, value DESC)')
    }
  })

  // The token half. On the monolithic table it is an ordinary CONCURRENTLY
  // build; when partitioned it MUST be absent here, because CONCURRENTLY is
  // rejected on a partitioned parent — ensurePartitionedWhaleIndex() owns it
  // instead. Absence in the partitioned list is therefore load-bearing, not
  // an omission, so pin it by name rather than relying on the generic
  // "no ON token_transfers( when partitioned" assertion above.
  it('creates tt_token_ts_idx inline only when token_transfers is monolithic', () => {
    const mono = buildConcurrentIndexList(false, FLOOR).filter(s => s.includes(TT_TOKEN_TS_IDX))
    expect(mono).toHaveLength(1)
    expect(mono[0]).toContain(`ON token_transfers(${TT_TOKEN_TS_COLUMNS})`)

    expect(buildConcurrentIndexList(true, FLOOR).filter(s => s.includes(TT_TOKEN_TS_IDX))).toHaveLength(0)
  })

  // ALTER INDEX ... ATTACH PARTITION only accepts a child whose definition
  // matches the parent's exactly. The monolithic statement and the partitioned
  // builder are written in two different places, so pin them to one shared
  // column list — a silent divergence would not fail until the ATTACH runs
  // against production data.
  it('builds the same column list on both the monolithic and partitioned paths', () => {
    const mono = buildConcurrentIndexList(false, FLOOR).find(s => s.includes(TT_TOKEN_TS_IDX))!
    expect(mono).toContain(`(${TT_TOKEN_TS_COLUMNS})`)
    expect(buildPartitionedWhaleIndexSql('token_transfers_p_1').parent)
      .toContain(`(${TT_TOKEN_TS_COLUMNS})`)
    expect(buildPartitionedWhaleIndexSql('token_transfers_p_1').child)
      .toContain(`(${TT_TOKEN_TS_COLUMNS})`)
  })

  // The parent index is created ON ONLY and is INVALID until every partition is
  // attached; only the per-partition children may use CONCURRENTLY.
  it('creates the parent ON ONLY and each child CONCURRENTLY', () => {
    const { parent, child, attach } = buildPartitionedWhaleIndexSql('token_transfers_p_42')
    expect(parent).toMatch(/^CREATE INDEX IF NOT EXISTS \S+ ON ONLY token_transfers\(/)
    expect(parent).not.toContain('CONCURRENTLY')   // rejected on a partitioned parent
    expect(child).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS \S+ ON token_transfers_p_42\(/)
    expect(attach).toBe(`ALTER INDEX ${TT_TOKEN_TS_IDX} ATTACH PARTITION tt_token_ts_p_42`)
  })

  // Child index names must be unique per partition and stable across boots, or
  // IF NOT EXISTS stops being idempotent and every restart rebuilds them.
  it('derives a distinct, stable child name per partition', () => {
    const a = buildPartitionedWhaleIndexSql('token_transfers_p_118938552')
    const b = buildPartitionedWhaleIndexSql('token_transfers_p_118842552')
    expect(a.childName).not.toBe(b.childName)
    expect(a.childName).toBe(buildPartitionedWhaleIndexSql('token_transfers_p_118938552').childName)
    // Postgres truncates identifiers at 63 bytes; a truncated collision would
    // silently attach the wrong child.
    expect(a.childName.length).toBeLessThanOrEqual(63)
  })
})

// The one change in this area that no test caught until it was written: reverting
// the sweep to a bare `NOT i.indisvalid` leaves every other test green while
// silently deleting tt_token_ts_idx on any boot that lands mid-build, along with
// the partition children already attached to it. Pin the filter.
describe('INVALID_INDEX_SWEEP_SQL', () => {
  it('only ever sweeps ordinary leaf indexes, never partitioned parents', () => {
    expect(INVALID_INDEX_SWEEP_SQL).toMatch(/NOT\s+i\.indisvalid/)
    expect(INVALID_INDEX_SWEEP_SQL).toMatch(/c\.relkind\s*=\s*'i'/)
    // 'I' is the partitioned-index relkind; matching it would reintroduce the bug.
    expect(INVALID_INDEX_SWEEP_SQL).not.toMatch(/relkind\s*=\s*'I'/)
    expect(INVALID_INDEX_SWEEP_SQL).not.toMatch(/relkind\s+IN/i)
  })
})

describe('tx_whale_value_idx', () => {
  const stmtFor = (floor: string) =>
    buildConcurrentIndexList(false, floor).find(x => x.includes('tx_whale_value_idx'))

  it('is emitted, partial, and leads on value so the scan can stop at 25', () => {
    const stmt = stmtFor(FLOOR)!
    expect(stmt).toBeDefined()
    // Leading on `value` is the whole point: it supplies the ORDER BY so the
    // walk stops at LIMIT, instead of reading every candidate row from the heap.
    expect(stmt).toContain('ON transactions(value DESC, timestamp DESC)')
    expect(stmt).toContain(`WHERE value > ${FLOOR}`)
    expect(stmt).toContain('CONCURRENTLY')
  })

  it.each(['bnb', 'eth'] as const)(
    'has a predicate matching %s config, which the query splices as a literal',
    (key: ChainKey) => {
      // Postgres only uses a partial index when it can prove the query implies
      // the predicate. The explorer emits `AND value > <nativeIndexFloorWei>` as
      // a raw literal for exactly that reason, so these two constants are one
      // constant. If they drift, the index is built and silently never used.
      const floor = getChainConfig(key).whales.nativeIndexFloorWei
      expect(stmtFor(floor)).toContain(`WHERE value > ${floor}`)
    },
  )

  it.each(['bnb', 'eth'] as const)(
    'has a %s threshold at or above the index floor',
    (key: ChainKey) => {
      // Below the floor the query truncates at the floor instead of the
      // configured threshold, silently returning fewer/larger rows than asked.
      const { nativeMinWei, nativeIndexFloorWei } = getChainConfig(key).whales
      expect(BigInt(nativeMinWei)).toBeGreaterThanOrEqual(BigInt(nativeIndexFloorWei))
    },
  )

  it('refuses a floor that is not a bare integer', () => {
    // It is spliced into DDL unescaped.
    expect(() => buildConcurrentIndexList(false, "1'; DROP TABLE transactions --"))
      .toThrow(/must be digits/)
    expect(() => buildConcurrentIndexList(false, '1e18')).toThrow(/must be digits/)
    expect(() => buildConcurrentIndexList(false, '')).toThrow(/must be digits/)
  })
})

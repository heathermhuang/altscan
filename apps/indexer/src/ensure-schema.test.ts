import { describe, expect, it } from 'vitest'
import {
  buildConcurrentIndexList,
  buildPartitionedTtWhaleIndexSql,
  buildPartitionedWhaleIndexSql,
  TT_WHALE_COLUMNS,
  ttWhaleIndexes,
  TT_TOKEN_TS_COLUMNS,
  TT_TOKEN_TS_IDX,
  INVALID_INDEX_SWEEP_SQL,
  partitionRangesToCreate,
  retireOldDexKeySql,
  retireOldTokensHealIndexSql,
  TOKENS_HEAL_IDX,
  TOKENS_HEAL_PREDICATE,
} from './ensure-schema'
import { UNKNOWN_NAME, UNKNOWN_SYMBOL } from './token-metadata'
import { BODY_PRUNE_OPS, type PruneOp } from './retention-policy'
import { getChainConfig, type ChainKey } from '@altscan/chain-config'
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core'
import { schema } from './db'

const FLOOR = '1000000000000000000'

describe('buildConcurrentIndexList', () => {
  // The two properties that actually matter for boot: CONCURRENTLY (never takes a
  // blocking lock behind the outgoing instance's writes) and IF NOT EXISTS
  // (idempotent across restarts). UNIQUE is permitted — dex_block_log_unique is
  // what makes a dex_trades replay dedupable — but nothing else may vary.
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
  //
  // Keyed on (block_number, log_index): a log index is block-scoped, so this is
  // the same natural key as (tx_hash, log_index), but it grows in order instead of
  // landing on a random page of a 398 MB index on every BNB insert.
  it('builds dex_block_log_unique on the natural key, in both partition modes', () => {
    for (const ttPartitioned of [false, true]) {
      const stmts = buildConcurrentIndexList(ttPartitioned, FLOOR)
        .filter(s => s.includes('dex_block_log_unique'))
      expect(stmts, `partitioned=${ttPartitioned}`).toHaveLength(1)
      expect(stmts[0]).toMatch(/^CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS /)
      expect(stmts[0]).toContain('ON dex_trades(block_number, log_index)')
      // PARTIAL is load-bearing: it excludes rows predating the column, so the
      // build cannot fail on legacy data and no migration has to precede it.
      expect(stmts[0]).toContain('WHERE log_index IS NOT NULL')
    }
  })

  // dex_pair_idx had 0 scans on BNB after 3.3M inserts; the old key is retired by
  // retireOldDexKeySql once its replacement is valid, never rebuilt at boot.
  it('no longer builds the tx-hash key or the unused pair index', () => {
    for (const ttPartitioned of [false, true]) {
      const stmts = buildConcurrentIndexList(ttPartitioned, FLOOR)
      expect(stmts.filter(s => s.includes('dex_tx_log_unique'))).toEqual([])
      expect(stmts.filter(s => s.includes('dex_pair_idx'))).toEqual([])
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

// The token-metadata healer's keyset paging. Its ORDER BY and row comparison are
// pinned against this column list in token-heal-query.test.ts; here the index
// itself: built in both modes, alongside the older single-column index (which the
// explorer's top-N queries use and nothing here retires). That the planner really
// uses it for each chain's queries is token-heal.pg.test.ts's job.
describe('tokens_heal_candidates_idx', () => {
  const heal = (ttPartitioned: boolean) =>
    buildConcurrentIndexList(ttPartitioned, FLOOR).filter(s => s.includes(TOKENS_HEAL_IDX))

  it('is built once in both partition modes, every column descending, partial over the heal candidates', () => {
    for (const ttPartitioned of [false, true]) {
      const stmts = heal(ttPartitioned)
      expect(stmts, `partitioned=${ttPartitioned}`).toHaveLength(1)
      // One direction across the columns is what makes the healer's row comparison an Index Cond.
      expect(stmts[0]).toMatch(/ ON tokens\(holder_count DESC, address DESC\) WHERE /)
      expect(stmts[0].endsWith(` WHERE ${TOKENS_HEAL_PREDICATE}`)).toBe(true)
    }
  })

  // The predicate is DDL, so it cannot take the healer's bound parameters: pin it to
  // the constants the healer binds, or a rename would leave the index empty of the
  // rows the healer asks for while every test stayed green.
  it('names the same placeholders the healer binds', () => {
    expect(TOKENS_HEAL_PREDICATE).toContain(`name IN ('${UNKNOWN_NAME}','')`)
    expect(TOKENS_HEAL_PREDICATE).toContain(`symbol IN ('${UNKNOWN_SYMBOL}','')`)
    expect(TOKENS_HEAL_PREDICATE).toContain(`total_supply = 0 AND type = 'BEP20'`)
  })

  // packages/db/schema.ts is the schema source of truth: it has to say what the
  // runtime DDL builds, columns, directions and WHERE clause all.
  it('is declared in the drizzle schema exactly as the runtime DDL builds it', () => {
    const declared = getTableConfig(schema.tokens).indexes
      .find(i => i.config.name === TOKENS_HEAL_IDX)
    expect(declared).toBeDefined()
    const columns = declared!.config.columns
      .map(c => `${(c as { name: string }).name} ${String((c as { indexConfig?: { order?: string } }).indexConfig?.order).toUpperCase()}`)
      .join(', ')
    const where = new PgDialect().sqlToQuery(declared!.config.where!).sql
    expect(heal(false)[0]).toBe(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${TOKENS_HEAL_IDX} ON tokens(${columns}) WHERE ${where}`,
    )
  })

  it('replaces the full-table index rather than sitting beside it', () => {
    for (const ttPartitioned of [false, true]) {
      expect(buildConcurrentIndexList(ttPartitioned, FLOOR).filter(s => s.includes('tokens_holder_count_address_idx'))).toEqual([])
    }
    expect(getTableConfig(schema.tokens).indexes.map(i => i.config.name)).not.toContain('tokens_holder_count_address_idx')
  })

  it('does not replace tokens_holder_count_idx', () => {
    const stmts = buildConcurrentIndexList(false, FLOOR).filter(s => s.includes('ON tokens('))
    expect(stmts.some(s => /tokens_holder_count_idx\s+ON tokens\(holder_count DESC\)$/.test(s))).toBe(true)
  })
})

describe('retireOldTokensHealIndexSql', () => {
  // The outgoing deploy generation pages through the same candidates, so some index
  // for them has to exist at every moment: the full one stays until the partial is valid.
  it('retires nothing until the replacement index is valid', () => {
    expect(retireOldTokensHealIndexSql(false)).toEqual([])
  })

  it('then drops the full index without blocking writes', () => {
    expect(retireOldTokensHealIndexSql(true)).toEqual(['DROP INDEX CONCURRENTLY IF EXISTS tokens_holder_count_address_idx'])
  })
})

// ---------------------------------------------------------------------------
describe('retireOldDexKeySql', () => {
  // Deploy generations overlap and both write dex_trades for the same blocks, so
  // SOME natural-key unique index must exist at every moment. Dropping the old one
  // before the new one is valid would open a window where overlapping inserts
  // duplicate trades.
  it('retires nothing until the replacement key is valid', () => {
    expect(retireOldDexKeySql(false)).toEqual([])
  })

  it('then drops the old tx-hash key without blocking writes', () => {
    expect(retireOldDexKeySql(true)).toEqual(['DROP INDEX CONCURRENTLY IF EXISTS dex_tx_log_unique'])
  })
})

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

describe('partitionRangesToCreate — the ladder for a table partitioned from day one', () => {
  const W = 7_200

  it('seeds an EMPTY ladder at the current block, never from block 0', () => {
    const ranges = partitionRangesToCreate([], W, 25_922_443, 25_922_443 + 2 * W)
    expect(ranges[0].lo).toBe(Math.floor(25_922_443 / W) * W)
    expect(ranges[0].lo).toBeLessThanOrEqual(25_922_443)
    expect(ranges[0].lo).toBeGreaterThan(0)
    // Contiguous, width-aligned, and reaching past the target.
    for (let i = 1; i < ranges.length; i++) expect(ranges[i].lo).toBe(ranges[i - 1].hi)
    for (const r of ranges) { expect(r.hi - r.lo).toBe(W); expect(r.lo % W).toBe(0) }
    expect(ranges[ranges.length - 1].hi).toBeGreaterThan(25_922_443 + 2 * W)
  })

  it('only fills the ranges an existing ladder does not already cover', () => {
    const existing = [{ lo: 100 * W, hi: 101 * W }, { lo: 101 * W, hi: 102 * W }]
    const ranges = partitionRangesToCreate(existing, W, 100 * W + 5, 103 * W + 5)
    expect(ranges).toEqual([{ lo: 102 * W, hi: 103 * W }, { lo: 103 * W, hi: 104 * W }])
  })

  it('is idempotent: applying its own output leaves nothing to create', () => {
    const first = partitionRangesToCreate([], W, 50 * W + 1, 53 * W)
    expect(first.length).toBeGreaterThan(0)
    expect(partitionRangesToCreate(first, W, 50 * W + 1, 53 * W)).toEqual([])
  })

  it('never proposes a range overlapping a wider, differently-aligned existing partition', () => {
    // A hand-made or legacy partition that is not width-aligned must be respected,
    // not straddled: overlapping ranges are a CREATE TABLE error at best.
    const existing = [{ lo: 0, hi: 100 * W + 3_000 }]
    const ranges = partitionRangesToCreate(existing, W, 100 * W, 102 * W)
    for (const r of ranges) expect(r.lo).toBeGreaterThanOrEqual(100 * W + 3_000)
    expect(ranges[0]).toEqual({ lo: 100 * W + 3_000, hi: 100 * W + 3_000 + W })
  })
})

// ---------------------------------------------------------------------------
// Round-5 indexes. Two jobs, both found by reading prod's plans:
//  - token search: `lower(symbol) = $1` / `LIKE $1 || '%'` had no index, so exact
//    and prefix lookups seq-scanned 4.66M BNB tokens;
//  - the value-ordered whale arm: token_transfers has no index on `value`, so
//    "largest transfers of USDT" read 10-39 s on ETH and minutes on BNB.
// A statement that is only ever executed by a human is a statement that never
// runs (ddl-in-a-file-nothing-executes), so these live in ensureSchema, and the
// production build script is generated from the same shapes.
// ---------------------------------------------------------------------------
describe('tokens_lower_symbol_idx / tokens_lower_name_idx', () => {
  // text_pattern_ops is what makes LIKE 'q%' indexable under a non-C collation
  // (prod's is en_US.UTF-8); equality is supported by the same opclass, so one
  // index serves both the exact and the prefix lookup.
  const EXPECTED = [
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tokens_lower_symbol_idx ON tokens(lower(symbol) text_pattern_ops)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS tokens_lower_name_idx ON tokens(lower(name) text_pattern_ops)',
  ]

  it('emits both, exactly, on BOTH chains and in both partition modes (tokens is never partitioned)', () => {
    for (const ttPartitioned of [false, true]) {
      const stmts = buildConcurrentIndexList(ttPartitioned, FLOOR).map(s => s.replace(/\s+/g, ' '))
      for (const expected of EXPECTED) {
        expect(stmts.filter(s => s === expected), `partitioned=${ttPartitioned}: ${expected}`).toHaveLength(1)
      }
    }
  })

  it('sits beside the other tokens indexes and replaces none of them', () => {
    const stmts = buildConcurrentIndexList(false, FLOOR)
    expect(stmts.some(s => /tokens_holder_count_idx\s+ON tokens\(holder_count DESC\)$/.test(s))).toBe(true)
    expect(stmts.some(s => s.includes(TOKENS_HEAL_IDX))).toBe(true)
    expect(stmts.filter(s => /ON tokens\(/.test(s))).toHaveLength(4)
  })
})

describe('ttWhaleIndexes — one partial index per tracked token', () => {
  it.each(['bnb', 'eth'] as const)('%s: one per tracked token, named from its symbol, predicate = literal address AND literal floor', (key: ChainKey) => {
    const { wrapped, stablecoins } = getChainConfig(key).whales
    const specs = ttWhaleIndexes(getChainConfig(key).whales)
    const tokens = [wrapped, ...stablecoins]
    expect(specs.map(w => w.name)).toEqual(tokens.map(t => `tt_whale_${t.symbol.toLowerCase()}_idx`))
    specs.forEach((w, i) => {
      expect(w.predicate).toBe(`token_address = '${tokens[i].address}' AND value > ${tokens[i].indexFloor}`)
      // A bound parameter cannot prove a partial-index predicate; this must be literals only.
      expect(w.predicate).not.toMatch(/[$?]/)
    })
  })

  it('names exactly the four production indexes', () => {
    expect(ttWhaleIndexes(getChainConfig('bnb').whales).map(w => w.name))
      .toEqual(['tt_whale_wbnb_idx', 'tt_whale_usdt_idx', 'tt_whale_usdc_idx'])
    expect(ttWhaleIndexes(getChainConfig('eth').whales).map(w => w.name))
      .toEqual(['tt_whale_weth_idx', 'tt_whale_usdt_idx', 'tt_whale_usdc_idx'])
  })

  it('defaults to the running chain', () => {
    expect(ttWhaleIndexes()).toEqual(ttWhaleIndexes(getChainConfig().whales))
  })

  // Everything in the predicate is spliced into DDL unescaped.
  it('refuses a token that cannot be spliced safely', () => {
    const base = getChainConfig('bnb').whales
    const bad = (patch: Partial<typeof base.wrapped>) => ttWhaleIndexes({ ...base, wrapped: { ...base.wrapped, ...patch } })
    expect(() => bad({ indexFloor: "1'; DROP TABLE token_transfers --" })).toThrow(/digits/)
    expect(() => bad({ indexFloor: '1e23' })).toThrow(/digits/)
    expect(() => bad({ indexFloor: '' })).toThrow(/digits/)
    expect(() => bad({ address: "0x'; DROP TABLE x --" })).toThrow(/address/)
    expect(() => bad({ address: base.wrapped.address.toUpperCase().replace('0X', '0x') })).toThrow(/address/)  // stored lowercase
    expect(() => bad({ symbol: 'W BNB' })).toThrow(/symbol/)
    expect(() => bad({ symbol: "x'; --" })).toThrow(/symbol/)
  })

  it('refuses two tokens that would share an index name', () => {
    const base = getChainConfig('bnb').whales
    expect(() => ttWhaleIndexes({ ...base, stablecoins: [base.stablecoins[0], { ...base.stablecoins[1], symbol: 'usdt' }] }))
      .toThrow(/duplicate/i)
  })
})

describe('tt_whale_*_idx on a MONOLITHIC token_transfers (ETH)', () => {
  it.each(['bnb', 'eth'] as const)('%s config: emits one exact CONCURRENTLY statement per token', (key: ChainKey) => {
    const specs = ttWhaleIndexes(getChainConfig(key).whales)
    const stmts = buildConcurrentIndexList(false, FLOOR, specs).map(s => s.replace(/\s+/g, ' '))
    for (const w of specs) {
      expect(stmts.filter(s => s.includes(` ${w.name} `)), w.name).toEqual([
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${w.name} ON token_transfers(${TT_WHALE_COLUMNS}) WHERE ${w.predicate}`,
      ])
    }
  })

  it('leads on token_address then value DESC, so a per-token value-ordered scan can stop at LIMIT', () => {
    expect(TT_WHALE_COLUMNS).toBe('token_address, value DESC')
  })

  it('spells ETH\'s USDT index with its real address and the $100k floor in 6-decimal units', () => {
    const stmts = buildConcurrentIndexList(false, FLOOR, ttWhaleIndexes(getChainConfig('eth').whales))
    expect(stmts).toContain(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS tt_whale_usdt_idx ON token_transfers(token_address, value DESC) " +
      "WHERE token_address = '0xdac17f958d2ee523a2206206994597c13d831ec7' AND value > 100000000000",
    )
  })

  // CONCURRENTLY is rejected on a partitioned parent: BNB takes the ON ONLY +
  // per-partition route below, so the flat list must not carry these there.
  it('are absent from the flat list when partitioned', () => {
    const stmts = buildConcurrentIndexList(true, FLOOR, ttWhaleIndexes(getChainConfig('bnb').whales))
    expect(stmts.filter(s => s.includes('tt_whale_'))).toEqual([])
  })
})

describe('tt_whale_*_idx on a PARTITIONED token_transfers (BNB)', () => {
  const [wbnb, usdt] = ttWhaleIndexes(getChainConfig('bnb').whales)

  it('emits the exact parent / child / attach statements', () => {
    expect(buildPartitionedTtWhaleIndexSql(usdt, 'token_transfers_p_118938552')).toEqual({
      parent:
        "CREATE INDEX IF NOT EXISTS tt_whale_usdt_idx ON ONLY token_transfers(token_address, value DESC) " +
        "WHERE token_address = '0x55d398326f99059ff775485246999027b3197955' AND value > 100000000000000000000000",
      child:
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS token_transfers_p_118938552_whale_usdt_idx ON token_transfers_p_118938552(token_address, value DESC) " +
        "WHERE token_address = '0x55d398326f99059ff775485246999027b3197955' AND value > 100000000000000000000000",
      childName: 'token_transfers_p_118938552_whale_usdt_idx',
      attach: 'ALTER INDEX tt_whale_usdt_idx ATTACH PARTITION token_transfers_p_118938552_whale_usdt_idx',
    })
    expect(buildPartitionedTtWhaleIndexSql(wbnb, 'token_transfers_legacy').child).toContain(
      "ON token_transfers_legacy(token_address, value DESC) WHERE token_address = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' AND value > 100000000000000000000",
    )
  })

  it('creates the parent ON ONLY and each child CONCURRENTLY (rejected outright on a partitioned parent)', () => {
    const { parent, child } = buildPartitionedTtWhaleIndexSql(usdt, 'token_transfers_p_1')
    expect(parent).toMatch(/^CREATE INDEX IF NOT EXISTS \S+ ON ONLY token_transfers\(/)
    expect(parent).not.toContain('CONCURRENTLY')
    expect(child).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS \S+ ON token_transfers_p_1\(/)
  })

  // ATTACH PARTITION adopts a child only when its definition matches the parent's
  // exactly, and the two are built from separate strings.
  it('builds a child whose definition (columns + predicate) is byte-identical to the parent\'s', () => {
    for (const w of [wbnb, usdt]) {
      const { parent, child } = buildPartitionedTtWhaleIndexSql(w, 'token_transfers_p_7')
      const tail = (s: string) => s.slice(s.indexOf('('))
      expect(tail(child).replace('token_transfers_p_7', 'token_transfers')).toBe(tail(parent))
    }
  })

  it('names children uniquely per (partition, token), stably, inside the 63-byte identifier limit', () => {
    const names = new Set<string>()
    for (const w of ttWhaleIndexes(getChainConfig('bnb').whales)) {
      for (const part of ['token_transfers_legacy', 'token_transfers_p_118938552', 'token_transfers_p_118842552', 'token_transfers_p_9999999999999']) {
        const { childName } = buildPartitionedTtWhaleIndexSql(w, part)
        expect(childName.length, childName).toBeLessThanOrEqual(63)
        expect(childName).toBe(buildPartitionedTtWhaleIndexSql(w, part).childName)
        names.add(childName)
      }
    }
    expect(names.size).toBe(12)
  })

  it('never reuses the parent names of the existing token_transfers indexes', () => {
    const taken = new Set([TT_TOKEN_TS_IDX, 'tt_token_idx', 'tt_from_ts_idx', 'tt_to_ts_idx', 'tt_block_idx', 'tt_tx_idx', 'tx_whale_value_idx'])
    for (const key of ['bnb', 'eth'] as const) {
      for (const w of ttWhaleIndexes(getChainConfig(key).whales)) expect(taken.has(w.name), w.name).toBe(false)
    }
  })
})

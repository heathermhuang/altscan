import { describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm'
import { schema } from './db'
import { buildConcurrentIndexList } from './ensure-schema'
import {
  ETH_ZERO_SUPPLY_MIN_HOLDERS, HEAD_LIMIT, HEAD_MIN_HOLDERS,
  healCandidateOrder, healCandidatePredicate, healCandidateWhere, healHeadWhere,
} from './token-heal-query'
import { UNKNOWN_NAME, UNKNOWN_SYMBOL } from './token-metadata'

const dialect = new PgDialect()
const render = (q: SQL) => {
  const { sql: text, params } = dialect.sqlToQuery(q)
  return { sql: text, params }
}
const { tokens } = schema

describe('healCandidatePredicate', () => {
  it('keeps the BNB predicate byte-for-byte what it was before the ETH split', () => {
    const before = or(
      inArray(tokens.name, [UNKNOWN_NAME, '']),
      inArray(tokens.symbol, [UNKNOWN_SYMBOL, '']),
      and(eq(tokens.totalSupply, '0'), eq(tokens.type, 'BEP20')),
    )!
    expect(render(healCandidatePredicate('bnb'))).toEqual(render(before))
    expect(render(healCandidatePredicate('bnb'))).toEqual({
      sql: '("tokens"."name" in ($1, $2) or "tokens"."symbol" in ($3, $4) or ("tokens"."total_supply" = $5 and "tokens"."type" = $6))',
      params: ['Unknown', '', '???', '', '0', 'BEP20'],
    })
  })

  // 0/33 healable among placeholder+zero-supply rows on ETH, 10/33 among placeholders
  // with a non-zero supply (2026-10-06): zero supply is excluded there, and the
  // BEP20-zero-supply clause that exists for BNB is gone too. Except with holders:
  // a throttled first fetch also stores supply 0 for a real token, so a zero-supply
  // placeholder with >= 2 holders stays a candidate (only 4 such rows in production).
  it('requires a non-zero supply or at least 2 holders on ETH, with no zero-supply-only clause', () => {
    expect(ETH_ZERO_SUPPLY_MIN_HOLDERS).toBe(2)
    expect(render(healCandidatePredicate('eth'))).toEqual({
      sql: '(("tokens"."name" in ($1, $2) or "tokens"."symbol" in ($3, $4)) and ("tokens"."total_supply" <> $5 or "tokens"."holder_count" >= $6))',
      params: ['Unknown', '', '???', '', '0', 2],
    })
  })

  it('differs between the chains, and ETH has no type clause', () => {
    expect(render(healCandidatePredicate('eth')).sql).not.toEqual(render(healCandidatePredicate('bnb')).sql)
    expect(render(healCandidatePredicate('eth')).sql).not.toContain('"type"')
  })
})

describe('healCandidateWhere', () => {
  const cursor = { holderCount: 0, address: '0x12ab34cd56ef' }

  it('is just the predicate from the top of the list', () => {
    for (const chain of ['bnb', 'eth'] as const) {
      expect(render(healCandidateWhere(chain, null))).toEqual(render(healCandidatePredicate(chain)))
    }
  })

  // A row comparison, never `holder_count < h OR (holder_count = h AND address < a)`:
  // only the row comparison is an Index Cond on tokens_holder_count_address_idx. The
  // OR spelling measured as a walk from the top of the table behind a heap Filter.
  it('resumes with one row comparison on the sort key, after the predicate, on both chains', () => {
    for (const chain of ['bnb', 'eth'] as const) {
      const predicate = render(healCandidatePredicate(chain))
      const q = render(healCandidateWhere(chain, cursor))
      const n = predicate.params.length
      expect(q.sql).toBe(
        `(${predicate.sql} and ("tokens"."holder_count", "tokens"."address") < ($${n + 1}, $${n + 2}))`,
      )
      expect(q.params).toEqual([...predicate.params, 0, '0x12ab34cd56ef'])
      // The OR spelling's signature is an equality on holder_count (the ETH predicate only uses >=).
      expect(q.sql).not.toMatch(/"holder_count" = \$/)
    }
  })
})

// The head is re-listed from the top every run so a candidate that climbs above the
// keyset cursor (holder_count is recomputed every 15 minutes) is seen next run, not a
// lap later. Prod 2026-10-06: BNB 31,049 tokens with >= 2 holders / 19 candidates /
// 23.6 ms; ETH 10,085 / 9 / 6.7 ms.
describe('healHeadWhere', () => {
  it('is 500 rows at most, from 2 holders up', () => {
    expect(HEAD_MIN_HOLDERS).toBe(2)
    expect(HEAD_LIMIT).toBe(500)
  })

  it('is the chain predicate and a lower bound on holder_count, with no cursor', () => {
    expect(render(healHeadWhere('bnb'))).toEqual({
      sql: '(("tokens"."name" in ($1, $2) or "tokens"."symbol" in ($3, $4) or ("tokens"."total_supply" = $5 and "tokens"."type" = $6)) and "tokens"."holder_count" >= $7)',
      params: ['Unknown', '', '???', '', '0', 'BEP20', 2],
    })
    expect(render(healHeadWhere('eth'))).toEqual({
      sql: '((("tokens"."name" in ($1, $2) or "tokens"."symbol" in ($3, $4)) and ("tokens"."total_supply" <> $5 or "tokens"."holder_count" >= $6)) and "tokens"."holder_count" >= $7)',
      params: ['Unknown', '', '???', '', '0', 2, 2],
    })
  })

  it('never carries the keyset row comparison', () => {
    for (const chain of ['bnb', 'eth'] as const) {
      expect(render(healHeadWhere(chain)).sql).not.toMatch(/\) < \(/)
    }
  })
})

describe('healCandidateOrder', () => {
  const rendered = () => render(sql.join([...healCandidateOrder], sql`, `)).sql

  it('sorts holder_count then address, both descending, so the row comparison matches', () => {
    expect(rendered()).toBe('"tokens"."holder_count" desc, "tokens"."address" desc')
  })

  // The keyset is an Index Cond, and the scan is already in order (no Sort node),
  // only on an index whose columns run exactly as the ORDER BY does. A drift in
  // either place is a silent seq scan or a table-wide sort, not an error.
  it('is the column list of the index ensure-schema builds for it', () => {
    for (const ttPartitioned of [false, true]) {
      const stmts = buildConcurrentIndexList(ttPartitioned, '1000000000000000000')
        .filter(s => s.includes('tokens_holder_count_address_idx'))
      expect(stmts, `partitioned=${ttPartitioned}`).toHaveLength(1)
      const columns = stmts[0].match(/ ON tokens\((.+)\)$/)?.[1]
      const ordering = rendered().replace(/"tokens"\./g, '').replace(/"/g, '').replace(/ (asc|desc)\b/g, m => m.toUpperCase())
      expect(columns).toBe(ordering)
    }
  })
})

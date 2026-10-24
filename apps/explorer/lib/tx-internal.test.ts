import { describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { schema, type Db } from '@altscan/db'
import { capTxInternals, selectTxInternals, TX_INTERNALS_SHOWN } from './tx-internal'

// A drizzle instance over no connection: toSQL() renders the statement without running it.
const db = drizzle({} as never, { schema }) as unknown as Db

const HASH = '0x' + 'ab'.repeat(32)

describe('selectTxInternals', () => {
  const { sql: text, params } = selectTxInternals(db, HASH, 12_345).toSQL()
  const flat = text.replace(/\s+/g, ' ')

  it('filters by block_number as well as tx_hash, so one partition is read and no other height can answer', () => {
    expect(flat).toMatch(/where \("internal_transactions"\."tx_hash" = \$1 and "internal_transactions"\."block_number" = \$2\)/)
    expect(params.slice(0, 2)).toEqual([HASH, 12_345])
  })

  it('orders in SQL by the trace address as integers, before the limit', () => {
    expect(flat).toMatch(/order by string_to_array\("internal_transactions"\."trace_address", '\.'\)::int\[\] limit/)
  })

  it('reads one row past the rows shown, to learn whether there are more', () => {
    expect(TX_INTERNALS_SHOWN).toBe(100)
    expect(flat).toMatch(/limit \$3$/)
    expect(params[2]).toBe(101)
  })
})

describe('capTxInternals', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => i)

  it('shows every row and reports no truncation up to the cap', () => {
    expect(capTxInternals(rows(0))).toEqual({ shown: [], truncated: false })
    expect(capTxInternals(rows(100))).toEqual({ shown: rows(100), truncated: false })
  })

  it('shows the first 100 and reports truncation when the extra row came back', () => {
    const out = capTxInternals(rows(101))
    expect(out.shown).toEqual(rows(100))
    expect(out.truncated).toBe(true)
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToReadableStream } from 'react-dom/server'
import type { SQL } from 'drizzle-orm'

// What the address page CLAIMS: the Analytics tab's sums, the transaction count, and the metadata that crawlers read.
// The real page renders with the database and RPC stubbed, so each claim is checked where a visitor (or a crawler)
// reads it, not just in the helper that formats it.
const ME = '0x' + '7'.repeat(40)
type Row = Record<string, unknown>
const h = vi.hoisted(() => ({
  tables: new Map<unknown, Row[]>(),
  exec: (() => []) as (sql: string) => Row[],
  execError: null as Error | null,
  sqls: [] as string[],
  nonce: 0 as number | null,
  code: '0x',
  selectError: null as Error | null,
  providerCalls: 0,
  dbSelects: 0,
}))

vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  const { PgDialect } = await import('drizzle-orm/pg-core')
  const builder = () => {
    let table: unknown
    const q: Record<string, unknown> = {}
    for (const m of ['where', 'orderBy', 'limit', 'offset', 'groupBy', 'leftJoin', 'innerJoin']) q[m] = () => q
    q.from = (t: unknown) => { table = t; return q }
    q.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) =>
      (h.selectError ? Promise.reject(h.selectError) : Promise.resolve(h.tables.get(table) ?? [])).then(resolve, reject)
    return q
  }
  return {
    schema,
    db: {
      select: () => { h.dbSelects++; return builder() },
      execute: async (query: SQL) => {
        const text = new PgDialect().sqlToQuery(query).sql
        h.sqls.push(text)
        if (h.execError) throw h.execError
        return h.exec(text)
      },
    },
  }
})
vi.mock('@/lib/address-query', () => ({ selectByAddress: async (_db: unknown, table: unknown) => h.tables.get(table) ?? [] }))
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130 Safari/537.36' }) }))
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound') } }))
vi.mock('@/lib/rpc', () => ({
  getWebProvider: async () => {
    h.providerCalls++
    return { getBalance: async () => 2n * 10n ** 18n, getTransactionCount: async () => h.nonce, getCode: async () => h.code }
  },
}))
vi.mock('@/lib/name-resolver', () => ({ resolveName: async () => null }))
vi.mock('@/lib/goplus', () => ({ getAddressRisk: async () => null }))
vi.mock('@/lib/native-price', () => ({ fetchNativeUsd: async () => null }))
vi.mock('@/lib/providers', () => ({ isBotRequest: () => false }))
vi.mock('@/lib/retention', () => ({ getRetentionFloor: async () => null, isLocalHistoryIncomplete: () => false }))
vi.mock('./HoldingsTab', () => ({ HoldingsTab: () => null, getTrackedBalances: async () => null }))
vi.mock('@/components/ads/AdReserve', () => ({ AdReserve: () => null }))

const load = async () => {
  vi.resetModules()
  const { schema } = await import('@/lib/db')   // the stub's own schema: table identity is the key
  const page = await import('./page')
  return { schema, page }
}
const render = async (tab: string, addressRow?: Row) => {
  const { schema, page } = await load()
  if (addressRow) h.tables.set(schema.addresses, [addressRow])
  const stream = await renderToReadableStream(await page.default({ params: Promise.resolve({ address: ME }), searchParams: Promise.resolve({ tab }) }))
  await stream.allReady
  return new Response(stream).text()
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

beforeEach(() => {
  h.tables.clear()
  h.exec = () => []
  h.execError = null
  h.sqls = []
  h.nonce = 0
  h.code = '0x'
  h.selectError = null
  h.providerCalls = 0
  h.dbSelects = 0
})

describe('address page, Analytics tab', () => {
  it('sums only successful transactions, and says the figure is a sample of the newest 1,000', async () => {
    h.exec = (sql) => (sql.includes('from_address') ? [{ total: '3000000000000000000', n: '1000' }] : [{ total: '1500000000000000000', n: '12' }])
    const t = text(await render('analytics'))
    // a failed tx moved no value, so the sums must exclude it
    expect(h.sqls).toHaveLength(2)
    for (const sql of h.sqls) expect(sql).toMatch(/status = true/)
    expect(t).toContain('Sent (last 1,000 indexed transactions) 3 BNB')
    expect(t).toContain('Received (12 indexed transactions) 1.5 BNB')
    expect(t).not.toContain('Total Sent')
  })

  it('shows "—", not a zero, when the sums could not be read', async () => {
    h.execError = new Error('statement timeout')
    const t = text(await render('analytics'))
    expect(t).toMatch(/Sent —/)
    expect(t).toMatch(/Received —/)
    expect(t).not.toMatch(/0\.0000|\b0 BNB/)
  })
})

const ROW = { address: ME, txCount: 0, firstSeen: new Date('2026-10-22T00:00:00Z'), lastSeen: new Date('2026-10-23T00:00:00Z'), label: null }
const description = async (row?: Row) => {
  const { schema, page } = await load()
  if (row) h.tables.set(schema.addresses, [row])
  return (await page.generateMetadata({ params: Promise.resolve({ address: ME }) })).description as string
}

describe('address page, transaction count', () => {
  it('does not present the outgoing-only RPC nonce as the wallet\'s transactions when the index has no row', async () => {
    h.nonce = 500
    const html = await render('txns')
    const t = text(html)
    expect(t).toMatch(/Transactions — 500 sent \(nonce\)/)
    expect(t).not.toMatch(/500 transactions/)
    expect(t).not.toMatch(/across/)
    expect(t).toContain('Transactions (—)')
  })

  it('does the same when the index row says 0 but the chain shows sends', async () => {
    h.nonce = 500
    const t = text(await render('txns', { ...ROW, txCount: 0 }))
    expect(t).toMatch(/Transactions — 500 sent \(nonce\)/)
    expect(t).not.toMatch(/500 transactions/)
  })

  it('prints the indexed count, and no nonce note, when the index has one', async () => {
    h.nonce = 500
    const t = text(await render('txns', { ...ROW, txCount: 1234 }))
    expect(t).toContain('across 1,234 transactions')
    expect(t).toContain('Transactions (1,234)')
    expect(t).not.toMatch(/nonce/)
  })

  it('does not label a contract\'s nonce (contracts created) as transactions sent', async () => {
    h.nonce = 1
    h.code = '0x6080604052348015600f57600080fd5b50'
    expect(text(await render('txns'))).not.toMatch(/nonce/)
  })
})

describe('address page, metadata description', () => {
  it('prints no transaction count when the index has no row for the address', async () => {
    h.nonce = 500
    const d = await description()
    expect(d).toContain('Balance: 2 BNB')
    expect(d).not.toMatch(/transaction/)
  })

  it('prints no transaction count when the addresses read failed', async () => {
    h.selectError = new Error('statement timeout')
    expect(await description()).not.toMatch(/transaction/)
  })

  it('does not turn the nonce into a count beside an indexed 0', async () => {
    h.nonce = 500
    const d = await description({ ...ROW, txCount: 0 })
    expect(d).not.toMatch(/transaction/)
  })

  it('prints the indexed count, singular or plural', async () => {
    expect(await description({ ...ROW, txCount: 7 })).toMatch(/, 7 transactions$/)
    expect(await description({ ...ROW, txCount: 1 })).toMatch(/, 1 transaction$/)
  })
})

describe('address page, metadata for a malformed address', () => {
  it.each(['vitalik.eth', '0x1234', '0x' + 'g'.repeat(40), ''])('returns noindex for %j without a provider or database call', async (bad) => {
    const { page } = await load()
    const meta = await page.generateMetadata({ params: Promise.resolve({ address: bad }) })
    expect(meta.robots).toEqual({ index: false, follow: false })
    expect(meta.alternates).toBeUndefined()
    expect(h.providerCalls).toBe(0)
    expect(h.dbSelects).toBe(0)
  })

  it('still looks a well-formed address up', async () => {
    const { page } = await load()
    const meta = await page.generateMetadata({ params: Promise.resolve({ address: ME.toUpperCase().replace('0X', '0x') }) })
    expect(meta.robots).toBeUndefined()
    expect(meta.alternates?.canonical).toBe(`/address/${ME}`)
    expect(h.providerCalls).toBe(1)
    expect(h.dbSelects).toBeGreaterThan(0)
  })
})

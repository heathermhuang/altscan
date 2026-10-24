import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToReadableStream } from 'react-dom/server'
import { PgDialect } from 'drizzle-orm/pg-core'

// What the address page CLAIMS: the Analytics tab's sums, the transaction count, and the metadata that crawlers read.
// The real page renders with the database and RPC stubbed, so each claim is checked where a visitor (or a crawler)
// reads it, not just in the helper that formats it.
const ME = '0x' + '7'.repeat(40)
type Row = Record<string, unknown>
const h = vi.hoisted(() => ({
  tables: new Map<unknown, Row[]>(),
  exec: (_sql: string): Row[] => [],
  execError: null as Error | null,
  sqls: [] as string[],
  nonce: 0 as number | null,
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
    q.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(h.tables.get(table) ?? []).then(resolve, reject)
    return q
  }
  return {
    schema,
    db: {
      select: () => { h.dbSelects++; return builder() },
      execute: async (query: Parameters<InstanceType<typeof PgDialect>['sqlToQuery']>[0]) => {
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
    return { getBalance: async () => 2n * 10n ** 18n, getTransactionCount: async () => h.nonce, getCode: async () => '0x' }
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

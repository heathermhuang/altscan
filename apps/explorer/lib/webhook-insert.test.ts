import { describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/postgres-js'
import { schema } from '@altscan/db'
import { insertWebhookSql } from './webhook-insert'

const dialect = new PgDialect()
const row = {
  ownerAddress: '0x' + 'a'.repeat(40),
  url: 'https://hooks.example.com/x',
  watchAddress: null,
  eventTypes: ['tx', 'new_block'],
  secret: 'f'.repeat(64),
}

describe('insertWebhookSql', () => {
  it('names only the columns the explorer writes, never the indexer-owned secret_enc', () => {
    const q = dialect.sqlToQuery(insertWebhookSql(row))
    const cols = q.sql.match(/INSERT INTO webhooks \(([^)]*)\)/)?.[1]
    expect(cols).toBe('owner_address, url, watch_address, event_types, secret')
    expect(q.sql).not.toContain('secret_enc')
  })

  it('binds event_types as a text[] array, not a row constructor', () => {
    const q = dialect.sqlToQuery(insertWebhookSql(row))
    expect(q.sql).toMatch(/ARRAY\[\$4, \$5\]::text\[\]/)
    expect(q.params).toEqual([row.ownerAddress, row.url, null, 'tx', 'new_block', row.secret])
  })

  // Why the hand-written statement exists. If this ever stops holding, the query
  // builder could be used again.
  it("drizzle's own insert would name secret_enc", () => {
    const db = drizzle({} as never, { schema })
    const q = db.insert(schema.webhooks).values({ ownerAddress: row.ownerAddress, url: row.url, secret: row.secret }).toSQL()
    expect(q.sql).toContain('"secret_enc"')
  })
})

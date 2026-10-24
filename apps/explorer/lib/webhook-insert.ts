import { sql, type SQL } from 'drizzle-orm'

export type NewWebhookRow = {
  ownerAddress: string
  url: string
  watchAddress: string | null
  eventTypes: string[]
  /** sha256(raw secret) in hex: the HMAC signing key. */
  secret: string
}

/**
 * The registration INSERT, naming its columns.
 *
 * drizzle's `insert(schema.webhooks)` lists every column schema.ts declares, so it
 * names `secret_enc`, which only the indexer's ensure-schema creates. An explorer
 * deployed ahead of that DDL (any upgrade crossing it, self-hosts included) would
 * then fail every registration. Naming the columns keeps the explorer independent
 * of indexer-owned columns.
 *
 * `event_types` is spelled as an ARRAY constructor: an array interpolated into
 * drizzle's `sql` becomes a row constructor, `($1, $2)`, not a text[].
 */
export function insertWebhookSql(row: NewWebhookRow): SQL {
  const events = sql.join(row.eventTypes.map((e) => sql`${e}`), sql`, `)
  return sql`
    INSERT INTO webhooks (owner_address, url, watch_address, event_types, secret)
    VALUES (${row.ownerAddress}, ${row.url}, ${row.watchAddress}, ARRAY[${events}]::text[], ${row.secret})
    RETURNING id
  `
}

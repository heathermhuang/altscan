import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/lib/db'
import { chainConfig } from '@/lib/chain'

export type WhalePeriod = '1h' | '24h' | '7d' | 'all'

export type TokenFilter = {
  address: string
  minValue: string
  symbol?: string
  decimals?: number
}

export type WhaleTx = {
  hash: string
  fromAddress: string
  toAddress: string | null
  value: string
  blockNumber: number
  timestamp: Date
  transferType: 'native' | 'token'
  tokenSymbol?: string
}

/** null = the query failed; [] = it succeeded and found nothing. The page
 *  renders those two differently, so they must not collapse into one value. */
export type WhaleResult = {
  native: WhaleTx[] | null
  token: WhaleTx[] | null
}

const QUERY_TIMEOUT_MS = 15_000

function cutoffFor(period: WhalePeriod): SQL {
  switch (period) {
    case '1h': return sql`NOW() - INTERVAL '1 hour'`
    case '7d': return sql`NOW() - INTERVAL '7 days'`
    case 'all': return sql`NOW() - INTERVAL '30 days'`   // "all" capped to 30d
    default: return sql`NOW() - INTERVAL '24 hours'`
  }
}

export function buildNativeWhaleQuery(period: WhalePeriod, minNativeWei: string): SQL {
  return sql`
      SELECT hash, from_address as "fromAddress", to_address as "toAddress",
             value, block_number as "blockNumber", timestamp,
             'native' as "transferType", ${chainConfig.currency} as "tokenSymbol"
      FROM transactions
      WHERE timestamp >= ${cutoffFor(period)}
        AND value > ${minNativeWei}
      ORDER BY value DESC
      LIMIT 25
  `
}

export function buildTokenWhaleQuery(period: WhalePeriod, filters: readonly TokenFilter[]): SQL {
  const addressList = sql.join(filters.map(f => sql`${f.address}`), sql`, `)
  const thresholds = sql.join(
    filters.map(f => sql`(tt.token_address = ${f.address} AND tt.value > ${f.minValue})`),
    sql` OR `,
  )
  return sql`
      SELECT tt.tx_hash as hash, tt.from_address as "fromAddress", tt.to_address as "toAddress",
             tt.value, tt.block_number as "blockNumber", tt.timestamp,
             'token' as "transferType",
             COALESCE(tk.symbol, 'TOKEN') as "tokenSymbol"
      FROM token_transfers tt
      LEFT JOIN tokens tk ON tk.address = tt.token_address
      WHERE tt.timestamp >= ${cutoffFor(period)}
        AND tt.token_address IN (${addressList})
        AND (${thresholds})
      ORDER BY tt.timestamp DESC
      LIMIT 25
  `
}

export function parseWhaleRow(row: unknown): WhaleTx {
  const r = row as Record<string, unknown>
  return {
    hash: String(r.hash),
    fromAddress: String(r.fromAddress),
    toAddress: r.toAddress ? String(r.toAddress) : null,
    value: String(r.value),
    blockNumber: Number(r.blockNumber),
    timestamp: new Date(r.timestamp as string),
    transferType: r.transferType === 'token' ? 'token' : 'native',
    tokenSymbol: r.tokenSymbol ? String(r.tokenSymbol) : undefined,
  }
}

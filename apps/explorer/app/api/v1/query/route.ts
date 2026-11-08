import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq, and, gte, lte, asc, desc, type SQL } from 'drizzle-orm'
import { authFailure, authRequest } from '@/lib/api-auth'
import { selectByAddress, selectInTimeOrder } from '@/lib/address-query'
import { getRetentionCutoff } from '@/lib/retention'
import { swallow } from '@/lib/observability'
// apiJson (not NextResponse.json) for data rows: blocks/transactions carry
// Drizzle bigint columns (gas_used, gas, gas_limit) that JSON.stringify throws
// on — that throw is what made those two entities 500. apiJson stringifies
// BigInt safely; error responses stay on NextResponse.json (plain objects).
import { apiJson } from '@/lib/api-serialize'
import { parseQuery, type Filter } from '@/lib/query-filter'

/**
 * The timestamp range a block range implies, so an (address, timestamp) index can start and
 * stop on it. Block timestamps never decrease, so every row in a block at or after `lo` is no
 * older than the newest block at or before `lo`, and every row at or before `hi` is no newer
 * than the oldest block at or after `hi`. Taken from the blocks around the bounds, not at
 * them, so a gap in `blocks` cannot exclude a row. Two primary-key lookups; a side with no
 * such block (below the retained floor, above the tip) gets no bound, and needs none.
 */
async function blockTimeBounds(lo: number | undefined, hi: number | undefined): Promise<{ from?: Date; to?: Date }> {
  const at = (where: SQL, order: SQL) =>
    db.select({ t: schema.blocks.timestamp }).from(schema.blocks).where(where).orderBy(order).limit(1)
  const [from, to] = await Promise.all([
    lo === undefined ? [] : at(lte(schema.blocks.number, lo), desc(schema.blocks.number)),
    hi === undefined ? [] : at(gte(schema.blocks.number, hi), asc(schema.blocks.number)),
  ])
  return { from: from[0]?.t, to: to[0]?.t }
}

/** Conditions for transactions / token_transfers: the block range, as blocks and, with a key filter, as time. */
async function rangeConditions(
  table: typeof schema.transactions | typeof schema.tokenTransfers,
  filter: Filter,
  keyed: boolean,
): Promise<SQL[]> {
  const lo = Math.max(filter.blockFrom ?? -1, filter.blockNumber ?? -1)
  const hi = Math.min(filter.blockTo ?? Infinity, filter.blockNumber ?? Infinity)
  const conditions: SQL[] = []
  if (lo >= 0) conditions.push(gte(table.blockNumber, lo))
  if (hi !== Infinity) conditions.push(lte(table.blockNumber, hi))
  if (keyed && (lo >= 0 || hi !== Infinity)) {
    const t = await blockTimeBounds(lo >= 0 ? lo : undefined, hi !== Infinity ? hi : undefined)
    if (t.from) conditions.push(gte(table.timestamp, t.from))
    if (t.to) conditions.push(lte(table.timestamp, t.to))
  }
  return conditions
}

export async function POST(request: Request) {
  const auth = await authRequest(request)
  if (!auth.ok) return authFailure(auth)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = parseQuery(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const { entity, filter, orderBy, limit: safeLimit, offset: safeOffset } = parsed.query
  const page = { order: orderBy, limit: safeLimit, offset: safeOffset }

  try {
    switch (entity) {
      case 'transactions': {
        const keyed = filter.address !== undefined || filter.from !== undefined || filter.to !== undefined
        const conditions = await rangeConditions(schema.transactions, filter, keyed)
        if (filter.from) conditions.push(eq(schema.transactions.fromAddress, filter.from))
        if (filter.to) conditions.push(eq(schema.transactions.toAddress, filter.to))
        // Start at the retention floor. A prune deletes millions of rows from the old
        // end of transactions, and until VACUUM finishes (~40 min every 6h on BNB) an
        // oldest-first walk steps over each of them and times out. The cutoff is
        // published before the delete starts, and the rows below it are outside the
        // index anyway (what the address API reports as indexedFrom).
        const cutoff = await getRetentionCutoff()
        if (cutoff) {
          conditions.push(gte(schema.transactions.blockNumber, cutoff.block), gte(schema.transactions.timestamp, cutoff.floor))
        }

        if (filter.address) {
          const rows = await selectByAddress(db, schema.transactions, filter.address, conditions, page)
          return apiJson({ entity, count: rows.length, data: rows })
        }
        if (filter.from || filter.to) {
          const rows = await selectInTimeOrder(db, schema.transactions, conditions, page)
          return apiJson({ entity, count: rows.length, data: rows })
        }
        const q = db.select().from(schema.transactions)
          .orderBy(orderBy === 'asc' ? schema.transactions.blockNumber : desc(schema.transactions.blockNumber))
          .limit(safeLimit).offset(safeOffset)
        const rows = conditions.length > 0 ? await q.where(and(...conditions)) : await q
        return apiJson({ entity, count: rows.length, data: rows })
      }

      case 'blocks': {
        const conditions = []
        if (filter.blockFrom !== undefined) conditions.push(gte(schema.blocks.number, filter.blockFrom))
        if (filter.blockTo !== undefined) conditions.push(lte(schema.blocks.number, filter.blockTo))

        const q = db.select().from(schema.blocks)
          .orderBy(orderBy === 'asc' ? schema.blocks.number : desc(schema.blocks.number))
          .limit(safeLimit).offset(safeOffset)
        const rows = conditions.length > 0 ? await q.where(and(...conditions)) : await q
        return apiJson({ entity, count: rows.length, data: rows })
      }

      case 'tokens': {
        const rows = await db.select().from(schema.tokens)
          .orderBy(orderBy === 'asc' ? schema.tokens.holderCount : desc(schema.tokens.holderCount))
          .limit(safeLimit).offset(safeOffset)
        return apiJson({ entity, count: rows.length, data: rows })
      }

      case 'token_transfers': {
        const keyed = filter.address !== undefined || filter.from !== undefined || filter.to !== undefined || filter.tokenAddress !== undefined
        const conditions = await rangeConditions(schema.tokenTransfers, filter, keyed)
        if (filter.from) conditions.push(eq(schema.tokenTransfers.fromAddress, filter.from))
        if (filter.to) conditions.push(eq(schema.tokenTransfers.toAddress, filter.to))
        if (filter.tokenAddress) conditions.push(eq(schema.tokenTransfers.tokenAddress, filter.tokenAddress))

        if (filter.address) {
          const rows = await selectByAddress(db, schema.tokenTransfers, filter.address, conditions, page)
          return apiJson({ entity, count: rows.length, data: rows })
        }
        if (keyed) {
          const rows = await selectInTimeOrder(db, schema.tokenTransfers, conditions, page)
          return apiJson({ entity, count: rows.length, data: rows })
        }
        const q = db.select().from(schema.tokenTransfers)
          .orderBy(orderBy === 'asc' ? schema.tokenTransfers.blockNumber : desc(schema.tokenTransfers.blockNumber))
          .limit(safeLimit).offset(safeOffset)
        const rows = conditions.length > 0 ? await q.where(and(...conditions)) : await q
        return apiJson({ entity, count: rows.length, data: rows })
      }

      case 'dex_trades': {
        const conditions = []
        if (filter.blockFrom !== undefined) conditions.push(gte(schema.dexTrades.blockNumber, filter.blockFrom))
        if (filter.blockTo !== undefined) conditions.push(lte(schema.dexTrades.blockNumber, filter.blockTo))

        const q = db.select().from(schema.dexTrades)
          .orderBy(orderBy === 'asc' ? schema.dexTrades.blockNumber : desc(schema.dexTrades.blockNumber))
          .limit(safeLimit).offset(safeOffset)
        const rows = conditions.length > 0 ? await q.where(and(...conditions)) : await q
        return apiJson({ entity, count: rows.length, data: rows })
      }

      default:
        return NextResponse.json({ error: 'Invalid entity' }, { status: 400 })
    }
  } catch (e) {
    // Do not leak DB error details to callers — but log them: a bare catch here
    // hid ~95 statement timeouts an hour from the address filter.
    swallow('api/v1/query', e)
    return NextResponse.json({ error: 'Query failed' }, { status: 500 })
  }
}

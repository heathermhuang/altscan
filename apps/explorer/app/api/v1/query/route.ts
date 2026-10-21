import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq, and, gte, lte, asc, desc } from 'drizzle-orm'
import { authFailure, authRequest } from '@/lib/api-auth'
import { selectByAddress } from '@/lib/address-query'
import { getRetentionCutoff } from '@/lib/retention'
import { swallow } from '@/lib/observability'
// apiJson (not NextResponse.json) for data rows: blocks/transactions carry
// Drizzle bigint columns (gas_used, gas, gas_limit) that JSON.stringify throws
// on — that throw is what made those two entities 500. apiJson stringifies
// BigInt safely; error responses stay on NextResponse.json (plain objects).
import { apiJson } from '@/lib/api-serialize'

const ADDR = /^0x[0-9a-fA-F]{40}$/
// Deeper pages walk the index row by row up to the statement timeout, for any
// anonymous caller; narrow with blockFrom/blockTo instead.
const MAX_OFFSET = 10_000

function validateAddr(v: unknown): string | null {
  if (!v || typeof v !== 'string' || !ADDR.test(v)) return null
  return v.toLowerCase()
}

type QueryBody = {
  entity: 'transactions' | 'blocks' | 'tokens' | 'token_transfers' | 'dex_trades'
  filter?: {
    address?: string
    from?: string
    to?: string
    blockNumber?: number
    blockFrom?: number
    blockTo?: number
    tokenAddress?: string
    dex?: string
  }
  orderBy?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export async function POST(request: Request) {
  const auth = await authRequest(request)
  if (!auth.ok) return authFailure(auth)

  let body: QueryBody
  try {
    body = await request.json() as QueryBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { entity, filter = {}, orderBy = 'desc', limit = 25, offset = 0 } = body
  const dir = orderBy === 'asc' ? asc : desc

  // Validate numeric params
  const safeLimit = Math.min(Math.max(1, Number(limit) || 25), 100)
  const safeOffset = Math.max(0, Number(offset) || 0)
  if (safeOffset > MAX_OFFSET) {
    return NextResponse.json(
      { error: `offset must be at most ${MAX_OFFSET}; narrow the range with filter.blockFrom/blockTo` },
      { status: 400 },
    )
  }

  // Validate address filters upfront
  if (filter.address && !ADDR.test(filter.address)) {
    return NextResponse.json({ error: 'Invalid filter.address' }, { status: 400 })
  }
  if (filter.from && !ADDR.test(filter.from)) {
    return NextResponse.json({ error: 'Invalid filter.from' }, { status: 400 })
  }
  if (filter.to && !ADDR.test(filter.to)) {
    return NextResponse.json({ error: 'Invalid filter.to' }, { status: 400 })
  }
  if (filter.tokenAddress && !ADDR.test(filter.tokenAddress)) {
    return NextResponse.json({ error: 'Invalid filter.tokenAddress' }, { status: 400 })
  }

  try {
    switch (entity) {
      case 'transactions': {
        const conditions = []
        if (filter.from) conditions.push(eq(schema.transactions.fromAddress, filter.from.toLowerCase()))
        if (filter.to) conditions.push(eq(schema.transactions.toAddress, filter.to.toLowerCase()))
        if (filter.blockNumber) conditions.push(eq(schema.transactions.blockNumber, filter.blockNumber))
        if (filter.blockFrom) conditions.push(gte(schema.transactions.blockNumber, filter.blockFrom))
        if (filter.blockTo) conditions.push(lte(schema.transactions.blockNumber, filter.blockTo))
        // Retention DELETEs transactions below the cutoff it publishes, so until its
        // VACUUM finishes (~40 min every 6h on BNB) the oldest end of every index is
        // dead entries, and an asc walk reads them all before its first row: 4.9 s
        // for 0x8894…d4e3 from mid-prune, 83 ms bounded. Start every walk at the
        // cutoff instead: timestamp for the (address, timestamp) indexes, block_number
        // for tx_block_idx. Rows below it are the ones being deleted.
        const cutoff = await getRetentionCutoff()
        if (cutoff) {
          conditions.push(gte(schema.transactions.blockNumber, cutoff.block), gte(schema.transactions.timestamp, cutoff.timestamp))
        }

        if (filter.address) {
          const rows = await selectByAddress(db, schema.transactions, filter.address.toLowerCase(), conditions,
            { order: orderBy, limit: safeLimit, offset: safeOffset })
          return apiJson({ entity, count: rows.length, data: rows })
        }
        // filter.from / filter.to sort as selectByAddress does, so the walk is the
        // address's own (address, timestamp) index and stops at the page. By
        // block_number alone the planner either walked tx_block_idx filtering every
        // row or read and sorted every row the address had: on BNB, filter.to
        // 0x1a39…27af in asc order ran past 10 minutes.
        const q = db.select().from(schema.transactions)
          .orderBy(...(filter.from || filter.to
            ? [dir(schema.transactions.timestamp), dir(schema.transactions.blockNumber)]
            : [dir(schema.transactions.blockNumber)]))
          .limit(safeLimit).offset(safeOffset)
        const rows = conditions.length > 0 ? await q.where(and(...conditions)) : await q
        return apiJson({ entity, count: rows.length, data: rows })
      }

      case 'blocks': {
        const conditions = []
        if (filter.blockFrom) conditions.push(gte(schema.blocks.number, filter.blockFrom))
        if (filter.blockTo) conditions.push(lte(schema.blocks.number, filter.blockTo))

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
        const conditions = []
        if (filter.from) conditions.push(eq(schema.tokenTransfers.fromAddress, filter.from.toLowerCase()))
        if (filter.to) conditions.push(eq(schema.tokenTransfers.toAddress, filter.to.toLowerCase()))
        if (filter.tokenAddress) conditions.push(eq(schema.tokenTransfers.tokenAddress, filter.tokenAddress.toLowerCase()))
        if (filter.blockFrom) conditions.push(gte(schema.tokenTransfers.blockNumber, filter.blockFrom))
        if (filter.blockTo) conditions.push(lte(schema.tokenTransfers.blockNumber, filter.blockTo))

        if (filter.address) {
          const rows = await selectByAddress(db, schema.tokenTransfers, filter.address.toLowerCase(), conditions,
            { order: orderBy, limit: safeLimit, offset: safeOffset })
          return apiJson({ entity, count: rows.length, data: rows })
        }
        // As for transactions: filter.to 0x1a39…27af 500ed in both orders on BNB.
        const q = db.select().from(schema.tokenTransfers)
          .orderBy(...(filter.from || filter.to
            ? [dir(schema.tokenTransfers.timestamp), dir(schema.tokenTransfers.blockNumber)]
            : [dir(schema.tokenTransfers.blockNumber)]))
          .limit(safeLimit).offset(safeOffset)
        const rows = conditions.length > 0 ? await q.where(and(...conditions)) : await q
        return apiJson({ entity, count: rows.length, data: rows })
      }

      case 'dex_trades': {
        const conditions = []
        if (filter.address) conditions.push(eq(schema.dexTrades.maker, filter.address.toLowerCase()))
        if (filter.dex) conditions.push(eq(schema.dexTrades.dex, filter.dex))
        if (filter.blockFrom) conditions.push(gte(schema.dexTrades.blockNumber, filter.blockFrom))
        if (filter.blockTo) conditions.push(lte(schema.dexTrades.blockNumber, filter.blockTo))

        const q = db.select().from(schema.dexTrades)
          .orderBy(orderBy === 'asc' ? schema.dexTrades.blockNumber : desc(schema.dexTrades.blockNumber))
          .limit(safeLimit).offset(safeOffset)
        const rows = conditions.length > 0 ? await q.where(and(...conditions)) : await q
        return apiJson({ entity, count: rows.length, data: rows })
      }

      default:
        return NextResponse.json({ error: 'Invalid entity. Use: transactions, blocks, tokens, token_transfers, dex_trades' }, { status: 400 })
    }
  } catch (e) {
    // Do not leak DB error details to callers — but log them: a bare catch here
    // hid ~95 statement timeouts an hour from the address filter.
    swallow('api/v1/query', e)
    return NextResponse.json({ error: 'Query failed' }, { status: 500 })
  }
}

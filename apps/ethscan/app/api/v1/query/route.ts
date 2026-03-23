import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq, and, gte, lte, or, desc } from 'drizzle-orm'
import { checkIpRateLimit } from '@/lib/api-rate-limit'

const ADDR = /^0x[0-9a-fA-F]{40}$/

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
  if (!checkIpRateLimit(request.headers.get('x-forwarded-for'))) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })

  let body: QueryBody
  try {
    body = await request.json() as QueryBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { entity, filter = {}, orderBy = 'desc', limit = 25, offset = 0 } = body

  // Validate numeric params
  const safeLimit = Math.min(Math.max(1, Number(limit) || 25), 100)
  const safeOffset = Math.max(0, Number(offset) || 0)

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
        if (filter.address) {
          const a = filter.address.toLowerCase()
          conditions.push(or(
            eq(schema.transactions.fromAddress, a),
            eq(schema.transactions.toAddress, a),
          )!)
        }
        if (filter.from) conditions.push(eq(schema.transactions.fromAddress, filter.from.toLowerCase()))
        if (filter.to) conditions.push(eq(schema.transactions.toAddress, filter.to.toLowerCase()))
        if (filter.blockNumber) conditions.push(eq(schema.transactions.blockNumber, filter.blockNumber))
        if (filter.blockFrom) conditions.push(gte(schema.transactions.blockNumber, filter.blockFrom))
        if (filter.blockTo) conditions.push(lte(schema.transactions.blockNumber, filter.blockTo))

        const q = db.select().from(schema.transactions)
          .orderBy(orderBy === 'asc' ? schema.transactions.blockNumber : desc(schema.transactions.blockNumber))
          .limit(safeLimit).offset(safeOffset)
        const rows = conditions.length > 0 ? await q.where(and(...conditions)) : await q
        return NextResponse.json({ entity, count: rows.length, data: rows })
      }

      case 'blocks': {
        const conditions = []
        if (filter.blockFrom) conditions.push(gte(schema.blocks.number, filter.blockFrom))
        if (filter.blockTo) conditions.push(lte(schema.blocks.number, filter.blockTo))

        const q = db.select().from(schema.blocks)
          .orderBy(orderBy === 'asc' ? schema.blocks.number : desc(schema.blocks.number))
          .limit(safeLimit).offset(safeOffset)
        const rows = conditions.length > 0 ? await q.where(and(...conditions)) : await q
        return NextResponse.json({ entity, count: rows.length, data: rows })
      }

      case 'tokens': {
        const rows = await db.select().from(schema.tokens)
          .orderBy(orderBy === 'asc' ? schema.tokens.holderCount : desc(schema.tokens.holderCount))
          .limit(safeLimit).offset(safeOffset)
        return NextResponse.json({ entity, count: rows.length, data: rows })
      }

      case 'token_transfers': {
        const conditions = []
        if (filter.address) {
          const a = filter.address.toLowerCase()
          conditions.push(or(
            eq(schema.tokenTransfers.fromAddress, a),
            eq(schema.tokenTransfers.toAddress, a),
          )!)
        }
        if (filter.from) conditions.push(eq(schema.tokenTransfers.fromAddress, filter.from.toLowerCase()))
        if (filter.to) conditions.push(eq(schema.tokenTransfers.toAddress, filter.to.toLowerCase()))
        if (filter.tokenAddress) conditions.push(eq(schema.tokenTransfers.tokenAddress, filter.tokenAddress.toLowerCase()))
        if (filter.blockFrom) conditions.push(gte(schema.tokenTransfers.blockNumber, filter.blockFrom))
        if (filter.blockTo) conditions.push(lte(schema.tokenTransfers.blockNumber, filter.blockTo))

        const q = db.select().from(schema.tokenTransfers)
          .orderBy(orderBy === 'asc' ? schema.tokenTransfers.blockNumber : desc(schema.tokenTransfers.blockNumber))
          .limit(safeLimit).offset(safeOffset)
        const rows = conditions.length > 0 ? await q.where(and(...conditions)) : await q
        return NextResponse.json({ entity, count: rows.length, data: rows })
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
        return NextResponse.json({ entity, count: rows.length, data: rows })
      }

      default:
        return NextResponse.json({ error: 'Invalid entity. Use: transactions, blocks, tokens, token_transfers, dex_trades' }, { status: 400 })
    }
  } catch {
    // Do not leak DB error details to callers
    return NextResponse.json({ error: 'Query failed' }, { status: 500 })
  }
}

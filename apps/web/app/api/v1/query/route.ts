import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq, and, gte, lte, or, desc } from 'drizzle-orm'
import { checkRateLimit } from '@/lib/api-rate-limit'

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
  const ip = request.headers.get('x-forwarded-for') ?? 'unknown'
  if (!checkRateLimit(ip)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })

  const body = await request.json() as QueryBody
  const { entity, filter = {}, orderBy = 'desc', limit = 25, offset = 0 } = body

  const safeLimit = Math.min(Math.max(1, limit), 100)

  try {
    switch (entity) {
      case 'transactions': {
        const conditions = []
        if (filter.address) {
          conditions.push(or(
            eq(schema.transactions.fromAddress, filter.address.toLowerCase()),
            eq(schema.transactions.toAddress, filter.address.toLowerCase()),
          )!)
        }
        if (filter.from) conditions.push(eq(schema.transactions.fromAddress, filter.from.toLowerCase()))
        if (filter.to) conditions.push(eq(schema.transactions.toAddress, filter.to.toLowerCase()))
        if (filter.blockNumber) conditions.push(eq(schema.transactions.blockNumber, filter.blockNumber))
        if (filter.blockFrom) conditions.push(gte(schema.transactions.blockNumber, filter.blockFrom))
        if (filter.blockTo) conditions.push(lte(schema.transactions.blockNumber, filter.blockTo))

        const q = db.select().from(schema.transactions)
          .orderBy(orderBy === 'asc' ? schema.transactions.blockNumber : desc(schema.transactions.blockNumber))
          .limit(safeLimit).offset(offset)
        const rows = conditions.length > 0 ? await q.where(and(...conditions)) : await q
        return NextResponse.json({ entity, count: rows.length, data: rows })
      }

      case 'blocks': {
        const conditions = []
        if (filter.blockFrom) conditions.push(gte(schema.blocks.number, filter.blockFrom))
        if (filter.blockTo) conditions.push(lte(schema.blocks.number, filter.blockTo))

        const q = db.select().from(schema.blocks)
          .orderBy(orderBy === 'asc' ? schema.blocks.number : desc(schema.blocks.number))
          .limit(safeLimit).offset(offset)
        const rows = conditions.length > 0 ? await q.where(and(...conditions)) : await q
        return NextResponse.json({ entity, count: rows.length, data: rows })
      }

      case 'tokens': {
        const rows = await db.select().from(schema.tokens)
          .orderBy(orderBy === 'asc' ? schema.tokens.holderCount : desc(schema.tokens.holderCount))
          .limit(safeLimit).offset(offset)
        return NextResponse.json({ entity, count: rows.length, data: rows })
      }

      case 'token_transfers': {
        const conditions = []
        if (filter.address) {
          conditions.push(or(
            eq(schema.tokenTransfers.fromAddress, filter.address.toLowerCase()),
            eq(schema.tokenTransfers.toAddress, filter.address.toLowerCase()),
          )!)
        }
        if (filter.from) conditions.push(eq(schema.tokenTransfers.fromAddress, filter.from.toLowerCase()))
        if (filter.to) conditions.push(eq(schema.tokenTransfers.toAddress, filter.to.toLowerCase()))
        if (filter.tokenAddress) conditions.push(eq(schema.tokenTransfers.tokenAddress, filter.tokenAddress.toLowerCase()))
        if (filter.blockFrom) conditions.push(gte(schema.tokenTransfers.blockNumber, filter.blockFrom))
        if (filter.blockTo) conditions.push(lte(schema.tokenTransfers.blockNumber, filter.blockTo))

        const q = db.select().from(schema.tokenTransfers)
          .orderBy(orderBy === 'asc' ? schema.tokenTransfers.blockNumber : desc(schema.tokenTransfers.blockNumber))
          .limit(safeLimit).offset(offset)
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
          .limit(safeLimit).offset(offset)
        const rows = conditions.length > 0 ? await q.where(and(...conditions)) : await q
        return NextResponse.json({ entity, count: rows.length, data: rows })
      }

      default:
        return NextResponse.json({ error: 'Invalid entity. Use: transactions, blocks, tokens, token_transfers, dex_trades' }, { status: 400 })
    }
  } catch (err) {
    return NextResponse.json({ error: 'Query failed', detail: String(err) }, { status: 500 })
  }
}

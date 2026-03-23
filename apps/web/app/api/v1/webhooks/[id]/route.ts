import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { checkRateLimit } from '@/lib/api-rate-limit'

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ip = request.headers.get('x-forwarded-for') ?? 'unknown'
  if (!checkRateLimit(ip)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })

  const { id } = await params
  const webhookId = parseInt(id, 10)
  if (isNaN(webhookId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const deleted = await db.delete(schema.webhooks)
    .where(eq(schema.webhooks.id, webhookId))
    .returning({ id: schema.webhooks.id })

  if (deleted.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ deleted: deleted[0].id })
}

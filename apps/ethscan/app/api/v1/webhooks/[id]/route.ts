import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { and, eq } from 'drizzle-orm'
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

  // Require ownerAddress to prevent unauthorized deletion
  const { searchParams } = new URL(request.url)
  const ownerAddress = searchParams.get('ownerAddress')?.toLowerCase()
  if (!ownerAddress || !/^0x[0-9a-f]{40}$/i.test(ownerAddress)) {
    return NextResponse.json({ error: 'ownerAddress query param required' }, { status: 400 })
  }

  const deleted = await db.delete(schema.webhooks)
    .where(and(
      eq(schema.webhooks.id, webhookId),
      eq(schema.webhooks.ownerAddress, ownerAddress),
    ))
    .returning({ id: schema.webhooks.id })

  if (deleted.length === 0) return NextResponse.json({ error: 'Not found or not authorized' }, { status: 404 })
  return NextResponse.json({ deleted: deleted[0].id })
}

import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { and, eq } from 'drizzle-orm'
import { authFailure, authRequest, requireApiKeyOwner } from '@/lib/api-auth'

const MAX_SERIAL = 2_147_483_647 // api_keys.id is a 4-byte serial; a larger id would be a database error

// DELETE: revoke an API key (requires an active key of the same owner). The row is deleted, not
// set inactive: mintApiKey counts every row an owner holds, so a deleted key frees its slot under
// the cap, while a key the operator deactivated (active=false) keeps counting and keeps its owner
// from minting a replacement with a signature alone.
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authRequest(request)
  if (!auth.ok) return authFailure(auth)

  const { id } = await params
  const keyId = /^[0-9]{1,10}$/.test(id) ? Number(id) : NaN
  if (!Number.isSafeInteger(keyId) || keyId > MAX_SERIAL) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }

  const { searchParams } = new URL(request.url)
  const owner = searchParams.get('owner')?.toLowerCase()
  if (!owner || !/^0x[0-9a-f]{40}$/.test(owner)) {
    return NextResponse.json({ error: 'Missing or invalid owner address' }, { status: 400 })
  }

  // The requesting key must belong to this owner; the update below then only reaches that owner's rows.
  const ownerAuth = await requireApiKeyOwner(request, owner)
  if (!ownerAuth.ok) return NextResponse.json({ error: ownerAuth.error }, { status: ownerAuth.status })

  const revoked = await db.delete(schema.apiKeys)
    .where(and(
      eq(schema.apiKeys.id, keyId),
      eq(schema.apiKeys.ownerAddress, owner),
    ))
    .returning({ id: schema.apiKeys.id })

  if (revoked.length === 0) return NextResponse.json({ error: 'Not found or not authorized' }, { status: 404 })
  return NextResponse.json({ revoked: revoked[0].id })
}

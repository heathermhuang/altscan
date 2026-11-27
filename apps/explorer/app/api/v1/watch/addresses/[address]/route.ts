import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { admitWatchRequest, requireWatchOwner, watchUnavailable } from '@/lib/watch-route'
import { isUndefinedTable, removeWatchAddress } from '@/lib/watch-addresses'
import { isLowerHexAddress } from '@/lib/hex'

export const dynamic = 'force-dynamic'

// DELETE: stop watching one address
export async function DELETE(request: Request, { params }: { params: Promise<{ address: string }> }) {
  const refused = await admitWatchRequest(request)
  if (refused) return refused
  const who = await requireWatchOwner(request, new URL(request.url).searchParams.get('owner'))
  if (!who.ok) return who.response
  const address = (await params).address.toLowerCase()
  if (!isLowerHexAddress(address)) return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  try {
    if (!(await removeWatchAddress(db, who.owner, address))) {
      return NextResponse.json({ error: 'Address is not watched' }, { status: 404 })
    }
    return NextResponse.json({ removed: address })
  } catch (e) {
    if (isUndefinedTable(e)) return watchUnavailable()
    throw e
  }
}

import { NextResponse } from 'next/server'
import { desc, eq } from 'drizzle-orm'
import { isSettingsKey } from '@altscan/settings-schema'
import { db, schema } from '@/lib/db'
import { isAdminRequest } from '@/lib/admin-auth'

export const dynamic = 'force-dynamic'

/** GET /api/admin/settings/:key/audit — last 20 writes for one namespace
 *  (the console's history/revert view re-PUTs an old value from here). */
export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const { key } = await params
  if (!isSettingsKey(key)) {
    return NextResponse.json({ error: `unknown settings key: ${key}` }, { status: 404 })
  }
  const rows = await db
    .select()
    .from(schema.explorerSettingsAudit)
    .where(eq(schema.explorerSettingsAudit.key, key))
    .orderBy(desc(schema.explorerSettingsAudit.id))
    .limit(20)
  return NextResponse.json({ key, entries: rows })
}

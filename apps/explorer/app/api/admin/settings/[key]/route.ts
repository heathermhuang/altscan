import { NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { sql } from 'drizzle-orm'
import { isSettingsKey, parseSetting } from '@altscan/settings-schema'
import { db } from '@/lib/db'
import { isAdminRequest } from '@/lib/admin-auth'

export const dynamic = 'force-dynamic'

/**
 * PUT /api/admin/settings/:key — validate one namespace, upsert with
 * optimistic versioning, append an audit row, and revalidate the 'settings'
 * cache tag so the change applies on the next render.
 * Body: { value, expectedVersion?, updatedBy? }
 */
export async function PUT(request: Request, { params }: { params: Promise<{ key: string }> }) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const { key } = await params
  if (!isSettingsKey(key)) {
    return NextResponse.json({ error: `unknown settings key: ${key}` }, { status: 404 })
  }

  let body: { value?: unknown; expectedVersion?: number; updatedBy?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const value = parseSetting(key, body.value)
  if (value === null) {
    return NextResponse.json({ error: 'value failed schema validation' }, { status: 422 })
  }
  const updatedBy = typeof body.updatedBy === 'string' ? body.updatedBy.slice(0, 120) : null
  const guard =
    typeof body.expectedVersion === 'number'
      ? sql`explorer_settings.version = ${body.expectedVersion}`
      : sql`true`

  const result = await db.execute(sql`
    INSERT INTO explorer_settings (key, value, version, updated_at, updated_by)
    VALUES (${key}, ${JSON.stringify(value)}::jsonb, 1, now(), ${updatedBy})
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          version = explorer_settings.version + 1,
          updated_at = now(),
          updated_by = EXCLUDED.updated_by
      WHERE ${guard}
    RETURNING key, version
  `)
  const row = Array.from(result as Iterable<{ key: string; version: number }>)[0]
  if (!row) {
    return NextResponse.json({ error: 'version conflict — reload and retry' }, { status: 409 })
  }

  await db.execute(sql`
    INSERT INTO explorer_settings_audit (key, value, version, updated_by)
    VALUES (${key}, ${JSON.stringify(value)}::jsonb, ${row.version}, ${updatedBy})
  `)

  revalidateTag('settings')
  return NextResponse.json({ ok: true, key, version: row.version })
}

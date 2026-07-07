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
  const json = JSON.stringify(value)

  // One transaction so a crash can never persist a setting without its audit
  // row — the console's revert-from-history trusts the audit trail. With
  // expectedVersion: strict optimistic concurrency, where an absent row is a
  // conflict too (a client that thinks it edits v N must not create v1).
  const row = await db.transaction(async (tx) => {
    const result =
      typeof body.expectedVersion === 'number'
        ? await tx.execute(sql`
            UPDATE explorer_settings
            SET value = ${json}::jsonb,
                version = version + 1,
                updated_at = now(),
                updated_by = ${updatedBy}
            WHERE key = ${key} AND version = ${body.expectedVersion}
            RETURNING key, version
          `)
        : await tx.execute(sql`
            INSERT INTO explorer_settings (key, value, version, updated_at, updated_by)
            VALUES (${key}, ${json}::jsonb, 1, now(), ${updatedBy})
            ON CONFLICT (key) DO UPDATE
              SET value = EXCLUDED.value,
                  version = explorer_settings.version + 1,
                  updated_at = now(),
                  updated_by = EXCLUDED.updated_by
            RETURNING key, version
          `)
    const updated = Array.from(result as Iterable<{ key: string; version: number }>)[0]
    if (!updated) return undefined
    await tx.execute(sql`
      INSERT INTO explorer_settings_audit (key, value, version, updated_by)
      VALUES (${key}, ${json}::jsonb, ${updated.version}, ${updatedBy})
    `)
    return updated
  })

  if (!row) {
    return NextResponse.json({ error: 'version conflict — reload and retry' }, { status: 409 })
  }

  revalidateTag('settings')
  return NextResponse.json({ ok: true, key, version: row.version })
}

import { NextResponse } from 'next/server'
import { AD_PLACEMENTS, SETTINGS_KEYS } from '@altscan/settings-schema'
import { db, schema } from '@/lib/db'
import { isAdminRequest } from '@/lib/admin-auth'
import { chainConfig } from '@/lib/chain'
import { DEFAULT_QUICK_LINKS } from '@/lib/settings-defaults'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/settings — all stored settings + built-in defaults.
 * Requires Authorization: Bearer <ADMIN_SECRET>. The admin console renders
 * its editor from this payload (keys, adPlacements, defaults for diffing).
 */
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let rows: (typeof schema.explorerSettings.$inferSelect)[] = []
  let warning: string | undefined
  try {
    rows = await db.select().from(schema.explorerSettings)
  } catch {
    warning = 'settings table unavailable (not created yet, or DB down) — defaults in effect'
  }

  return NextResponse.json({
    chain: chainConfig.key,
    keys: SETTINGS_KEYS,
    adPlacements: AD_PLACEMENTS,
    settings: Object.fromEntries(
      rows.map((r) => [
        r.key,
        { value: r.value, version: r.version, updatedAt: r.updatedAt, updatedBy: r.updatedBy },
      ]),
    ),
    defaults: {
      links: { quickLinks: DEFAULT_QUICK_LINKS },
      footer: { tagline: chainConfig.tagline, notAffiliatedWith: chainConfig.notAffiliatedWith },
      ads: { binanceRefCode: chainConfig.key === 'eth' ? 'ETHSCAN' : 'BNBSCAN', placements: {} },
    },
    ...(warning ? { warning } : {}),
  })
}

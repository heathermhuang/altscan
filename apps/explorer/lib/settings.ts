import { unstable_cache } from 'next/cache'
import { parseSetting, type SettingsKey, type SettingsShape } from '@altscan/settings-schema'
import { db, schema } from './db'

/**
 * All settings rows, cached 60s and tagged so the admin PUT can
 * revalidateTag('settings') for near-instant application on this instance.
 * Any failure (table missing, DB down) → {} → callers use built-in defaults.
 */
const loadRaw = unstable_cache(
  async (): Promise<Record<string, unknown>> => {
    try {
      const rows = await db.select().from(schema.explorerSettings)
      return Object.fromEntries(rows.map((r) => [r.key, r.value]))
    } catch {
      return {}
    }
  },
  ['explorer-settings'],
  { revalidate: 60, tags: ['settings'] },
)

/** Validated override for one namespace, or null → use defaults. */
export async function getSetting<K extends SettingsKey>(key: K): Promise<SettingsShape[K] | null> {
  const all = await loadRaw()
  return key in all ? parseSetting(key, all[key]) : null
}

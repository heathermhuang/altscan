import { drizzle } from 'drizzle-orm/d1'
import { and, eq } from 'drizzle-orm'
import * as schema from './schema'

export function getDb(env: Env) {
  return drizzle(env.DB, { schema })
}

/** Tenant-scoped by design: a member can only address explorers inside their
 *  own tenant. A cross-tenant ID reads as "not found" (404), never 403 — no
 *  existence leak, and every downstream proxy (settings/render/audit) is
 *  automatically fenced because they all resolve explorers through here. */
export async function getExplorer(env: Env, id: string, tenantId: string) {
  const rows = await getDb(env)
    .select()
    .from(schema.explorers)
    .where(and(eq(schema.explorers.id, id), eq(schema.explorers.tenantId, tenantId)))
    .limit(1)
  return rows[0] ?? null
}

/** Fleet listing, fenced to the member's tenant like getExplorer. */
export async function listExplorers(env: Env, tenantId: string) {
  return getDb(env).select().from(schema.explorers).where(eq(schema.explorers.tenantId, tenantId))
}

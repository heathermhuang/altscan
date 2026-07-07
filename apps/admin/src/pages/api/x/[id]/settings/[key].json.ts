import type { APIRoute } from 'astro'
import { getDb, getExplorer } from '../../../../../lib/db'
import { audit } from '../../../../../lib/schema'
import { canWrite } from '../../../../../lib/rbac'
import { json } from '../../../../../lib/http'
import { explorerAdminFetch } from '../../../../../lib/upstream'

export const prerender = false

/** PUT proxy — RBAC-gated; injects the authenticated actor as updatedBy and
 *  records a console-side audit row on success. */
export const PUT: APIRoute = async ({ params, locals, request }) => {
  const env = locals.runtime.env
  if (!canWrite(locals.member.role)) return json({ error: 'forbidden: read-only role' }, 403)

  const explorer = await getExplorer(env, params.id!, locals.member.tenantId)
  if (!explorer) return json({ error: 'unknown explorer' }, 404)

  let body: { value?: unknown; expectedVersion?: number }
  try {
    const parsed: unknown = await request.json()
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return json({ error: 'body must be a JSON object' }, 400)
    }
    body = parsed as typeof body
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  const upstream = await explorerAdminFetch(env, explorer, `/api/admin/settings/${params.key}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, updatedBy: locals.member.email }),
  })

  if (upstream.ok) {
    await getDb(env)
      .insert(audit)
      .values({
        actorEmail: locals.member.email,
        tenantId: explorer.tenantId,
        explorerId: explorer.id,
        action: `settings.put:${params.key}`,
        payload: JSON.stringify(body.value ?? null).slice(0, 4000),
        at: Math.floor(Date.now() / 1000),
      })
  }
  return json(upstream.body ?? { error: upstream.error ?? 'upstream error' }, upstream.status || 502)
}

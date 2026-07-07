import type { APIRoute } from 'astro'
import { getExplorer } from '../../../../lib/db'
import { json } from '../../../../lib/http'
import { explorerAdminFetch } from '../../../../lib/upstream'

export const prerender = false

/** GET proxy — pass the explorer's settings payload through, annotated with
 *  the caller's role so the editor island can disable inputs for viewers. */
export const GET: APIRoute = async ({ params, locals }) => {
  const env = locals.runtime.env
  const explorer = await getExplorer(env, params.id!, locals.member.tenantId)
  if (!explorer) return json({ error: 'unknown explorer' }, 404)
  const upstream = await explorerAdminFetch(env, explorer, '/api/admin/settings')
  if (!upstream.ok) {
    return json({ error: upstream.error ?? 'upstream error', upstreamStatus: upstream.status }, 502)
  }
  return json({ ...(upstream.body as Record<string, unknown>), role: locals.member.role })
}

import type { APIRoute } from 'astro'
import { getExplorer } from '../../../../lib/db'
import { json } from '../../../../lib/http'
import { canWrite } from '../../../../lib/rbac'
import { redactSettingsPayload } from '../../../../lib/redact'
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
  const body = upstream.body as Record<string, unknown>
  // A stored rpc.webRpcUrl can embed an API key; viewers get the host only.
  const safe = canWrite(locals.member.role) ? body : redactSettingsPayload(body)
  return json({ ...safe, role: locals.member.role })
}

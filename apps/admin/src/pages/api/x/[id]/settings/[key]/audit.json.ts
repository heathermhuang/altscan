import type { APIRoute } from 'astro'
import { getExplorer } from '../../../../../../lib/db'
import { json } from '../../../../../../lib/http'
import { canWrite } from '../../../../../../lib/rbac'
import { redactAuditPayload } from '../../../../../../lib/redact'
import { explorerAdminFetch } from '../../../../../../lib/upstream'

export const prerender = false

export const GET: APIRoute = async ({ params, locals }) => {
  const env = locals.runtime.env
  const explorer = await getExplorer(env, params.id!, locals.member.tenantId)
  if (!explorer) return json({ error: 'unknown explorer' }, 404)
  const upstream = await explorerAdminFetch(
    env,
    explorer,
    `/api/admin/settings/${params.key}/audit`,
  )
  const body = upstream.body ?? { error: upstream.error ?? 'upstream error' }
  // rpc history carries prior webRpcUrl values, which can embed an API key.
  const safe =
    params.key === 'rpc' && upstream.ok && !canWrite(locals.member.role)
      ? redactAuditPayload(body as Record<string, unknown>)
      : body
  return json(safe, upstream.status || 502)
}

import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { isSettingsKey } from '@altscan/settings-schema'
import { getExplorer } from '../../../../../../lib/db'
import { json } from '../../../../../../lib/http'
import { canWrite } from '../../../../../../lib/rbac'
import { redactAuditPayload } from '../../../../../../lib/redact'
import { explorerAdminFetch } from '../../../../../../lib/upstream'

export const prerender = false

export const GET: APIRoute = async ({ params, locals }) => {
  // The key is spliced into an upstream path that carries the explorer's admin
  // secret, so only a known namespace may reach it — never a `..` segment that
  // would re-target the request (and dodge the rpc-only redaction below).
  if (!isSettingsKey(params.key ?? '')) return json({ error: 'unknown setting' }, 404)
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

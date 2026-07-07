import type { APIRoute } from 'astro'
import { getExplorer } from '../../../../../../lib/db'
import { json } from '../../../../../../lib/http'
import { explorerAdminFetch } from '../../../../../../lib/upstream'

export const prerender = false

export const GET: APIRoute = async ({ params, locals }) => {
  const env = locals.runtime.env
  const explorer = await getExplorer(env, params.id!)
  if (!explorer) return json({ error: 'unknown explorer' }, 404)
  const upstream = await explorerAdminFetch(
    env,
    explorer,
    `/api/admin/settings/${params.key}/audit`,
  )
  return json(upstream.body ?? { error: upstream.error ?? 'upstream error' }, upstream.status || 502)
}

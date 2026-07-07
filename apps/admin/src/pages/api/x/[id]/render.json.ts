import type { APIRoute } from 'astro'
import { getExplorer } from '../../../../lib/db'
import { json } from '../../../../lib/http'
import { renderApi } from '../../../../lib/upstream'

export const prerender = false

export const GET: APIRoute = async ({ params, locals }) => {
  const env = locals.runtime.env
  const explorer = await getExplorer(env, params.id!, locals.member.tenantId)
  if (!explorer) return json({ error: 'unknown explorer' }, 404)

  const services = [
    { label: 'web', id: explorer.renderWebId },
    { label: 'indexer', id: explorer.renderIndexerId },
  ].filter((s): s is { label: string; id: string } => !!s.id)

  const details = await Promise.all(
    services.map(async (s) => ({
      service: s.label,
      info: (await renderApi(env, `/services/${s.id}`)).body,
      deploys: (await renderApi(env, `/services/${s.id}/deploys?limit=3`)).body,
    })),
  )
  return json({ id: explorer.id, services: details })
}

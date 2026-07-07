import type { APIRoute } from 'astro'
import { listExplorers } from '../../lib/db'
import { buildFleetPayload } from '../../lib/fleet'
import { fetchExplorerHealth, fetchLatestDeploys } from '../../lib/upstream'
import { json } from '../../lib/http'

export const prerender = false

export const GET: APIRoute = async ({ locals }) => {
  const env = locals.runtime.env
  const rows = await listExplorers(env, locals.member.tenantId)
  const probes = await Promise.all(
    rows.map(async (x) => {
      const [health, deploys] = await Promise.all([
        fetchExplorerHealth(env, x),
        fetchLatestDeploys(env, x),
      ])
      return {
        explorer: { id: x.id, brand: x.brand, publicUrl: x.publicUrl, status: x.status },
        health,
        deploys,
      }
    }),
  )
  return json(buildFleetPayload(probes, Date.now()))
}

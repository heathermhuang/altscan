import type { APIRoute } from 'astro'
import { getDb } from '../../lib/db'
import { explorers } from '../../lib/schema'
import { buildFleetPayload } from '../../lib/fleet'
import { fetchExplorerHealth, fetchLatestDeploys } from '../../lib/upstream'
import { json } from '../../lib/http'

export const prerender = false

export const GET: APIRoute = async ({ locals }) => {
  const env = locals.runtime.env
  const rows = await getDb(env).select().from(explorers)
  const probes = await Promise.all(
    rows.map(async (x) => ({
      explorer: { id: x.id, brand: x.brand, publicUrl: x.publicUrl, status: x.status },
      health: await fetchExplorerHealth(env, x),
      deploys: await fetchLatestDeploys(env, x),
    })),
  )
  return json(buildFleetPayload(probes, Date.now()))
}

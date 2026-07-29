import type { APIRoute } from 'astro'
import { getChainConfig } from '@altscan/chain-config'
import { getExplorer } from '../../../../../lib/db'
import { json } from '../../../../../lib/http'
import { probeRpc, validateRpcUrl } from '../../../../../lib/rpc-probe'

export const prerender = false

/**
 * POST { url } → probe it for chain id / head block / latency.
 *
 * Read-only, so any console member may run it; persisting the result still goes
 * through the RBAC-gated settings PUT. Guarded by the CF Access middleware plus
 * a tenant-scoped explorer lookup (cross-tenant = 404).
 */
export const POST: APIRoute = async ({ params, locals, request }) => {
  const env = locals.runtime.env
  const explorer = await getExplorer(env, params.id!, locals.member.tenantId)
  if (!explorer) return json({ error: 'unknown explorer' }, 404)

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }
  const url = validateRpcUrl((raw as { url?: unknown } | null)?.url)
  if (!url) return json({ error: 'url must be an https:// URL' }, 400)

  // getChainConfig THROWS on an unknown key. A D1 explorer row can be seeded for
  // a chain this build of chain-config doesn't know yet — degrade to "no
  // expectation" instead of 500ing the probe.
  let expectedChainId: number | null = null
  try {
    expectedChainId = getChainConfig(explorer.key).chainId
  } catch {
    expectedChainId = null
  }

  return json(await probeRpc(url, expectedChainId))
}

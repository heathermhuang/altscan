import type { ExplorerRow } from './schema'
import type { DeploySummary, UpstreamResult } from './fleet'

export async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<UpstreamResult> {
  const { timeoutMs = 6000, ...rest } = init
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...rest, signal: controller.signal })
    const body = await res.json().catch(() => null)
    return { ok: res.ok, status: res.status, body }
  } catch (err) {
    return { ok: false, status: 0, body: null, error: String(err) }
  } finally {
    clearTimeout(timer)
  }
}

export function adminSecretFor(env: Env, explorer: ExplorerRow): string | null {
  const secret = (env as unknown as Record<string, unknown>)[explorer.adminSecretBinding]
  return typeof secret === 'string' && secret.length > 0 ? secret : null
}

/** Authenticated call to an explorer's admin API via its onrender.com origin
 *  (the CF-fronted public domains challenge non-browser callers). */
export function explorerAdminFetch(
  env: Env,
  explorer: ExplorerRow,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<UpstreamResult> {
  const secret = adminSecretFor(env, explorer)
  if (!secret) {
    return Promise.resolve({
      ok: false,
      status: 500,
      body: null,
      error: `missing Worker secret: ${explorer.adminSecretBinding}`,
    })
  }
  return fetchJson(`${explorer.originUrl}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${secret}` },
  })
}

export function renderApi(env: Env, path: string): Promise<UpstreamResult> {
  return fetchJson(`https://api.render.com/v1${path}`, {
    headers: { authorization: `Bearer ${env.RENDER_API_KEY}`, accept: 'application/json' },
  })
}

function summarizeDeploy(result: UpstreamResult): DeploySummary | undefined {
  if (!result.ok || !Array.isArray(result.body)) return undefined
  const d = (result.body[0] as { deploy?: Record<string, unknown> } | undefined)?.deploy
  if (!d) return undefined
  const commit = (d.commit as { id?: string } | undefined)?.id
  return {
    status: typeof d.status === 'string' ? d.status : undefined,
    finishedAt: typeof d.finishedAt === 'string' ? d.finishedAt : undefined,
    commit: typeof commit === 'string' ? commit.slice(0, 7) : undefined,
  }
}

export async function fetchLatestDeploys(
  env: Env,
  explorer: ExplorerRow,
): Promise<{ web?: DeploySummary; indexer?: DeploySummary }> {
  const [web, indexer] = await Promise.all([
    explorer.renderWebId ? renderApi(env, `/services/${explorer.renderWebId}/deploys?limit=1`) : null,
    explorer.renderIndexerId
      ? renderApi(env, `/services/${explorer.renderIndexerId}/deploys?limit=1`)
      : null,
  ])
  return {
    ...(web ? { web: summarizeDeploy(web) } : {}),
    ...(indexer ? { indexer: summarizeDeploy(indexer) } : {}),
  }
}

export function fetchExplorerHealth(env: Env, explorer: ExplorerRow): Promise<UpstreamResult> {
  return explorerAdminFetch(env, explorer, '/api/health')
}

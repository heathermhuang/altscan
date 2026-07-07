export type UpstreamResult = { ok: boolean; status: number; body: unknown; error?: string }
export type DeploySummary = { status?: string; finishedAt?: string; commit?: string }

export type ExplorerProbe = {
  explorer: { id: string; brand: string; publicUrl: string; status: string }
  health: UpstreamResult
  deploys: { web?: DeploySummary; indexer?: DeploySummary }
}

export type FleetExplorer = {
  id: string
  brand: string
  publicUrl: string
  registryStatus: string
  health: 'ok' | 'degraded' | 'unreachable'
  latestBlock: number | null
  lagSeconds: number | null
  dbSizeMB: number | null
  memoryStatus: string | null
  /** getMoralisLimiterState() passthrough from admin health — shape is
   *  version-dependent, so it stays unknown and the UI renders defensively. */
  moralis: unknown
  deploys: ExplorerProbe['deploys']
}

export type FleetPayload = { generatedAt: number; explorers: FleetExplorer[] }

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function buildFleetPayload(probes: ExplorerProbe[], generatedAt: number): FleetPayload {
  return {
    generatedAt,
    explorers: probes.map(({ explorer, health, deploys }) => {
      const body = (health.body ?? {}) as Record<string, unknown>
      const database = (body.database ?? {}) as Record<string, unknown>
      const memory = (body.memory ?? {}) as Record<string, unknown>
      const healthState: FleetExplorer['health'] = !health.ok
        ? 'unreachable'
        : body.status === 'degraded'
          ? 'degraded'
          : 'ok'
      return {
        id: explorer.id,
        brand: explorer.brand,
        publicUrl: explorer.publicUrl,
        registryStatus: explorer.status,
        health: healthState,
        latestBlock: num(body.latestBlock),
        lagSeconds: num(body.lagSeconds),
        dbSizeMB: num(database.sizeMB),
        memoryStatus: typeof memory.status === 'string' ? memory.status : null,
        moralis: body.moralis ?? null,
        deploys,
      }
    }),
  }
}

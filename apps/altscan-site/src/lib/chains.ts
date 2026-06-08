export interface HealthBody { status?: string; latestBlock?: number | null; lagSeconds?: number | null; }
export interface ChainState { block: number | null; online: boolean; }

export function parseHealth(body: unknown): ChainState {
  const b = body as HealthBody | null | undefined;
  const block = typeof b?.latestBlock === 'number' ? b.latestBlock : null;
  return { block, online: b?.status === 'ok' && block !== null };
}

export function buildChainsPayload(
  results: Array<{ id: string; body: unknown }>,
  ts: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ts };
  for (const r of results) out[r.id] = parseHealth(r.body);
  return out;
}

/** Fetch one health endpoint with a hard timeout; never throws. */
export async function fetchHealth(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2000,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { 'user-agent': 'altscan-site' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

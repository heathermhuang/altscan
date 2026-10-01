/** [number, unixSeconds, txCount, gasPct] — compact so the payload stays ~2 KB. */
export type BlockTuple = [number, number, number, number];

export interface LatestBlock {
  number: number;
  hash: string;
  miner: string;
  timestamp: number;
  txCount: number;
  gasUsed: string;
  gasLimit: string;
  baseFeePerGas: string | null;
}

export interface ChainState {
  block: number | null;
  online: boolean;
  blocks?: BlockTuple[];
  latest?: LatestBlock;
}

const DIGITS = /^\d+$/;

/** Integer percent of the gas limit used. BigInt math, because gas values can pass 2^53. */
export function gasPct(used: unknown, limit: unknown): number | null {
  if (typeof used !== 'string' || typeof limit !== 'string' || !DIGITS.test(used) || !DIGITS.test(limit)) {
    return null;
  }
  const l = BigInt(limit);
  if (l === 0n) return 0;
  const pct = Number((BigInt(used) * 100n) / l);
  return Math.min(100, pct);
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * Map an explorer's /api/v1/blocks body to the chain state served by /api/chains.json.
 *
 * `online` means the explorer answered with at least one usable block. An empty list is treated
 * as offline: a healthy explorer always has recent blocks, and an empty answer is what a broken
 * upstream returns. Malformed rows are dropped, never coerced — every number on the page must be real.
 */
export function parseBlocks(body: unknown): ChainState {
  const rows = (body as { blocks?: unknown } | null | undefined)?.blocks;
  if (!Array.isArray(rows)) return { block: null, online: false };

  const valid: Array<{ tuple: BlockTuple; latest: LatestBlock }> = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    if (!r || typeof r !== 'object') continue;
    const ms = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
    const g = gasPct(r.gasUsed, r.gasLimit);
    if (!isCount(r.number) || !Number.isFinite(ms) || !isCount(r.txCount) || g === null) continue;
    if (typeof r.hash !== 'string' || typeof r.miner !== 'string') continue;
    const ts = Math.floor(ms / 1000);
    valid.push({
      tuple: [r.number, ts, r.txCount, g],
      latest: {
        number: r.number, hash: r.hash, miner: r.miner, timestamp: ts, txCount: r.txCount,
        gasUsed: r.gasUsed as string, gasLimit: r.gasLimit as string,
        baseFeePerGas: typeof r.baseFeePerGas === 'string' ? r.baseFeePerGas : null,
      },
    });
  }
  if (valid.length === 0) return { block: null, online: false };

  // Pages fetched in parallel can overlap when a block lands between them.
  const unique = [...new Map(valid.map((v) => [v.tuple[0], v])).values()];
  unique.sort((a, b) => b.tuple[0] - a.tuple[0]);
  return {
    block: unique[0].tuple[0],
    online: true,
    blocks: unique.map((v) => v.tuple),
    latest: unique[0].latest,
  };
}

export function buildChainsPayload(
  results: Array<{ id: string; body: unknown }>,
  ts: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ts };
  for (const r of results) out[r.id] = parseBlocks(r.body);
  return out;
}

/** Fetch JSON with a hard timeout; never throws (null on any failure, including non-2xx). */
export async function fetchJson(
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

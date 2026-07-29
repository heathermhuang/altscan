import { rpcSettingsSchema } from '@altscan/settings-schema'

export const PROBE_TIMEOUT_MS = 5000
/** Cap what we read from an operator-supplied host. A chain-id/block-number
 *  reply is tens of bytes; anything larger is not an RPC endpoint. */
export const MAX_RESPONSE_BYTES = 8192

export type RpcProbeResult = {
  ok: boolean
  chainId?: number
  expectedChainId: number | null
  /** null = the expected id is unknown, so a match can't be confirmed. */
  chainIdMatches?: boolean | null
  blockNumber?: number | null
  latencyMs?: number
  error?: string
  blockNumberError?: string
}

type CallOk = { result: string; latencyMs: number }
type CallErr = { error: string }

/**
 * Read at most MAX_RESPONSE_BYTES, without ever buffering the whole body.
 * `res.text()` would pull an unbounded response into worker memory before any
 * length check could reject it, so there is deliberately NO text() fallback
 * here — a missing body reads as empty rather than as "read it all". Counts
 * BYTES off the wire, not UTF-16 code units. Returns null when the cap is
 * exceeded.
 */
async function readCapped(res: Response): Promise<string | null> {
  const declared = Number(res.headers?.get?.('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return null

  const reader = res.body?.getReader?.()
  if (!reader) return ''

  const decoder = new TextDecoder()
  let out = ''
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value?.byteLength ?? 0
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        return null
      }
      out += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock?.()
  }
  return out + decoder.decode()
}

/**
 * Validate a candidate RPC URL through the REAL settings schema — which now
 * carries the blocked-host rule itself, so probe and save enforce one policy
 * and cannot drift apart. Returns null when invalid.
 */
export function validateRpcUrl(url: unknown): string | null {
  const parsed = rpcSettingsSchema.safeParse({ webRpcUrl: url })
  return parsed.success ? (parsed.data.webRpcUrl ?? null) : null
}

/**
 * Single JSON-RPC call against a candidate endpoint.
 *
 * SSRF posture (design §7, hardened after review): https-only, blocked hosts
 * rejected, write-capable member only, short timeout, redirects NOT followed,
 * body read bounded before buffering, and ONLY parsed scalars are returned —
 * never the upstream body, headers, or status text.
 */
async function rpcCall(
  url: string,
  method: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<CallOk | CallErr> {
  const startedAt = Date.now()
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
      signal,
      // Do NOT follow redirects: an https URL that 302s to http:// (or to a
      // host validateRpcUrl would have refused) would otherwise defeat every
      // check above. A real RPC endpoint does not redirect.
      redirect: 'manual',
    })
    const latencyMs = Date.now() - startedAt
    if (res.status >= 300 && res.status < 400) return { error: 'endpoint redirected — not a JSON-RPC endpoint' }
    if (!res.ok) return { error: `endpoint returned HTTP ${res.status}` }

    const text = await readCapped(res)
    if (text === null) return { error: 'response too large to be a JSON-RPC reply' }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { error: 'endpoint did not return JSON' }
    }
    const body = parsed as { result?: unknown; error?: { message?: unknown } } | null
    if (body?.error) {
      const msg = typeof body.error.message === 'string' ? body.error.message : 'unknown error'
      return { error: `${method} rejected: ${msg.slice(0, 200)}` }
    }
    if (typeof body?.result !== 'string') return { error: `${method} returned no result` }
    return { result: body.result, latencyMs }
  } catch (err) {
    // AbortError included — surface as a timeout rather than the raw message.
    const aborted = err instanceof Error && err.name === 'AbortError'
    return { error: aborted ? `timed out after ${PROBE_TIMEOUT_MS}ms` : 'could not reach endpoint' }
  }
}

/** Strict hex parse: Number.parseInt('nope', 16) is NaN, but it also happily
 *  accepts '0x12zz' by stopping at the junk — reject that outright. */
function hexToNumber(hex: string): number | null {
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) return null
  const n = Number.parseInt(hex, 16)
  return Number.isSafeInteger(n) ? n : null
}

/**
 * Probe `url` for chain id, head block, and latency.
 * `expectedChainId` may be null when the chain is unknown to this build.
 */
export async function probeRpc(
  url: string,
  expectedChainId: number | null,
  fetchImpl: typeof fetch = fetch,
): Promise<RpcProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  let chain: CallOk | CallErr
  let block: CallOk | CallErr
  try {
    ;[chain, block] = await Promise.all([
      rpcCall(url, 'eth_chainId', controller.signal, fetchImpl),
      rpcCall(url, 'eth_blockNumber', controller.signal, fetchImpl),
    ])
  } finally {
    clearTimeout(timer)
  }

  if ('error' in chain) return { ok: false, expectedChainId, error: chain.error }

  const chainId = hexToNumber(chain.result)
  if (chainId === null) return { ok: false, expectedChainId, error: 'eth_chainId was not a hex number' }

  return {
    ok: true,
    chainId,
    expectedChainId,
    chainIdMatches: expectedChainId === null ? null : chainId === expectedChainId,
    blockNumber: 'error' in block ? null : hexToNumber(block.result),
    latencyMs: chain.latencyMs,
    ...('error' in block ? { blockNumberError: block.error } : {}),
  }
}

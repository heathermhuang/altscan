/**
 * ERC-20 metadata for the `tokens` table, shared by the block processor's
 * first-sight insert and the token-metadata healer.
 *
 * The first-sight fetch is one-shot: a failed name()/symbol() became the
 * permanent placeholder 'Unknown' / '???', and existing rows were never retried.
 * Two causes put 90k BNB and 155k ETH rows in that state — a rate-limited
 * eth_call ("method eth_call in batch triggered rate limit"), and tokens such as
 * MKR whose name()/symbol() return bytes32 instead of string, which the string
 * ABI cannot decode.
 *
 * name() and symbol() have the SAME selector whether they return string or
 * bytes32, so there is only ever one eth_call per field: the returned bytes are
 * decoded as a string first and as bytes32 second. The fallback costs no extra
 * RPC call, which matters because the rate limit is what caused the placeholders.
 */
import { Interface, decodeBytes32String, getBytes, toUtf8String } from 'ethers'
import { sanitizeNullableText } from './postgres-text'

export const UNKNOWN_NAME = 'Unknown'
export const UNKNOWN_SYMBOL = '???'

/** All a fetch needs from a provider: a raw eth_call. A JsonRpcProvider fits. */
export interface CallRunner {
  call(tx: { to: string; data: string }): Promise<string>
}

/** One field per `tokens` column; null means that field did not resolve to a real value. */
export type TokenMetadata = {
  name: string | null
  symbol: string | null
  decimals: number | null
  totalSupply: string | null
}

/** `meta.transportFailed`: at least one call failed for a reason that says nothing about the contract. */
export type FetchedTokenMetadata = TokenMetadata & { transportFailed: boolean }

const STRING_ABI = new Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
])

type Fn = 'name' | 'symbol' | 'decimals' | 'totalSupply'

// JSON-RPC codes for "slow down": -32005 is the de-facto limit-exceeded code.
const TRANSPORT_RPC_CODES = new Set([-32005, 429])
const TRANSPORT_ETHERS_CODES = new Set(['TIMEOUT', 'NETWORK_ERROR', 'SERVER_ERROR'])
const TRANSPORT_TEXT =
  /rate.?limit|too many requests|\b429\b|timed? ?out|timeout|missing response|throttl|capacity|ETIMEDOUT|ECONN\w*|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|bad gateway|service unavailable|gateway time/i

type RpcErrorShape = { code?: unknown; message?: unknown; data?: unknown }

/**
 * Did this eth_call fail for a reason that says nothing about the contract?
 *
 * ethers reports an eth_call that the NODE refused as CALL_EXCEPTION too — a
 * rate-limit response (-32005, "method eth_call in batch triggered rate limit")
 * arrives as `CALL_EXCEPTION: missing revert data`, so the code alone cannot tell
 * a revert from a throttle; the JSON-RPC error under `info.error` has to be read.
 *
 * Only explicit transport signals count. An unrecognised error is treated as the
 * contract's answer: a permanently-odd contract misread as "transport" would be
 * retried first every run forever and stop the healer each time.
 */
export function isTransportError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { code?: unknown; shortMessage?: unknown; message?: unknown; data?: unknown; info?: { error?: RpcErrorShape }; error?: RpcErrorShape }
  const rpc = e.info?.error ?? e.error
  if (typeof rpc?.code === 'number' && TRANSPORT_RPC_CODES.has(rpc.code)) return true
  const text = [e.shortMessage, e.message, rpc?.message].filter((x): x is string => typeof x === 'string').join(' ')
  // A revert is the contract answering, whatever its reason string happens to say.
  const revertData = [rpc?.data, e.data].some(d => typeof d === 'string' && d.length > 2)
  if (revertData || /execution reverted/i.test(text)) return false
  if (typeof e.code === 'string' && TRANSPORT_ETHERS_CODES.has(e.code)) return true
  return TRANSPORT_TEXT.test(text)
}

/** Collects, across the calls of one fetch, whether any failed for a transport reason. */
type Probe = { transportFailed: boolean }

/** Raw return data, or null when the call failed (revert, rate limit, timeout). */
async function callRaw(runner: CallRunner, to: string, fn: Fn, probe: Probe): Promise<string | null> {
  try {
    return await runner.call({ to, data: STRING_ABI.encodeFunctionData(fn) })
  } catch (err) {
    if (isTransportError(err)) probe.transportFailed = true
    return null
  }
}

/** The return data of a `returns (bytes32)` name()/symbol(): exactly 32 bytes of
 *  text, left-aligned and NUL-padded on the right. Tolerates a name that fills all
 *  32 bytes (no terminator, which decodeBytes32String rejects); anything that is not
 *  valid UTF-8 is unresolved rather than stored as replacement characters. */
function decodeBytes32Text(raw: string): string | null {
  try {
    return decodeBytes32String(raw)
  } catch { /* fall through to the lenient trim */ }
  try {
    const bytes = getBytes(raw)
    // A leading NUL is a number or hash, not left-aligned text.
    if (bytes.length !== 32 || bytes[0] === 0) return null
    let end = bytes.length
    while (end > 0 && bytes[end - 1] === 0) end--
    return toUtf8String(bytes.slice(0, end))
  } catch {
    return null
  }
}

async function readText(
  runner: CallRunner,
  to: string,
  fn: 'name' | 'symbol',
  maxLength: number,
  probe: Probe,
): Promise<string | null> {
  const raw = await callRaw(runner, to, fn, probe)
  if (raw === null) return null
  let text: string | null
  try {
    text = STRING_ABI.decodeFunctionResult(fn, raw)[0] as string
  } catch {
    text = decodeBytes32Text(raw)
  }
  return sanitizeNullableText(text, maxLength)
}

async function readDecimals(runner: CallRunner, to: string, probe: Probe): Promise<number | null> {
  const raw = await callRaw(runner, to, 'decimals', probe)
  if (raw === null) return null
  try {
    return Number(STRING_ABI.decodeFunctionResult('decimals', raw)[0])
  } catch {
    return null
  }
}

async function readTotalSupply(runner: CallRunner, to: string, probe: Probe): Promise<string | null> {
  const raw = await callRaw(runner, to, 'totalSupply', probe)
  if (raw === null) return null
  try {
    return BigInt(STRING_ABI.decodeFunctionResult('totalSupply', raw)[0]).toString()
  } catch {
    return null
  }
}

/**
 * Fetch name, symbol, decimals and totalSupply. Never throws: a field that could
 * not be read is null, so each caller picks its own fallback — the block processor
 * stores placeholders, the healer leaves the column alone. `transportFailed` says
 * whether any null is down to the endpoint (rate limit, timeout, network) rather
 * than the contract, which is the healer's cue to try again soon instead of
 * writing the token off for a day.
 *
 * `sequential` issues the four calls one after another. The default fires them
 * together, which ethers coalesces into one JSON-RPC batch — the shape that
 * providers rate-limit — so the healer, which exists to retry what that dropped,
 * must not do it.
 */
export async function fetchTokenMetadata(
  runner: CallRunner,
  address: string,
  opts: { sequential?: boolean } = {},
): Promise<FetchedTokenMetadata> {
  const probe: Probe = { transportFailed: false }
  if (!opts.sequential) {
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      readText(runner, address, 'name', 255, probe),
      readText(runner, address, 'symbol', 50, probe),
      readDecimals(runner, address, probe),
      readTotalSupply(runner, address, probe),
    ])
    return { name, symbol, decimals, totalSupply, transportFailed: probe.transportFailed }
  }
  const name = await readText(runner, address, 'name', 255, probe)
  const symbol = await readText(runner, address, 'symbol', 50, probe)
  const decimals = await readDecimals(runner, address, probe)
  const totalSupply = await readTotalSupply(runner, address, probe)
  return { name, symbol, decimals, totalSupply, transportFailed: probe.transportFailed }
}

// ── Healer decisions (pure — the healer module only does I/O around these) ──

/** How long a token is left alone after the healer tried it. */
export const HEAL_RETRY_MS = 24 * 60 * 60 * 1000

/** The tokens columns the healer reads to decide what is still a placeholder. */
export type HealRow = {
  address: string
  name: string
  symbol: string
  decimals: number
  totalSupply: string
  type: string
  holderCount: number
}

/** Only fields that resolved — never null, so it can be handed straight to an UPDATE. */
export type HealPatch = { name?: string; symbol?: string; decimals?: number; totalSupply?: string }

const isZero = (n: string) => /^0*$/.test(n.trim())

/**
 * The columns to write back for one token, or null when nothing resolved to
 * something better than what is stored.
 *
 * A placeholder is replaced only by a real value; a real stored value is never
 * touched, and a failed fetch can never write one (null fields are skipped).
 * Supply is only filled while the stored value is 0 — a non-zero stored supply
 * was read from the chain once and is not the healer's to refresh. Decimals are
 * immutable on chain, so a resolved value that differs from the stored one is
 * always the correction (a failed first fetch also defaulted decimals to 18).
 */
export function planHeal(row: HealRow, meta: TokenMetadata): HealPatch | null {
  const patch: HealPatch = {}
  if ((row.name === UNKNOWN_NAME || row.name === '') && meta.name !== null && meta.name !== UNKNOWN_NAME) {
    patch.name = meta.name
  }
  if ((row.symbol === UNKNOWN_SYMBOL || row.symbol === '') && meta.symbol !== null && meta.symbol !== UNKNOWN_SYMBOL) {
    patch.symbol = meta.symbol
  }
  if (isZero(row.totalSupply) && meta.totalSupply !== null && !isZero(meta.totalSupply)) {
    patch.totalSupply = meta.totalSupply
  }
  if (meta.decimals !== null && meta.decimals !== row.decimals) patch.decimals = meta.decimals
  return Object.keys(patch).length > 0 ? patch : null
}

/** Consecutive transport failures after which a run gives up and leaves the rest for the next tick. */
export const TRANSPORT_STREAK_LIMIT = 3

export type HealStep = {
  patch: HealPatch | null
  /** Only a token the contract actually answered for is left alone for HEAL_RETRY_MS. */
  markTried: boolean
  transportFailed: boolean
  /** Consecutive transport failures including this token. */
  streak: number
  stop: boolean
}

/**
 * What the healer does with one fetched token. `meta` is null when the whole
 * fetch timed out. A transport failure is not an answer: the token is not marked
 * tried (the next tick retries it) and counts toward the early stop — a run that
 * starts while the endpoint is throttled must not write off the top of the list
 * for a day. Whatever DID resolve is still written back.
 */
export function decideHeal(row: HealRow, meta: FetchedTokenMetadata | null, streak: number): HealStep {
  const transportFailed = meta === null || meta.transportFailed
  const nextStreak = transportFailed ? streak + 1 : 0
  return {
    patch: meta === null ? null : planHeal(row, meta),
    markTried: !transportFailed,
    transportFailed,
    streak: nextStreak,
    stop: nextStreak >= TRANSPORT_STREAK_LIMIT,
  }
}

/** The first `batchSize` rows (in the order given) not tried within `ttlMs`. */
export function selectHealBatch<T extends { address: string }>(
  rows: readonly T[],
  tried: ReadonlyMap<string, number>,
  now: number,
  batchSize: number,
  ttlMs: number = HEAL_RETRY_MS,
): T[] {
  const out: T[] = []
  for (const row of rows) {
    const at = tried.get(row.address)
    if (at !== undefined && now - at < ttlMs) continue
    out.push(row)
    if (out.length >= batchSize) break
  }
  return out
}

/** Drop entries older than `ttlMs`, so the map is bounded by one window of runs. */
export function pruneTried(tried: Map<string, number>, now: number, ttlMs: number = HEAL_RETRY_MS): void {
  for (const [address, at] of tried) if (now - at >= ttlMs) tried.delete(address)
}

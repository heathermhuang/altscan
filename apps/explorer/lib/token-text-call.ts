import { AbiCoder } from 'ethers'

/**
 * A token's name() or symbol(), read off the chain with a bound.
 *
 * The contract chooses how much it returns, and ethers decodes all of it: the token page used to render whatever came
 * back, megabytes included, several times over (h1, title, Open Graph, JSON-LD), on every request for an address with
 * no tokens row. So the call is raw and its return data is measured BEFORE decoding. A 255-character string, the
 * indexer's cap for a name, encodes to 320 bytes, so anything over TOKEN_TEXT_MAX_RETURN_BYTES is no answer.
 */
export const TOKEN_TEXT_MAX_RETURN_BYTES = 1024
export const TOKEN_NAME_MAX = 255
export const TOKEN_SYMBOL_MAX = 50

const SELECTOR = { name: '0x06fdde03', symbol: '0x95d89b41' } as const

type Caller = { call(tx: { to: string; data: string }): Promise<string> }

/**
 * `settled`: the contract will answer the same way next time, with text or with none to give (a revert, an empty or
 * oversized return, data that is not an ABI string). Otherwise the read failed for a reason that says nothing about
 * the contract, and must not be cached.
 */
export type TextRead = { settled: true; text: string | null } | { settled: false; err: unknown }

const TRANSPORT_RPC_CODES = new Set([-32005, -32007, -32029, 429])
const TRANSPORT_TEXT = /rate.?limit|limit reached|too many requests|\b429\b|timed? ?out|timeout|throttl|capacity|unavailable/i

/**
 * A revert the contract will repeat, not a node that refused or failed the call. ethers reports both as
 * CALL_EXCEPTION: a rate limit (-32005) arrives as `CALL_EXCEPTION: missing revert data`, so the code alone cannot tell
 * them apart and the JSON-RPC error underneath has to be read.
 */
export function isDefinitiveRevert(err: unknown): boolean {
  const e = err as {
    code?: unknown; message?: unknown; shortMessage?: unknown; info?: { error?: { code?: unknown; message?: unknown } }
  } | null
  if (e?.code !== 'CALL_EXCEPTION') return false
  const rpc = e.info?.error
  if (typeof rpc?.code === 'number' && TRANSPORT_RPC_CODES.has(rpc.code)) return false
  const text = [e.shortMessage, e.message, rpc?.message].filter((x): x is string => typeof x === 'string').join(' ')
  return !TRANSPORT_TEXT.test(text)
}

export async function readTokenText(caller: Caller, to: string, fn: 'name' | 'symbol'): Promise<TextRead> {
  let raw: unknown
  try {
    raw = await caller.call({ to, data: SELECTOR[fn] })
  } catch (err) {
    return isDefinitiveRevert(err) ? { settled: true, text: null } : { settled: false, err }
  }
  if (typeof raw !== 'string' || raw === '0x' || raw.length > 2 + 2 * TOKEN_TEXT_MAX_RETURN_BYTES) {
    return { settled: true, text: null }
  }
  try {
    const [text] = AbiCoder.defaultAbiCoder().decode(['string'], raw)
    return { settled: true, text: typeof text === 'string' && text.length > 0 ? text : null }
  } catch {
    return { settled: true, text: null }   // not an ABI string: a bytes32 symbol, or garbage
  }
}

/** The token page's name and symbol, each capped as the indexer caps what it stores. */
export async function readTokenNameAndSymbol(caller: Caller, to: string): Promise<{ name: string | null; symbol: string | null }> {
  const [name, symbol] = await Promise.all([readTokenText(caller, to, 'name'), readTokenText(caller, to, 'symbol')])
  return {
    name: name.settled && name.text ? name.text.slice(0, TOKEN_NAME_MAX) : null,
    symbol: symbol.settled && symbol.text ? symbol.text.slice(0, TOKEN_SYMBOL_MAX) : null,
  }
}

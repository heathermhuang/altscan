/**
 * Pure cache-key + (de)serialize helpers for the on-demand tx body cache. Kept free
 * of RPC/Redis imports so it is unit-testable in isolation (and locally under node).
 */
export type CachedLog = {
  address: string
  topic0: string | null
  topic1: string | null
  topic2: string | null
  topic3: string | null
  data: string
  logIndex: number
}
export type TxBody = { input: string; logs: CachedLog[] }

export function bodyCacheKey(hash: string): string {
  return `body:tx:${hash.toLowerCase()}`
}

export function serializeTxBody(body: TxBody): string {
  return JSON.stringify(body)
}

/** A cached body is external data — written by an older deploy, editable in
 *  Redis — and the tx page dereferences `l.address` on every element without
 *  guarding it. Checking only `Array.isArray` let a null element through. */
function isCachedLog(v: unknown): v is CachedLog {
  return !!v && typeof v === 'object' && typeof (v as CachedLog).address === 'string'
}

export function parseTxBody(raw: string | null | undefined): TxBody | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as unknown
    if (v && typeof v === 'object'
        && typeof (v as TxBody).input === 'string'
        && Array.isArray((v as TxBody).logs)
        && (v as TxBody).logs.every(isCachedLog)) {
      return v as TxBody
    }
    return null
  } catch {
    return null
  }
}

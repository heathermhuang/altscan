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

export function parseTxBody(raw: string | null | undefined): TxBody | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as unknown
    if (v && typeof v === 'object'
        && typeof (v as TxBody).input === 'string'
        && Array.isArray((v as TxBody).logs)) {
      return v as TxBody
    }
    return null
  } catch {
    return null
  }
}

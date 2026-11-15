/**
 * A position in the wallet-watch feed: the last event served, or the end of a block.
 *
 * Events sort by (block, kind, index, watched): native transfers (kind 0, by tx_index) before token
 * transfers (kind 1, by log_index), then by watched address, since one transfer between two watched
 * addresses is served once for each. kind 2 means "past every event of block b". `h` is block b's hash
 * when the cursor was issued: if it no longer matches, a reorg replaced the block and the feed rewinds.
 *
 * Opaque to clients: base64url of a JSON array. Decoding is strict, since the fields go into SQL.
 */
export type WatchCursor = { b: number; h: string; k: 0 | 1 | 2; i: number; w: string }

export const END_OF_BLOCK = 2

const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/

export function encodeCursor(c: WatchCursor): string {
  return Buffer.from(JSON.stringify([c.b, c.h, c.k, c.i, c.w])).toString('base64url')
}

export function decodeCursor(s: string): WatchCursor | null {
  if (s.length > 512) return null
  let v: unknown
  try {
    v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!Array.isArray(v) || v.length !== 5) return null
  const [b, h, k, i, w] = v as unknown[]
  if (!Number.isSafeInteger(b) || (b as number) < 0) return null
  if (typeof h !== 'string' || !HASH.test(h)) return null
  if (k !== 0 && k !== 1 && k !== 2) return null
  if (!Number.isSafeInteger(i) || (i as number) < 0) return null
  if (typeof w !== 'string' || !(w === '' || ADDRESS.test(w))) return null
  return { b: b as number, h, k, i: i as number, w }
}

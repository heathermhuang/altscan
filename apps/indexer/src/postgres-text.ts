// PostgreSQL text/varchar cannot store U+0000, and the remaining C0 control
// bytes are never meaningful in provider- or contract-supplied metadata. Tab,
// LF and CR are deliberately KEPT — Postgres stores them fine and they do
// occur in legitimate free text.
//
// Both helpers below share this one class on purpose: they guard two different
// save paths (the live indexer and the A4b backfill worker), and a drift
// between them would silently reopen the hole on whichever path fell behind.
const UNSTORABLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

function strip(value: unknown, maxLength?: number): string {
  const cleaned = String(value ?? '')
    .replace(UNSTORABLE, '')
    .trim()
  return maxLength === undefined ? cleaned : cleaned.slice(0, maxLength)
}

/** For NOT NULL columns: unstorable bytes are removed and an empty result is
 *  replaced by `fallback`, so the column always receives a usable value. */
export function sanitizeTokenMetadata(value: unknown, fallback: string, maxLength: number): string {
  const sanitized = strip(value, maxLength)
  return sanitized.length > 0 ? sanitized : fallback
}

/** For NULLABLE columns: null in, null out, and text that sanitizes away to
 *  nothing becomes null rather than a fabricated placeholder.
 *
 *  `maxLength` is OPTIONAL and must be passed only for a column that actually
 *  has one — VARCHAR(64) like `token_symbol` and `category`, where an over-long
 *  provider value fails the INSERT just as fatally as a control byte does.
 *  Leave it off for TEXT. Capping an unbounded column is not free safety: for a
 *  numeric string like `value_formatted`, a token with very high decimals can
 *  push the first significant digit past any cap, so truncating would silently
 *  turn a real amount into zero on the serve path. Strip bytes Postgres cannot
 *  store; never quietly shorten a value it can. */
export function sanitizeNullableText(
  value: string | null | undefined,
  maxLength?: number,
): string | null {
  if (value === null || value === undefined) return null
  const sanitized = strip(value, maxLength)
  return sanitized.length > 0 ? sanitized : null
}

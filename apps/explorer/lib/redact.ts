/**
 * Scrub RPC credentials out of error text before it is logged or returned.
 *
 * Endpoints are frequently keyed (the secret is basic-auth userinfo, a path
 * segment or a query parameter depending on vendor), and ethers 6.17 embeds the
 * complete `requestUrl` in the message of every HTTP failure error:
 *
 *   server response 429 (..., info={ "requestUrl": "https://rpc.example/v2/KEY", ... }, code=SERVER_ERROR)
 *
 * so the raw message of any RPC error is secret-bearing. The indexer has the same
 * scrubbing (apps/indexer/src/rpc-failover.ts); it is an app, not a package, so
 * the explorer carries its own copy. Pure and dependency-free so it is cheap to test.
 */

/** `requestUrl` followed by `:` or `=` and a quoted value, JSON or util.inspect style. */
const REQUEST_URL_VALUE = /(\brequestUrl\b["']?\s*[:=]\s*)(["'])(?:\\.|(?!\2)[^\\])*\2/g
/** An absolute http(s)/ws(s) URL, up to the next whitespace, quote, bracket or backslash. */
const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s"'<>\\]+/gi
/** `//user:pass@` userinfo on a URL the pass above could not parse. */
const ORPHAN_USERINFO = /\/\/[^/\s@"']+@/g

/** Mask what is credential-shaped in one URL; a bare public origin stays readable. */
function redactUrl(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return '<redacted-url>'
  }
  const hasUserInfo = parsed.username !== '' || parsed.password !== ''
  // A non-empty path or any query is assumed to carry the key: the two are
  // indistinguishable from a routing path without vendor-specific knowledge.
  const hasTail = (parsed.pathname !== '' && parsed.pathname !== '/') || parsed.search !== '' || parsed.hash !== ''
  if (!hasUserInfo && !hasTail) return raw
  return `${parsed.protocol}//${hasUserInfo ? '***@' : ''}${parsed.host}${hasTail ? '/***' : ''}`
}

export function redactSecrets(text: string): string {
  return text
    .replace(REQUEST_URL_VALUE, (_m, key: string, quote: string) => `${key}${quote}[redacted]${quote}`)
    .replace(URL_IN_TEXT, redactUrl)
    .replace(ORPHAN_USERINFO, '//***@')
}

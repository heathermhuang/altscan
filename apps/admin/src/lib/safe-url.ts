/**
 * Return `url` only if it is a safe external http(s) link; otherwise '#'.
 *
 * `explorers.publicUrl` comes from the D1 control plane. A malicious/compromised
 * tenant owner could store a `javascript:`/`data:` value that becomes clickable
 * stored XSS for a same-tenant viewer. Neither React (href) nor Astro escapes the
 * scheme, so gate it here before it reaches an anchor.
 */
export function safeExternalUrl(url: string | null | undefined): string {
  if (!url) return '#'
  try {
    const proto = new URL(url).protocol
    return proto === 'https:' || proto === 'http:' ? url : '#'
  } catch {
    return '#'
  }
}

/**
 * Sanitize token symbol/name to strip homoglyph/confusable Unicode characters.
 * Replaces common Cyrillic/Greek lookalikes with ASCII equivalents, then
 * strips anything outside printable ASCII + basic Latin-1.
 *
 * Single source of truth: @altscan/providers, the indexer, AND the explorer all
 * use this one (apps/explorer/lib/format.ts re-exports it). It used to be
 * duplicated, which is a bad shape for a security-relevant sanitizer — a fix
 * applied to one copy silently leaves the other exploitable.
 *
 * Returns '' when nothing survives sanitization. It deliberately does NOT fall
 * back to the raw input: an all-confusable string (emoji-only, zero-width, or
 * bidi overrides like U+202E) cleans to empty, and returning the original there
 * would hand back exactly the characters this function exists to remove.
 * Callers already handle the empty case with their own placeholder.
 */
const MAX_SYMBOL_LEN = 128

export function sanitizeSymbol(raw: string): string {
  // Map common homoglyphs to ASCII (explicit \u escapes — the chars are
  // visually identical to ASCII, so keep them unambiguous, never literal)
  const homoglyphs: Record<string, string> = {
    '\u0410': 'A', '\u0412': 'B', '\u0421': 'C', '\u0415': 'E', '\u041D': 'H',
    '\u041A': 'K', '\u041C': 'M', '\u041E': 'O', '\u0420': 'P', '\u0422': 'T',
    '\u0425': 'X', '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p',
    '\u0441': 'c', '\u0443': 'y', '\u0445': 'x', '\u0455': 's',
    '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0397': 'H', '\u0399': 'I',
    '\u039A': 'K', '\u039C': 'M', '\u039D': 'N', '\u039F': 'O', '\u03A1': 'P',
    '\u03A4': 'T', '\u03A5': 'Y', '\u03A7': 'X', '\u03B5': 'e', '\u03BF': 'o',
    '\u210B': 'H', '\u210C': 'H', '\u210D': 'H', '\u210E': 'h', '\u2110': 'I',
    '\u2112': 'L', '\u2113': 'l', '\u2115': 'N', '\u2119': 'P', '\u211A': 'Q',
    '\u211B': 'R', '\u211C': 'R', '\u211D': 'R',
  }
  // Bound the work before iterating: `raw` is attacker-controlled (a token
  // symbol straight off-chain) and the loop below builds a string per char.
  const bounded = raw.length > MAX_SYMBOL_LEN ? raw.slice(0, MAX_SYMBOL_LEN) : raw
  let cleaned = ''
  for (const ch of bounded) {
    cleaned += homoglyphs[ch] ?? ch
  }
  // Strip non-printable and non-ASCII (keep basic Latin, digits, common symbols).
  // No raw fallback — see the doc comment: returning `raw` on an all-confusable
  // input restores the very characters we just stripped.
  return cleaned.replace(/[^\x20-\x7E]/g, '').trim()
}

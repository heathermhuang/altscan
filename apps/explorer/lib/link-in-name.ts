/**
 * Token names and symbols are typed by whoever deploys the contract, and airdrop spam uses them as
 * an advert: "Visit claim-bnb.xyz to claim". The explorer must not become that page's billboard, so
 * a name or symbol that reads as a web address or a social handle is treated as unsafe. This only
 * DECIDES; the callers choose the treatment: a headline names the token by its short address instead
 * (tx-decoder safeTransferSymbol, addressHeadline), and a table keeps the text but badges it
 * (components/ui/LinkInName). Nothing here, or at any call site, ever turns the text into a link.
 *
 * Pure and import-free on purpose: client components (the typeahead, the holdings tab) use it too.
 */

const TLDS = 'com|io|xyz|org|net|app|top|vip|cc|me|co|site|online|finance|exchange|gg|fun|link|ly'

const URL_OR_HANDLE = new RegExp(
  [
    '[a-z][a-z0-9+.-]{1,9}:\\/\\/',                    // a scheme: http://, https://, ftp://
    '\\bwww\\.',
    // A domain-like token; any script may name its label (a CJK .vip is as much an advert). {1,63} is a DNS
    // label's length: it keeps this linear on a long dotless name.
    // `t.me/…` is covered here (.me), and a ticker like USDT.z / BTC.b / USDC.e is not: z, b, e are no TLD,
    // and `\b` stops ".co" matching the front of ".coin".
    `[\\p{L}\\p{N}-]{1,63}\\.(?:${TLDS})\\b`,
    '(?:^|[^a-z0-9_])@[a-z_][a-z0-9_]+',               // an @handle, at the start or after a space or bracket, not mid-word (USDT@BSC)
  ].join('|'),
  'iu',
)

/**
 * True when `text` contains a URL, a `www.` host, a domain on a common TLD, `t.me/…` or an `@handle`.
 * Fullwidth letters fold to ASCII (NFKC), invisible characters are dropped and the ideographic full stops
 * (U+3002, U+FF61) read as '.', so a name is judged as what it displays as: fullwidth "ｗｗｗ．scam．ｃｏｍ",
 * "exam" + a zero-width space + "ple.com", and "claim。xyz" are all flagged.
 */
export function looksLikeUrlOrHandle(text: string | null | undefined): boolean {
  if (!text) return false
  // NFKC maps the halfwidth ideographic full stop (U+FF61) to U+3002, and neither is a '.' to NFKC: fold both ourselves.
  return URL_OR_HANDLE.test(text.normalize('NFKC').replace(/[\p{Cf}\p{Cc}]/gu, '').replace(/[\u3002\uFF61]/g, '.'))
}

/** The badge's `title`: what "link in name" means. */
export const LINK_IN_NAME_NOTE =
  'The name or symbol of this token contains what looks like a web address or social handle. It is shown as plain text, never as a link: do not trust it.'

// Single source of truth for the AI-bot access policy, consumed by BOTH
// middleware.ts (Edge runtime — keep this file zero-import) and
// app/robots.txt/route.ts. The two had drifted apart; flipping policy for a
// bot is now a one-line move between the arrays below.
//
// Policy: citations yes, training no.
// - Retrieval/search/user-triggered AI fetchers are welcome — they make the
//   sites citable in ChatGPT/Claude/Perplexity answers (AEO) and fetch pages
//   one at a time, not in bulk.
// - Training / bulk-corpus crawlers are robots-blocked site-wide AND 429'd on
//   DB-heavy paths (they ignore robots often enough that the fence stays).
// Verified search engines (Googlebot/Bingbot) are governed by `User-agent: *`
// in robots.txt and the Cloudflare verified-bot WAF skip, not by these lists.

/** AI retrieval / search-index / user-triggered fetchers — ALLOWED.
 *  Deliberately given no robots.txt group of their own (under REP a UA with
 *  no matching group inherits `User-agent: *`) and never throttled by the
 *  middleware. The list itself is the policy manifest: a UA's absence from
 *  TRAINING_BLOCKED is what allows it. */
export const RETRIEVAL_ALLOWED = [
  'OAI-SearchBot',    // ChatGPT search index
  'ChatGPT-User',     // user-triggered ChatGPT browsing
  'Claude-SearchBot', // Claude search index
  'Claude-User',      // user-triggered Claude fetches
  'PerplexityBot',    // Perplexity search index
  'Perplexity-User',  // user-triggered Perplexity fetches
  'Applebot',         // Siri/Spotlight search (training opt-out is Applebot-Extended)
  'DuckAssistBot',    // DuckDuckGo AI answers
] as const

/** Training / bulk-corpus crawlers — robots `Disallow: /` + middleware 429 on
 *  heavy paths. Google-Extended and Applebot-Extended are robots.txt-only
 *  tokens that never appear in a User-Agent header: they matter in the robots
 *  output, and the middleware match simply never fires for them.
 *  facebookexternalhit is deliberately NOT here — it is the user-triggered
 *  link-preview fetcher (WhatsApp/FB/Messenger unfurls); throttling it broke
 *  link previews. FacebookBot / meta-externalagent (Meta's crawlers) stay. */
export const TRAINING_BLOCKED = [
  'GPTBot',
  'ClaudeBot',
  'Claude-Web',
  'anthropic-ai',
  'CCBot',
  'Google-Extended',
  'Applebot-Extended',
  'Bytespider',
  'meta-externalagent',
  'meta-webindexer',
  'FacebookBot',
  'Amazonbot',
  'cohere-ai',
  'Diffbot',
  'ImagesiftBot',
  'omgilibot',
  'YouBot',
] as const

/** DB-heavy paths (big-table queries) where TRAINING_BLOCKED UAs get 429.
 *  Home is ISR-cached and doesn't need throttling. The /md/tx/ and /md/block/
 *  mirrors are listed explicitly — an aggressive crawler can request those
 *  directly, bypassing the canonical-path check, and each hit runs a DB
 *  lookup in the /md route handler. */
export const HEAVY_PATH_PREFIXES = [
  '/blocks',
  '/txs',
  '/tx/',
  '/address/',
  '/token/',
  '/block/',
  '/api/v1/blocks',
  '/api/v1/transactions',
  '/api/v1/addresses',
  '/api/v1/tokens',
  '/api/v1/contracts',
  '/md/tx/',
  '/md/block/',
  '/md/blocks/',
] as const

export function isTrainingBot(ua: string | null): boolean {
  if (!ua) return false
  const normalized = ua.toLowerCase()
  for (const needle of TRAINING_BLOCKED) {
    if (normalized.includes(needle.toLowerCase())) return true
  }
  return false
}

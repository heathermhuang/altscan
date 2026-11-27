/**
 * The API limits this explorer publishes, named once.
 *
 * Each value is enforced where its comment says and quoted from here by every page that
 * documents it (api-docs, developer, auth.md, llms.txt, the OpenAPI spec). Before this, a
 * limit was a literal in the enforcing code and again in three or four pages of prose, so
 * changing one meant finding them all. api-limits.test.ts fails on a page that spells a
 * limit out instead of interpolating it.
 */

// No imports on purpose, so any module, a client component included, can quote a limit; the
// @altscan/explorer-core barrel would drag the Redis client in with it.

/** Keyless /api/v1 requests per minute per client IP (lib/api-rate-limit.ts checkIpRateLimit). */
export const IP_REQUESTS_PER_MINUTE = 100
/** POST /api/v1/verify, in its own bucket (app/api/v1/verify/route.ts). */
export const VERIFY_REQUESTS_PER_MINUTE = 10
/** What a new API key is minted with (lib/api-key-mint.ts); enforced per key from its row. */
export const KEY_REQUESTS_PER_MINUTE = 100
/** OAuth access tokens, per address, shared by every token for it (lib/api-auth.ts). */
export const TOKEN_REQUESTS_PER_MINUTE = 100
/** Largest page an /api/v1 list returns; larger `limit`s are clamped (lib/list-depth.ts). */
export const LIST_MAX_LIMIT = 50
/** Default page size of an /api/v1 list. */
export const LIST_DEFAULT_LIMIT = 20
/** POST /api/v1/query page size: default, and the cap a larger `limit` is clamped to (lib/query-filter.ts). */
export const QUERY_DEFAULT_LIMIT = 25
export const QUERY_MAX_LIMIT = 100
/**
 * Deepest POST /api/v1/query offset (lib/query-filter.ts). Deeper pages walk the index row by
 * row up to the statement timeout, for any anonymous caller; narrow with blockFrom/blockTo.
 */
export const QUERY_MAX_OFFSET = 10_000
/** The OAuth endpoints that mint something, per client IP (lib/oauth.ts). */
export const OAUTH_MINT_REQUESTS_PER_MINUTE = 20

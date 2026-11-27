# Architecture map

What each workspace owns, which way dependencies point, and where each cross-cutting
concern has its one implementation. Commands, gotchas and production rules live in
[AGENTS.md](../../AGENTS.md); decisions and their reasons live in [decisions/](decisions/);
the running list of governance work is [governance-log.md](governance-log.md).

This file records only what the file tree cannot tell you: ownership, direction and
canonical modules. Anything marked **enforced** fails CI when broken.

## Workspaces and dependency direction

```
apps/explorer   ──▶ providers, db, chain-config, explorer-core, oauth, settings-schema
apps/indexer    ──▶ providers, db, chain-config
apps/admin      ──▶ chain-config, settings-schema
apps/altscan-site ▶ oauth
apps/status     ──▶ (none)

packages/providers ──▶ chain-config, explorer-core
packages/{chain-config, db, explorer-core, oauth, settings-schema}: leaves
```

- Packages never import apps. Apps never import each other.
- **Enforced** by [scripts/workspace-graph.test.ts](../../scripts/workspace-graph.test.ts):
  the approved edges are listed there, and every `@altscan/*` import must be declared,
  every declared dependency used, and every edge approved. A new edge is an
  architecture decision made in that file.
- Contract tests may read across a boundary (e.g. the webhook docs sample against the
  indexer's payload); production source may not, except the one listed exception.

| Workspace | Owns | Does not own |
|---|---|---|
| `apps/indexer` | Ingesting blocks into Postgres: the polling loop, receipts, transfers, reorgs, retention, schema DDL at boot (`ensure-schema.ts`) | Anything served over HTTP |
| `apps/explorer` | The two public sites and their API (`/api/v1`), MCP/agent surfaces, ISR pages | Writing chain data (it reads what the indexer wrote) |
| `apps/admin` | The admin console on Cloudflare: tenants and members (D1), and the UI that edits explorer settings by proxying to each explorer | The settings values themselves (each explorer stores its own) |
| `apps/altscan-site` | altscan.io on Cloudflare: landing page, `/mcp`, OAuth for altscan.io | Chain data (it calls the explorers) |
| `apps/status` | The status page | — |
| `packages/db` | Drizzle schema (source of truth for tables) and the pool getters | Chain selection: callers pass `dbEnvVar` |
| `packages/chain-config` | Everything that differs between BNB and ETH, selected by `CHAIN` | Runtime env overrides (those live in each app's config) |
| `packages/explorer-core` | Redis client, kv cache, IP rate limiting, `sanitizeSymbol` | Anything Next- or Node-app-specific |
| `packages/providers` | The Moralis client, its CU budget and response cache | — |
| `packages/oauth` | The OAuth server shared by the explorers and altscan.io | Code storage (each site injects it) |
| `packages/settings-schema` | The shape and validation of explorer settings, shared by the admin UI and the explorer | — |

## Canonical modules

One implementation per concern. "Guard" names the test that fails on a second copy.

| Concern | Canonical module | Guard |
|---|---|---|
| Workspace dependencies | `scripts/workspace-graph.test.ts` (the approved graph) | itself |
| DB pool for the running chain | indexer `src/db.ts`, explorer `lib/db.ts`; `@altscan/db` getters require the env var | `apps/indexer/src/db.test.ts` (compile-time) |
| Indexer environment variables | `apps/indexer/src/config.ts` (typed, printed at boot) | `src/env-boundary.test.ts` (provider.ts endpoint lists and one CLI excepted) |
| Chain differences (incl. per-chain features such as wallet watch) | `@altscan/chain-config` (`features`); explorer reads it via `lib/chain.ts` (server) and `lib/chain-client.ts` (client components, `NEXT_PUBLIC_CHAIN`) | `lib/client-chain-config.test.ts` |
| Address / hash shape | explorer `lib/hex.ts` | `lib/hex.test.ts` |
| Explorer env variables | read once, in the module that owns each; numbers via `lib/env.ts` `positiveIntEnv` | `lib/env.test.ts` |
| Bounding a wait | explorer `lib/with-timeout.ts`; indexer `src/rpc-failover.ts` `withTimeout` (ADR 0002) | `lib/with-timeout.test.ts` |
| In-process cache | explorer `lib/ttl-cache.ts` (bounded LRU, registered for `/api/health`) | `lib/ttl-cache.test.ts` |
| Shared cache across instances | `@altscan/explorer-core` `kvGet`/`kvSet` (Redis, bounded fallback) | — |
| List-page data cache | explorer `lib/page-cache.ts` | its own tests |
| Ad-slot layout | `components/ads/AdFrame.tsx` (creatives supply content) | — |
| Swallowed-error logging | explorer `lib/observability.ts` (`swallow`, `swallowed`) | — |
| Per-IP rate limiting and the 429 body | `@altscan/explorer-core` `checkRateLimit` keyed by `clientIpBucket`; explorer `lib/api-rate-limit.ts` (`checkIpRateLimit`, `rateLimitResponse`) | `lib/ip-bucket-callers.test.ts`, `lib/rate-limit-response.test.ts` |
| Number, amount and time formatting | explorer `lib/format.ts`; address display `lib/address-display.ts` | — |
| Token symbol sanitizing | `@altscan/explorer-core/format` `sanitizeSymbol` | — |
| RPC for the web tier | explorer `lib/rpc.ts` (`getWebProvider`, sequential failover) | — |
| Async token_transfers writer and durable watermark | indexer `src/transfer-writer.ts` | — |
| RPC for the indexer | indexer `src/rpc-failover.ts`, `src/provider.ts` | — |

## State ownership

| State | Owner (writer) | Readers |
|---|---|---|
| Chain tables (`blocks`, `transactions`, `token_transfers`, …) | indexer | explorer |
| Schema DDL | indexer `ensure-schema.ts` at boot; `packages/db/schema.ts` describes it | everyone |
| Explorer settings (`explorer_settings`) | explorer `/api/admin/settings`, called by the admin console | explorer `lib/settings.ts` (60s cache, tag `settings`) |
| Admin tenants and members | admin (D1) | admin |
| API keys, webhooks, watch lists | explorer `/api/v1` | indexer (webhook delivery) |
| Moralis CU ledger and response cache | `@altscan/providers` (Redis) | — |
| Rate-limit buckets | `@altscan/explorer-core` (Redis, in-memory fallback) | — |

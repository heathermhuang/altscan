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
apps/altscan-site ▶ chain-config, oauth
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
| `packages/db` | Drizzle schema (every table, enforced against the built DB) and the pool getters | Chain selection: callers pass `dbEnvVar` |
| `packages/chain-config` | Everything that differs between BNB and ETH, selected by `CHAIN` | Runtime env overrides (those live in each app's config) |
| `packages/explorer-core` | Redis client, kv cache, IP rate limiting, `sanitizeSymbol` | Anything Next- or Node-app-specific |
| `packages/providers` | The Moralis client, its CU budget and response cache | — |
| `packages/oauth` | The OAuth server shared by the explorers and altscan.io | Code storage (each site injects it) |
| `packages/settings-schema` | The shape and validation of explorer settings, shared by the admin UI and the explorer | — |

## Canonical modules

One implementation per concern. "Guard" names the test that fails on a second copy; "—"
means none yet. Paths are repo-relative, and `scripts/architecture-map.test.ts` fails when one
no longer exists, so this inventory cannot silently rot.

| Concern | Canonical module | Guard |
|---|---|---|
| Workspace dependencies | `scripts/workspace-graph.test.ts` (the approved graph) | itself |
| One module per exported name | `scripts/unique-exports.test.ts` (listed exceptions with reasons) | itself |
| Concept inventory (this table) | `scripts/architecture-map.test.ts` | itself |
| DB pool for the running chain | `apps/indexer/src/db.ts`, `apps/explorer/lib/db.ts`; `packages/db/client.ts` getters require the env var | `apps/indexer/src/db.test.ts` (compile-time) |
| Database shape | `packages/db/schema.ts` (every table, enum) | `apps/indexer/src/schema-parity.pg.test.ts` |
| Indexer environment variables | `apps/indexer/src/config.ts` (typed, printed at boot) | `apps/indexer/src/env-boundary.test.ts` |
| Chain differences (incl. per-chain features such as wallet watch) | `packages/chain-config/src/index.ts` (`features`); read via `apps/explorer/lib/chain.ts` (server) and `apps/explorer/lib/chain-client.ts` (client) | `apps/explorer/lib/client-chain-config.test.ts` |
| Address / hash shape | `apps/explorer/lib/hex.ts`; altscan.io `apps/altscan-site/src/lib/hex.ts` (ADR 0002) | `apps/explorer/lib/hex.test.ts`, `apps/altscan-site/test/hex.test.ts` |
| Explorer env variables | read once, in the module that owns each; numbers via `apps/explorer/lib/env.ts` | `apps/explorer/lib/env.test.ts` |
| Bounding a wait | `apps/explorer/lib/with-timeout.ts`; indexer `apps/indexer/src/rpc-failover.ts` (ADR 0002) | `apps/explorer/lib/with-timeout.test.ts` |
| In-process cache | `apps/explorer/lib/ttl-cache.ts` (bounded LRU, registered for `/api/health`) | `apps/explorer/lib/ttl-cache.test.ts` |
| Shared cache across instances | `packages/explorer-core/src/kv-cache.ts` (Redis, bounded fallback) | — |
| List-page data cache | `apps/explorer/lib/page-cache.ts` | `apps/explorer/lib/page-cache.test.ts` |
| List depth and `?page=` parsing | `apps/explorer/lib/list-depth.ts`, `apps/explorer/lib/list-pages.ts` | `apps/explorer/lib/list-depth.test.ts` |
| Token standards | `apps/explorer/lib/token-type-label.ts` (from the schema enum) | `apps/explorer/lib/token-type-label.test.ts` |
| Ad-slot layout | `apps/explorer/components/ads/AdFrame.tsx` (creatives supply content) | — |
| Swallowed-error logging | `apps/explorer/lib/observability.ts` (`swallow`, `swallowed`) | — |
| Published API limits (rates, page sizes, offsets) | `apps/explorer/lib/api-limits.ts`, quoted by every docs page | `apps/explorer/lib/api-limits.test.ts` |
| Per-IP rate limiting and the 429 body | `packages/explorer-core/src/rate-limit.ts`; `apps/explorer/lib/api-rate-limit.ts` | `apps/explorer/lib/ip-bucket-callers.test.ts`, `apps/explorer/lib/rate-limit-response.test.ts` |
| Number, amount and time formatting | `apps/explorer/lib/format.ts`; address display `apps/explorer/lib/address-display.ts` | — |
| Token symbol sanitizing | `packages/explorer-core/src/format.ts` (`sanitizeSymbol`) | — |
| RPC for the web tier | `apps/explorer/lib/rpc.ts` (sequential failover) | — |
| Async token_transfers writer and durable watermark | `apps/indexer/src/transfer-writer.ts` | — |
| Receipts and their pre-write checks | `apps/indexer/src/receipts.ts` | — |
| RPC for the indexer | `apps/indexer/src/rpc-failover.ts`, `apps/indexer/src/provider.ts` | — |

## State ownership

| State | Owner (writer) | Readers |
|---|---|---|
| Chain tables (`blocks`, `transactions`, `token_transfers`, …) | indexer | explorer |
| Schema DDL | indexer `ensure-schema.ts` at boot; `packages/db/schema.ts` declares every table, checked against the built database by `apps/indexer/src/schema-parity.pg.test.ts` | everyone |
| Explorer settings (`explorer_settings`) | explorer `/api/admin/settings`, called by the admin console | explorer `lib/settings.ts` (60s cache, tag `settings`) |
| Admin tenants and members | admin (D1) | admin |
| API keys, webhooks, watch lists | explorer `/api/v1` | indexer (webhook delivery) |
| Moralis CU ledger and response cache | `@altscan/providers` (Redis) | — |
| Rate-limit buckets | `@altscan/explorer-core` (Redis, in-memory fallback) | — |

# Changelog

All notable changes to **Altscan** — the open-source, multi-chain block explorer platform powering BNBScan and EthScan — are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses a four-part `MAJOR.MINOR.PATCH.BUILD` version scheme.

## [Unreleased]

### Security
- **Upgraded drizzle-orm to 0.45.2** (drizzle-kit to 0.31.10), clearing the "SQL injection via improperly escaped SQL identifiers" advisory. Nothing here calls `sql.identifier()`, so it was not reachable. Since 0.44, drizzle wraps every database error in one that carries the SQL, not the reason. The deadlock retries, the indexer's boot-time database retry, and every log line and response that reports a database error now read the underlying Postgres error.

## [0.3.0.0] - 2026-09-18

Three months of hardening since the open-source release: a full-history data layer, an admin console, internal transactions, and a long run of indexer-reliability and explorer-correctness fixes (#40–#155).

### Security
- **Patched a critical Next.js image-optimizer RCE** — upgraded to Next.js 15.5.25 and switched off the unused `/_next/image` endpoint on both explorers (#154).
- **Dependabot, CodeQL, a CLA check, and CODEOWNERS.** CI now pins its actions to commit SHAs, runs with a read-only token, and tests on Node 22, the version production runs (#155).
- Remediated the findings of a full-site security audit across the explorer, status page, admin console, and indexer (#64).
- The public API emits a single valid CORS origin (#111), and the repo no longer publishes the production database ID (#134).

### Added
- **Admin console** (`apps/admin`) behind Cloudflare Access with D1-backed roles, plus a runtime settings backbone for footer links and house ads (#59, #60, #63, #84).
- **Full-history data layer** — transaction bodies are refetched on demand after retention prunes them (#66), and older address history is backfilled lazily through a provider adapter under a hard Moralis compute-unit budget (#70, #74, #76, #77, #85, #135, #137).
- **Internal transactions** — traced, partitioned, replay-safe, and gated on indexer lag (#132).
- **Reorg handling** — a tail check with bounded rollback (#67).
- **Index completeness reporting** — skipped block ranges are recorded and reported by `/api/health` (#94, #95), and a block that keeps failing is quarantined instead of abandoning the blocks around it (#97).
- **Web-tier RPC failover** — a comma-separated endpoint list, tried in order (#140, #153).
- **Transaction pages** show the EIP-1559 fee breakdown, NFT transfers, and honest confirmation counts (#131).
- **Search and AI discoverability** — sitemap overhaul, `llms.txt`, a citations-yes/training-no bot policy, breadcrumbs, and structured data on altscan.io (#51–#54).
- **Self-hosting** — a verified Docker path, plus CLA and dual-licensing docs (#83).
- **Disk safety** — `DB_DISK_GB` synced from the real provisioned disk, true utilisation reporting, and separate alarm and action thresholds (#103, #108, #109).

### Changed
- Provider code moved into `@altscan/providers`, and `providers`, `explorer-core`, and `chain-config` now ship compiled `dist/` builds (#74, #79, #89).
- The indexer has one typed config module and a boot log that shows the resolved config (#119).
- Retention yields to a lagging indexer, skips deletes a partition drop is about to reclaim, and skips the in-place body prune when the compact prune covers it (#101, #104, #143).
- `pnpm lint` is real (ESLint, gated in CI), and CI builds the explorer the way production does (#120, #124).
- Removed dead weight: `packages/ui`, `apps/eth-indexer`, the legacy VPS deploy path, the hand-maintained `schema.sql`, orphaned BullMQ modules, and unused columns (#40, #87, #106, #118, #125, #126).

### Fixed
- **Whale Tracker** repaired on both chains (#110, #115, #116).
- **DEX swaps are recorded again** — a length guard had rejected every real V2 swap (#145).
- **Caching** — list pages are cached as intended; a BigInt had silently voided every cache write (#117, #121, #122).
- Missing tx, block, and token pages return real 404s or `noindex` (#50, #55, #56).
- Explorer correctness: checksummed addresses, chain-correct labels, and fee precision (#128); RPC data no longer discarded on tx and block pages (#129); RPC failures no longer rendered as "not found" (#142); small transfers no longer shown as 0.0000 (#113); a truncated transfer list says so (#147); token lookups explain failures and cache reverts (#138, #139, #141, #146); the homepage market cap no longer blanks (#45, #46).
- Public API: the advertised routes match the real ones (#112), and the address filter no longer scans the whole table (#148).
- Accessibility: data tables have proper headers and scroll on phones (#114).
- Indexer reliability: token-transfer writer flushing and backpressure (#41–#44, #47); RPC failover, timeouts, and isolating one bad endpoint (#91–#93, #99); stalls from maintenance I/O (#65); replay-safe blocks and DEX trades (#96, #149); the validator syncer (#80); backfill loops and stalls (#107, #133, #136); ETH backfill reading the wrong database pool (#82); deploy packaging (#78, #86).
- The patched `postgres` driver no longer leaves holes in the next result after a mid-result error (#144), and a full Redis no longer freezes the Moralis spend ceiling (#151).

## [0.2.0.0] - 2026-06-09

The platform was unified, rebranded to **Altscan**, and open-sourced. This release also covers the new altscan.io umbrella site and a wave of Moralis-reliability and indexer-throughput work.

### Added
- **Open-sourced under AGPL-3.0** at [github.com/heathermhuang/altscan](https://github.com/heathermhuang/altscan), with a full README, `CONTRIBUTING.md`, `SECURITY.md`, and a Contributor Covenant `CODE_OF_CONDUCT.md`.
- **altscan.io umbrella site** (`apps/altscan-site`) — an Astro 5 landing site on Cloudflare Workers that presents every explorer, a self-host guide, and a live `/api/chains.json` edge endpoint proxying each explorer's `/api/health` (2 s timeout, 60 s cache, static fallback). Custom domains `altscan.io` (apex + `www` → 301) and `status.altscan.io`.
- **"Powered by Altscan" footer** on both explorers, alongside Status (`status.altscan.io`) and GitHub links.
- **Per-feature Moralis budgets** — independent Redis rate-limit buckets for address history, token holders, and wallet assets (`moralis:rl:v7:{history,holders,assets}`), so one feature can no longer starve the others fleet-wide.
- **Token market + holders** on ERC-20 token pages — holder counts/lists via Moralis, and a market card (price/liquidity) via the keyless DexScreener and CoinGecko APIs.
- **Lazy-loaded token holders** — a new internal endpoint `/api/internal/token/[address]/holders` moves holder fetches off server render, so SSR spends zero Moralis compute units.
- **Async, crash-safe token-transfers writer** (`ASYNC_TT_WRITER`) with a watermark in `indexer_cursor`, plus `block_number` range partitioning for instant DROP-partition retention (~6× ETH throughput).
- **`@altscan/explorer-core` `redis-client` + `kv-cache`** — a shared lazy Redis singleton and a Redis-backed string cache with bounded in-memory fallback, reused by rate limiting and the Moralis cache.
- **Continuous integration** — a GitHub Actions workflow runs the Vitest suite on every push and pull request.

### Changed
- **Unified rebrand to Altscan** — the workspace and packages moved to the `@altscan/*` scope, and one codebase (`apps/explorer`, `apps/indexer`) now serves every chain via the `CHAIN` environment variable.
- **Domains moved to Cloudflare** with SSL Full (strict) and a WAF Managed Challenge on `/address/`, `/token/`, and `/api/internal/*` — deflects scraping bots while real browsers pass automatically.
- **Rate limiter is now fleet-wide and Redis-backed** — hourly/daily caps use Redis `INCR`/`PEXPIRE`, so `numInstances: 2` no longer multiplies intended spend and caps survive deploys.
- **`MORALIS_DISABLED` documented in `render.yaml`** as the emergency kill switch.

### Fixed
- **Moralis re-enabled on BNBScan without the OOM** — address pages for wallets idle longer than the 7-day retention window were dead-ending ("Transaction history is not available in the local index") because the Moralis fallback had been globally disabled to stop an OOM crash-loop driven by an in-process response-cache `Map` growing on the heap. The response cache and its rate-limiter counters now live in Redis (off-heap, shared across instances), with a bounded in-memory fallback for environments without Redis. Re-enables Transactions, Token Transfers, Holdings, and NFTs for unindexed/pruned addresses.
- **Corrected stale references** — fixed old `bnbscan` repository links (about page, `security.txt`) and out-of-date README sections (test paths, Postgres sizing, and the no-longer-accurate "rate limiting is not Redis-backed" note).

## [0.1.1.0] - 2026-03-23

### Security
- **Webhook management authentication**: `GET /webhooks` and `DELETE /webhooks/:id` now require `X-API-Key` whose `ownerAddress` matches the requested owner — prevents enumeration and unauthorized deletion by anyone who knows an address
- **`requireApiKeyOwner()` helper**: API middleware enforces ownership proof on sensitive management endpoints
- **Remaining API routes hardened**: `keys`, `contracts/call`, and `webhooks POST` now use `authRequest()` middleware instead of raw `checkIpRateLimit`

### Fixed
- **Schema idempotency**: Added `unique(tx_hash, log_index)` constraints to `logs` and `token_transfers` tables — `ON CONFLICT DO NOTHING` now functions correctly on indexer replays and crash recovery
- **NFT image lazy loading**: Added `loading="lazy"` to NFT grid images in address page to prevent layout shift

### Added
- **Unified explorer auth**: Chain-specific API key handling now lives in the shared explorer app.

## [0.1.0.0] - 2026-03-23

### Added
- **BNBScan** (bnbscan.com): Full BNB Chain explorer — blocks, transactions, addresses, tokens, DEX trades, whale tracker, charts
- **EthScan** (ethscan.io): Full Ethereum explorer with identical feature set, parallel indexer
- **Developer Platform**: API key management (`bnbs_` prefix, SHA-256 hashed), rate limiting (100 req/min per key), webhook delivery with HMAC-SHA256 signatures
- **Webhook system**: Register webhooks for address activity; delivery engine wired to block processor; auto-deactivates after 5 consecutive failures
- **API key enforcement**: `authRequest()` middleware validates `X-API-Key` header, applies per-key rate limits, falls back to IP-based limiting
- **Enrichment libraries**: GoPlus security analysis, Moralis balance/NFT data, Space ID name service, ENS resolution, RPC fallback for DB misses
- **Network switcher**: Switch between BNBScan and EthScan from the header
- **Contract verification**: Sourcify integration for contract source verification
- **CSV export**: Transaction history export for any address
- **Homepage timestamps**: Latest Block and Total Transactions now show time since last activity
- **SSRF protection**: Webhook URL validation blocks all private IP ranges (localhost, 10.x, 192.168.x, 172.16-31.x, 169.254.x, etc.) and non-http protocols
- **Vitest test suite**: 23 tests covering IP spoofing prevention and SSRF protection

### Security
- **X-Forwarded-For IP spoofing fix**: Rate limiter now takes the LAST entry from X-Forwarded-For (Render appends the real client IP last; first entries are attacker-controlled)
- **Consolidated rate limiter**: Shared `@altscan/explorer-core` package eliminates divergent per-app implementations
- **Webhook secret hashing**: Raw secret returned to caller once; SHA-256 hash stored in DB — DB compromise cannot be used to forge webhook signatures
- **API key hashing**: `bnbs_`/`eths_` keys stored as SHA-256 hashes; prefix stored for display

### Fixed
- **RPC provider stability**: `JsonRpcProvider` now stored in `globalThis` to survive Next.js hot reloads; null-cleared on `error` event for automatic reconnection
- **DB connection pool**: Reduced web app pool from max:10 to max:5 so total connections (web=5 + indexer=10 = 15) stay within Render Standard's 25-connection limit

### Infrastructure
- Turborepo monorepo: `apps/explorer`, `apps/indexer`, `apps/status`, `packages/db`, `packages/explorer-core`, `packages/ui`
- Unified indexer: one chain-configurable worker for BNB Chain and Ethereum
- Render hosting: web service + 2 indexer workers + PostgreSQL + Redis

[Unreleased]: https://github.com/heathermhuang/altscan/compare/v0.3.0.0...HEAD
[0.3.0.0]: https://github.com/heathermhuang/altscan/compare/v0.2.0.0...v0.3.0.0
[0.2.0.0]: https://github.com/heathermhuang/altscan/compare/v0.1.1.0...v0.2.0.0
[0.1.1.0]: https://github.com/heathermhuang/altscan/compare/v0.1.0.0...v0.1.1.0
[0.1.0.0]: https://github.com/heathermhuang/altscan/releases/tag/v0.1.0.0

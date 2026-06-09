# Changelog

All notable changes to **Altscan** — the open-source, multi-chain block explorer platform powering BNBScan and EthScan — are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses a four-part `MAJOR.MINOR.PATCH.BUILD` version scheme.

## [Unreleased]

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

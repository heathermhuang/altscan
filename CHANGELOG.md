# Changelog

All notable changes to BNBScan / EthScan are documented here.

## [Unreleased]

### Fixed
- **Moralis re-enabled on BNBScan without the OOM**: address pages for wallets idle longer than the 7-day index-retention window were dead-ending ("Transaction history is not available in the local index") because the Moralis fallback had been globally disabled to stop an OOM crash-loop. The crash-loop was driven by the in-process response-cache `Map` growing on the heap. Moved the Moralis response cache and its hourly/daily rate-limiter counters into Redis (off-heap, shared across instances) with a bounded in-memory fallback for environments without Redis (EthScan). Re-enables Transactions, Token Transfers, Holdings, and NFTs for unindexed/pruned addresses on BNBScan.

### Added
- **`@bnbscan/explorer-core` `redis-client` + `kv-cache`**: shared lazy Redis singleton and a Redis-backed string cache with bounded in-memory fallback, reused by rate limiting and the Moralis cache.

### Changed
- **Moralis rate limiter is now fleet-wide**: hourly/daily CU caps use Redis `INCR`/`PEXPIRE`, so `numInstances: 2` no longer multiplies the intended Moralis spend, and caps survive deploys.
- **`MORALIS_DISABLED` documented in `render.yaml`** as the emergency kill switch (set to `"false"` on `bnbscan-web`).

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
- **Consolidated rate limiter**: Shared `@bnbscan/explorer-core` package eliminates divergent per-app implementations
- **Webhook secret hashing**: Raw secret returned to caller once; SHA-256 hash stored in DB — DB compromise cannot be used to forge webhook signatures
- **API key hashing**: `bnbs_`/`eths_` keys stored as SHA-256 hashes; prefix stored for display

### Fixed
- **RPC provider stability**: `JsonRpcProvider` now stored in `globalThis` to survive Next.js hot reloads; null-cleared on `error` event for automatic reconnection
- **DB connection pool**: Reduced web app pool from max:10 to max:5 so total connections (web=5 + indexer=10 = 15) stay within Render Standard's 25-connection limit

### Infrastructure
- Turborepo monorepo: `apps/explorer`, `apps/indexer`, `apps/status`, `packages/db`, `packages/explorer-core`, `packages/ui`
- Unified indexer: one chain-configurable worker for BNB Chain and Ethereum
- Render hosting: web service + 2 indexer workers + PostgreSQL + Redis

# BNBScan / EthScan

Open-source BNB Chain and Ethereum explorers. Maintained by [Measurable Data Token (MDT)](https://mdt.io).

- **BNBScan.com** — The Alternative BNB Chain Explorer
- **EthScan.io** — The Alternative Ethereum Explorer

## Features

- Block, transaction, address, and token exploration
- DEX trade tracking (PancakeSwap, Uniswap V2/V3)
- Whale tracker and token holder analysis
- Gas price charts and network analytics
- Contract verification (Sourcify integration)
- NFT/ERC-721/1155 portfolio view
- CSV export for any address
- Developer API with key management and webhooks
- Network switcher between BNB Chain and Ethereum

## Architecture

```
bnbscan.com / ethscan.io
├── apps/web          Next.js 14 — BNBScan frontend + API
├── apps/ethscan      Next.js 14 — EthScan frontend + API
├── apps/indexer      BullMQ indexer — BNB Chain block processor
├── apps/eth-indexer  Node.js indexer — Ethereum block processor
├── packages/db       Drizzle ORM schema + Postgres client
├── packages/explorer-core  Shared utilities (rate limiting, format)
└── packages/ui       Shared React components
```

**Stack:** Next.js 14, Drizzle ORM, PostgreSQL, BullMQ, Redis, ethers.js, Tailwind CSS, Turborepo

**Hosting:** Render.com (web services + workers + PostgreSQL Standard + Redis)

## Getting Started

```bash
# Install dependencies
pnpm install

# Copy env files
cp apps/web/.env.example apps/web/.env.local
cp apps/ethscan/.env.example apps/ethscan/.env.local

# Start dev servers
pnpm dev
# BNBScan: http://localhost:3000
# EthScan:  http://localhost:3001
```

## Environment Variables

See `apps/web/.env.example` and `apps/ethscan/.env.example` for the full list. Key vars:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string (BNB) |
| `ETH_DATABASE_URL` | PostgreSQL connection string (ETH) |
| `BNB_RPC_URL` | BSC RPC endpoint (Chainstack recommended) |
| `ETH_RPC_URL` | Ethereum RPC endpoint |
| `REDIS_URL` | Redis connection string |
| `MORALIS_API_KEY` | Moralis API for balance/NFT enrichment |
| `GOPLUS_API_KEY` | GoPlus security analysis |

## Deployment

```bash
# Deploy to Render — uses render.yaml
git push origin main

# Deploy to self-hosted (Hetzner)
./infra/deploy.sh user@YOUR_SERVER_IP
```

See `infra/README.md` for server setup instructions.

## API

Both explorers expose a v1 REST API. See the in-app API docs page (`/api-docs`) or the developer page (`/developer`) to create an API key.

```bash
# Query transactions
curl -X POST https://bnbscan.com/api/v1/query \
  -H "X-API-Key: bnbs_..." \
  -H "Content-Type: application/json" \
  -d '{"entity":"transactions","filter":{"address":"0x..."}}'
```

## Testing

```bash
pnpm test
```

23 tests covering IP spoofing prevention and SSRF protection. See `packages/explorer-core/src/rate-limit.test.ts` and `apps/web/lib/webhook-ssrf.test.ts`.

## Known Limitations (v0.1)

See `TODOS.md` for the full backlog. Key v0.1 limitations:

- No reorg handling — indexers advance by block height without canonical validation
- Token holder counts and address balances are not live-updated
- Rate limiting is per-process (not Redis-backed); may allow bypass if auto-scaled
- Historical coverage starts from a recent block, not genesis

## License

MIT

# Infrastructure

## Architecture

```
bnbscan.com  ──→  Nginx :80/:443  ──→  PM2: bnbscan-web  ──→  Next.js :3000
ethscan.io   ──→  Nginx :80/:443  ──→  PM2: ethscan-web   ──→  Next.js :3001
                                   ──→  PM2: bnb-indexer   ──→  BSC RPC
                                   ──→  PM2: eth-indexer   ──→  ETH RPC
                                   ──→  PostgreSQL: bnbscan DB
                                   ──→  PostgreSQL: ethscan DB
```

## First-time server setup

```bash
# On a fresh Hetzner Ubuntu 22.04 server (as root):
bash infra/server-setup.sh

# Then create env files:
cp apps/web/.env.example apps/web/.env.production
cp apps/ethscan/.env.example apps/ethscan/.env.production
# Edit both files with real values

# Build and start:
pnpm build
pm2 start infra/ecosystem.config.js
pm2 save && pm2 startup
```

## Deploy (from local machine)

```bash
./infra/deploy.sh user@YOUR_SERVER_IP
```

## Server sizing

| Plan | RAM | Use case |
|------|-----|----------|
| CX21 | 4GB | Dev/staging, one chain |
| CX31 | 8GB | Production, both chains |
| CX41 | 16GB | High traffic, both chains + Redis |

## Recommended: CX31 (8GB)
- 2GB — PostgreSQL (two databases)
- 1.5GB — BNBScan Next.js
- 1.5GB — EthScan Next.js
- 1GB — BNB indexer
- 1GB — ETH indexer
- 1GB — OS headroom

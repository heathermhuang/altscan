#!/bin/bash
# Deploy script for Hetzner server.
# Run from LOCAL machine: ./infra/deploy.sh user@server-ip
# Assumes SSH key auth is set up.
set -euo pipefail

SERVER="${1:?Usage: ./deploy.sh user@server-ip}"
REMOTE_DIR="/opt/bnbscan"

echo "🚀 Deploying to $SERVER"

# 1. Pull latest code
ssh "$SERVER" "cd $REMOTE_DIR && git pull origin main"

# 2. Install dependencies
ssh "$SERVER" "cd $REMOTE_DIR && pnpm install --frozen-lockfile"

# 3. Build apps
ssh "$SERVER" "cd $REMOTE_DIR && pnpm build"

# 4. Copy static assets for standalone output
ssh "$SERVER" "
  cp -r $REMOTE_DIR/apps/web/public $REMOTE_DIR/apps/web/.next/standalone/apps/web/public
  cp -r $REMOTE_DIR/apps/web/.next/static $REMOTE_DIR/apps/web/.next/standalone/apps/web/.next/static
  cp -r $REMOTE_DIR/apps/ethscan/public $REMOTE_DIR/apps/ethscan/.next/standalone/apps/ethscan/public 2>/dev/null || true
  cp -r $REMOTE_DIR/apps/ethscan/.next/static $REMOTE_DIR/apps/ethscan/.next/standalone/apps/ethscan/.next/static 2>/dev/null || true
"

# 5. Reload web processes (zero-downtime)
ssh "$SERVER" "cd $REMOTE_DIR && pm2 reload bnbscan-web ethscan-web"

# 6. Restart indexers (they're stateful — do NOT reload, use restart)
ssh "$SERVER" "cd $REMOTE_DIR && pm2 restart bnb-indexer eth-indexer"

echo "✅ Deploy complete. Run 'pm2 status' on server to verify."

#!/usr/bin/env bash
#
# Database maintenance script for BNBScan / EthScan
# Reports DB size and optionally prunes old data.
#
# Usage:
#   ./scripts/db-maintenance.sh                    # report only
#   ./scripts/db-maintenance.sh --prune            # prune + VACUUM
#   RENDER_API_KEY=xxx ./scripts/db-maintenance.sh  # with Render API
#
set -euo pipefail

RENDER_API_KEY="${RENDER_API_KEY:-}"
if [[ -z "$RENDER_API_KEY" && -f "$(dirname "$0")/../.render-api-key" ]]; then
  RENDER_API_KEY=$(grep -oP 'RENDER_API_KEY=\K.*' "$(dirname "$0")/../.render-api-key" 2>/dev/null || true)
fi

PRUNE=false
[[ "${1:-}" == "--prune" ]] && PRUNE=true

echo "=== DB Maintenance Report — $(date -u '+%Y-%m-%d %H:%M:%S UTC') ==="

for site in "bnbscan.com|BNBScan" "ethscan.io|EthScan"; do
  IFS='|' read -r domain label <<< "$site"
  echo ""
  echo "--- $label ($domain) ---"

  health=$(curl -s --max-time 15 "https://$domain/api/health" 2>/dev/null || echo '{}')
  db_info=$(echo "$health" | python3 -c "
import json,sys
d = json.load(sys.stdin).get('database',{})
if d:
    size_gb = round(d.get('sizeMB',0) / 1024, 1)
    print(f\"  DB Size:          {size_gb} GB\")
    print(f\"  Transactions:     {d.get('txRows',0):,}\")
    print(f\"  Token Transfers:  {d.get('tokenTransferRows',0):,}\")
    print(f\"  Blocks:           {d.get('blockRows',0):,}\")
    print(f\"  Active Conns:     {d.get('activeConns',0)} / {d.get('totalConns',0)}\")
else:
    print('  DB metrics unavailable')
" 2>/dev/null)
  echo "$db_info"

  mem_info=$(echo "$health" | python3 -c "
import json,sys
m = json.load(sys.stdin).get('memory',{})
print(f\"  Heap:             {m.get('heapUsedMB',0)}MB / {m.get('heapTotalMB',0)}MB\")
print(f\"  RSS:              {m.get('rssMB',0)}MB\")
print(f\"  Status:           {m.get('status','unknown')}\")
" 2>/dev/null)
  echo "$mem_info"

  uptime=$(echo "$health" | python3 -c "import json,sys; print(f\"  Uptime:           {json.load(sys.stdin).get('uptime',0)}s\")" 2>/dev/null)
  echo "$uptime"
done

echo ""
echo "=== Optimization ==="
echo "Run: psql \$DATABASE_URL -f scripts/db-optimize.sql"
echo "  - Creates composite indexes (from_address, timestamp) on transactions + token_transfers"
echo "  - Prunes gas_history (>30d), logs (>60d), dex_trades (>60d)"
echo "  - VACUUM ANALYZE on pruned tables"

if $PRUNE; then
  echo ""
  echo "=== PRUNE MODE ==="
  echo "Pruning is not yet automated — requires direct DB access."
  echo "Safe pruning targets:"
  echo "  - gas_history older than 90 days"
  echo "  - logs older than 30 days (if not needed for contract verification)"
  echo "  - dex_trades older than 90 days"
fi

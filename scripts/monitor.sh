#!/usr/bin/env bash
#
# BNBScan / EthScan monitoring script
# Checks site health and triggers redeploy if down.
#
# Usage:
#   ./scripts/monitor.sh                  # check both sites
#   RENDER_API_KEY=xxx ./scripts/monitor.sh  # with auto-redeploy
#
# Run on a cron (every 5 min) or manually.
# Exits 0 if all healthy, 1 if any issues detected.

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────

SITES=(
  "bnbscan.com|${BNBSCAN_SERVICE_ID:-}"
  "ethscan.io|${ETHSCAN_SERVICE_ID:-}"
)

TIMEOUT=15
RENDER_API_KEY="${RENDER_API_KEY:-}"

# Load API key from file if not in env
if [[ -z "$RENDER_API_KEY" && -f "$(dirname "$0")/../.render-api-key" ]]; then
  RENDER_API_KEY=$(grep -oP 'RENDER_API_KEY=\K.*' "$(dirname "$0")/../.render-api-key" 2>/dev/null || true)
fi

# ── Helpers ───────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log_ok()   { echo -e "${GREEN}[OK]${NC}   $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; }

check_endpoint() {
  local url="$1"
  local label="$2"
  local code
  local raw
  raw=$(curl -s --max-time "$TIMEOUT" -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || true)
  # Extract last 3 digits — handles 103 Early Hints prefixing the status
  code="${raw: -3}"
  [[ -z "$code" || ! "$code" =~ ^[0-9]+$ ]] && code="000"
  if [[ "$code" == "200" ]]; then
    log_ok "$label ($url) -> $code"
    return 0
  elif [[ "$code" == "000" ]]; then
    log_fail "$label ($url) -> timeout/unreachable"
    return 1
  else
    log_fail "$label ($url) -> HTTP $code"
    return 1
  fi
}

get_health() {
  local domain="$1"
  local json
  json=$(curl -s --max-time "$TIMEOUT" "https://$domain/api/health" 2>/dev/null || echo '{}')
  echo "$json"
}

check_render_events() {
  local service_id="$1"
  local domain="$2"
  if [[ -z "$RENDER_API_KEY" ]]; then return; fi

  local events
  events=$(curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
    "https://api.render.com/v1/services/$service_id/events?limit=5" 2>/dev/null)

  local crashes
  crashes=$(echo "$events" | python3 -c "
import json,sys
try:
    data = json.load(sys.stdin)
    count = sum(1 for e in data if e['event']['type'] == 'server_failed')
    print(count)
except:
    print(0)
" 2>/dev/null || echo "0")

  if [[ "$crashes" -gt 2 ]]; then
    log_warn "$domain: $crashes crashes in last 5 events — crash-looping"
    return 1
  elif [[ "$crashes" -gt 0 ]]; then
    log_warn "$domain: $crashes recent crash(es)"
  fi
  return 0
}

trigger_redeploy() {
  local service_id="$1"
  local domain="$2"
  if [[ -z "$RENDER_API_KEY" ]]; then
    log_warn "No RENDER_API_KEY — cannot auto-redeploy $domain"
    return
  fi

  log_warn "Triggering redeploy for $domain ($service_id)..."
  local result
  result=$(curl -s -X POST \
    -H "Authorization: Bearer $RENDER_API_KEY" \
    -H "Content-Type: application/json" \
    "https://api.render.com/v1/services/$service_id/deploys" \
    -d '{"clearCache":"do_not_clear"}' 2>/dev/null)

  local deploy_id
  deploy_id=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('deploy',{}).get('id','unknown'))" 2>/dev/null || echo "unknown")
  log_ok "Redeploy triggered: $deploy_id"
}

# ── Main ──────────────────────────────────────────────────────────────────────

echo "=== BNBScan/EthScan Health Check — $(date -u '+%Y-%m-%d %H:%M:%S UTC') ==="
echo ""

overall_status=0

for site_config in "${SITES[@]}"; do
  IFS='|' read -r domain service_id <<< "$site_config"
  echo "--- $domain ---"

  site_down=false

  # 1. Check homepage
  if ! check_endpoint "https://$domain" "Homepage"; then
    site_down=true
  fi

  # 2. Check health endpoint
  if ! check_endpoint "https://$domain/api/ping" "Health ping"; then
    site_down=true
  fi

  # 3. Parse /api/health for memory status
  health_json=$(get_health "$domain")
  if [[ "$health_json" != "{}" ]]; then
    mem_status=$(echo "$health_json" | python3 -c "import json,sys; d=json.load(sys.stdin); m=d.get('memory',{}); print(f\"heap={m.get('heapUsedMB',0)}MB/{m.get('heapTotalMB',0)}MB rss={m.get('rssMB',0)}MB status={m.get('status','unknown')}\")" 2>/dev/null || echo "parse error")
    uptime=$(echo "$health_json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('uptime',0))" 2>/dev/null || echo "?")
    caches=$(echo "$health_json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('totalCacheEntries',0))" 2>/dev/null || echo "?")
    status=$(echo "$health_json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','unknown'))" 2>/dev/null || echo "unknown")

    if [[ "$status" == "ok" ]]; then
      log_ok "Health: $mem_status uptime=${uptime}s caches=$caches"
    elif [[ "$status" == "degraded" ]]; then
      log_warn "Health DEGRADED: $mem_status uptime=${uptime}s caches=$caches"
    else
      log_fail "Health: $status — $mem_status"
    fi
  fi

  # 4. Check Render events for crash-loop
  if ! check_render_events "$service_id" "$domain"; then
    overall_status=1
  fi

  # 5. Auto-redeploy if site is down
  if $site_down; then
    overall_status=1
    trigger_redeploy "$service_id" "$domain"
  fi

  echo ""
done

if [[ $overall_status -eq 0 ]]; then
  echo -e "${GREEN}All sites healthy.${NC}"
else
  echo -e "${RED}Issues detected — check above.${NC}"
fi

exit $overall_status

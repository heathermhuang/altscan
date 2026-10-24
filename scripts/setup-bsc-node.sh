#!/bin/bash
# =============================================================================
# BNBScan — BSC Full Node Setup Script
# Target:  Hetzner AX52 (2×960GB NVMe), Ubuntu 22.04
# Snapshot: ~1.5TB pruned (needs ~2TB free) — takes 4-8 hours to download
# Cost:    €65/mo — unlimited bandwidth, no egress fees
#
# This script runs as root and executes downloaded code, so nothing is fetched
# "latest" and nothing runs unverified: you pin exact versions and sha256
# digests below (or pass them as environment variables), and it refuses to run
# until every pin is set.
#
# Usage (run as root on the Hetzner server):
#   # Review the script at a commit you trust, and fetch it from THAT commit
#   # (not from a moving branch):
#   curl -sO https://raw.githubusercontent.com/heathermhuang/bnbscan/<reviewed-commit-sha>/scripts/setup-bsc-node.sh
#   CONFIRM_WIPE=yes \
#   BSC_VERSION=v1.x.y GETH_SHA256=... MAINNET_ZIP_SHA256=... \
#   FETCH_SNAPSHOT_COMMIT=<40-hex> FETCH_SNAPSHOT_SHA256=... \
#   RPC_BIND_ADDR=<this server's address> RENDER_IPS="12.34.56.78 98.76.54.32" \
#     bash setup-bsc-node.sh
#
# To pin: on a machine you trust, download the artifacts for the release/commit
# you picked, read them, and record `sha256sum` of each (geth_linux and
# mainnet.zip from https://github.com/bnb-chain/bsc/releases/tag/<BSC_VERSION>;
# dist/fetch-snapshot.sh from bnb-chain/bsc-snapshots at FETCH_SNAPSHOT_COMMIT).
# The multi-hundred-GB snapshot data itself is not hashed here: it is pinned by
# SNAPSHOT_NAME and fetched/verified by the pinned fetch-snapshot.sh.
#
# After setup, the RPC listens on 127.0.0.1 only. To serve Render, set
# RPC_BIND_ADDR to a non-loopback address AND list Render's IPs in RENDER_IPS;
# then set BNB_RPC_URL=http://<server-ip>:8545 in Render env vars. Note the RPC
# is plain HTTP: the firewall allow-list is the only access control.
# =============================================================================
set -euo pipefail

# ── Config — edit before running, or override with environment variables ─────
DATA_DIR="/data/bsc"             # where chaindata lives (on your large NVMe)
SNAP_DIR="/data/snapshot"        # temp dir for snapshot download (auto-deleted after extract)
BSC_USER="bsc"                   # dedicated system user for the node process
RPC_PORT="8545"
P2P_PORT="30311"

# Snapshot name — check latest at: https://github.com/bnb-chain/bsc-snapshots
# Format: mainnet-geth-pbss-YYYYMMDD  (updated monthly by BNB Chain team)
SNAPSHOT_NAME="${SNAPSHOT_NAME:-mainnet-geth-pbss-20260306}"

# HTTP RPC bind address. Loopback by default: the node is unreachable from the
# network. Setting any other address is the explicit opt-in to expose RPC, and
# then RENDER_IPS (below) is mandatory.
RPC_BIND_ADDR="${RPC_BIND_ADDR:-127.0.0.1}"

# Your Render outbound IPs — find at: Render dashboard → service → Outbound IPs
# Space-separated. Required whenever RPC_BIND_ADDR is not loopback: the script
# refuses to open the RPC port to everyone.
RENDER_IPS="${RENDER_IPS:-}"   # e.g. "12.34.56.78 98.76.54.32"

# Step 1 reformats every NVMe drive. Nothing is touched unless this is "yes".
CONFIRM_WIPE="${CONFIRM_WIPE:-}"

# ── Pinned artifacts — REQUIRED, deliberately no defaults ────────────────────
BSC_VERSION="${BSC_VERSION:-}"                       # BSC release tag, e.g. v1.x.y
GETH_SHA256="${GETH_SHA256:-}"                       # sha256 of that release's geth_linux
MAINNET_ZIP_SHA256="${MAINNET_ZIP_SHA256:-}"         # sha256 of that release's mainnet.zip
FETCH_SNAPSHOT_COMMIT="${FETCH_SNAPSHOT_COMMIT:-}"   # bnb-chain/bsc-snapshots commit (40 hex)
FETCH_SNAPSHOT_SHA256="${FETCH_SNAPSHOT_SHA256:-}"   # sha256 of dist/fetch-snapshot.sh at that commit
GETH_ASSET="geth_linux"                              # asset names inside the release
MAINNET_ASSET="mainnet.zip"

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${GREEN}[✓]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
error()   { echo -e "${RED}[✗]${NC} $*"; exit 1; }
step()    { echo -e "\n${CYAN}━━━ $* ━━━${NC}"; }

[[ $EUID -ne 0 ]] && error "Run as root: sudo bash setup-bsc-node.sh"

# ── Refuse to run on an unpinned or unsafe configuration ─────────────────────
# Everything here is checked BEFORE the first change to the machine.
for var in BSC_VERSION GETH_SHA256 MAINNET_ZIP_SHA256 FETCH_SNAPSHOT_COMMIT FETCH_SNAPSHOT_SHA256; do
  [[ -n "${!var}" ]] || error "$var is not set. Pin it explicitly (see the header); this script never downloads 'latest'."
done
[[ "$BSC_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] \
  || error "BSC_VERSION must be an exact release tag like v1.2.3 (got '$BSC_VERSION')"
for var in GETH_SHA256 MAINNET_ZIP_SHA256 FETCH_SNAPSHOT_SHA256; do
  [[ "${!var}" =~ ^[0-9a-f]{64}$ ]] || error "$var must be 64 lowercase hex characters"
done
[[ "$FETCH_SNAPSHOT_COMMIT" =~ ^[0-9a-f]{40}$ ]] \
  || error "FETCH_SNAPSHOT_COMMIT must be a full 40-character commit SHA, not a branch name"
# SNAPSHOT_NAME and RPC_BIND_ADDR are interpolated into generated files.
[[ "$SNAPSHOT_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || error "SNAPSHOT_NAME has unexpected characters"
[[ "$RPC_BIND_ADDR" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || error "RPC_BIND_ADDR must be an IPv4 address (got '$RPC_BIND_ADDR')"

if [[ "$RPC_BIND_ADDR" == "127.0.0.1" ]]; then
  [[ -z "$RENDER_IPS" ]] || warn "RENDER_IPS is ignored while RPC_BIND_ADDR is 127.0.0.1 — the RPC is not reachable from outside"
else
  [[ -n "$RENDER_IPS" ]] \
    || error "RPC_BIND_ADDR=$RPC_BIND_ADDR exposes the RPC, but RENDER_IPS is empty. Refusing to open $RPC_PORT to everyone — list the Render outbound IPs."
  for ip in $RENDER_IPS; do
    [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}(/[0-9]{1,2})?$ ]] || error "RENDER_IPS entry '$ip' is not an IPv4 address or CIDR"
  done
fi

# Verify a downloaded file against its pinned sha256 before anything uses it.
# verify_sha256 <file> <expected-hex>; deletes the file and exits on mismatch.
verify_sha256() {
  local file="$1" want="$2" got
  got=$(sha256sum "$file" | awk '{print $1}')
  if [[ "$got" != "$want" ]]; then
    rm -f "$file"
    error "sha256 mismatch for $(basename "$file"): expected $want, got $got — refusing to use it"
  fi
}

# =============================================================================
step "1/9 — Disk: merge two NVMe drives into one volume"
# =============================================================================
# Hetzner AX52 ships with 2×960GB NVMe. We stripe them together
# for ~1.9TB of fast storage under /data.
# Skip this step if /data is already mounted (e.g. re-running script).
if ! mountpoint -q /data; then
  # Find the two NVMe devices (usually nvme0n1 + nvme1n1)
  NVME_DEVS=$(lsblk -dno NAME,TYPE | awk '$2=="disk" && $1~/nvme/{print "/dev/"$1}')
  [[ -n "$NVME_DEVS" ]] || error "No NVMe drives found — nothing to set up /data on"
  NVME_COUNT=$(echo "$NVME_DEVS" | wc -l)

  # DESTRUCTIVE: everything below erases every NVMe drive listed here. Require
  # an explicit opt-in, and never touch a drive that is in use (e.g. the OS disk).
  for dev in $NVME_DEVS; do
    IN_USE=$(lsblk -nr -o MOUNTPOINT "$dev")
    if [[ -n "${IN_USE//[[:space:]]/}" ]]; then
      error "$dev (or one of its partitions) is mounted or in use — refusing to wipe it. Mount /data yourself on a spare drive and re-run."
    fi
  done
  if [[ "$CONFIRM_WIPE" != "yes" ]]; then
    echo "$NVME_DEVS"
    error "Step 1 would ERASE the NVMe drives listed above. Re-run with CONFIRM_WIPE=yes if that is intended."
  fi
  warn "CONFIRM_WIPE=yes — erasing: $(tr '\n' ' ' <<< "$NVME_DEVS")"

  if [[ $NVME_COUNT -ge 2 ]]; then
    info "Found $NVME_COUNT NVMe drives — creating RAID-0 stripe for max throughput"
    apt-get install -y -qq mdadm
    DEVS_ARRAY=($NVME_DEVS)
    # Create RAID-0 (stripe) — all space available, 2× read/write speed
    mdadm --create --verbose /dev/md0 --level=0 --raid-devices=2 "${DEVS_ARRAY[@]}" --force <<< "yes" || true
    mkfs.ext4 -F /dev/md0
    mkdir -p /data
    mount /dev/md0 /data
    echo '/dev/md0 /data ext4 defaults,nofail 0 2' >> /etc/fstab
    info "RAID-0 mounted at /data (~1.9TB)"
  else
    # Single drive fallback
    SINGLE_DEV=$(echo "$NVME_DEVS" | head -1)
    warn "Only 1 NVMe found — using $SINGLE_DEV directly"
    mkfs.ext4 -F "$SINGLE_DEV"
    mkdir -p /data
    mount "$SINGLE_DEV" /data
    echo "$SINGLE_DEV /data ext4 defaults,nofail 0 2" >> /etc/fstab
  fi
else
  info "/data already mounted — skipping disk setup"
fi

df -h /data

# =============================================================================
step "2/9 — Dependencies"
# =============================================================================
apt-get update -qq
apt-get install -y -qq \
  curl wget aria2 unzip screen ufw fail2ban \
  htop iotop nethogs lz4 jq git
info "Dependencies installed"

# =============================================================================
step "3/9 — BSC user & directories"
# =============================================================================
if ! id "$BSC_USER" &>/dev/null; then
  useradd -m -s /bin/bash -d "/home/$BSC_USER" "$BSC_USER"
fi

mkdir -p "$DATA_DIR" "$SNAP_DIR" "/home/$BSC_USER/bsc"
chown -R "$BSC_USER:$BSC_USER" "$DATA_DIR" "$SNAP_DIR" "/home/$BSC_USER/bsc"
info "Directories ready"

# =============================================================================
step "4/9 — BSC geth binary"
# =============================================================================
BSC_DIR="/home/$BSC_USER/bsc"
cd "$BSC_DIR"

BSC_RELEASE_URL="https://github.com/bnb-chain/bsc/releases/download/$BSC_VERSION"
info "Fetching pinned BSC release $BSC_VERSION..."

# Download, then verify the pinned sha256 BEFORE the file is made executable or
# unpacked. Nothing downloaded is ever executed as root.
wget -q --show-progress -O geth "$BSC_RELEASE_URL/$GETH_ASSET"
verify_sha256 geth "$GETH_SHA256"
wget -q --show-progress -O mainnet.zip "$BSC_RELEASE_URL/$MAINNET_ASSET"
verify_sha256 mainnet.zip "$MAINNET_ZIP_SHA256"
chmod +x geth
chown -R "$BSC_USER:$BSC_USER" "$BSC_DIR"
info "Installed BSC geth $BSC_VERSION: $(sudo -u "$BSC_USER" ./geth version 2>&1 | head -1)"

# Config files (genesis.json + config.toml), unpacked as the node user
sudo -u "$BSC_USER" unzip -o mainnet.zip && rm mainnet.zip
[[ -f genesis.json ]] || error "genesis.json not found after unzip"
[[ -f config.toml  ]] || error "config.toml not found after unzip"
info "Config files ready: genesis.json  config.toml"

# Init genesis (safe to re-run)
if [[ ! -d "$DATA_DIR/geth/chaindata" ]]; then
  info "Initializing genesis block..."
  sudo -u "$BSC_USER" "$BSC_DIR/geth" --datadir "$DATA_DIR" init "$BSC_DIR/genesis.json"
fi

chown -R "$BSC_USER:$BSC_USER" "$BSC_DIR"

# =============================================================================
step "5/9 — Systemd service"
# =============================================================================
# RPC hardening: bound to $RPC_BIND_ADDR (loopback unless you opted in), only
# the eth/net/web3 namespaces (no debug/txpool — those expose node internals and
# are expensive to serve), no CORS, and no wildcard Host allow-list. geth always
# accepts an IP-literal Host header, so BNB_RPC_URL=http://<server-ip>:8545 works
# with vhosts "localhost"; a DNS name would need that name added to --http.vhosts.
cat > /etc/systemd/system/bsc-node.service << EOF
[Unit]
Description=BNB Smart Chain Full Node
After=network-online.target
Wants=network-online.target

[Service]
User=$BSC_USER
Group=$BSC_USER
WorkingDirectory=$BSC_DIR
Restart=on-failure
RestartSec=10
LimitNOFILE=65536
KillSignal=SIGINT
TimeoutStopSec=300

ExecStart=$BSC_DIR/geth \\
  --config $BSC_DIR/config.toml \\
  --datadir $DATA_DIR \\
  --cache 8192 \\
  --rpc.allow-unprotected-txs \\
  --history.transactions 0 \\
  --history.logs 576000 \\
  --tries-verify-mode none \\
  --http \\
  --http.addr $RPC_BIND_ADDR \\
  --http.port $RPC_PORT \\
  --http.vhosts localhost \\
  --http.api eth,net,web3 \\
  --maxpeers 50

StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
# Note: NOT enabling yet — start after snapshot is extracted
info "Systemd service written (will auto-start after snapshot download)"

# =============================================================================
step "6/9 — Firewall (UFW)"
# =============================================================================
ufw --force reset
ufw default deny incoming
ufw default allow outgoing

ufw allow 22/tcp    comment "SSH"
ufw allow $P2P_PORT/tcp comment "BSC P2P"
ufw allow $P2P_PORT/udp comment "BSC P2P"

# The RPC port is only ever opened to the listed Render IPs, never to everyone
# (an empty RENDER_IPS with a non-loopback bind was already rejected up front).
if [[ "$RPC_BIND_ADDR" != "127.0.0.1" ]]; then
  for ip in $RENDER_IPS; do
    ufw allow from "$ip" to any port $RPC_PORT proto tcp comment "RPC - Render"
    info "RPC allowed from $ip"
  done
else
  info "RPC bound to 127.0.0.1 — no firewall rule opened for port $RPC_PORT"
fi

ufw allow from 127.0.0.1 to any port $RPC_PORT proto tcp comment "RPC - localhost"
ufw --force enable
ufw status verbose
info "Firewall configured"

# =============================================================================
step "7/9 — fail2ban"
# =============================================================================
cat > /etc/fail2ban/jail.local << 'EOF'
[sshd]
enabled  = true
port     = ssh
maxretry = 5
bantime  = 3600
findtime = 600
EOF
systemctl enable fail2ban --now
info "fail2ban enabled"

# =============================================================================
step "8/9 — Snapshot download (runs in screen, ~4-8 hours)"
# =============================================================================
# Download fetch-snapshot.sh from BNB Chain at a PINNED commit (never a moving
# branch) and refuse to use it unless it matches the pinned sha256.
wget -q -O "$SNAP_DIR/fetch-snapshot.sh" \
  "https://raw.githubusercontent.com/bnb-chain/bsc-snapshots/$FETCH_SNAPSHOT_COMMIT/dist/fetch-snapshot.sh"
verify_sha256 "$SNAP_DIR/fetch-snapshot.sh" "$FETCH_SNAPSHOT_SHA256"
chmod +x "$SNAP_DIR/fetch-snapshot.sh"

# Write the download+start script. It stays root-owned in a root-owned directory:
# it runs as root (it must enable the service), so the node user must not be able
# to rewrite it. Only the downloaded fetch-snapshot.sh runs as $BSC_USER.
RUN_SNAPSHOT=/usr/local/sbin/run-snapshot.sh
cat > "$RUN_SNAPSHOT" << SNAP
#!/bin/bash
set -eo pipefail
echo "════════════════════════════════════════"
echo "  BSC Snapshot Download"
echo "  Snapshot: $SNAPSHOT_NAME (pruned ~1.5TB)"
echo "  Started:  \$(date)"
echo "  Log:      /tmp/snapshot.log"
echo "════════════════════════════════════════"

cd $SNAP_DIR
sudo -u $BSC_USER bash fetch-snapshot.sh -d -e -c -p --auto-delete \\
  -D $SNAP_DIR \\
  -E $DATA_DIR \\
  $SNAPSHOT_NAME 2>&1 | tee /tmp/snapshot.log

echo ""
echo "════════════════════════════════════════"
echo "  Snapshot done! Starting node..."
echo "════════════════════════════════════════"
chown -R $BSC_USER:$BSC_USER $DATA_DIR
systemctl enable bsc-node
systemctl start bsc-node
echo "BSC node started. Check: journalctl -u bsc-node -f"
SNAP

chmod 755 "$RUN_SNAPSHOT"
chown root:root "$RUN_SNAPSHOT"

# Launch in detached screen session so it survives disconnection
screen -dmS bsc-snapshot bash "$RUN_SNAPSHOT"
info "Snapshot download running in screen session 'bsc-snapshot'"

# =============================================================================
step "9/9 — Status helper"
# =============================================================================
cat > /usr/local/bin/bsc-status << 'HELPER'
#!/bin/bash
echo "════════════════════════════════════════"
echo "  BSC Node — $(date)"
echo "════════════════════════════════════════"

echo ""
echo "▸ SNAPSHOT DOWNLOAD:"
if screen -ls 2>/dev/null | grep -q bsc-snapshot; then
  echo "  In progress..."
  tail -3 /tmp/snapshot.log 2>/dev/null || echo "  (starting...)"
else
  echo "  Complete (or not started)"
fi

echo ""
echo "▸ NODE:"
if systemctl is-active bsc-node &>/dev/null; then
  SYNC=$(curl -sf -X POST http://localhost:8545 \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"eth_syncing","params":[],"id":1}' 2>/dev/null)
  if echo "$SYNC" | grep -q '"result":false'; then
    echo "  ✓ Fully synced"
  else
    CURRENT=$(echo "$SYNC" | jq -r '.result.currentBlock // "?"' 2>/dev/null)
    HIGHEST=$(echo "$SYNC" | jq -r '.result.highestBlock // "?"' 2>/dev/null)
    echo "  Syncing: block $CURRENT / $HIGHEST"
  fi
else
  echo "  Not running"
fi

echo ""
echo "▸ DISK:"
df -h /data | tail -1

echo ""
echo "▸ RECENT LOGS:"
journalctl -u bsc-node -n 5 --no-pager 2>/dev/null || echo "  (node not started)"

echo ""
echo "Commands:"
echo "  screen -r bsc-snapshot     — watch snapshot download live"
echo "  tail -f /tmp/snapshot.log  — snapshot log"
echo "  journalctl -u bsc-node -f  — node logs"
HELPER

chmod +x /usr/local/bin/bsc-status

# =============================================================================
SERVER_IP=$(curl -sf ifconfig.me || hostname -I | awk '{print $1}')

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Setup complete!                                 ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo "  Snapshot: downloading in background (4-8 hours)"
echo "  Node will auto-start when snapshot is done"
echo ""
if [[ "$RPC_BIND_ADDR" == "127.0.0.1" ]]; then
  echo "  RPC endpoint:  http://127.0.0.1:$RPC_PORT  (loopback only — not reachable from Render)"
else
  echo "  RPC endpoint:  http://$SERVER_IP:$RPC_PORT  (firewalled to RENDER_IPS)"
fi
echo ""
echo "  Monitor:  bsc-status"
echo ""
echo -e "${YELLOW}  Next steps after node is synced:${NC}"
if [[ "$RPC_BIND_ADDR" == "127.0.0.1" ]]; then
  echo "  1. To let Render use this node, re-run with RPC_BIND_ADDR=<server address>"
  echo "     and RENDER_IPS=\"<Render outbound IPs>\" (the RPC is loopback-only now)"
else
  echo "  1. Set in Render env vars:"
  echo "     BNB_RPC_URL=http://$SERVER_IP:$RPC_PORT"
fi
echo "  2. Run backfill from Render Shell:"
echo "     node dist/backfill.js 1 47800000 --skip-logs"
echo ""

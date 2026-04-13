#!/bin/bash
# =============================================================================
# BNBScan — BSC Full Node Setup Script
# Target:  Hetzner AX52 (2×960GB NVMe), Ubuntu 22.04
# Snapshot: ~1.5TB pruned (needs ~2TB free) — takes 4-8 hours to download
# Cost:    €65/mo — unlimited bandwidth, no egress fees
#
# Usage (run as root on the Hetzner server):
#   curl -sO https://raw.githubusercontent.com/nicemdt/bnbscan/main/scripts/setup-bsc-node.sh
#   bash setup-bsc-node.sh
#
# After setup:
#   Set BNB_RPC_URL=http://<server-ip>:8545 in Render env vars
# =============================================================================
set -euo pipefail

# ── Config — edit before running ─────────────────────────────────────────────
DATA_DIR="/data/bsc"             # where chaindata lives (on your large NVMe)
SNAP_DIR="/data/snapshot"        # temp dir for snapshot download (auto-deleted after extract)
BSC_USER="bsc"                   # dedicated system user for the node process
RPC_PORT="8545"
P2P_PORT="30311"

# Snapshot name — check latest at: https://github.com/bnb-chain/bsc-snapshots
# Format: mainnet-geth-pbss-YYYYMMDD  (updated monthly by BNB Chain team)
SNAPSHOT_NAME="mainnet-geth-pbss-20260306"

# Your Render outbound IPs — find at: Render dashboard → service → Outbound IPs
# Space-separated. Leave empty to allow all (fine for private/testing nodes).
RENDER_IPS=""   # e.g. "12.34.56.78 98.76.54.32"

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${GREEN}[✓]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
error()   { echo -e "${RED}[✗]${NC} $*"; exit 1; }
step()    { echo -e "\n${CYAN}━━━ $* ━━━${NC}"; }

[[ $EUID -ne 0 ]] && error "Run as root: sudo bash setup-bsc-node.sh"

# =============================================================================
step "1/9 — Disk: merge two NVMe drives into one volume"
# =============================================================================
# Hetzner AX52 ships with 2×960GB NVMe. We stripe them together
# for ~1.9TB of fast storage under /data.
# Skip this step if /data is already mounted (e.g. re-running script).
if ! mountpoint -q /data; then
  # Find the two NVMe devices (usually nvme0n1 + nvme1n1)
  NVME_DEVS=$(lsblk -dno NAME,TYPE | awk '$2=="disk" && $1~/nvme/{print "/dev/"$1}')
  NVME_COUNT=$(echo "$NVME_DEVS" | wc -l)

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

info "Fetching latest BSC release..."
LATEST_API=$(curl -s https://api.github.com/repos/bnb-chain/bsc/releases/latest)
GETH_URL=$(echo "$LATEST_API" | jq -r '.assets[].browser_download_url | select(test("geth_linux"))')
MAINNET_URL=$(echo "$LATEST_API" | jq -r '.assets[].browser_download_url | select(test("mainnet.zip"))')
BSC_TAG=$(echo "$LATEST_API" | jq -r '.tag_name')

[[ -z "$GETH_URL" ]] && error "Could not find geth_linux download. Check https://github.com/bnb-chain/bsc/releases"

wget -q --show-progress -O geth "$GETH_URL"
chmod +x geth
info "Installed BSC geth $BSC_TAG: $(./geth version 2>&1 | head -1)"

# Config files (genesis.json + config.toml)
wget -q --show-progress -O mainnet.zip "$MAINNET_URL"
unzip -o mainnet.zip && rm mainnet.zip
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
  --http.addr 0.0.0.0 \\
  --http.port $RPC_PORT \\
  --http.vhosts "*" \\
  --http.corsdomain "*" \\
  --http.api eth,net,web3,txpool,debug \\
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

if [[ -n "$RENDER_IPS" ]]; then
  for ip in $RENDER_IPS; do
    ufw allow from "$ip" to any port $RPC_PORT proto tcp comment "RPC - Render"
    info "RPC allowed from $ip"
  done
else
  warn "No RENDER_IPS set — RPC port open to all. Update after deploy!"
  ufw allow $RPC_PORT/tcp comment "BSC RPC (open - update later)"
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
# Download official fetch-snapshot.sh from BNB Chain
wget -q -O "$SNAP_DIR/fetch-snapshot.sh" \
  https://raw.githubusercontent.com/bnb-chain/bsc-snapshots/main/dist/fetch-snapshot.sh
chmod +x "$SNAP_DIR/fetch-snapshot.sh"

# Write the download+start script
cat > /home/$BSC_USER/run-snapshot.sh << SNAP
#!/bin/bash
set -e
echo "════════════════════════════════════════"
echo "  BSC Snapshot Download"
echo "  Snapshot: $SNAPSHOT_NAME (pruned ~1.5TB)"
echo "  Started:  \$(date)"
echo "  Log:      /tmp/snapshot.log"
echo "════════════════════════════════════════"

cd $SNAP_DIR
bash fetch-snapshot.sh -d -e -c -p --auto-delete \\
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

chmod +x /home/$BSC_USER/run-snapshot.sh
chown "$BSC_USER:$BSC_USER" /home/$BSC_USER/run-snapshot.sh

# Launch in detached screen session so it survives disconnection
screen -dmS bsc-snapshot bash /home/$BSC_USER/run-snapshot.sh
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
echo "  RPC endpoint:  http://$SERVER_IP:$RPC_PORT"
echo ""
echo "  Monitor:  bsc-status"
echo ""
echo -e "${YELLOW}  Next steps after node is synced:${NC}"
echo "  1. Set in Render env vars:"
echo "     BNB_RPC_URL=http://$SERVER_IP:$RPC_PORT"
echo "  2. Run backfill from Render Shell:"
echo "     node dist/backfill.js 1 47800000 --skip-logs"
echo "  3. Add your Render outbound IPs to RENDER_IPS in this script"
echo "     and re-run to lock down the firewall"
echo ""

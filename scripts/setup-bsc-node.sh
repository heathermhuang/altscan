#!/usr/bin/env bash
# =============================================================================
# BNB Smart Chain Full Node — Hetzner Setup Script
# =============================================================================
# Tested on: Ubuntu 22.04 LTS (Hetzner AX41-NVMe)
#
# What this does:
#   1. Installs dependencies (aria2, jq, etc.)
#   2. Downloads the latest BSC geth binary
#   3. Fetches mainnet config.toml + genesis.json
#   4. Downloads the latest pruned snapshot via aria2 (parallel, resumable)
#   5. Extracts the snapshot to the data directory
#   6. Sets up a systemd service (auto-start, auto-restart)
#   7. Configures ufw firewall (P2P open, RPC restricted to your IP)
#
# Usage:
#   curl -sO https://raw.githubusercontent.com/heathermhuang/bnbscan/main/scripts/setup-bsc-node.sh
#   chmod +x setup-bsc-node.sh
#   sudo ./setup-bsc-node.sh
#
# After setup, your RPC is at: http://<server-ip>:8545
# Set BNB_RPC_URL=http://<server-ip>:8545 in Render env vars.
# =============================================================================

set -euo pipefail

# --- Config ------------------------------------------------------------------
BSC_VERSION="v1.4.15"          # Check latest: https://github.com/bnb-chain/bsc/releases
BSC_DATA_DIR="/data/bsc"
BSC_LOG_DIR="/var/log/bsc"
BSC_USER="bsc"
RPC_PORT="8545"
P2P_PORT="30311"

# Your Render outbound IPs — restrict RPC access to these only.
# Find them: Render dashboard → your service → "Outbound IPs"
# Leave empty ("") to allow all (less secure, ok for testing)
ALLOWED_RPC_IPS=""  # e.g. "34.1.2.3 34.5.6.7"

# Snapshot URL — check the latest at: https://github.com/bnb-chain/bsc-snapshots
# These rotate frequently. Get the current URL from the repo and paste it below.
SNAPSHOT_URL=""  # e.g. "https://pub-c0627345c16f47ab858c9469133073a.r2.dev/geth-20240101.tar.gz"

# --- Colors ------------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}[+]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
error()   { echo -e "${RED}[x]${NC} $*"; exit 1; }

# --- Checks ------------------------------------------------------------------
[[ $EUID -ne 0 ]] && error "Run as root: sudo ./setup-bsc-node.sh"

if [[ -z "$SNAPSHOT_URL" ]]; then
  warn "SNAPSHOT_URL is not set."
  warn "Get the latest URL from: https://github.com/bnb-chain/bsc-snapshots"
  warn "Then set SNAPSHOT_URL at the top of this script and re-run."
  warn ""
  warn "Example URLs from the repo (may be outdated — always check GitHub):"
  warn "  Pruned (recommended): https://pub-c0627345c16f47ab858c9469133073a.r2.dev/geth-*.tar.gz"
  warn "  Full: larger, slower to download"
  read -rp "Paste the snapshot URL now (or press Enter to skip snapshot download): " SNAPSHOT_URL
fi

# --- 1. System deps ----------------------------------------------------------
info "Installing dependencies..."
apt-get update -qq
apt-get install -y -qq \
  aria2 curl wget jq unzip tar \
  ufw htop screen

# --- 2. Disk setup -----------------------------------------------------------
info "Setting up data directory at $BSC_DATA_DIR..."
# If you have a second NVMe on Hetzner AX41 (/dev/nvme1n1), mount it first:
# mkfs.ext4 /dev/nvme1n1 && mkdir -p /data && mount /dev/nvme1n1 /data
# echo '/dev/nvme1n1 /data ext4 defaults 0 2' >> /etc/fstab
# (Uncomment and run manually if needed before running this script)
mkdir -p "$BSC_DATA_DIR" "$BSC_LOG_DIR"

# --- 3. BSC user -------------------------------------------------------------
info "Creating bsc system user..."
id -u "$BSC_USER" &>/dev/null || useradd -r -s /bin/false -d "$BSC_DATA_DIR" "$BSC_USER"
chown -R "$BSC_USER:$BSC_USER" "$BSC_DATA_DIR" "$BSC_LOG_DIR"

# --- 4. Download BSC binary --------------------------------------------------
info "Downloading BSC geth binary ($BSC_VERSION)..."
ARCH=$(uname -m)
case $ARCH in
  x86_64)  GETH_ARCH="linux-amd64" ;;
  aarch64) GETH_ARCH="linux-arm64" ;;
  *)       error "Unsupported architecture: $ARCH" ;;
esac

GETH_URL="https://github.com/bnb-chain/bsc/releases/download/${BSC_VERSION}/geth_${GETH_ARCH}"
curl -fSL "$GETH_URL" -o /usr/local/bin/geth
chmod +x /usr/local/bin/geth

geth version | head -3
info "geth installed at /usr/local/bin/geth"

# --- 5. Download mainnet config ----------------------------------------------
info "Downloading mainnet config files..."
CONFIG_DIR="$BSC_DATA_DIR/config"
mkdir -p "$CONFIG_DIR"

RELEASE_BASE="https://github.com/bnb-chain/bsc/releases/download/${BSC_VERSION}"
curl -fSL "$RELEASE_BASE/mainnet.zip" -o /tmp/mainnet.zip
unzip -o /tmp/mainnet.zip -d "$CONFIG_DIR"

# mainnet.zip extracts: config.toml, genesis.json
GENESIS="$CONFIG_DIR/genesis.json"
CONFIG_TOML="$CONFIG_DIR/config.toml"

[[ -f "$GENESIS" ]]     || error "genesis.json not found after extraction"
[[ -f "$CONFIG_TOML" ]] || error "config.toml not found after extraction"
info "Config files ready."

# --- 6. Patch config.toml for RPC + performance ------------------------------
info "Patching config.toml..."

# Enable HTTP RPC
sed -i 's/^HTTPHost = .*/HTTPHost = "0.0.0.0"/' "$CONFIG_TOML"
sed -i "s/^HTTPPort = .*/HTTPPort = $RPC_PORT/" "$CONFIG_TOML"
# Allow standard ETH APIs
grep -q 'HTTPModules' "$CONFIG_TOML" || \
  echo 'HTTPModules = ["eth","net","web3","txpool","debug"]' >> "$CONFIG_TOML"

# Pruning mode (saves ~40% disk vs full)
grep -q 'NoPruning' "$CONFIG_TOML" || \
  echo 'NoPruning = false' >> "$CONFIG_TOML"

chown -R "$BSC_USER:$BSC_USER" "$CONFIG_DIR"

# --- 7. Init genesis ---------------------------------------------------------
CHAINDATA_DIR="$BSC_DATA_DIR/node/geth/chaindata"
if [[ ! -d "$CHAINDATA_DIR" ]]; then
  info "Initializing genesis block..."
  sudo -u "$BSC_USER" geth \
    --datadir "$BSC_DATA_DIR/node" \
    init "$GENESIS"
  info "Genesis initialized."
else
  info "Genesis already initialized — skipping."
fi

# --- 8. Download + extract snapshot ------------------------------------------
if [[ -n "$SNAPSHOT_URL" ]]; then
  SNAP_FILE="/data/snapshot.tar.gz"

  if [[ ! -f "$SNAP_FILE" ]]; then
    info "Downloading snapshot (this is ~400GB — will take hours)..."
    info "URL: $SNAPSHOT_URL"
    info "Using aria2 with 16 connections for max speed. Safe to Ctrl+C and resume."
    aria2c \
      --out="$SNAP_FILE" \
      --continue=true \
      --max-connection-per-server=16 \
      --split=16 \
      --min-split-size=100M \
      --file-allocation=falloc \
      --summary-interval=60 \
      "$SNAPSHOT_URL"
  else
    info "Snapshot file already exists — skipping download."
  fi

  info "Extracting snapshot to $BSC_DATA_DIR/node..."
  warn "This may take 30-60 minutes for a 400GB archive."
  # BSC snapshots extract directly into the geth datadir
  tar -xzvf "$SNAP_FILE" -C "$BSC_DATA_DIR/node" --strip-components=1 2>&1 | tail -5
  chown -R "$BSC_USER:$BSC_USER" "$BSC_DATA_DIR/node"

  info "Cleaning up snapshot archive..."
  rm -f "$SNAP_FILE"
  info "Snapshot extracted."
else
  warn "Skipping snapshot download — node will sync from scratch (takes weeks, not recommended)."
fi

# --- 9. Systemd service ------------------------------------------------------
info "Creating systemd service..."
cat > /etc/systemd/system/bsc-node.service <<EOF
[Unit]
Description=BNB Smart Chain Full Node
After=network.target
Wants=network.target

[Service]
User=$BSC_USER
Group=$BSC_USER
Type=simple
Restart=always
RestartSec=10
KillSignal=SIGINT
TimeoutStopSec=120

ExecStart=/usr/local/bin/geth \\
  --config $CONFIG_TOML \\
  --datadir $BSC_DATA_DIR/node \\
  --cache 8192 \\
  --http \\
  --http.addr 0.0.0.0 \\
  --http.port $RPC_PORT \\
  --http.api eth,net,web3,txpool \\
  --http.vhosts "*" \\
  --http.corsdomain "*" \\
  --ws \\
  --ws.addr 0.0.0.0 \\
  --ws.port 8546 \\
  --ws.api eth,net,web3 \\
  --syncmode snap \\
  --gcmode full \\
  --maxpeers 50 \\
  --txlookuplimit 0

StandardOutput=append:$BSC_LOG_DIR/bsc.log
StandardError=append:$BSC_LOG_DIR/bsc-error.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable bsc-node
info "Systemd service created: bsc-node"

# --- 10. Firewall ------------------------------------------------------------
info "Configuring firewall..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing

# SSH (don't lock yourself out!)
ufw allow 22/tcp

# P2P — open to all (required for peer discovery)
ufw allow "$P2P_PORT/tcp"
ufw allow "$P2P_PORT/udp"

# RPC — restrict to Render IPs (or all if not set)
if [[ -n "$ALLOWED_RPC_IPS" ]]; then
  for IP in $ALLOWED_RPC_IPS; do
    ufw allow from "$IP" to any port "$RPC_PORT" proto tcp
    info "RPC allowed from $IP"
  done
else
  warn "No ALLOWED_RPC_IPS set — RPC port $RPC_PORT open to all. Set it after deploy!"
  ufw allow "$RPC_PORT/tcp"
fi

ufw --force enable
ufw status verbose

# --- 11. Start node ----------------------------------------------------------
info "Starting BSC node..."
systemctl start bsc-node

sleep 3
if systemctl is-active --quiet bsc-node; then
  info "BSC node is running!"
else
  warn "Node didn't start. Check logs: journalctl -u bsc-node -f"
fi

# --- Done --------------------------------------------------------------------
SERVER_IP=$(curl -s ifconfig.me || hostname -I | awk '{print $1}')

echo ""
echo -e "${GREEN}======================================================${NC}"
echo -e "${GREEN}  BSC Node Setup Complete!${NC}"
echo -e "${GREEN}======================================================${NC}"
echo ""
echo "  RPC endpoint:  http://$SERVER_IP:$RPC_PORT"
echo "  WS endpoint:   ws://$SERVER_IP:8546"
echo ""
echo "  Monitor logs:  journalctl -u bsc-node -f"
echo "  Check sync:    curl -s -X POST http://localhost:$RPC_PORT \\"
echo "                   -H 'Content-Type: application/json' \\"
echo "                   -d '{\"jsonrpc\":\"2.0\",\"method\":\"eth_syncing\",\"params\":[],\"id\":1}'"
echo ""
echo "  Next steps:"
echo "  1. Set in Render env vars:"
echo "     BNB_RPC_URL=http://$SERVER_IP:$RPC_PORT"
echo "  2. Once synced, run backfill from Render Shell:"
echo "     node dist/backfill.js 1 \$(curl -s http://localhost:$RPC_PORT ...)"
echo "  3. Restrict RPC firewall to Render outbound IPs only (see ALLOWED_RPC_IPS)"
echo ""
echo -e "${GREEN}======================================================${NC}"

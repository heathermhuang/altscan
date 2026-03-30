#!/bin/bash
# One-time server setup script for a fresh Hetzner Ubuntu 22.04 server.
# Run as root: bash server-setup.sh
set -euo pipefail

echo "📦 Installing system dependencies..."
apt-get update -q
apt-get install -y -q nginx certbot python3-certbot-nginx git curl postgresql postgresql-contrib

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y -q nodejs

# pnpm
npm install -g pnpm pm2

echo "🗄️ Setting up PostgreSQL..."
sudo -u postgres psql <<'SQL'
CREATE DATABASE bnbscan;
CREATE DATABASE ethscan;
CREATE USER bnbscan_user WITH PASSWORD 'CHANGE_ME_IN_PRODUCTION';
GRANT ALL PRIVILEGES ON DATABASE bnbscan TO bnbscan_user;
GRANT ALL PRIVILEGES ON DATABASE ethscan TO bnbscan_user;
SQL

echo "📁 Setting up application directory..."
mkdir -p /opt/bnbscan
mkdir -p /var/log/bnbscan
git clone https://github.com/YOUR_ORG/bnbscan.git /opt/bnbscan
cd /opt/bnbscan
pnpm install

echo "🌐 Setting up Nginx..."
cp /opt/bnbscan/infra/nginx.conf /etc/nginx/sites-available/explorers
ln -sf /etc/nginx/sites-available/explorers /etc/nginx/sites-enabled/explorers
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "🔒 Getting SSL certificates..."
echo "Run: certbot --nginx -d bnbscan.com -d www.bnbscan.com -d ethscan.io -d www.ethscan.io"
echo ""
echo "📋 Next steps:"
echo "  1. Create .env.production files in apps/web and apps/ethscan"
echo "  2. Run: pnpm build"
echo "  3. Run: pm2 start infra/ecosystem.config.js"
echo "  4. Run: pm2 save && pm2 startup"
echo "  5. Run certbot for SSL"

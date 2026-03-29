#!/usr/bin/env bash
##
## NepTrade Pro — One-command VPS Deploy Script
## Tested on Ubuntu 22.04 / 24.04
## Usage: bash deploy.sh [domain.com]
##

set -e
DOMAIN=${1:-""}
APP_DIR="/opt/neptrade"
APP_USER="neptrade"
NODE_VERSION="20"

echo ""
echo "╔══════════════════════════════════╗"
echo "║  NepTrade Pro — Deploy Script    ║"
echo "╚══════════════════════════════════╝"
echo ""

# ── 1. System dependencies ───────────────────────────────────────────────────
echo "→ Installing system packages..."
apt-get update -qq
apt-get install -y -q curl git nginx ufw

# ── 2. Node.js ───────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "→ Installing Node.js $NODE_VERSION..."
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y nodejs
fi
echo "   Node: $(node -v) | npm: $(npm -v)"

# ── 3. App user ──────────────────────────────────────────────────────────────
if ! id "$APP_USER" &>/dev/null; then
  useradd -r -m -s /bin/bash "$APP_USER"
  echo "→ Created user: $APP_USER"
fi

# ── 4. App files ─────────────────────────────────────────────────────────────
echo "→ Copying app to $APP_DIR..."
mkdir -p "$APP_DIR"
cp -r . "$APP_DIR/"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

cd "$APP_DIR"
sudo -u "$APP_USER" npm install --production --quiet

# ── 5. Environment ──────────────────────────────────────────────────────────
cat > "$APP_DIR/.env" << EOF
NODE_ENV=production
PORT=3000
EOF
chown "$APP_USER:$APP_USER" "$APP_DIR/.env"

# ── 6. Systemd service ───────────────────────────────────────────────────────
echo "→ Creating systemd service..."
cat > /etc/systemd/system/neptrade.service << EOF
[Unit]
Description=NepTrade Pro — NEPSE Intelligence Platform
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=neptrade
Environment=NODE_ENV=production PORT=3000

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable neptrade
systemctl restart neptrade
echo "   Service status: $(systemctl is-active neptrade)"

# ── 7. Nginx ─────────────────────────────────────────────────────────────────
echo "→ Configuring Nginx..."
if [ -n "$DOMAIN" ]; then
  SERVERNAME="$DOMAIN www.$DOMAIN"
else
  SERVERNAME="_"
fi

cat > /etc/nginx/sites-available/neptrade << NGINX
server {
    listen 80;
    server_name $SERVERNAME;
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;
    }
    gzip on;
    gzip_types text/plain text/css application/json application/javascript;
}
NGINX

ln -sf /etc/nginx/sites-available/neptrade /etc/nginx/sites-enabled/neptrade
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# ── 8. Firewall ──────────────────────────────────────────────────────────────
ufw allow 22/tcp  >/dev/null 2>&1 || true
ufw allow 80/tcp  >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

# ── 9. Optional SSL ──────────────────────────────────────────────────────────
if [ -n "$DOMAIN" ] && command -v certbot &>/dev/null; then
  echo "→ Getting SSL certificate for $DOMAIN..."
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN" || true
elif [ -n "$DOMAIN" ]; then
  echo ""
  echo "→ To add SSL (free):"
  echo "   apt-get install -y certbot python3-certbot-nginx"
  echo "   certbot --nginx -d $DOMAIN"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || echo "your-server-ip")
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  ✓ NepTrade Pro deployed successfully!       ║"
echo "║                                              ║"
echo "║  URL: http://$PUBLIC_IP"
if [ -n "$DOMAIN" ]; then
echo "║  Domain: http://$DOMAIN"
fi
echo "║                                              ║"
echo "║  Logs:    journalctl -u neptrade -f          ║"
echo "║  Restart: systemctl restart neptrade         ║"
echo "║  Status:  systemctl status neptrade          ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

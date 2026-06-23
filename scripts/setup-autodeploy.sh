#!/bin/bash
# ERA Comms — one-time auto-deploy setup
# Run once on the server. After this, git push = auto-deploy within 5 minutes.
# Usage: bash <(curl -fsSL https://raw.githubusercontent.com/erasystems811/era-comms/main/scripts/setup-autodeploy.sh)

set -e
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info() { echo -e "${GREEN}[ERA]${NC} $1"; }

info "Pulling latest ERA Comms from GitHub..."
cd /opt/era-comms
git pull origin main

info "Adding deploy SSH key to authorized_keys..."
mkdir -p ~/.ssh
chmod 700 ~/.ssh
DEPLOY_KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINggFuuz3oDWnd8EHFxmrfRYZmvl663bOTZaVABEI3IW era-comms-deploy"
if ! grep -qF "$DEPLOY_KEY" ~/.ssh/authorized_keys 2>/dev/null; then
    echo "$DEPLOY_KEY" >> ~/.ssh/authorized_keys
    chmod 600 ~/.ssh/authorized_keys
    info "Deploy key added"
else
    info "Deploy key already present"
fi

info "Applying nginx config (WebSocket fix)..."
cp /opt/era-comms/scripts/nginx.conf /etc/nginx/sites-available/era-comms
nginx -t && systemctl reload nginx
info "Nginx updated with WebSocket support"

info "Fixing ERA Hub permissions..."
chmod -R 755 /var/www/era-hub/ 2>/dev/null || true

info "Setting up auto-deploy cron (every 5 minutes)..."
CRON_CMD="*/5 * * * * bash /opt/era-comms/scripts/deploy.sh >> /var/log/era-deploy.log 2>&1"
(crontab -l 2>/dev/null | grep -v "era-comms/scripts/deploy"; echo "$CRON_CMD") | crontab -

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Auto-deploy is live!                                ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
info "Nginx WebSocket fix applied — QR codes will now work"
info "Every 5 minutes, the server checks GitHub for updates"
info "ERA Hub will auto-deploy when you push to era-hub on GitHub"
echo ""

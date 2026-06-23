#!/bin/bash
# ERA Comms — one-command VPS installer
# Run as root on a fresh Ubuntu 22.04/24.04 VPS:
#   curl -fsSL https://raw.githubusercontent.com/erasystems811/era-comms/main/scripts/install.sh -o install.sh && bash install.sh

set -e
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}[ERA]${NC} $1"; }
warn()    { echo -e "${YELLOW}[ERA]${NC} $1"; }
required(){ echo -e "${RED}[ERA]${NC} $1"; exit 1; }

# ── 1. COLLECT CONFIG ─────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║          ERA Comms — VPS Setup                       ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "Answer a few questions — the rest is automatic."
echo ""

read -rp "Your domain (e.g. erasystems.com.ng): " DOMAIN
[ -z "$DOMAIN" ] && required "Domain is required"

read -rp "OpenAI API key (sk-...): " OPENAI_KEY
[ -z "$OPENAI_KEY" ] && required "OpenAI key is required"

read -rp "Anthropic API key (sk-ant-...): " ANTHROPIC_KEY
[ -z "$ANTHROPIC_KEY" ] && required "Anthropic key is required"

read -rp "Your WhatsApp number for alerts (e.g. +2348012345678): " WA_NUMBER
[ -z "$WA_NUMBER" ] && required "WhatsApp number is required"

echo ""
echo "Email setup — use your Gmail address to send system emails."
echo "(For Gmail you need an App Password — go to myaccount.google.com > Security > App passwords)"
echo ""
read -rp "Your Gmail address (e.g. you@gmail.com): " SMTP_USER
read -rp "Gmail App Password (16 characters, no spaces): " SMTP_PASS
EMAIL_FROM=${SMTP_USER}

echo ""
info "Got it. Setting everything up now — this takes about 5 minutes..."
echo ""

# ── 2. INSTALL DOCKER ─────────────────────────────────────────
info "Installing Docker..."
apt-get update -qq
apt-get install -y -qq curl git nginx certbot python3-certbot-nginx 2>/dev/null
curl -fsSL https://get.docker.com | sh -s -- -q
usermod -aG docker "$USER" 2>/dev/null || true

# ── 3. CLONE REPO ─────────────────────────────────────────────
info "Cloning ERA Comms..."
cd /opt
[ -d era-comms ] && rm -rf era-comms
git clone -q https://github.com/erasystems811/era-comms.git
cd era-comms

# ── 4. GENERATE SECRETS ───────────────────────────────────────
info "Generating secrets..."
POSTGRES_PASSWORD=$(openssl rand -hex 24)
REDIS_PASSWORD=$(openssl rand -hex 24)
SESSION_KEY=$(openssl rand -hex 32)
OPERATOR_SECRET=$(openssl rand -hex 32)

# Save them so you can recover them later
mkdir -p /etc/era
cat > /etc/era/secrets.env <<SECRETS
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
REDIS_PASSWORD=$REDIS_PASSWORD
SESSION_KEY=$SESSION_KEY
OPERATOR_SECRET=$OPERATOR_SECRET
SECRETS
chmod 600 /etc/era/secrets.env
info "Secrets saved to /etc/era/secrets.env (keep this file safe)"

# ── 5. WRITE .env.production ──────────────────────────────────
info "Writing production config..."
cat > /opt/era-comms/.env.production <<ENV
NODE_ENV=production
PORT=3000
HOST=0.0.0.0

DATABASE_URL=postgresql://era_app:${POSTGRES_PASSWORD}@postgres:5432/era_comms
REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379

OPENAI_API_KEY=${OPENAI_KEY}
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}

SESSION_CREDENTIALS_KEY=${SESSION_KEY}
OPERATOR_SECRET=${OPERATOR_SECRET}
CONNECT_SHARED_SECRET=era-connect-telemetry-v1

ALERT_WHATSAPP_NUMBER=${WA_NUMBER}
OPERATOR_INTERNAL_CLIENT_ID=c0ffee00-0000-4000-a000-000000000001

EMAIL_FROM=${EMAIL_FROM}
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=${SMTP_USER}
SMTP_PASS=${SMTP_PASS}

PORTAL_URL=https://hub.${DOMAIN}

WHATSAPP_PROXY_URL=
ENV
chmod 600 /opt/era-comms/.env.production

# ── 6. WRITE docker-compose secrets file ──────────────────────
cat > /opt/era-comms/docker/.env <<DENV
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
REDIS_PASSWORD=${REDIS_PASSWORD}
DENV
chmod 600 /opt/era-comms/docker/.env

# ── 7. START ERA COMMS ────────────────────────────────────────
info "Starting ERA Comms stack (postgres + redis + api)..."
cd /opt/era-comms/docker
docker compose -f docker-compose.prod.yml up -d --build

# ── 8. NGINX CONFIG ───────────────────────────────────────────
info "Configuring nginx..."
mkdir -p /var/www/era-hub

cat > /etc/nginx/sites-available/era-comms <<NGINX
server {
    listen 80;
    server_name api.${DOMAIN} hub.${DOMAIN};

    # Temporary HTTP config — certbot will upgrade to HTTPS
    location / { return 200 'ERA Comms installing...'; add_header Content-Type text/plain; }
}
NGINX

ln -sf /etc/nginx/sites-available/era-comms /etc/nginx/sites-enabled/era-comms
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# ── 9. OBTAIN SSL CERTIFICATES ────────────────────────────────
info "Obtaining SSL certificates (make sure DNS is pointed to this server first)..."
echo ""
warn "You need TWO DNS A records pointing to this server's IP:"
warn "  api.${DOMAIN}  →  this server's IP"
warn "  hub.${DOMAIN}  →  this server's IP"
echo ""
read -rp "Have you set the DNS records? (yes/no): " DNS_READY

if [ "$DNS_READY" = "yes" ]; then
    certbot --nginx --non-interactive --agree-tos -m "${SMTP_USER}" \
        -d "api.${DOMAIN}" -d "hub.${DOMAIN}" || \
        warn "SSL setup failed — run: certbot --nginx -d api.${DOMAIN} -d hub.${DOMAIN}"

    # Write the real nginx config with SSL + proxy
    cat > /etc/nginx/sites-available/era-comms <<NGINX2
server {
    listen 443 ssl;
    server_name api.${DOMAIN};
    ssl_certificate /etc/letsencrypt/live/api.${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.${DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 300s;
    }
}
server {
    listen 443 ssl;
    server_name hub.${DOMAIN};
    ssl_certificate /etc/letsencrypt/live/api.${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.${DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    root /var/www/era-hub;
    index index.html;
    location / { try_files \$uri \$uri/ /index.html; }
    location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; }
}
server {
    listen 80;
    server_name api.${DOMAIN} hub.${DOMAIN};
    return 301 https://\$host\$request_uri;
}
NGINX2
    nginx -t && systemctl reload nginx
    info "nginx configured with SSL"
else
    warn "Skipping SSL for now. Run this later:"
    warn "  certbot --nginx -d api.${DOMAIN} -d hub.${DOMAIN}"
fi

# ── 10. DONE ──────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ERA Comms is running!                               ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
info "API:         https://api.${DOMAIN}"
info "Admin panel: https://hub.${DOMAIN}  (deploy ERA Hub here next)"
info "Postal mail: https://postal.${DOMAIN}"
echo ""
info "Your OPERATOR_SECRET (copy to ERA Hub env vars):"
echo "  $OPERATOR_SECRET"
echo ""
warn "Next step: deploy ERA Hub to /var/www/era-hub"
warn "Run this on your local machine:"
warn "  cd era-hub && npm run build && scp -r dist/* root@VPS_IP:/var/www/era-hub/"
echo ""
info "All secrets saved at: /etc/era/secrets.env"

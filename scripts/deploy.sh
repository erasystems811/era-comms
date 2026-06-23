#!/bin/bash
# ERA Comms — server-side deploy script
# Run automatically by cron every 5 minutes.
# Also called by GitHub Actions after a push.

set -e

cd /opt/era-comms
git pull --ff-only origin main 2>/dev/null || git fetch origin main && git reset --hard origin/main

# Apply nginx config
cp /opt/era-comms/scripts/nginx.conf /etc/nginx/sites-available/era-comms
nginx -t && systemctl reload nginx

# Fix ERA Hub permissions (scp always resets these)
chmod -R 755 /var/www/era-hub/ 2>/dev/null || true

echo "[ERA] Deploy complete at $(date)"

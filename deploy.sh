#!/usr/bin/env bash
# Ship local changes to GitHub + the Contabo VPS in ONE command.
#
#   ./deploy.sh "what changed"     # commit msg optional
#
# What it does, in order:
#   1. commit any local changes + push to GitHub (history/backup)
#   2. rsync the CODE to the VPS  — NEVER touches the bot's data/ (accumulated
#      edge/paper/live state stays put), node_modules, .venv, vendor, or .env
#   3. rebuild + restart the API on the VPS (Caddy serves the fresh web build)
#
# Safety: .env is excluded, so a local mainnet-enable can't leak to the VPS by
# accident — that stays a deliberate manual edit on the server.
set -euo pipefail

VPS=root@194.233.71.109
REMOTE_DIR=/root/kronos/daily-trading-cockpit-v2
SSH_KEY="$HOME/.ssh/contabo_dtc"
PROJECT=daily-trading-cockpit-v2

cd "$(dirname "$0")"

echo "==> 1/3  commit + push to GitHub"
git add -A
git commit -m "${1:-deploy $(date '+%Y-%m-%d %H:%M')}" || echo "    (nothing new to commit)"
git push origin main

echo "==> 2/3  rsync code -> VPS (data/ untouched)"
rsync -az --delete \
  --exclude '.git' --exclude 'node_modules' --exclude 'data' \
  --exclude '.venv' --exclude 'vendor' --exclude 'dist' --exclude '.env' \
  -e "ssh -i $SSH_KEY" \
  "$PROJECT/" "$VPS:$REMOTE_DIR/"

echo "==> 3/3  build + restart on VPS"
ssh -i "$SSH_KEY" "$VPS" "cd $REMOTE_DIR \
  && mkdir -p apps/api/data data \
  && npm install --no-audit --no-fund \
  && npm run build \
  && pm2 restart dtc-api dtc-web --update-env \
  && pm2 save"

echo ""
echo "✅ Deployed. Dashboard: https://194.233.71.109   (pm2 logs dtc-api to watch)"

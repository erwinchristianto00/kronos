#!/usr/bin/env bash
#
# One-shot deploy for the daily-trading-cockpit bot on a fresh Ubuntu VPS
# (Oracle Cloud Always-Free ARM, GCP e2-micro, or any non-Indonesia box — no WARP
# needed off-Indonesia). Installs Node + Python, builds the stack, sets up Kronos,
# and runs API + Web + Kronos under pm2 (auto-restart + survives reboot).
#
#   cd ~/daily-trading-cockpit-v2
#   bash deploy/setup-vps.sh            # full stack
#   KRONOS_ENABLED=0 bash deploy/setup-vps.sh   # API + Web only (small box)
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KRONOS_ENABLED="${KRONOS_ENABLED:-1}"
log() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }

log "Repo: $ROOT  |  Kronos: $([ "$KRONOS_ENABLED" = 0 ] && echo OFF || echo ON)"

# ── 0. .env must exist (testnet keys) ──────────────────────────────────────
if [ ! -f "$ROOT/.env" ]; then
  echo "!! $ROOT/.env is missing. Copy your local .env here first (scp), then re-run."
  echo "   It holds LIVE_BINANCE_* testnet keys + LIVE_MIRROR_ALL_PAPER=0 etc."
  exit 1
fi

# ── 1. System packages ─────────────────────────────────────────────────────
log "Installing system packages (git, python3-venv, build tools)"
sudo apt-get update -y
sudo apt-get install -y git build-essential python3 python3-venv python3-pip curl ca-certificates

# ── 1b. Swap on tiny boxes (e.g. GCP e2-micro 1GB) so npm/vite build don't OOM ─
mem_mb="$(free -m | awk '/^Mem:/{print $2}')"
if [ "${mem_mb:-9999}" -lt 1700 ] && [ ! -f /swapfile ]; then
  log "Low RAM (${mem_mb}MB) — creating a 2GB swapfile so the build doesn't OOM"
  sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# ── 2. Node 22 LTS (if not already 20+) ────────────────────────────────────
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 20 ] && need_node=0
fi
if [ "$need_node" = 1 ]; then
  log "Installing Node.js 22 LTS"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

# ── 3. Build the JS stack (shared → api → web dist) ────────────────────────
log "npm install"
cd "$ROOT"
npm install
log "Building (@dtc/shared + api + web dashboard)"
npm run build

# ── 4. Kronos (optional) ───────────────────────────────────────────────────
if [ "$KRONOS_ENABLED" != 0 ]; then
  log "Setting up Kronos (Python venv + torch — this is the slow part)"
  cd "$ROOT/services/kronos"
  [ -d vendor/Kronos ] || git clone --depth 1 https://github.com/shiyu-coder/Kronos vendor/Kronos
  [ -d .venv ] || python3 -m venv .venv
  ./.venv/bin/python -m pip install --upgrade pip
  ./.venv/bin/python -m pip install -r requirements.txt
  cd "$ROOT"
else
  log "Skipping Kronos (KRONOS_ENABLED=0)"
fi

# ── 5. pm2 + launch ────────────────────────────────────────────────────────
log "Installing pm2"
sudo npm install -g pm2
chmod +x "$ROOT"/deploy/run-*.sh

log "Starting services under pm2"
KRONOS_ENABLED="$KRONOS_ENABLED" pm2 start "$ROOT/deploy/ecosystem.config.cjs"
pm2 save

log "DONE. Next two manual steps:"
cat <<EOF

  1) Make pm2 start on every reboot — run the command pm2 prints here:
       pm2 startup
     (copy-paste the 'sudo env PATH=... pm2 startup ...' line it shows, then: pm2 save)

  2) Open the dashboard port in BOTH firewalls (see deploy/README.md):
       - Oracle Console → VCN → Security List → add Ingress TCP 5173 (your IP only!)
       - OS:  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 5173 -j ACCEPT
              sudo netfilter-persistent save

  Dashboard:  http://<VM_PUBLIC_IP>:5173     (READ deploy/README.md SECURITY first)
  Status:     pm2 status        Logs: pm2 logs dtc-api        Restart: pm2 restart all
EOF

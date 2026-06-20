#!/usr/bin/env bash
#
# One command to bring the whole bot up after a laptop restart:
#   npm run dev:all
# Starts Kronos (port 8001) + API (3101) + Web (5173), then auto re-arms the live
# engine once the clock skew has settled (handles the WARP-unstable spike right
# after boot that otherwise disarms it). API + Web logs stay in this terminal;
# Ctrl-C stops everything (Kronos too).
#
# macOS/Linux. (The Windows equivalent is scripts/dev-full.ps1.)
# Note: on this laptop you still need Cloudflare WARP connected for Binance market
# data (Indonesia geo-block). On a non-Indonesia VPS that isn't needed.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PORT="${PORT:-3101}"

KRONOS_PID=""
ARMER_PID=""
cleanup() {
  [ -n "$ARMER_PID" ] && kill "$ARMER_PID" 2>/dev/null || true
  [ -n "$KRONOS_PID" ] && kill "$KRONOS_PID" 2>/dev/null || true
  npx kill-port 8001 >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "[dev:all] freeing ports 3101/5173/8001..."
npx kill-port 3101 5173 8001 >/dev/null 2>&1 || true

# ── Kronos (optional — scan degrades gracefully without it) ──────────────────
if [ "${KRONOS_ENABLED:-1}" != "0" ] && [ -x "services/kronos/.venv/bin/python" ]; then
  echo "[dev:all] starting Kronos (port 8001, logs → /tmp/kronos.log)..."
  ( cd services/kronos && exec ./.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8001 ) >/tmp/kronos.log 2>&1 &
  KRONOS_PID=$!
else
  echo "[dev:all] Kronos skipped (no venv or KRONOS_ENABLED=0)."
fi

# ── arm-watcher: wait for API, let skew settle, then re-arm ───────────────────
(
  until curl -s --max-time 3 "http://localhost:$PORT/api/health" 2>/dev/null | grep -q '"ok":true'; do sleep 2; done
  for _ in $(seq 1 12); do
    st=$(curl -s --max-time 5 "http://localhost:$PORT/api/live/status" 2>/dev/null)
    armed=$(printf '%s' "$st" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('armed'))
except Exception: print('?')" 2>/dev/null)
    skew=$(printf '%s' "$st" | python3 -c "import json,sys
try: print(round(json.load(sys.stdin).get('health',{}).get('clockSkewMs',0) or 0))
except Exception: print(9999)" 2>/dev/null)
    if [ "$armed" = "True" ]; then echo "[dev:all] ✅ engine armed (skew ${skew}ms)."; break; fi
    if [ "${skew:-9999}" -lt 1500 ]; then
      curl -s -X POST "http://localhost:$PORT/api/live/arm" -H 'Content-Type: application/json' -d '{"confirm":"ARM"}' >/dev/null 2>&1
      echo "[dev:all] re-arm sent (skew ${skew}ms) — verifying next pass..."
    else
      echo "[dev:all] skew ${skew}ms high (WARP settling?) — waiting before arming..."
    fi
    sleep 15
  done
) &
ARMER_PID=$!

# ── API + Web in the foreground (logs here; Ctrl-C stops all) ─────────────────
echo "[dev:all] starting API + Web..."
npx concurrently -n api,web -c blue,green "npm run dev -w @dtc/api" "npm run dev -w @dtc/web"

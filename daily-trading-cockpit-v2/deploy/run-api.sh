#!/usr/bin/env bash
# pm2 launches this via `interpreter: bash`. Runs the trading API (port 3101).
set -euo pipefail
cd "$(dirname "$0")/../apps/api"
exec npx tsx src/server.ts

#!/usr/bin/env bash
# Serves the BUILT dashboard (apps/web/dist) on port 5173 and proxies /api to the
# API (via vite.config preview.proxy). Run `npm run build` first (setup does it).
set -euo pipefail
cd "$(dirname "$0")/../apps/web"
exec npx vite preview --host 0.0.0.0 --port 5173 --strictPort

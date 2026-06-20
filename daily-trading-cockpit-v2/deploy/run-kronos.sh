#!/usr/bin/env bash
# Kronos ML prediction service (port 8001, localhost only). Optional — the scan
# degrades gracefully without it. Requires services/kronos/.venv (setup builds it).
set -euo pipefail
cd "$(dirname "$0")/../services/kronos"
exec ./.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8001

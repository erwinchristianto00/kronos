#!/usr/bin/env bash
# Kronos ML prediction service (port 8001, localhost only). Optional — the scan
# degrades gracefully without it. Requires services/kronos/.venv (setup builds it).
set -euo pipefail
cd "$(dirname "$0")/../services/kronos"

# Keep the sidecar usable on small VPS CPU boxes. These can still be overridden
# from PM2/env, but the defaults should not make every scan forecast time out.
export KRONOS_SAMPLE_RUNS="${KRONOS_SAMPLE_RUNS:-1}"
export KRONOS_PRED_LEN="${KRONOS_PRED_LEN:-4}"
export TOKENIZERS_PARALLELISM="${TOKENIZERS_PARALLELISM:-false}"

exec ./.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8001

#!/usr/bin/env bash
# Starts exactly one canonical collector and one canonical lifecycle authority under PM2.
# Run from the dedicated /root/kronos-continuation/release checkout, never from both API lanes.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
collector="${CONTINUATION_COLLECTOR_PM2_NAME:-kronos-continuation-collector}"
lifecycle="${CONTINUATION_LIFECYCLE_PM2_NAME:-kronos-continuation-lifecycle}"

[ -x "$here/run-continuation-collector.sh" ] || { echo "missing collector launcher" >&2; exit 2; }
[ -x "$here/run-continuation-lifecycle.sh" ] || { echo "missing lifecycle launcher" >&2; exit 2; }

pm2 start "$here/run-continuation-collector.sh" --name "$collector" --interpreter bash --cwd "$here" --update-env
pm2 start "$here/run-continuation-lifecycle.sh" --name "$lifecycle" --interpreter bash --cwd "$here" --update-env
pm2 save
pm2 status "$collector" "$lifecycle"

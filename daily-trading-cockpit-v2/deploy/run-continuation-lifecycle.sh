#!/usr/bin/env bash
# Low-priority trainer/evaluator/pointer authority. It never starts an order process.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
envfile="$here/../.env"
if [ -f "$envfile" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$envfile"
  set +a
fi
cd "$here/../apps/api"
root="${CONTINUATION_LIFECYCLE_ROOT:-/root/kronos-continuation}"
# Python's isolated LightGBM dependencies live outside any release. LightGBM itself is capped to
# two threads in the trainer; nice/ionice ensure execution always wins on the shared VPS.
exec nice -n 19 ionice -c 3 env \
  NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=384}" \
  PYTHONPATH="${CONTINUATION_PYTHONPATH:-${PYTHONPATH:-/root/pylibs}}" \
  ./node_modules/.bin/tsx scripts/continuation-lifecycle.ts "--root=$root"

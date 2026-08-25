#!/usr/bin/env bash
# Independent public-market collector. It owns no trading state or exchange credentials.
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
# Collector stays below execution priority, while its network I/O must still be able to reconnect.
exec nice -n 10 ionice -c 2 -n 7 env NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=256}" \
  "$here/../node_modules/.bin/tsx" scripts/continuation-collector.ts "--root=$root"

#!/usr/bin/env bash
# pm2 launches this via `interpreter: bash`. Runs the trading API.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

# Enforce the cutover-critical env policy at the ONE moment it matters: process start, which is
# also the only moment these values are read. A release dir gets a REAL .env, not a symlink, so a
# cutover that forgets to carry them forward reverts them to code defaults — silently, which is how
# the 36h hold policy was lost on 2026-08-05.
#
# Fail CLOSED, because the operator is present during a cutover and the fix is one command, whereas
# a silently wrong config trades real money for days. Escape hatch: REQUIRED_ENV_CHECK=warn starts
# anyway (use it if this ever blocks a recovery), REQUIRED_ENV_CHECK=off skips entirely.
#
# Scoped by path to the two policy-governed release roots, so other instances (3101 research, ad-hoc
# trees) are unaffected and cannot be blocked by a policy that was never written for them. The path
# also names the instance, so an explicitly documented non-strategy instance override can be
# checked without weakening the shared strategy contract.
instance=""
case "$here" in
  /root/kronos-live-releases/*)    instance=3103 ;;
  /root/kronos-testnet-releases/*) instance=3102 ;;
esac
if [ -n "$instance" ]; then
    envfile="$here/../.env"
    checker="$here/apply-required-env.sh"
    mode="${REQUIRED_ENV_CHECK:-enforce}"
    if [ "$mode" != "off" ] && [ -x "$checker" ] && [ -f "$envfile" ]; then
      if ! "$checker" --check "$envfile" "$instance"; then
        echo ""
        echo "!!  REQUIRED ENV DRIFT — this release is NOT running the measured configuration."
        echo "!!  Fix:   $checker --apply $envfile $instance   (then restart)"
        echo "!!  Start anyway, knowingly:   REQUIRED_ENV_CHECK=warn pm2 restart <process>"
        echo ""
        [ "$mode" = "warn" ] || exit 78   # EX_CONFIG
        echo "!!  REQUIRED_ENV_CHECK=warn — starting despite the drift above."
      fi
    fi
fi

cd "$here/../apps/api"
exec npx tsx src/server.ts

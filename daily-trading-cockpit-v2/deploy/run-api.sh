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

# Testnet positions are owned by the approved durable lane ledger, not by a
# release archive.  Keep this stricter-than-generic fence from the incumbent
# release: a merely valid but different symlink can still make every real
# Testnet position look foreign to the new process.
if [ "$instance" = "3102" ]; then
    state_dir="$here/../apps/api/data"
    canonical_testnet_state="${KRONOS_TESTNET_STATE_DIR:-/root/kronos-testnet-releases/128b09f/daily-trading-cockpit-v2/apps/api/data}"
    state_target="$(readlink -f "$state_dir" 2>/dev/null || true)"
    if [ ! -L "$state_dir" ] || [ "$state_target" != "$canonical_testnet_state" ] \
       || [ ! -s "$state_target/cross-sectional-executor.json" ] \
       || [ ! -s "$state_target/live-execution.json" ]; then
      echo "!! TESTNET STATE GUARD — refusing to start without the approved shared position ledger."
      echo "!! Expected: $canonical_testnet_state"
      echo "!! Actual:   ${state_target:-not-a-symlink}"
      exit 79
    fi
fi
if [ -n "$instance" ]; then
    # Runtime state must be shared deliberately with the durable lane store. A source archive
    # contains historical data fixtures, so merely creating a link *inside* apps/api/data leaves
    # a new process blind to existing baskets. Refuse to start a governed release unless the
    # directory itself is a symlink to an existing state directory.
    state_dir="$here/../apps/api/data"
    if [ ! -L "$state_dir" ] || [ ! -d "$state_dir" ]; then
      echo ""
      echo "!!  RELEASE STATE WIRING INVALID — $state_dir must be a symlink to the durable state store."
      echo "!!  Refusing to start: an unshared data directory can lose management of open baskets."
      echo ""
      exit 78 # EX_CONFIG
    fi
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

# Staged releases use this non-mutating path before PM2 replaces a healthy
# process.  It validates the exact same state/env guards as a real start.
if [ "${RUN_API_PRECHECK_ONLY:-0}" = "1" ]; then
  echo "OK: API prestart checks passed for instance ${instance:-unscoped}."
  exit 0
fi

cd "$here/../apps/api"
exec npx tsx src/server.ts

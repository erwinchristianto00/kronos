#!/usr/bin/env bash
# Guarded governed API release cutover. It creates no orders and preserves the
# existing engine arm state; a short, persisted new-entry drain prevents a
# naturally scheduled basket from racing the account-fingerprint check.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <old-release-root> <new-release-root>" >&2
  exit 64
fi

old_root="$1"
new_root="$2"
target="${CUTOVER_TARGET:-live}"
name="${CUTOVER_PM2_NAME:-dtc-api-live}"
port="${CUTOVER_PORT:-3103}"
case "${target}:${name}:${port}" in
  live:dtc-api-live:3103|testnet:dtc-api-testnet:3102) ;;
  *)
    echo "unsupported governed target: target=${target} process=${name} port=${port}" >&2
    exit 64
    ;;
esac

# A Testnet process starts with an empty dashboard-account cache.  Its first
# private snapshot may legitimately inherit Binance's two-minute IP cooldown,
# even though the pre-cutover snapshot was fresh.  Keep the entry drain in
# place and wait for that concrete cooldown rather than rolling back after the
# old fixed 75-second retry window.  This never treats a stale account as
# verified; it only gives the fresh-snapshot gate enough bounded time.
case "${target}" in
  # Binance Testnet can return a concrete -1003 ban window close to eight
  # minutes.  Twelve minutes leaves a small post-cooldown window for the
  # three-read account snapshot while remaining bounded and fail-closed.
  testnet) default_fresh_snapshot_timeout_seconds=720 ;;
  live) default_fresh_snapshot_timeout_seconds=120 ;;
esac
fresh_snapshot_timeout_seconds="${CUTOVER_FRESH_SNAPSHOT_TIMEOUT_SECONDS:-${default_fresh_snapshot_timeout_seconds}}"
if ! [[ "${fresh_snapshot_timeout_seconds}" =~ ^[1-9][0-9]*$ ]]; then
  echo "CUTOVER_FRESH_SNAPSHOT_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 64
fi
pm2_bin="/usr/bin/pm2"
curl_bin="/usr/bin/curl"
node_bin="/usr/bin/node"
# The standalone guarded API path is also used for LIVE-only repairs. Share the
# same non-blocking release lock as the governed bundle path so two rooms
# cannot both pass their preflight and race the PM2 replacement.
mkdir -p /root/kronos-release-bundles
exec 9>/root/kronos-release-bundles/.cutover.lock
if ! flock -n 9; then
  echo "another Kronos release cutover is already in progress; refusing overlap" >&2
  exit 75
fi
# Keep cutover evidence outside the candidate.  A governed artifact stays
# immutable even when an attempted cutover logs a rejected fingerprint.
release_id="$(basename "$(dirname "${new_root}")")"
log_dir="/root/kronos-release-logs/${release_id}/guarded-${target}-api-cutover"
mkdir -p "$log_dir"
exec >>"${log_dir}/cutover.log" 2>&1

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# Read the fingerprint directly from Binance in a fresh short-lived process
# rather than from the running process's own /api/live/account.
#
# 2026-09-04: that endpoint is served BY the process being replaced. When its
# transport queue jammed, the endpoint stopped answering altogether (HTTP 000
# at 300s) — so this guard became unsatisfiable exactly when a cutover was most
# needed, and the release that fixes the jam could not be deployed. A direct
# read is also simply better evidence: the endpoint is allowed to serve a
# last-good cache, and a cutover needs exchange truth. deploy/
# verify-testnet-account-fingerprint.ts already made this argument for Testnet.
snapshot() {
  local file="$1"
  (cd "$new_root" && "$new_root/node_modules/.bin/tsx" deploy/verify-live-account-fingerprint.ts) >"$file"
}

assert_fresh() {
  local file="$1"
  "$node_bin" - "$file" <<'NODE'
const fs = require("fs");
const payload = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
// The direct reader either produced both exchange facts or exited non-zero.
// There is no cache to be stale, and no Daily Range order-coverage merge to
// wait for, so those two checks no longer apply here.
if (payload.ok !== true || payload.source !== "USD_M_DIRECT_READ") {
  throw new Error("direct exchange fingerprint is not fresh");
}
NODE
}

fingerprint() {
  local file="$1"
  "$node_bin" - "$file" <<'NODE'
const fs = require("fs");
const payload = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const positions = (payload.positions ?? [])
  .filter((position) => Number(position.quantity) !== 0)
  .map((position) => ({
    symbol: String(position.symbol),
    direction: String(position.direction),
    quantity: Number(position.quantity),
  }))
  .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.direction.localeCompare(b.direction));
process.stdout.write(JSON.stringify({
  openPositionCount: Number(payload.openPositionCount),
  openOrderCount: Number(payload.openOrderCount),
  positions,
  regularOrders: payload.regularOrders ?? [],
  conditionalOrders: payload.conditionalOrders ?? [],
}));
NODE
}

set_entry_drain() {
  local enabled="$1"
  local body
  body="{\"enabled\":${enabled},\"confirm\":\"DRAIN\",\"reason\":\"guarded live release cutover\"}"
  "$curl_bin" --fail --silent --show-error --max-time 15 \
    -H 'content-type: application/json' \
    -X POST --data "$body" \
    "http://127.0.0.1:${port}/api/live/new-entry-drain"
}

wait_for_health() {
  for _ in $(seq 1 45); do
    if "$curl_bin" --fail --silent --max-time 2 "http://127.0.0.1:${port}/api/health" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_fresh_snapshot() {
  local file="$1"
  local attempt=0
  local deadline_epoch=$(( $(date +%s) + fresh_snapshot_timeout_seconds ))
  local remaining_seconds
  while [ "$(date +%s)" -lt "${deadline_epoch}" ]; do
    attempt=$((attempt + 1))
    if snapshot "$file" && assert_fresh "$file"; then
      return 0
    fi
    remaining_seconds=$(( deadline_epoch - $(date +%s) ))
    log "fresh account snapshot attempt ${attempt} did not pass; retrying while ${remaining_seconds}s remain"
    sleep "$(( remaining_seconds < 15 ? remaining_seconds : 15 ))"
  done
  return 1
}

assert_account_endpoint_answers() {
  local file="${log_dir}/account-endpoint-after.json"
  local attempt=0
  while [ "$attempt" -lt 6 ]; do
    attempt=$((attempt + 1))
    if "$curl_bin" --fail --silent --show-error --max-time 75 \
      "http://127.0.0.1:${port}/api/live/account" >"$file"; then
      log "/api/live/account answered after the cutover (attempt ${attempt})"
      return 0
    fi
    log "/api/live/account has not answered yet (attempt ${attempt}/6)"
    sleep 10
  done
  log "/api/live/account never answered after the cutover — the read path is still stalled"
  return 1
}

restore_old_release() {
  log "verification failed; restoring ${old_root}"
  "$pm2_bin" delete "$name" || true
  "$pm2_bin" start "${old_root}/deploy/run-api.sh" --name "$name" --interpreter bash
  wait_for_health || true
}

restore_entry_state() {
  if [ "${entry_drain_was_active}" = "false" ]; then
    set_entry_drain false >/dev/null || log "WARNING: failed to restore new-entry drain; operator action required"
  fi
}

# A long Testnet fresh-snapshot wait can overlap a deployment from another
# release room.  Never delete the named PM2 process unless it still points to
# the release whose account fingerprint we just checked.  This makes an old
# cutover fail closed instead of replacing a newer room's release.
active_release_script() {
  "$pm2_bin" jlist | "$node_bin" -e '
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const name = process.argv[1];
  const entry = JSON.parse(raw).find((candidate) => candidate?.name === name);
  if (!entry?.pm2_env?.pm_exec_path) process.exit(2);
  process.stdout.write(String(entry.pm2_env.pm_exec_path));
});
' "$name"
}

assert_expected_active_release() {
  local expected_script="${old_root}/deploy/run-api.sh"
  local observed_script
  if ! observed_script="$(active_release_script)"; then
    log "cannot resolve active ${name} script; refusing cutover"
    return 1
  fi
  if [ "$observed_script" != "$expected_script" ]; then
    log "active ${name} changed by another release room; expected=${expected_script} observed=${observed_script}; refusing cutover"
    return 1
  fi
}

stamp_candidate_release() {
  # Stamp after all preflight/fingerprint gates but before PM2 replacement.
  # This is an activation boundary, not a source-tree/build timestamp.
  KRONOS_RELEASE_ACTIVATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$new_root/deploy/stamp-release-provenance.sh" "$new_root"
}

# A healthy FADE R-trail is causally tied to one continuous contract-price
# stream. A planned API replacement would create a blind interval between the
# two processes, so refuse that deployment rather than quietly degrading the
# live trail. The explicit escape hatch is for an operator who has consciously
# chosen the native-bracket-only fallback and is recorded in the cutover log.
assert_no_healthy_daily_rtrail() {
  local file="${log_dir}/daily-range-status-before.json"
  "$curl_bin" --fail --silent --show-error --max-time 20 \
    "http://127.0.0.1:${port}/api/live/daily-range-lane/status" >"$file"
  CUTOVER_ALLOW_RTRAIL_PATH_GAP="${CUTOVER_ALLOW_RTRAIL_PATH_GAP:-0}" "$node_bin" - "$file" <<'NODE'
const fs = require("fs");
const payload = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const affected = (payload.openTrades ?? []).filter((trade) => (
  trade?.status === "OPEN"
  && trade?.fadeRTrail?.mfePolicyId === "daily-fade-r30-floor25-v2"
  && trade?.fadeRTrail?.health === "HEALTHY"
));
if (affected.length > 0 && process.env.CUTOVER_ALLOW_RTRAIL_PATH_GAP !== "1") {
  const ids = affected.map((trade) => `${trade.tradeId}:${trade.symbol}`).join(", ");
  throw new Error(`refusing planned restart: healthy Daily Range R-trail needs continuous contract-price path (${ids}); set CUTOVER_ALLOW_RTRAIL_PATH_GAP=1 only to accept native-bracket fallback`);
}
if (affected.length > 0) {
  process.stdout.write(`override accepted for healthy Daily Range R-trail: ${affected.map((trade) => trade.tradeId).join(", ")}\n`);
}
NODE
}

entry_drain_was_active="unknown"
engine_was_armed="unknown"
restore_original_arm_state() {
  if [ "$engine_was_armed" != "false" ]; then return 0; fi
  "$curl_bin" --fail --silent --show-error --max-time 15 -X POST \
    "http://127.0.0.1:${port}/api/live/disarm" | "$node_bin" -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.ok!==true||x.armed!==false)process.exit(1);});'
}
cleanup() {
  local code="$?"
  trap - EXIT
  # Startup auto-arm is env driven, whereas manual disarm is process-local.
  # Restore the prior operator state BEFORE releasing the persisted entry drain.
  if ! restore_original_arm_state; then
    log "ERROR: could not restore original DISARMED state; entry drain remains enabled"
    exit 1
  fi
  if [ "$entry_drain_was_active" = "false" ]; then restore_entry_state; fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log "guarded ${target} cutover started"

before_status="${log_dir}/status-before.json"
"$curl_bin" --fail --silent --show-error --max-time 15 \
  "http://127.0.0.1:${port}/api/live/status" >"$before_status"
engine_was_armed="$($node_bin -e 'const s=require(process.argv[1]);if(typeof s.armed!=="boolean")process.exit(1);process.stdout.write(String(s.armed));' "$before_status")"
entry_drain_was_active="$($node_bin - "$before_status" <<'NODE'
const fs = require("fs");
const status = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(String(status?.newEntries?.drainActive === true));
NODE
)"
if [ "$entry_drain_was_active" = "unknown" ]; then
  log "cannot determine pre-cutover new-entry drain state"
  exit 1
fi

before="${log_dir}/account-before.json"
# The dashboard account reader intentionally returns its last-good snapshot as
# stale while it refreshes it in the background. A single pre-cutover read
# would therefore reject a healthy account whenever its short cache had just
# expired. Use the same bounded, fail-closed waiter used after the restart so
# the fingerprint is always based on a genuinely fresh exchange snapshot.
# Do this before taking the temporary entry drain: a Binance cooldown must not
# freeze the execution lane merely because a release is waiting to verify.
if ! wait_for_fresh_snapshot "$before"; then
  log "pre-cutover account snapshot did not become fresh"
  exit 1
fi

if ! assert_no_healthy_daily_rtrail; then
  log "Daily Range R-trail continuity guard rejected cutover"
  exit 1
fi

# Preserve a pre-existing operator drain.  Otherwise this short gate makes
# the final fingerprint meaningful even if a scheduler wakes during cutover.
if [ "$entry_drain_was_active" = "false" ]; then
  set_entry_drain true >"${log_dir}/entry-drain-enabled.json"
fi

# Re-read once after the gate. It normally reuses the fresh cache above; if it
# does not, the drain is active only for the bounded final verification window.
before_after_drain="${log_dir}/account-before-after-drain.json"
if ! wait_for_fresh_snapshot "$before_after_drain"; then
  log "post-drain account snapshot did not become fresh"
  exit 1
fi
before_fp="$(fingerprint "$before_after_drain")"
log "pre-cutover fingerprint ${before_fp}"

if ! (cd "${new_root}/deploy" && RUN_API_PRECHECK_ONLY=1 ./run-api.sh); then
  log "candidate precheck failed"
  exit 1
fi

if ! assert_expected_active_release; then
  exit 1
fi

if ! stamp_candidate_release; then
  log "candidate release-provenance stamp failed"
  exit 1
fi

log "cutting ${name} to ${new_root}"
"$pm2_bin" delete "$name"
"$pm2_bin" start "${new_root}/deploy/run-api.sh" --name "$name" --interpreter bash

if ! wait_for_health; then
  restore_old_release
  exit 1
fi

after="${log_dir}/account-after.json"
if ! wait_for_fresh_snapshot "$after"; then
  restore_old_release
  exit 1
fi
after_fp="$(fingerprint "$after")"
if [ "$before_fp" != "$after_fp" ]; then
  log "account fingerprint mismatch before=${before_fp} after=${after_fp}"
  restore_old_release
  exit 1
fi

# The fingerprint above is now read directly from Binance, so on its own it
# would accept a replacement whose own read path is still jammed. Require the
# endpoint that the jam silenced to actually answer.
if ! assert_account_endpoint_answers; then
  restore_old_release
  exit 1
fi

"$curl_bin" --fail --silent --show-error --max-time 20 \
  "http://127.0.0.1:${port}/api/live/daily-range-lane/status" >"${log_dir}/daily-range-status.json"

"$pm2_bin" save
log "${target} candidate verified with matching account fingerprint"

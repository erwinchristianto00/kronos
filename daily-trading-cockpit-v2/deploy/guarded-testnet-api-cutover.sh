#!/usr/bin/env bash
# Guarded TESTNET API release cutover.  It owns no exchange order operation:
# a persisted entry drain freezes new admissions while the process is replaced,
# and the account fingerprint must match before the drain is released.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <old-release-root> <new-release-root>" >&2
  exit 64
fi

old_root="$1"
new_root="$2"
mkdir -p /root/kronos-release-bundles
exec 9>/root/kronos-release-bundles/.cutover.lock
flock -n 9 || { echo "another cutover is in progress" >&2; exit 75; }
name="dtc-api-testnet"
port="3102"
allow_stale_account="${CUTOVER_ALLOW_STALE_ACCOUNT:-0}"
if [ "$allow_stale_account" != "0" ] && [ "$allow_stale_account" != "1" ]; then
  echo "CUTOVER_ALLOW_STALE_ACCOUNT must be 0 or 1" >&2
  exit 64
fi
pm2_bin="/usr/bin/pm2"
curl_bin="/usr/bin/curl"
node_bin="/usr/bin/node"
log_dir="${new_root}/deploy/guarded-testnet-api-cutover"
mkdir -p "$log_dir"
exec >>"${log_dir}/cutover.log" 2>&1

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

snapshot() {
  local file="$1"
  # The dashboard endpoint is intentionally allowed to return a last-good
  # cache while it refreshes in the background. A cutover needs exchange truth,
  # so use the read-only direct verifier instead. It uses the same durable
  # Testnet transport coordinator, but never calls an order-mutating endpoint.
  (cd "$new_root" && "$new_root/node_modules/.bin/tsx" deploy/verify-testnet-account-fingerprint.ts) >"$file"
}

assert_fresh() {
  local file="$1"
  "$node_bin" - "$file" <<'NODE'
const fs = require("fs");
const payload = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
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
  if [ "$enabled" = "false" ]; then restore_original_arm_state || return 1; fi
  "$curl_bin" --fail --silent --show-error --max-time 15 \
    -H 'content-type: application/json' \
    -X POST --data "{\"enabled\":${enabled},\"confirm\":\"DRAIN\",\"reason\":\"guarded Testnet quote-preflight cutover\"}" \
    "http://127.0.0.1:${port}/api/live/new-entry-drain"
}

wait_for_health() {
  for _ in $(seq 1 60); do
    if "$curl_bin" --fail --silent --max-time 2 "http://127.0.0.1:${port}/api/health" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_fresh_snapshot() {
  local file="$1"
  # A direct snapshot should normally complete within a few paced GETs. Keep a
  # bounded retry for a transient Testnet gateway response, never bypass it.
  local max_attempts=6
  for attempt in $(seq 1 "$max_attempts"); do
    if snapshot "$file" && assert_fresh "$file"; then
      return 0
    fi
    log "fresh account snapshot attempt ${attempt}/${max_attempts} did not pass"
    if [ "$attempt" -lt "$max_attempts" ]; then sleep 5; fi
  done
  return 1
}

restore_old_release() {
  log "verification failed; restoring ${old_root}"
  "$pm2_bin" delete "$name" || true
  "$pm2_bin" start "${old_root}/deploy/run-api.sh" --name "$name" --interpreter bash
  wait_for_health || true
}

assert_release_identity() {
  "$pm2_bin" jlist | "$node_bin" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).find(p=>p.name==="dtc-api-testnet");if(p?.pm2_env?.pm_exec_path!==process.argv[1]+"/deploy/run-api.sh")process.exit(1);});' "$old_root"
}
if ! assert_release_identity; then log "active release changed; refusing stale cutover"; exit 1; fi

drain_was_active="$($curl_bin --fail --silent --show-error --max-time 15 "http://127.0.0.1:${port}/api/live/status" | "$node_bin" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);process.stdout.write(String(x?.newEntries?.drainActive===true));})')"
engine_was_armed="$($curl_bin --fail --silent --show-error --max-time 15 "http://127.0.0.1:${port}/api/live/status" | "$node_bin" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(typeof x.armed!=="boolean")process.exit(1);process.stdout.write(String(x.armed));})')"
if [ "$drain_was_active" != "true" ] && [ "$drain_was_active" != "false" ]; then
  log "cannot determine pre-cutover entry drain state"
  exit 1
fi

# Preserve the original admission state even on an unexpected shell error/signal.
# Never bypass a fresh fingerprint or clear the exchange cooldown on this path.
cleanup_entry_drain() {
  local code="$?"
  trap - EXIT
  # Startup auto-arm must not erase an operator/reconciliation disarm on either swap or rollback.
  if ! restore_original_arm_state; then
    log "ERROR cannot preserve DISARMED state; leaving entry drain enabled"
    exit 1
  fi
  if [ "$drain_was_active" = "false" ]; then
    set_entry_drain false >/dev/null || log "WARNING entry drain restore failed; operator action required"
  fi
  exit "$code"
}
restore_original_arm_state() {
  if [ "$engine_was_armed" != "false" ]; then return 0; fi
  "$curl_bin" --fail --silent --show-error --max-time 15 -X POST \
    "http://127.0.0.1:${port}/api/live/disarm" | "$node_bin" -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.ok!==true||x.armed!==false)process.exit(1);});'
}
trap cleanup_entry_drain EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$drain_was_active" = "false" ]; then
  set_entry_drain true >"${log_dir}/entry-drain-enabled.json"
fi

before="${log_dir}/account-before.json"
before_fp=""
if [ "$allow_stale_account" = "1" ]; then
  log "operator-authorized Testnet stale-account exception: preserving entry drain and shared state, skipping pre-cutover exchange fingerprint"
else
  if ! wait_for_fresh_snapshot "$before"; then
    log "pre-cutover account snapshot is not fresh; refusing to replace the process"
    if [ "$drain_was_active" = "false" ]; then set_entry_drain false || true; fi
    exit 1
  fi
  before_fp="$(fingerprint "$before")"
  log "pre-cutover fingerprint ${before_fp}"
fi

if ! (cd "${new_root}/deploy" && RUN_API_PRECHECK_ONLY=1 ./run-api.sh); then
  log "candidate precheck failed"
  if [ "$drain_was_active" = "false" ]; then set_entry_drain false || true; fi
  exit 1
fi

if ! KRONOS_RELEASE_ACTIVATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$new_root/deploy/stamp-release-provenance.sh" "$new_root"; then
  log "candidate release-provenance stamp failed"
  if [ "$drain_was_active" = "false" ]; then set_entry_drain false || true; fi
  exit 1
fi

if ! assert_release_identity; then
  log "active release changed during verification; refusing stale cutover"
  if [ "$drain_was_active" = "false" ]; then set_entry_drain false || true; fi
  exit 1
fi
log "cutting ${name} to ${new_root}"
if ! "$pm2_bin" delete "$name" || ! "$pm2_bin" start "${new_root}/deploy/run-api.sh" --name "$name" --interpreter bash; then
  restore_old_release
  if [ "$drain_was_active" = "false" ]; then set_entry_drain false || true; fi
  exit 1
fi

if ! wait_for_health; then
  restore_old_release
  if [ "$drain_was_active" = "false" ]; then set_entry_drain false || true; fi
  exit 1
fi

after="${log_dir}/account-after.json"
if [ "$allow_stale_account" = "1" ]; then
  log "candidate health verified; exchange fingerprint intentionally deferred until Binance transport recovers"
else
  if ! wait_for_fresh_snapshot "$after"; then
    restore_old_release
    if [ "$drain_was_active" = "false" ]; then set_entry_drain false || true; fi
    exit 1
  fi
  after_fp="$(fingerprint "$after")"
  if [ "$before_fp" != "$after_fp" ]; then
    log "account fingerprint mismatch before=${before_fp} after=${after_fp}"
    restore_old_release
    if [ "$drain_was_active" = "false" ]; then set_entry_drain false || true; fi
    exit 1
  fi
fi

"$pm2_bin" save
restore_original_arm_state
if [ "$drain_was_active" = "false" ]; then
  set_entry_drain false >"${log_dir}/entry-drain-restored.json"
fi
if [ "$allow_stale_account" = "1" ]; then
  log "TESTNET candidate verified under operator-authorized stale-account exception"
else
  log "TESTNET candidate verified with matching account fingerprint"
fi

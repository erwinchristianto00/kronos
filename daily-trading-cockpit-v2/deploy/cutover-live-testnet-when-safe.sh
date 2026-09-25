#!/usr/bin/env bash
# One-shot guarded cutover. It intentionally owns no order/position operation.
set -euo pipefail

export HOME=/root
pm2_bin="/usr/bin/pm2"
curl_bin="/usr/bin/curl"
node_bin="/usr/bin/node"
old_live="/root/kronos-live-releases/v4-strict-slowfast-d1dbba7-20260827T142400Z/daily-trading-cockpit-v2"
new_live="/root/kronos-live-releases/usdm-418-containment-8e10196-20260827T145700Z/daily-trading-cockpit-v2"
old_testnet="/root/kronos-testnet-releases/v4-strict-slowfast-route-exit-v1-c431467-20260827T142543Z/daily-trading-cockpit-v2"
new_testnet="/root/kronos-testnet-releases/usdm-418-containment-8e10196-20260827T150100Z/daily-trading-cockpit-v2"
log_dir="${new_live}/deploy/usdm-418-cutover"
mkdir -p "$log_dir"
exec >>"${log_dir}/cutover.log" 2>&1

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] guarded cutover started"

snapshot() {
  local port="$1"
  local file="$2"
  "$curl_bin" --fail --silent --show-error --max-time 25 "http://127.0.0.1:${port}/api/live/account" >"$file"
}

assert_fresh() {
  local file="$1"
  "$node_bin" - "$file" <<'NODE'
const fs = require("fs");
const payload = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const snapshot = payload.accountSnapshot;
if (payload.ok !== true || !snapshot || snapshot.stale === true || snapshot.retryAt) {
  throw new Error(`account snapshot is not fresh: ${snapshot?.lastFailure ?? "unknown"}`);
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
}));
NODE
}

wait_for_health() {
  local port="$1"
  for _ in $(seq 1 24); do
    if "$curl_bin" --fail --silent --max-time 2 "http://127.0.0.1:${port}/api/health" >/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

rollback() {
  local name="$1"
  local old_root="$2"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ${name} verification failed; restoring prior release"
  "$pm2_bin" delete "$name" || true
  "$pm2_bin" start "${old_root}/deploy/run-api.sh" --name "$name" --interpreter bash
}

cutover() {
  local name="$1"
  local port="$2"
  local old_root="$3"
  local new_root="$4"
  local before="${log_dir}/${name}-before.json"
  local after="${log_dir}/${name}-after.json"

  snapshot "$port" "$before"
  assert_fresh "$before"
  local before_fp
  before_fp="$(fingerprint "$before")"

  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] cutting ${name} to ${new_root}"
  "$pm2_bin" delete "$name"
  "$pm2_bin" start "${new_root}/deploy/run-api.sh" --name "$name" --interpreter bash
  if ! wait_for_health "$port"; then
    rollback "$name" "$old_root"
    return 1
  fi
  if ! snapshot "$port" "$after" || ! assert_fresh "$after"; then
    rollback "$name" "$old_root"
    return 1
  fi
  local after_fp
  after_fp="$(fingerprint "$after")"
  if [ "$before_fp" != "$after_fp" ]; then
    echo "before=${before_fp}"
    echo "after=${after_fp}"
    rollback "$name" "$old_root"
    return 1
  fi
  "$pm2_bin" save
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ${name} verified"
}

cutover "dtc-api-live" 3103 "$old_live" "$new_live"
cutover "dtc-api-testnet" 3102 "$old_testnet" "$new_testnet"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] guarded cutover complete; continuation collector intentionally remains stopped"

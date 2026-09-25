#!/usr/bin/env bash
# Stamp the moment one immutable release becomes eligible to serve an exchange
# environment. This is deliberately separate from build time: reports need the
# actual cutover boundary the operator experienced.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <release-root>" >&2
  exit 64
fi

release_root="$(cd "$1" && pwd)"
case "$release_root" in
  /root/kronos-testnet-releases/*) environment="testnet" ;;
  /root/kronos-live-releases/*) environment="mainnet" ;;
  *)
    echo "refusing to stamp an ungoverned release root: $release_root" >&2
    exit 64
    ;;
esac

release_id="$(basename "$(dirname "$release_root")")"
if ! [[ "$release_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "invalid release id: $release_id" >&2
  exit 64
fi
release_label="$(printf '%s' "$release_id" | sed -E 's/-[0-9]{8}T[0-9]{6}Z([._-].*)?$//')"
if [ -z "$release_label" ]; then release_label="$release_id"; fi
if [ -n "${KRONOS_RELEASE_ACTIVATED_AT:-}" ]; then
  activated_at="$KRONOS_RELEASE_ACTIVATED_AT"
else
  activated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
manifest_file="$release_root/release-provenance.json"

/usr/bin/node - "$manifest_file" "$release_id" "$release_label" "$environment" "$activated_at" <<'NODE'
const fs = require("fs");
const [file, releaseId, label, environment, activatedAt] = process.argv.slice(2);
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(releaseId) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)) {
  throw new Error("invalid release manifest token");
}
if (!["testnet", "mainnet"].includes(environment) || !Number.isFinite(Date.parse(activatedAt))) {
  throw new Error("invalid release manifest environment or activation time");
}
const manifest = {
  schemaVersion: "kronos-release-provenance/1",
  releaseId,
  label,
  environment,
  activatedAt: new Date(activatedAt).toISOString(),
};
const tmp = file + "." + process.pid + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(manifest) + "\n", { encoding: "utf8", mode: 0o644 });
fs.renameSync(tmp, file);
NODE

echo "stamped release provenance: $release_id ($environment) at $activated_at"

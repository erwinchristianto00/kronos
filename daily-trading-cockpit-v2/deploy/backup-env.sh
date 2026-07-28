#!/usr/bin/env bash
#
# Timestamped .env backup. Use this INSTEAD of an ad-hoc `cp`.
#
# 2026-07-28: ten backups across all three instances were found named literally
#   .env.bak-<label>-$(date -u +%Y%m%dT%H%M%SZ)
# — the `$( )` never expanded because the whole filename had been wrapped in SINGLE quotes in an
# interactive command. Two consequences, both silent:
#   1. the backup carried no timestamp, so its age was unknowable from the name; and
#   2. every later backup with the SAME label resolved to the SAME filename, so it overwrote the
#      previous one. A backup that destroys the thing it is backing up is worse than none.
# The ten were renamed to their real mtimes. This script exists so the hazard cannot come back:
# the timestamp is produced here, correctly quoted, once.
#
# usage:  deploy/backup-env.sh <label>        # e.g. deploy/backup-env.sh timelinegate
# prints: the path it wrote
#
set -euo pipefail

label="${1:-}"
if [ -z "$label" ]; then
  echo "usage: $0 <label>   (e.g. $0 timelinegate)" >&2
  exit 2
fi
# Keep labels filename-safe so the result can never again be a shell expression.
case "$label" in
  *[!A-Za-z0-9_-]*)
    echo "label may only contain letters, digits, '_' and '-' (got: $label)" >&2
    exit 2
    ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$root/.env"
if [ ! -f "$env_file" ]; then
  echo "no .env at $env_file" >&2
  exit 1
fi

dest="$root/.env.bak-${label}-$(date -u +%Y%m%dT%H%M%SZ)"
# Same label twice inside one second is the only way to collide; refuse rather than clobber.
if [ -e "$dest" ]; then
  echo "refusing to overwrite existing $dest" >&2
  exit 1
fi

cp -p "$env_file" "$dest"
chmod 600 "$dest"
echo "$dest"

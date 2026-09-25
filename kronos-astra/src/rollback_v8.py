"""Roll the runner back to the pre-V8 sources and unit. Journals are never restored.

Rolling back after cycles have run means the journals describe work the old sources
did not do; that is fine, because the journals are append-only history. Restoring a
journal snapshot would delete real recorded outcomes, so this script refuses to.

The V8 manifest is disarmed rather than deleted, so the installed sources stay
inspectable and inert instead of half-present.

Run on the VPS as root:
  work/hermes-agent/.venv/bin/python rollback_v8.py /opt/kronos-astra/pre-v8-XXXX --apply
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path("/opt/kronos-astra/runtime")
UNIT = Path("/etc/systemd/system/kronos-astra-hermes.service")
SERVICE = "kronos-astra-hermes"
JOURNAL_NAMES = ("astra-experiments.json", "astra-plans.json", "astra-learning.json",
                 "astra-cadence.json", "astra-canonical-v8.json")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("backup")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    backup = Path(args.backup)
    sources = sorted(p.name for p in backup.glob("*.py"))
    unit = backup / UNIT.name
    if not sources or not unit.exists():
        raise SystemExit("Backup does not look like a V8 deployment backup")
    plan = {"restoreSources": sources, "restoreUnit": str(unit),
            "journalsPreserved": [n for n in JOURNAL_NAMES if (ROOT / "hermes-home" / n).exists()],
            "disarmManifest": (ROOT / "v8-manifest.json").exists()}
    print(json.dumps(plan, indent=2), flush=True)
    if not args.apply:
        print("Dry run; nothing changed.")
        return
    subprocess.run(["systemctl", "stop", SERVICE], check=True, timeout=60)
    for name in sources:
        target = ROOT / name
        stat = target.stat() if target.exists() else ROOT.stat()
        fd, tmp = tempfile.mkstemp(prefix=name + ".rollback-", dir=str(ROOT))
        with os.fdopen(fd, "wb") as stream:
            stream.write((backup / name).read_bytes())
            stream.flush()
            os.fsync(stream.fileno())
        os.chown(tmp, stat.st_uid, stat.st_gid)
        os.chmod(tmp, stat.st_mode & 0o777 or 0o600)
        os.replace(tmp, target)
    UNIT.write_text(unit.read_text())
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    manifest_path = ROOT / "v8-manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        manifest["armed"] = False
        manifest["disarmedReason"] = "ROLLED_BACK"
        manifest_path.write_text(json.dumps(manifest))
    subprocess.run(["systemctl", "start", SERVICE], check=True, timeout=60)
    subprocess.run(["systemctl", "show", SERVICE, "-p", "ActiveState", "-p", "MainPID",
                    "-p", "NRestarts", "-p", "ExecStart"], check=True)
    print(json.dumps({"state": "ROLLED_BACK", "journalsPreserved": plan["journalsPreserved"],
                      "note": "Positions, native protection and every journal were left untouched."}))


if __name__ == "__main__":
    main()

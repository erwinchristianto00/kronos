"""Host-only: adopt a changed common policy as a new incumbent baseline.

The experiment journal deliberately refuses a changed policy hash so a running
comparison can never silently swap the instructions both arms follow. When the
policy text really did change, this records the migration rather than hiding it.
Refuses while the runner holds its lock, and preserves journal ownership.
"""
import argparse
import fcntl
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))


def held(lock_path):
    if not lock_path.exists():
        return False
    with lock_path.open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return True
        fcntl.flock(handle, fcntl.LOCK_UN)
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reason", required=True)
    parser.add_argument("--apply", action="store_true", help="without this the run is a dry run")
    args = parser.parse_args()
    if held(ROOT / "runner.lock"):
        sys.exit("Runner is active and rewrites this journal every cycle. "
                 "Stop kronos-astra-hermes first, then re-run.")
    import astra_runner
    from astra_experiments import ExperimentBook, digest
    current = digest({"base": astra_runner.SYSTEM, "common": astra_runner.EXPERIMENT_RULES})
    book = ExperimentBook(ROOT, None)
    print(json.dumps({"journalHash": book.state["basePolicyHash"], "runnerHash": current,
                      "champion": book.state["champion"],
                      "activeStudy": (book.active() or {}).get("id")}, indent=1))
    if book.state["basePolicyHash"] == current:
        print(json.dumps({"status": "UNCHANGED", "note": "Nothing to migrate"}, indent=1))
        return
    if not args.apply:
        print(json.dumps({"dryRun": True, "wouldAdopt": current,
                          "note": "Re-run with --apply to write it"}, indent=1))
        return
    print(json.dumps({"result": book.migrate_policy(current, args.reason),
                      "champion": book.state["champion"]}, indent=1, default=str))


if __name__ == "__main__":
    main()

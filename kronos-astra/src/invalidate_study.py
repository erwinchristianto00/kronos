"""Host-only: end a strategy trial whose evidence cannot support any verdict.

Never reachable from the model tool surface. Requires an explicit study id, a
whitelisted reason and a written note. Refuses to run while the runner holds its
lock, because the runner rewrites the whole journal from memory on every cycle
and would silently overwrite this change.

Nothing is deleted or relabelled: assignments, submissions, trades and receipts
stay exactly as recorded, and the champion is untouched.
"""
import argparse
import fcntl
import json
import os
import sys
from pathlib import Path

from astra_experiments import ExperimentBook, INVALIDATION_REASONS, RUNNING

ROOT = Path(__file__).resolve().parent


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


def describe(book, study):
    phase = study["phases"][-1]
    data = book.phase_data(study, phase)
    return {"id": study["id"], "status": study["status"], "phase": phase["name"],
            "sealedAt": phase["sealedAt"], "completionRate": round(data["completionRate"], 6),
            "completedAssignments": data["completedAssignments"],
            "scoredAssignments": data["scoredAssignments"],
            "excludedAssignments": data["excludedAssignments"],
            "unclassifiedLegacy": data["unclassifiedLegacy"], "outcomes": data["outcomes"],
            "closedPerArm": {arm: m["closedN"] for arm, m in data["arms"].items()},
            "pending": data["pending"]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--study", required=True)
    parser.add_argument("--reason", required=True, choices=list(INVALIDATION_REASONS))
    parser.add_argument("--note", required=True)
    parser.add_argument("--apply", action="store_true", help="without this the run is a dry run")
    args = parser.parse_args()

    if held(ROOT / "runner.lock"):
        sys.exit("Runner is active and rewrites this journal every cycle. "
                 "Stop kronos-astra-hermes first, then re-run.")

    book = ExperimentBook(ROOT, None)
    study = next((s for s in book.state["studies"] if s["id"] == args.study), None)
    if not study:
        sys.exit("Unknown study: " + args.study)
    if study["status"] not in RUNNING:
        sys.exit("Study already finished with status " + study["status"])

    print(json.dumps({"before": describe(book, study)}, indent=1, default=str))
    if not args.apply:
        print(json.dumps({"dryRun": True, "wouldSetStatus": "INVALIDATED_" + args.reason,
                          "note": "Re-run with --apply to write it"}, indent=1))
        return
    # The journal is rewritten atomically as a new file. Run as root, that new
    # file lands root-owned and the runner (a different, unprivileged user) can
    # no longer read its own journal, which fails entries closed. Carry the
    # original owner and mode across the replace.
    stat = os.stat(book.path)
    result = book.invalidate(args.study, args.reason, args.note)
    os.chown(book.path, stat.st_uid, stat.st_gid)
    os.chmod(book.path, stat.st_mode & 0o777)
    restored = os.stat(book.path)
    if (restored.st_uid, restored.st_gid) != (stat.st_uid, stat.st_gid):
        sys.exit("Journal ownership was not restored; fix it before starting the runner")
    print(json.dumps({"result": result, "after": describe(book, study),
                      "champion": book.state["champion"],
                      "activeStudy": (book.active() or {}).get("id"),
                      "journalOwner": "%d:%d" % (restored.st_uid, restored.st_gid),
                      "journalMode": oct(restored.st_mode & 0o777)}, indent=1, default=str))


if __name__ == "__main__":
    main()

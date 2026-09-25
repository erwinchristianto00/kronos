"""Carry the V8 supervisor's working state across a re-cohort.

`Supervisor.__init__` refuses a `supervisor.json` whose fingerprint is not the
manifest's — correctly, because jobs, pending events, ready states and dispatch
history all belong to the cohort that produced them. It names "explicit migration"
as the way past that and nothing implemented one, so `deploy_v8.py --recohort`
armed successfully and then left the service crash-looping on its own guard. This
is that migration, and `deploy_v8.arm()` now runs it as part of a re-cohort.

What is NOT carried: every scheduling field. A new cohort starts with an empty job
table and no formation cursor, which is the whole point of the guard.

What IS carried: `modelHealth`. Which provider answers is a fact about the providers,
not about the cohort. Dropping it restarts the lane on the primary, spends a cycle
discovering the outage that is already known, and records that cycle as a failure.

Nothing is deleted: the previous state is archived beside the new one.

Standalone use, with the service STOPPED:
  python3 migrate_supervisor_cohort.py --apply
"""
import argparse
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

ROOT = Path("/opt/kronos-astra/runtime")
SERVICE = "kronos-astra-hermes"


def _fresh_state(root, fingerprint, carried_health, carried_router=None):
    import sys
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    from astra_fast_v8 import new_event_state
    import astra_models_v8 as MODELS
    return {"version": 8, "fingerprint": fingerprint, "events": new_event_state(),
            "jobs": {}, "pendingEvents": [], "readyStates": {}, "calls": [], "lastFormationAt": None,
            "positionSamples": {}, "lastManagedAt": {}, "seenDispatchEvents": [],
            "modelHealth": carried_health or {"role": MODELS.PRIMARY, "since": int(time.time() * 1000),
                                              "primaryFailures": 0, "fallbackFailures": 0,
                                              "lastProbe": {}, "switches": []},
            # Carried for the same reason as modelHealth: which provider can answer is a
            # fact about the PROVIDERS, not about the cohort. Dropping it reset the router
            # to ASTRA_PRIMARY on every re-cohort, so the lane re-tried a quota-exhausted
            # provider and burned a cycle on a 429 it already knew was coming — once per
            # deploy. The per-opportunity fallback ledger is cohort-scoped and is not
            # carried: those opportunity keys belong to the sealed cohort.
            **({"router": {k: v for k, v in carried_router.items() if k != "fallbackOpportunities"}}
               if carried_router else {})}


def reconcile_orphaned_coverage(root, known_job_ids, *, apply_changes):
    """Close coverage reservations whose owning job no longer exists.

    `CoverageBook.reserve` refuses a new batch while any reservation is still open, and
    only the owning job can close one. Dropping the job table without closing its
    reservations therefore wedges the lane permanently: every tick raises "Reconcile
    outstanding coverage job before another reservation" and no FAST job is ever
    dispatched again. That is what this migration did on its first run.

    Nothing is deleted. The row is closed with an outcome that says what happened to it,
    and `progress` still refuses to let a closed row claim assessment it never made.
    """
    root = Path(root)
    path = root / "hermes-home/v8/coverage.json"
    if not path.exists():
        return {"state": "NO_COVERAGE_STATE"}
    state = json.loads(path.read_text())
    orphans = sorted(jid for jid, row in (state.get("jobs") or {}).items()
                     if row.get("outcome") is None and jid not in set(known_job_ids))
    open_but_owned = sorted(jid for jid, row in (state.get("jobs") or {}).items()
                            if row.get("outcome") is None and jid in set(known_job_ids))
    receipt = {"state": "WOULD_RECONCILE" if orphans else "NOTHING_ORPHANED",
               "orphaned": orphans, "stillOwned": open_but_owned}
    if not orphans or not apply_changes:
        return receipt
    import sys
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    from astra_v8_host import CoverageBook
    owner = (path.stat().st_uid, path.stat().st_gid)
    book = CoverageBook(path)
    for jid in orphans:
        book.progress(jid, outcome="COHORT_MIGRATION_DISCARDED")
    os.chown(path, *owner)
    return {**receipt, "state": "RECONCILED"}


def migrate(root, fingerprint, *, apply_changes):
    """Returns a receipt dict; never raises for the two ordinary no-op cases."""
    root = Path(root)
    path = root / "hermes-home/v8/supervisor.json"
    if not path.exists():
        return {"state": "NO_STATE_TO_MIGRATE"}
    state = json.loads(path.read_text())
    if state.get("fingerprint") == fingerprint:
        return {"state": "ALREADY_ON_COHORT", "fingerprint": fingerprint}

    running = sorted(k for k, j in (state.get("jobs") or {}).items() if not j.get("finishedAt"))
    if running:
        # A job whose result would land in the new cohort's tables is not a job this
        # migration may silently drop. Let it finish first.
        raise SystemExit("Unfinished jobs in the old cohort: " + ", ".join(running))

    health = state.get("modelHealth")
    router = state.get("router")
    receipt = {"state": "WOULD_MIGRATE", "from": state.get("fingerprint"), "to": fingerprint,
               "droppedJobs": len(state.get("jobs") or {}),
               "droppedPendingEvents": len(state.get("pendingEvents") or []),
               "carriedModelRole": (health or {}).get("role"),
               "carriedSwitches": len((health or {}).get("switches") or []),
               "carriedRouterState": (router or {}).get("routerState"),
               "carriedPrimaryFailureReason": (router or {}).get("primaryFailureReason")}
    if not apply_changes:
        return receipt

    # Read the owner off the ORIGINAL, before anything root-owned is written beside it:
    # shutil.copy2 carries mode and times but not uid/gid, so a copy taken as root is
    # root's. A root-owned state file locks the service out of its own journal, which
    # is a silent wedge rather than a crash — hence the sweep below as well.
    owner = (path.stat().st_uid, path.stat().st_gid)
    archive = path.with_name("supervisor.pre-" + str(state.get("fingerprint"))[:12] + ".json")
    shutil.copy2(path, archive)
    from astra_v8_host import atomic_json
    atomic_json(path, _fresh_state(root, fingerprint, health, router))
    for target in (path, archive):
        os.chown(target, *owner)
    # The new state has no jobs, so every open reservation is now orphaned. Closing them
    # here is not optional bookkeeping: leaving one open wedges the lane for good.
    coverage = reconcile_orphaned_coverage(root, [], apply_changes=True)
    stranded = [str(p) for p in (root / "hermes-home").rglob("*") if p.stat().st_uid != owner[0]]
    if stranded:
        raise SystemExit("Root-owned files left in the service profile: " + ", ".join(stranded[:5]))
    return {**receipt, "state": "MIGRATED", "archive": str(archive), "coverage": coverage}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Without this nothing is written.")
    parser.add_argument("--root", default=str(ROOT))
    parser.add_argument("--reconcile-coverage-only", action="store_true",
                        help="Close reservations orphaned by an earlier migration, without re-migrating.")
    args = parser.parse_args()
    root = Path(args.root)
    active = subprocess.run(["systemctl", "is-active", SERVICE], capture_output=True, text=True).stdout.strip()
    if args.apply and active == "active":
        raise SystemExit("Service is active; stop it before migrating its own state file")
    if args.reconcile_coverage_only:
        known = json.loads((root / "hermes-home/v8/supervisor.json").read_text()).get("jobs") or {}
        print(json.dumps(reconcile_orphaned_coverage(root, list(known), apply_changes=args.apply), indent=2))
        return
    manifest = json.loads((root / "v8-manifest.json").read_text())
    print(json.dumps(migrate(root, manifest["fingerprint"], apply_changes=args.apply), indent=2))


if __name__ == "__main__":
    main()

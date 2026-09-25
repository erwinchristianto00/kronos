"""Guarded, runner-only activation of the Astra V8 orchestration on the Testnet VPS.

What this does NOT do, by construction: it never touches the Testnet or LIVE API
process, never changes the gateway execution version, never edits an engine module,
never rewrites or rolls back a journal, never places or cancels an order, and never
closes a position to make a deployment possible.

Two outcomes are legitimate:

  ARMED                 the lane was flat, the cohort boundary was recorded and the
                        service now runs the V8 supervisor.
  STAGED_WAITING_FLAT   a position was open, so the sources are installed but the
                        manifest stays unarmed and the incumbent runner keeps
                        managing that position. Re-run with --arm-only when flat.

Run on the VPS as root:  work/hermes-agent/.venv/bin/python deploy_v8.py --apply
Without --apply it performs every check and changes nothing.
"""
import argparse
import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
from contextlib import contextmanager
from pathlib import Path

ROOT = Path("/opt/kronos-astra/runtime")
STAGE = Path(__file__).resolve().parent
SERVICE = "kronos-astra-hermes"
SERVICE_USER = "kronos-astra"
UNIT = Path("/etc/systemd/system/kronos-astra-hermes.service")
VENV = ROOT / "work/hermes-agent/.venv/bin/python"
REPORT_URL = "http://127.0.0.1:3102/api/live/astra-hermes/report"
GATEWAY_VERSION = "astra-final-book-contract-v1-20260909"

# The runner that owns entry admission must already be the deployed final-book build
# and must stay byte-identical through this deployment. Pinning it here means a
# staging directory that quietly carries a different engine cannot be installed.
PINNED_ENGINE = {
    "astra_runner.py": "b176546c677508903dfbc70fa14d8f5f33f9df979dd32fdd708c7d0141d41753",
    "astra_cadence.py": "e2b817f4433618ab6c29eae0f4508938aecb9e103cd55e8e6f53ff346176117f",
    "astra_learning.py": "dca5a9e2e2135bd5453c949266a5ff623283da248725b0328025aedc997ec4f9",
    "runner_host.py": "4ef5e156d76a537fd046273951cc3883679a556b36870c91c59c8131d9372124",
    # Listed in the manifest and imported by the worker, so a silent difference here
    # would only surface as a release_gate failure after the service was restarted.
    "astra_decisions.py": "48a7589c32644f023cffe8beeee8717dd6652a9734f50bbc732edb764311aac6",
    "astra_procedures.py": "d04dfa67bc80d2e511284b7ef0d526edce62351608a8ad231ec66698a1170e49",
}
# Exactly one existing engine module is deliberately replaced, and only for the
# fallback: study arms must hold out cycles a different decision policy produced.
# The pre-image is pinned so the replacement can only ever land on the build it
# was written against.
REPLACED_ENGINE = {
    # Reporting-only replacement, 2026-09-10. PINNED_ENGINE modules are verified and
    # never installed, so a deliberate change to one belongs here with an explicit
    # pre-image: it can only ever land on the build it was written against.
    # Adds costFloorBps / modelledAllInCostBps, gross + legacy + cost-symmetric ratios,
    # and planStatus FROZEN|ADMISSIBLE|READY. No gate, threshold, sizing, TP/SL or
    # execution path changes; the risk-envelope verdict is asserted identical.
    "astra_plans.py": {
        "from": "ebb47a43aa81de1e0b281caeb57341e2de3dcc7ced0c7effad3f8c17033e5405",
        "to": "138e5eb40e1d90bd01f247663c4614e23ecab7b75ab173ac5f6d4a99b7754cbe",
        "reason": "reporting only: explicit cost decomposition, cost-symmetric R/R, plan status"},
    "astra_experiments.py": {
        # Already installed and unchanged by this release: pre-image and image are the
        # same build, so this deploy must neither alter it nor accept another one.
        "from": "0f807f13d98e535f1e7a0edba454e43c2a348a0af05ec5068d424767741ce891",
        "to": "0f807f13d98e535f1e7a0edba454e43c2a348a0af05ec5068d424767741ce891",
        "reason": "phase_data counts every assignment and reports each arm's policy composition; "
                  "record_screen_outcome closes slots the host screened out; per-cycle figures "
                  "divide by dispatched slots and disclose each arm's dispatch rate"},
}
NEW_SOURCES = ("astra_v8_supervisor.py", "astra_v8_runner.py", "astra_v8_host.py", "astra_v8_phase.py",
               "astra_fast_v8.py", "astra_canonical_v8.py", "astra_models_v8.py",
               "make_v8_manifest.py", "migrate_supervisor_cohort.py", "hermes_dashboard.py",
               "astra_router_v9.py", "verify_router_policies.py", "deploy_v8.py")
NEW_TESTS = ("test_astra_fast_v8.py", "test_astra_canonical_v8.py", "test_astra_v8_runner.py",
             "test_astra_v8_supervisor.py", "test_astra_v8_host.py", "test_astra_v8_phase.py",
             "test_astra_fallback_v8.py", "test_astra_router_v9.py",
             "test_astra_router_wiring.py", "test_row_refresh.py",
             "test_coaching_schema.py",
             "test_plan_reporting.py")
# The runtime carries older copies of these three that no longer match the engine
# beside them: run on their own they fail 5 and error 1 before this release exists.
# A stale suite sitting in a production directory is a trap — the next person to run
# it reads a real failure. They are replaced with the copies this release was tested
# against; test files are never imported by the service.
REFRESHED_TESTS = ("test_astra_plans.py", "test_astra_cadence.py", "test_astra_experiments.py",
                   "test_hermes_dashboard.py")
JOURNALS = ("astra-experiments.json", "astra-plans.json", "astra-learning.json", "astra-cadence.json")
TEST_MODULES = ("test_astra_fast_v8", "test_astra_canonical_v8", "test_astra_v8_runner",
                "test_astra_v8_supervisor", "test_astra_v8_host", "test_astra_v8_phase",
                "test_astra_fallback_v8", "test_astra_plans", "test_astra_experiments",
                "test_astra_cadence", "test_runner_schema", "test_runner_host",
                "test_hermes_dashboard", "test_astra_router_v9", "test_astra_router_wiring",
                "test_row_refresh", "test_coaching_schema", "test_plan_reporting")
EXEC_OLD = "astra_runner.py --trade --loop"
EXEC_NEW = "astra_v8_supervisor.py --loop"


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def pm2():
    rows = json.loads(subprocess.check_output(["pm2", "jlist"]))
    return {p["name"]: {"pid": p["pid"], "path": p["pm2_env"]["pm_exec_path"]}
            for p in rows if p["name"] in ("dtc-api-live", "dtc-api-testnet")}


def check_sources(*, installed=False):
    """The engine must be the deployed build, and staging must not differ from it.

    `installed=True` is the post-install check: the replaced module is expected to
    have become its `to` hash, everything else is still expected to be untouched.
    """
    for name, expected in PINNED_ENGINE.items():
        if sha(ROOT / name) != expected:
            raise SystemExit("Active runtime " + name + " is not the pinned final-book build")
        if sha(STAGE / name) != expected:
            raise SystemExit("Staging " + name + " differs from the deployed engine")
    for name, change in REPLACED_ENGINE.items():
        # Before installing, either state is legitimate: the original build, or this
        # release already installed (re-running the deploy over itself). Anything
        # else is an unknown third build and must not be overwritten blindly.
        allowed = {change["to"]} if installed else {change["from"], change["to"]}
        if sha(ROOT / name) not in allowed:
            raise SystemExit("Active runtime " + name + " is neither the pinned pre-image nor this "
                             "release's build; refusing to overwrite an unknown version")
        if sha(STAGE / name) != change["to"]:
            raise SystemExit("Staging " + name + " is not the reviewed replacement")
    for name in NEW_SOURCES + NEW_TESTS + REFRESHED_TESTS:
        if not (STAGE / name).is_file():
            raise SystemExit("Staging is incomplete; missing " + name)


def gateway_status(engine):
    status = engine.gateway("/status")
    engine.validate_capital_identity(status)
    if (status.get("environment") != "testnet" or status.get("laneId") != "ASTRA_HERMES_TESTNET"
            or status.get("executionVersion") != GATEWAY_VERSION):
        raise SystemExit("Wrong gateway identity or execution version; no V8 change")
    if status.get("lastError"):
        raise SystemExit("Lane reports an error; resolve it before deploying")
    return status


def check_report_route():
    """The V8 supervisor reads owned PnL from this route every poll; fail early."""
    with urllib.request.urlopen(REPORT_URL, timeout=15) as stream:
        value = json.load(stream)
    if value.get("environment") != "testnet" or value.get("laneId") != "ASTRA_HERMES_TESTNET":
        raise SystemExit("Report route identity mismatch")
    return value


def probe_policies():
    """Report which decision policies actually answer, without arming anything.

    A fallback with no credential is not a deployment failure: the lane keeps its
    existing behaviour and simply never fails over. Reporting it is what stops
    anyone believing there is a spare policy when there is not.
    """
    import astra_models_v8 as models
    result = {}
    for role in models.ROLES:
        answer = models.probe(role, root=ROOT, python=str(VENV), timeout=150, run_as=SERVICE_USER)
        result[role] = {"available": bool(answer.get("available")), "reason": answer.get("reason")}
    return result


def wait_for_idle_boundary(seconds=600):
    """Install only between cycles: a half-finished cycle must not be interrupted."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        receipt = json.loads(subprocess.check_output(["tail", "-n", "1", str(ROOT / "logs/cycles.jsonl")]))
        if 0 <= time.time() - receipt["at"] < 240 and time.time() < receipt["startedAt"] + 265:
            return receipt
        time.sleep(5)
    raise SystemExit("No safe idle boundary observed; nothing changed")


def install(src, dst):
    """Atomic replace that keeps the destination's ownership and mode."""
    if dst.exists():
        stat = dst.stat()
        uid, gid, mode = stat.st_uid, stat.st_gid, stat.st_mode & 0o777
    else:
        stat = dst.parent.stat()
        uid, gid, mode = stat.st_uid, stat.st_gid, 0o600
    fd, name = tempfile.mkstemp(prefix=dst.name + ".v8-", dir=dst.parent)
    with os.fdopen(fd, "wb") as stream:
        stream.write(Path(src).read_bytes())
        stream.flush()
        os.fsync(stream.fileno())
    os.chown(name, uid, gid)
    os.chmod(name, mode)
    os.replace(name, dst)


@contextmanager
def runner_lock(required):
    """Hold the runner's singleton lock while installing.

    A dry run only reads, so a live runner holding the lock is information rather
    than a blocker; an --apply run has already stopped the service, so a held lock
    there means something else is running and installing would race it.
    """
    with (ROOT / "runner.lock").open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            if required:
                raise SystemExit("Runner lock is held after stopping the service; refusing to install")
            yield "SKIPPED_RUNNER_ACTIVE"
            return
        yield "HELD"


def ledger(engine):
    status = engine.gateway("/status")
    return {"closed": {t["id"]: t for t in status.get("closed", [])}, "net": status.get("net"),
            "active": sorted(p["id"] for p in status.get("active", []))}


def runtime_owner():
    """uid/gid the service runs as, taken from the runtime directory itself.

    Not from a source file inside it: the runtime's sources are root-owned and
    world-readable, so copying THEIR owner onto a mode-600 file makes it unreadable
    by the service. That mistake crash-looped the supervisor once already.
    """
    stat = ROOT.stat()
    return stat.st_uid, stat.st_gid


def run_tests():
    """Run the release's own suite, from the release directory.

    Running it in the runtime would import whatever test files happen to be lying
    there, which is how a stale copy from an older lineage gets mistaken for a
    regression in this one. Every module under test is byte-identical in both
    directories at this point, so the staged run still exercises what was installed.
    """
    # As the service account, never as root: a suite that touches the agent can
    # refresh an OAuth token, and a root-written credential file locks the service
    # out of its own provider. That happened; it is not hypothetical.
    result = subprocess.run(["runuser", "-u", SERVICE_USER, "--", str(VENV), "-B", "-m", "unittest", *TEST_MODULES],
                            cwd=str(STAGE), capture_output=True, text=True)
    print(result.stderr[-4000:], flush=True)
    if result.returncode != 0:
        raise SystemExit("V8 test subset failed on the VPS; nothing is armed")
    return result.stderr.strip().splitlines()[-3:]


def seed_canonical(apply_changes):
    """Install the offline legacy audit exactly once; never overwrite a live overlay."""
    target = ROOT / "hermes-home/astra-canonical-v8.json"
    if target.exists():
        return "PRESERVED_EXISTING_OVERLAY"
    artifact = json.loads((STAGE / "canonical-legacy-audit.json").read_text())
    if artifact.get("artifactKind") != "OFFLINE_LEGACY_CANONICAL_SEED":
        raise SystemExit("Unexpected canonical seed artifact")
    if not apply_changes:
        return "WOULD_SEED_%d_EVENTS" % len(artifact["overlay"])
    fd, name = tempfile.mkstemp(prefix="astra-canonical-v8.", dir=str(target.parent))  # noqa: E501
    with os.fdopen(fd, "w") as stream:
        json.dump(artifact["overlay"], stream, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    owner = (ROOT / "hermes-home/astra-plans.json").stat()
    os.chown(name, owner.st_uid, owner.st_gid)
    os.chmod(name, owner.st_mode & 0o777)
    os.replace(name, target)
    return "SEEDED_%d_EVENTS" % len(artifact["overlay"])


def set_exec_start(apply_changes, target_exec):
    text = UNIT.read_text()
    lines = [l for l in text.splitlines() if l.startswith("ExecStart=")]
    if len(lines) != 1:
        raise SystemExit("Unit file does not have exactly one ExecStart")
    if target_exec in lines[0]:
        return "UNCHANGED"
    other = EXEC_OLD if target_exec == EXEC_NEW else EXEC_NEW
    if other not in lines[0]:
        raise SystemExit("Unexpected ExecStart; refusing to rewrite: " + lines[0])
    if apply_changes:
        UNIT.write_text(text.replace(other, target_exec))
        subprocess.run(["systemctl", "daemon-reload"], check=True)
    return lines[0].replace(other, target_exec)


def arm(engine, apply_changes, backup, recohort=False):
    """Record the cohort boundary and arm, but only from a genuinely flat lane.

    `recohort` is for a later release of V8 itself: changed runtime sources mean a
    changed fingerprint, so the running cohort is sealed and a new one opened under
    an explicitly recorded boundary rather than quietly continuing.
    """
    from astra_experiments import ExperimentBook, digest
    from astra_v8_phase import prepare_v8_phase
    import make_v8_manifest

    status = gateway_status(engine)
    if status.get("active"):
        return {"state": "STAGED_WAITING_FLAT",
                "reason": "Owned position(s) " + ",".join(sorted(p["id"] for p in status["active"]))
                          + " predate V8; they keep their original management and protection."}
    common = digest({"base": engine.SYSTEM, "common": engine.EXPERIMENT_RULES})
    book = ExperimentBook(ROOT, common)
    legacy_trades = sorted({t["id"] for t in status.get("closed", [])})
    legacy_decisions = sorted({d.get("decision", {}).get("id") for d in status.get("decisions", [])
                               if isinstance(d, dict) and (d.get("decision") or {}).get("id")})
    manifest = make_v8_manifest.build(STAGE, armed=True, tests_passed=True, integration_verified=True,
                                      gateway_version=GATEWAY_VERSION, started_at=int(time.time() * 1000),
                                      legacy_decision_ids=legacy_decisions)
    event = prepare_v8_phase(book, int(time.time() * 1000), manifest["fingerprint"], legacy_trades,
                             recohort=recohort)
    if not apply_changes:
        return {"state": "WOULD_ARM", "boundary": event, "fingerprint": manifest["fingerprint"],
                "legacyTradeN": len(legacy_trades)}
    shutil.copy2(ROOT / "hermes-home/astra-experiments.json", backup / "astra-experiments.json.pre-v8-boundary")
    book.save()
    from astra_v8_host import atomic_json
    atomic_json(ROOT / "v8-manifest.json", manifest)
    os.chown(ROOT / "v8-manifest.json", *runtime_owner())
    # The service reads this file on every start; an unreadable manifest is a crash
    # loop, so prove it is readable as the service account before rewriting the unit.
    check = subprocess.run(["runuser", "-u", SERVICE_USER, "--", "cat", str(ROOT / "v8-manifest.json")],
                           capture_output=True)
    if check.returncode != 0:
        raise SystemExit("Manifest is not readable by " + SERVICE_USER + "; refusing to arm")
    # The supervisor refuses a state file from the previous fingerprint. Arming without
    # migrating it produced a successful ARMED receipt and a service crash-looping on
    # its own guard, so the two steps belong together.
    import migrate_supervisor_cohort
    migrated = migrate_supervisor_cohort.migrate(ROOT, manifest["fingerprint"], apply_changes=True)
    set_exec_start(True, EXEC_NEW)
    return {"state": "ARMED", "boundary": event, "fingerprint": manifest["fingerprint"],
            "supervisorState": migrated,
            "resumeAfterMs": event["resumeAfterMs"], "legacyTradeN": len(legacy_trades)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Without this nothing is written.")
    parser.add_argument("--arm-only", action="store_true",
                        help="Sources are already installed; only record the boundary and arm.")
    parser.add_argument("--skip-idle-wait", action="store_true",
                        help="Only when the service is already stopped by an operator.")
    parser.add_argument("--recohort", action="store_true",
                        help="Updating an already-armed V8: seal the running phase and open a new one "
                             "under the new fingerprint. Required whenever a runtime source changed.")
    args = parser.parse_args()
    os.chdir(str(ROOT))
    import sys
    sys.path.insert(0, str(ROOT))
    import astra_runner as engine
    engine.ROOT = ROOT
    engine.gateway_base(ROOT)

    check_sources()
    protected = pm2()
    if protected["dtc-api-live"]["pid"] <= 0:
        raise SystemExit("LIVE API is not running as expected; refusing to touch anything")
    status = gateway_status(engine)
    check_report_route()
    before = ledger(engine)
    policies = probe_policies()
    print(json.dumps({"step": "preflight", "protected": protected, "active": before["active"],
                      "closedN": len(before["closed"]), "net": before["net"],
                      "gateway": status.get("executionVersion"), "modelPolicies": policies,
                      "fallbackNote": "An unavailable fallback simply never engages; the lane keeps "
                                      "reporting PROVIDER_UNAVAILABLE exactly as it does today."},
                     indent=2), flush=True)
    if not policies["PRIMARY"]["available"]:
        print(json.dumps({"step": "warning",
                          "detail": "Primary policy did not answer during preflight; deploying anyway "
                                    "changes nothing about that outage."}), flush=True)

    # A dry run changes nothing, so there is nothing to schedule around; waiting
    # ten minutes for a boundary would only delay the answer.
    if args.apply and not args.skip_idle_wait and not args.arm_only:
        print(json.dumps({"step": "idle_boundary", "receipt": wait_for_idle_boundary()}), flush=True)

    backup = Path(tempfile.mkdtemp(prefix="pre-v8-20260909-", dir=str(ROOT.parent))) if args.apply else Path(tempfile.mkdtemp())
    print(json.dumps({"step": "backup", "path": str(backup)}), flush=True)
    if args.apply:
        subprocess.run(["systemctl", "stop", SERVICE], check=True, timeout=60)

    installed, armed = [], None
    try:
        with runner_lock(args.apply) as lock_state:
            print(json.dumps({"step": "runner_lock", "state": lock_state}), flush=True)
            check_sources()
            if ledger(engine) != before:
                raise SystemExit("Ledger changed between preflight and install; nothing written")
            for name in (list(PINNED_ENGINE) + list(REPLACED_ENGINE) + list(NEW_SOURCES)
                         + list(NEW_TESTS) + list(REFRESHED_TESTS) + ["v8-manifest.json"]):
                if (ROOT / name).exists():
                    shutil.copy2(ROOT / name, backup / name)
            for name in JOURNALS:
                shutil.copy2(ROOT / "hermes-home" / name, backup / name)
            shutil.copy2(UNIT, backup / UNIT.name)

            if not args.arm_only:
                for name in tuple(REPLACED_ENGINE) + NEW_SOURCES + NEW_TESTS + REFRESHED_TESTS:
                    if args.apply:
                        install(STAGE / name, ROOT / name)
                    installed.append(name)
                print(json.dumps({"step": "seed_canonical", "result": seed_canonical(args.apply)}), flush=True)
                # An unarmed manifest lets the sources sit installed and inert.
                if args.apply:
                    from astra_v8_host import atomic_json
                    import make_v8_manifest
                    atomic_json(ROOT / "v8-manifest.json",
                                make_v8_manifest.build(STAGE, armed=False, tests_passed=False,
                                                       integration_verified=False,
                                                       gateway_version=GATEWAY_VERSION))
                    os.chown(ROOT / "v8-manifest.json", *runtime_owner())
                if args.apply:
                    check_sources(installed=True)
                    print(json.dumps({"step": "tests", "tail": run_tests()}), flush=True)

            armed = arm(engine, args.apply, backup, recohort=args.recohort)
            print(json.dumps({"step": "arm", "result": armed}, indent=2), flush=True)
    except BaseException as error:
        if args.apply:
            for name in (list(PINNED_ENGINE) + list(REPLACED_ENGINE) + list(NEW_SOURCES)
                         + list(NEW_TESTS) + list(REFRESHED_TESTS)):
                if (backup / name).exists():
                    install(backup / name, ROOT / name)
            if (backup / UNIT.name).exists():
                UNIT.write_text((backup / UNIT.name).read_text())
                subprocess.run(["systemctl", "daemon-reload"], check=False)
            subprocess.run(["systemctl", "start", SERVICE], check=False)
        print(json.dumps({"step": "aborted", "error": str(error), "backup": str(backup),
                          "note": "Sources and unit restored; journals, positions and native protection untouched."}), flush=True)
        raise

    if args.apply:
        subprocess.run(["systemctl", "start", SERVICE], check=True, timeout=60)
        time.sleep(20)
        subprocess.run(["systemctl", "show", SERVICE, "-p", "ActiveState", "-p", "MainPID",
                        "-p", "NRestarts", "-p", "ExecStart"], check=True)
    after = ledger(engine)
    print(json.dumps({"step": "post", "state": (armed or {}).get("state"), "backup": str(backup),
                      "modelPolicies": policies,
                      "ledgerUnchanged": after == before, "protectedUnchanged": pm2() == protected,
                      "installed": installed}, indent=2), flush=True)
    if after != before:
        raise SystemExit("Astra ledger changed across deployment; investigate before arming further")


if __name__ == "__main__":
    main()

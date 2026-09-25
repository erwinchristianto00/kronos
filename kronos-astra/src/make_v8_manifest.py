"""Build, inspect or arm the V8 release manifest. Host-only; no journal is touched.

The manifest is the only thing that lets `astra_v8_supervisor` start: `release_gate`
refuses a partial build, a changed source file, a wrong gateway or an unarmed
release. Arming is therefore a separate, explicit step from installing files, which
is what makes STAGED_WAITING_FLAT possible — the sources can sit installed and inert
while the old runner keeps managing an open position.

The fingerprint is derived from the exact runtime hashes, so editing any listed file
changes the cohort identity and every already-enrolled assignment stops matching.
That is deliberate: a mid-cohort source edit must not silently continue the cohort.
"""
import argparse
import hashlib
import json
from pathlib import Path

from astra_v8_host import COHORT, GATEWAY_VERSION, atomic_json, digest

# Worker + engine sources whose exact bytes define this cohort. The first eight are
# required by verify_manifest(); the rest are the engine modules the worker imports,
# listed so an unnoticed change to any of them also breaks the fingerprint.
RUNTIME_FILES = ("portfolio_attribution.py", "quant_snapshot.py", "quant_snapshot_host.py", "quant_measurements.py", "astra_v4_spec.py", "astra_quant_v4.py", "astra_replan_v2.py", "astra_v8_supervisor.py", "astra_v8_runner.py", "astra_v8_host.py", "astra_v8_phase.py",
                 "astra_fast_v8.py", "astra_canonical_v8.py", "astra_models_v8.py",
                 # The router chooses which model decides, so a change to it MUST change
                 # the release identity; leaving it out would let routing ship unnoticed.
                 "hermes_model_policy_v1.py", "astra_router_v9.py", "astra_runner.py",
                 "astra_decisions.py", "astra_plans.py", "astra_experiments.py", "astra_cadence.py",
                 "astra_learning.py", "astra_procedures.py", "runner_host.py", "claude_availability.py")


RUNTIME_FILES = ("hermes_learner.py", "hermes_context.py", "narrative_attention.py", "astra_watch_queue.py", "dynamic_candidates.py", "dynamic_scan.py", "candidate_disposition.py", "hermes_dashboard.py", "hermes_decision_evidence.py", "quant_candidate_refresh.py") + RUNTIME_FILES


def runtime_hashes(root):
    root = Path(root)
    missing = [name for name in RUNTIME_FILES if not (root / name).is_file()]
    if missing:
        raise SystemExit("Incomplete V8 release; missing " + ", ".join(missing))
    return {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in RUNTIME_FILES}


def build(root, *, armed, tests_passed, integration_verified, gateway_version,
          started_at=None, legacy_decision_ids=()):
    """`started_at` and `legacy_decision_ids` fix the cohort boundary for membership().

    Membership is prospective: a decision belongs to V8 only if it was validated after
    the recorded start and is not one of the pre-existing decisions. Without both
    fields a profitable old close could later be read as V8's result.
    """
    files = runtime_hashes(root)
    return {"cohortId": COHORT, "fingerprint": digest(files), "armed": bool(armed),
            "runtimeFiles": files, "gatewayExecutionVersion": gateway_version,
            "testsPassed": bool(tests_passed), "integrationVerified": bool(integration_verified),
            "startedAt": started_at, "legacyDecisionIds": sorted(set(legacy_decision_ids)),
            "meaning": "Arming permits V8 orchestration only; it claims no profitability."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=str(Path(__file__).resolve().parent))
    parser.add_argument("--gateway-version", default=GATEWAY_VERSION)
    parser.add_argument("--arm", action="store_true", help="Set armed=true. Requires both evidence flags.")
    parser.add_argument("--tests-passed", action="store_true")
    parser.add_argument("--integration-verified", action="store_true")
    parser.add_argument("--write", action="store_true", help="Without this the manifest is only printed.")
    args = parser.parse_args()
    if args.arm and not (args.tests_passed and args.integration_verified):
        raise SystemExit("Refusing to arm without --tests-passed and --integration-verified")
    manifest = build(args.root, armed=args.arm, tests_passed=args.tests_passed,
                     integration_verified=args.integration_verified, gateway_version=args.gateway_version)
    path = Path(args.root) / "v8-manifest.json"
    if path.exists():
        old = json.loads(path.read_text())
        # A rewritten fingerprint mid-cohort orphans every enrolled assignment, so
        # say so loudly instead of quietly issuing a new identity.
        if old.get("fingerprint") != manifest["fingerprint"]:
            print("WARNING: runtime sources changed; fingerprint " + str(old.get("fingerprint"))[:16]
                  + " -> " + manifest["fingerprint"][:16] + ". Enrolled assignments will not match.")
    if args.write:
        atomic_json(path, manifest)
        print("WROTE " + str(path))
    print(json.dumps(manifest, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()

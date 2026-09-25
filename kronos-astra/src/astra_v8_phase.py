"""Operator-only, in-memory V8 phase preparation; never writes an old outcome."""
import copy
from astra_v8_host import COHORT, digest


def prepare_v8_phase(book, now, fingerprint, legacy_trade_ids, recohort=False):
    """Open the V8 cohort, or — with `recohort` — open a new one after a code change.

    Changing any runtime source changes the release fingerprint, and an assignment
    enrolled under the old one stops matching: entries block while management keeps
    working. That is the intended consequence, not a bug, because decisions made by
    changed code are not the same cohort. `recohort=True` is the operator-only way to
    say so out loud: it seals the running phase with its own boundary record and opens
    a new phase under the new fingerprint. Nothing is deleted or relabelled, and the
    previous phase keeps whatever it observed.
    """
    if not isinstance(fingerprint, str) or len(fingerprint) != 64:
        raise ValueError("Exact release fingerprint required")
    already = book.state.get("decisionVersion") == COHORT
    if already and not recohort:
        raise ValueError("V8 already initialized; no cohort reset")
    if recohort and not already:
        raise ValueError("Nothing to re-cohort; V8 has not been initialized")
    if already and _boundary_fingerprint(book) == fingerprint:
        raise ValueError("Re-cohort needs a different release fingerprint")
    if len(set(legacy_trade_ids)) != len(legacy_trade_ids):
        raise ValueError("Duplicate historical trade identity")
    original = book.state
    book.state = copy.deepcopy(original)
    try:
        study = book.active()
        if not study or study["status"] != "HOLDOUT":
            raise ValueError("Expected active HOLDOUT; review changed study before cutover")
        phase = study["phases"][-1]
        if phase.get("sealedAt"):
            raise ValueError("Current phase already sealed")
        phase["sealedAt"] = now
        phase["result"] = {"at": now, "passed": False,
                           "reason": "V8_RECOHORT_BOUNDARY" if recohort else "ORCHESTRATION_BOUNDARY",
                           "verdict": ("NO STRATEGY CONCLUSION; the V8 runtime sources changed, so these "
                                       "decisions belong to the previous release fingerprint"
                                       if recohort else
                                       "NO STRATEGY CONCLUSION; do not mix V8 decisions with older execution"),
                           "arms": book.phase_data(study, phase)["arms"]}
        book.new_phase(study, "HOLDOUT")
        study["phases"][-1].update(cohortId=COHORT, decisionVersion=COHORT, fingerprint=fingerprint)
        # This tag identifies orchestration enrollment, not the gateway binary.
        # The latter retains its independently verified final-book capability.
        book.state["decisionVersion"] = COHORT
        book.state["executionVersion"] = COHORT
        event = {"type": "ORCHESTRATION_BOUNDARY", "at": now, "cohortId": COHORT,
                 "recohort": bool(recohort),
                 "previousFingerprint": _boundary_fingerprint(book) if recohort else None,
                 "fingerprint": fingerprint, "studyId": study["id"], "previousPhaseId": phase["id"],
                 "phaseId": study["phases"][-1]["id"], "legacyTradeIds": sorted(legacy_trade_ids),
                 "resumeAfterMs": (now // 300000 + 1) * 300000,
                 "profitImprovement": "UNPROVEN"}
        book.state["events"].append(event)
        for key in ("versions", "assignments", "submissions", "planVersions", "tradeDecisions",
                    "basePolicyHash", "champion", "gates"):
            if book.state[key] != original[key]:
                raise ValueError("Protected history/policy changed: " + key)
        return event
    except BaseException:
        book.state = original
        raise


def _boundary_fingerprint(book):
    """The fingerprint of the V8 boundary currently in force, or None."""
    for event in reversed(book.state.get("events", [])):
        if event.get("type") == "ORCHESTRATION_BOUNDARY" and event.get("cohortId") == COHORT:
            return event.get("fingerprint")
    return None


def membership(decision, manifest):
    """Prospective membership, never inferred from a profitable post-cutover close."""
    return bool(decision.get("cohortId") == COHORT
                and decision.get("fingerprint") == manifest.get("fingerprint")
                and isinstance(decision.get("validatedAt"), (int, float))
                and decision["validatedAt"] >= manifest["startedAt"]
                and decision.get("id") not in manifest.get("legacyDecisionIds", []))


def validate_assignment(book, assignment, manifest, at):
    boundary = next((e for e in reversed(book.state.get("events", []))
                     if e.get("type") == "ORCHESTRATION_BOUNDARY" and e.get("cohortId") == COHORT), None)
    if (book.state.get("decisionVersion") != COHORT or not boundary
            or boundary.get("fingerprint") != manifest.get("fingerprint")
            or at < boundary["resumeAfterMs"]
            or assignment.get("executionVersion") != COHORT
            or assignment.get("at", 0) < boundary["resumeAfterMs"]):
        raise ValueError("V8 phase not admitted; management remains available, no new entry")
    study = next((s for s in book.state["studies"] if s["id"] == assignment.get("studyId")), None)
    phase = next((p for p in study["phases"] if p["id"] == assignment.get("phaseId")), None) if study else None
    if (not phase or phase.get("fingerprint") != manifest["fingerprint"]
            or phase.get("cohortId") != COHORT):
        raise ValueError("Assignment does not belong to V8 phase")
    return True


def fail_fast_review(closed, *, operational_failures=(), prior_review=None):
    """Operational checkpoints are not promotion gates or permission to tune alpha."""
    n = len(closed)
    if operational_failures:
        return {"checkpoint": "IMMEDIATE_CORRECTNESS", "recommendation": "STOP",
                "reason": "Proven operational invariant failure", "automaticAction": False}
    if n < 3:
        return {"checkpoint": "ACCUMULATING", "recommendation": "INSUFFICIENT_EVIDENCE", "automaticAction": False}
    stage = "LATENCY_DISPLACEMENT_LESSON_USAGE" if n <= 5 else "EXPECTANCY_MANAGEMENT_DIRECTION" if n <= 9 else "PRACTICAL_TESTNET_REVIEW"
    net = sum(t["net"] for t in closed)
    return {"checkpoint": stage, "closedN": n, "net": net,
            "recommendation": "REVIEW_REQUIRED", "automaticAction": False,
            "meaning": "Choose KEEP_RUNNING / REVISE_ONE_DOMINANT_FAILURE / STOP using canonical evidence; no automatic capital or LIVE promotion"}

"""Prospective, versioned Testnet strategy trials. No exchange or arbitrary code access.

Calendar-block bootstrap is an empirical screening heuristic, not a profit guarantee,
a certified causal effect, or a valid confidence interval under arbitrary dependence.
"""
import copy
import hashlib
import math
import json
import os
import random
import secrets
import statistics
import time

import hermes_learner

DAY = 86400000
GATES = {"minClosedPerArm": 30, "minPairedDays": 10, "minSymbols": 3,
         "maxStageDays": 30, "minCompletionRate": .95, "minProfitFactor": 1.1,
         "maxSymbolAbsPnlShare": .5, "maxNotionalPerCycleRatio": 1.25,
         "drawdownBpsFloor": 25, "maxDrawdownRatio": 1.1,
         "bootstrapDraws": 10000, "lowerQuantile": .01}
DIMENSIONS = ("entryEvidence", "invalidationEvidence", "opportunityRanking", "holdingRationale")

# Every enrolled slot ends in exactly one outcome. Provider and budget losses are
# resource constraints, NOT model behaviour, so they never score as a failed
# evaluation; a host-screened slot is a real evaluation with a verified result.
# SCREENED_NOT_ADMITTED is the slot the host was barred from entering at all — a
# cohort boundary or a phase it does not belong to. Like the other constraints it is
# not model behaviour, and unlike a screen it is not an evaluation either.
OUTCOME_COMPLETED = ("MODEL_DECISION", "SCREENED_NO_TRADE")
OUTCOME_EXCLUDED = ("PROVIDER_UNAVAILABLE", "SCREENED_BUDGET", "SCREENED_RETRY_BACKOFF",
                    "SCREENED_NOT_ADMITTED", "SCREENED_CONTEXT_PREPARING",
                    "SCREENED_PREPARATION_SELECTION_CHANGED", "SCREENED_CANDIDATE_DATA_UNAVAILABLE")
OUTCOMES = OUTCOME_COMPLETED + OUTCOME_EXCLUDED + ("MODEL_INCOMPLETE",)
SLOT = 300000  # one enrollment slot; assignments are keyed by this window
RUNNING = ("HOLDOUT", "FORWARD", "MONITOR")
# A study can end because its evidence answered the question, or because the
# protocol was never met. The second is not a verdict about the candidate.
INVALIDATION_REASONS = ("INFRASTRUCTURE", "PROTOCOL")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def completion(assignments):
    """Reliability over slots the lane could actually be evaluated in.

    Legacy assignments predate outcome classification and keep their recorded
    `completed` flag; their history is scored as it was written, never rewritten.
    """
    scored = [a for a in assignments if a.get("outcome") not in OUTCOME_EXCLUDED]
    done = sum(a["completed"] for a in scored)
    return {"completionRate": done/len(scored) if scored else 0,
            "completedAssignments": done, "scoredAssignments": len(scored),
            "excludedAssignments": len(assignments) - len(scored),
            "outcomes": {o: sum(a.get("outcome") == o for a in assignments) for o in OUTCOMES},
            "unclassifiedLegacy": sum(a.get("outcome") is None for a in assignments)}


def reliability_outlook(phase, data, now):
    """How many further flawless slots reliability still needs, and whether the
    deadline can still contain them. Surfaced every cycle so a contaminated
    denominator is visible on day one instead of at the enrollment deadline."""
    gap = GATES["minCompletionRate"] * data["scoredAssignments"] - data["completedAssignments"]
    needed = max(0, math.ceil(gap / (1 - GATES["minCompletionRate"])))
    left = int(max(0, (phase["start"] + GATES["maxStageDays"] * DAY - now) // SLOT))
    return {"perfectSlotsToReachReliability": needed, "slotsBeforeDeadline": left,
            "reliabilityReachable": needed <= left,
            "perfectShareOfRemaining": round(needed / left, 4) if left else None,
            "meaning": "Deadline arithmetic assuming zero further failures, not a feasibility claim. "
                       "Below the gate every further failed slot costs about 19 flawless ones; "
                       "perfectShareOfRemaining is the fraction of every remaining slot that must succeed"}


# Outcomes only a worker can record, so reaching one is itself proof a job ran.
DISPATCHED_OUTCOMES = ("MODEL_DECISION", "MODEL_INCOMPLETE", "PROVIDER_UNAVAILABLE")


def was_dispatched(assignment):
    """Did a job actually run for this slot?

    Either witness alone is sufficient and neither can be talked out of the other: the
    host sets the flag before the worker starts, and the worker can only record these
    outcomes by having run. Taking the flag alone would miss slots enrolled before it
    existed; taking the outcome alone would miss a job that crashed before recording
    one, which is a dispatched cycle and must stay in the denominator.
    """
    return bool(assignment.get("dispatched")) or assignment.get("outcome") in DISPATCHED_OUTCOMES


def metrics(trades, cycles, assigned):
    ordered = sorted(trades, key=lambda t: (t["closedAt"], t["id"]))
    net = sum(t["net"] for t in ordered)
    notional = sum(t["entryNotional"] for t in ordered)
    win = sum(max(0, t["net"]) for t in ordered)
    loss = -sum(min(0, t["net"]) for t in ordered)
    equity = peak = dd = bps = bps_peak = bps_dd = 0
    symbols = {}
    for t in ordered:
        equity += t["net"]
        peak = max(peak, equity)
        dd = max(dd, peak-equity)
        bps += t["net"] / t["entryNotional"] * 10000
        bps_peak = max(bps_peak, bps)
        bps_dd = max(bps_dd, bps_peak-bps)
        symbols[t["symbol"]] = symbols.get(t["symbol"], 0) + abs(t["net"])
    absolute = sum(symbols.values())
    return {"closedN": len(ordered), "cycles": cycles, "assignedCycles": assigned, "net": net,
        "gross": sum(t["gross"] for t in ordered), "fees": sum(t["fees"] for t in ordered),
        "funding": sum(t["funding"] for t in ordered), "entryNotional": notional,
        # Per cycle the model was actually asked about. Dividing by every enrolled slot
        # measured how often the host dispatches, not how the strategy performed: most
        # slots are screened, so the figure came out diluted several times over. Both
        # counts are reported because the ratio between them is itself the thing to
        # watch — an arm that dispatches less gets a smaller denominator.
        "netPerDispatchedCycle": net/cycles if cycles else 0,
        "notionalPerDispatchedCycle": notional/cycles if cycles else 0,
        "expectancy": net/len(ordered) if ordered else None,
        "netBps": net/notional*10000 if notional else None,
        "profitFactor": win/loss if loss else None, "noLosses": loss == 0,
        "winRate": sum(t["net"] > 0 for t in ordered)/len(ordered) if ordered else None,
        "closedDrawdownUsd": dd, "sumTradeReturnDrawdownBps": bps_dd,
        "symbolN": len(symbols), "maxSymbolAbsPnlShare": max(symbols.values())/absolute if absolute else None}


class ExperimentBook:
    def __init__(self, root, base_policy_hash=None, now=None):
        self.path = root / "hermes-home/astra-experiments.json"
        self.now = now or (lambda: int(time.time()*1000))
        if self.path.exists():
            self.state = json.loads(self.path.read_text())
            if (self.state.get("version") != 1 or self.state.get("gates") != GATES
                    or (base_policy_hash and self.state.get("basePolicyHash") != base_policy_hash)):
                raise ValueError("Experiment identity/gates changed; explicit migration required")
            for key in ("versions", "assignments", "planVersions", "submissions", "tradeDecisions"):
                if not isinstance(self.state.get(key), dict):
                    raise ValueError("Invalid experiment state; no reset")
            if not isinstance(self.state.get("studies"), list) or self.state.get("champion") not in self.state["versions"]:
                raise ValueError("Invalid experiment champion/history")
        else:
            if not base_policy_hash:
                raise ValueError("No experiment journal")
            baseline = "baseline_" + base_policy_hash[:16]
            self.state = {"version": 1, "createdAt": self.now(), "basePolicyHash": base_policy_hash,
                "gates": copy.deepcopy(GATES), "champion": baseline, "versions": {
                    baseline: {"id": baseline, "kind": "BASELINE", "description": "Incumbent v5 discretionary policy; not a proven profitable champion"}},
                "studies": [], "assignments": {}, "planVersions": {}, "submissions": {},
                "tradeDecisions": {}, "evidence": None, "events": [], "watch": None}
        self.current = None

    def save(self):
        keep = self.path.stat() if self.path.exists() else None
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        with temporary.open("w") as stream:
            os.chmod(temporary, 0o600)
            json.dump(self.state, stream, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(self.path)
        if keep and (keep.st_uid, keep.st_gid) != (os.geteuid(), os.getegid()):
            # A maintenance script run as another user replaces this file with a
            # new inode it owns, locking the runner out of its own journal and
            # failing entries closed. Carry the original owner across the replace.
            os.chown(self.path, keep.st_uid, keep.st_gid)
            os.chmod(self.path, keep.st_mode & 0o777)

    def active(self):
        return next((s for s in reversed(self.state["studies"]) if s["status"] in RUNNING), None)

    def propose(self, proposal, learning):
        keys = {"name", "dimension", "oneChange", "hypothesis", "entryApplication", "invalidation", "disconfirmingEvidence", "lessonIds"}
        if not isinstance(proposal, dict) or set(proposal) != keys:
            raise ValueError("Complete bounded candidate proposal required")
        if proposal["dimension"] not in DIMENSIONS:
            raise ValueError("One supported strategy dimension required")
        for k in keys - {"lessonIds", "dimension"}:
            if not isinstance(proposal[k], str) or not 10 <= len(proposal[k]) <= 600:
                raise ValueError("Proposal text must be 10-600 characters per field")
        ids = proposal["lessonIds"]
        if not isinstance(ids, list) or not 1 <= len(ids) <= 5 or any(not isinstance(x, str) for x in ids) or len(set(ids)) != len(ids):
            raise ValueError("Link 1-5 actual source lessons")
        if not learning or not learning.fresh():
            raise ValueError("Fresh verified learning evidence required")
        available = {x["id"] for x in learning.state["lessons"]}
        if any(x not in available for x in ids):
            raise ValueError("Unknown source lesson")
        fingerprint = digest({"parent": self.state["champion"], "proposal": proposal})
        version_id = "candidate_"+fingerprint[:16]
        existing = self.state["versions"].get(version_id)
        if existing:
            prior = next((x for x in self.state["studies"] if x["candidate"] == version_id), None)
            if prior and prior["status"] in RUNNING:
                return existing  # idempotent retry inside the trial that is already running
            raise ValueError("This exact candidate already has a finished or invalidated trial; "
                             "propose a genuinely different one-dimension change")
        if self.active():
            raise ValueError("One candidate trial at a time; do not rewrite an ongoing held-out test")
        if self.current and self.current["version"] != self.state["champion"]:
            raise ValueError("Propose from the incumbent cycle only")
        version = {"id": version_id, "kind": "CANDIDATE", "parent": self.state["champion"],
            "registeredAt": self.now(), "trainingCutoff": self.now(), "proposal": copy.deepcopy(proposal),
            "sourceClosedIds": [t["id"] for t in learning.state["report"]["closed"]],
            "fingerprint": fingerprint, "basePolicyHash": self.state["basePolicyHash"]}
        version["effectiveChanges"] = copy.deepcopy(self.state["versions"][self.state["champion"]].get("effectiveChanges", {}))
        version["effectiveChanges"][proposal["dimension"]] = copy.deepcopy(proposal)
        self.state["versions"][version_id] = version
        study = {"id": "study_"+fingerprint[:16], "candidate": version_id, "control": self.state["champion"],
            "status": "HOLDOUT", "registeredAt": self.now(), "phases": [], "seed": secrets.token_hex(16)}
        self.new_phase(study, "HOLDOUT")
        self.state["studies"].append(study)
        self.save()
        return version

    def invalidate(self, study_id, reason, note):
        """Host-only: end a study whose evidence cannot support any verdict.

        This is NOT a strategy result. The protocol was not met, so the candidate
        is neither supported nor refuted. Assignments, submissions, trades and
        receipts are preserved exactly as recorded and never relabelled; the
        champion is unchanged. The model tool surface cannot reach this.
        """
        if reason not in INVALIDATION_REASONS:
            raise ValueError("Invalidation reason must be one of " + str(INVALIDATION_REASONS))
        if not isinstance(note, str) or not 20 <= len(note) <= 600:
            raise ValueError("Record a 20-600 character host note explaining the invalidation")
        study = next((s for s in self.state["studies"] if s["id"] == study_id), None)
        if not study:
            raise ValueError("Unknown study")
        if study["status"] not in RUNNING:
            raise ValueError("Study already finished with status " + study["status"])
        phase = study["phases"][-1]
        data = self.phase_data(study, phase)
        previous = study["status"]
        result = {"at": self.now(), "passed": False, "reason": "INVALIDATED_" + reason, "note": note,
            "verdict": "NO STRATEGY CONCLUSION: the protocol was not met, so the candidate is neither supported nor refuted",
            "reliabilityAtInvalidation": {k: data[k] for k in
                ("completionRate", "completedAssignments", "scoredAssignments",
                 "excludedAssignments", "outcomes", "unclassifiedLegacy")},
            "outlook": reliability_outlook(phase, data, self.now()),
            "arms": data["arms"], "pairedDays": len(data["pairedDays"]), "pending": data["pending"]}
        phase["sealedAt"] = self.now()
        phase["result"] = result
        study["status"] = "INVALIDATED_" + reason
        self.state["events"].append({"at": self.now(), "studyId": study["id"], "finishedPhase": phase["id"],
            "result": result, "previousChampion": self.state["champion"], "champion": self.state["champion"],
            "status": study["status"], "previousStatus": previous})
        self.save()
        return result

    def new_phase(self, study, name):
        study["status"] = name
        study["phases"].append({"id": len(study["phases"]), "name": name,
            "start": self.now(), "sealedAt": None, "result": None})

    def sync_evidence(self, learning, raw_report):
        if not learning.fresh():
            raise ValueError("Fresh host-verified evidence required")
        self.state["tradeDecisions"].update(learning.state["tradeDecisions"])
        self.state["evidence"] = {"at": learning.state["report"]["at"],
            "closed": copy.deepcopy(learning.state["report"]["closed"]),
            "excludedClosedN": learning.state["report"]["excludedClosedN"],
            "noFillIds": [x["id"] for x in raw_report.get("noFill", []) if x.get("state") == "NO_FILL"],
            "lastError": raw_report.get("lastError")}
        self.save()

    def fresh(self):
        e = self.state.get("evidence")
        return bool(e and abs(self.now()-e["at"]) <= 120000 and not e["lastError"] and not e["excludedClosedN"])

    def start_cycle(self):
        # Assignment precedes model/market reads. Retry of the same five-minute slot never redraws.
        slot = str(self.now()//300000)
        if slot in self.state["assignments"]:
            self.current = self.state["assignments"][slot]
            return self.current
        self.advance()
        study = self.active()
        phase = study["phases"][-1] if study else None
        # The learner study is continuous: its lessons graduate or retire one by one
        # on their own prospective evidence, so the 30-day enrolment deadline of a
        # one-shot proposal trial does not apply to it.
        if (phase and study.get("kind") != hermes_learner.STUDY_KIND
                and self.now()-phase["start"] >= GATES["maxStageDays"]*DAY and not phase["sealedAt"]):
            phase["sealedAt"] = self.now()  # Enrollment deadline holds even during a reporting outage.
        version = self.state["champion"]
        arm = "INCUMBENT"
        if phase and not phase["sealedAt"]:
            previous = [a for a in self.state["assignments"].values() if a["studyId"] == study["id"] and a["phaseId"] == phase["id"]]
            n = len(previous)
            flip = int(digest([study["seed"], phase["id"], n//2]), 16) % 2
            arm = "CANDIDATE" if n % 2 == flip else "CONTROL"
            version = study["candidate"] if arm == "CANDIDATE" else study["control"]
        assignment = {"id": slot, "at": self.now(), "version": version, "arm": arm,
            "executionVersion": self.state.get("executionVersion"),
            "studyId": study["id"] if phase and not phase["sealedAt"] else None,
            "phaseId": phase["id"] if phase and not phase["sealedAt"] else None,
            "completed": False, "outcome": None, "dispatched": False}
        self.state["assignments"][slot] = assignment
        self.current = assignment
        self.save()
        return assignment

    def finish_cycle(self, outcome):
        # Accepts the classified outcome; a bare bool stays valid for older callers.
        if outcome is True or outcome is False:
            outcome = "MODEL_DECISION" if outcome else "MODEL_INCOMPLETE"
        if outcome not in OUTCOMES:
            raise ValueError("Unknown cycle outcome: " + str(outcome))
        if self.current:
            self.current["outcome"] = outcome
            self.current["completed"] = outcome in OUTCOME_COMPLETED
            self.save()
        return outcome

    def record_screen_outcome(self, outcome):
        """Close a slot the host decided about without ever calling the model.

        `start_cycle` enrols every five-minute slot prospectively, but only a slot that
        dispatches a job ever reached `finish_cycle`. Slots the host screened out were
        left with no outcome at all and then counted as failed evaluations — the lane
        was scored down for cycles it was never asked to run. This is the other half of
        "every enrolled slot ends in exactly one outcome".

        Never overwrites: a slot that reached the model is described by what the model
        did, not by a later tick in the same slot deciding there was nothing to do.
        """
        if self.current and self.current.get("outcome") is None:
            return self.finish_cycle(outcome)
        return self.current.get("outcome") if self.current else None

    def bind_plan(self, plan):
        plan_id = plan["plan"]["id"]
        if plan_id not in self.state["planVersions"]:
            if not self.current:
                raise ValueError("No prospective cycle assignment")
            version = self.current["version"]
            if plan["createdAt"] < self.state["createdAt"]:
                version = next(v["id"] for v in self.state["versions"].values() if v["kind"] == "BASELINE")
            elif plan["createdAt"] < self.current["at"]:
                raise ValueError("Untracked plan from an earlier cycle cannot be retrospectively relabeled")
            self.state["planVersions"][plan_id] = {"version": version,
                "hash": digest(plan["plan"]), "at": self.now()}
            self.save()

    def check_entry(self, plan):
        if not self.current:
            raise ValueError("Strategy assignment unavailable; management exits unaffected")
        version = self.state["planVersions"].get(plan["plan"]["id"])
        if not version:
            # Only genuinely pre-v6 plans are grandfathered into the original baseline.
            if plan["createdAt"] >= self.state["createdAt"]:
                raise ValueError("Plan lacks prospective strategy provenance")
            baseline = next(v["id"] for v in self.state["versions"].values() if v["kind"] == "BASELINE")
            version = {"version": baseline, "hash": digest(plan["plan"])}
        if version["version"] != self.current["version"] or version["hash"] != digest(plan["plan"]):
            raise ValueError("Plan belongs to a different strategy version; preserve it for its assigned arm, never relabel it")
        lessons = self.learner_block(plan)
        if lessons:
            raise ValueError("HERMES_LESSON_BLOCK: " + " | ".join(hermes_learner.lesson_text(l) for l in lessons))

    def learner_arm(self):
        """The arm a Hermes lesson is enforced for: CANDIDATE/CONTROL only inside the learner study."""
        study = next((x for x in self.state["studies"] if x["id"] == (self.current or {}).get("studyId")), None)
        if study and study.get("kind") == hermes_learner.STUDY_KIND:
            return self.current["arm"]
        return "INCUMBENT"

    def learner_block(self, plan):
        """Lessons that block this plan now. Unreadable learner state blocks nothing."""
        state = hermes_learner.read_state_quiet(self.path.parent.parent)
        return hermes_learner.screen(state, plan, self.learner_arm(),
                                     context_builder=hermes_learner.default_builder({}))

    def register_learner_study(self, note):
        """Host-only: open the continuous Hermes learner A/B. Model tools cannot reach this."""
        if self.active():
            raise ValueError("Finish or invalidate the running study first")
        if not isinstance(note, str) or not 20 <= len(note) <= 600:
            raise ValueError("Record a 20-600 character host note")
        control = self.state["champion"]
        version_id = hermes_learner.LEARNER_VERSION_ID
        if version_id in self.state["versions"]:
            raise ValueError("Learner version already registered")
        self.state["versions"][version_id] = {"id": version_id, "kind": "CANDIDATE", "parent": control,
            "registeredAt": self.now(), "trainingCutoff": self.now(), "basePolicyHash": self.state["basePolicyHash"],
            "description": "Incumbent policy plus Hermes learner lessons: TESTING lessons are enforced only in "
                           "this arm, GRADUATED lessons in every arm. Lessons can only block a plan.",
            "effectiveChanges": copy.deepcopy(self.state["versions"][control].get("effectiveChanges", {})),
            "sourceClosedIds": [], "fingerprint": digest({"learner": hermes_learner.VERSION, "grid": hermes_learner.BINS_HASH})}
        study = {"id": "study_" + version_id, "kind": hermes_learner.STUDY_KIND, "candidate": version_id,
                 "control": control, "status": "HOLDOUT", "registeredAt": self.now(), "phases": [],
                 "seed": secrets.token_hex(16), "note": note}
        self.new_phase(study, "HOLDOUT")
        self.state["studies"].append(study)
        self.save()
        return study

    def record_submission(self, decision_id, plan):
        self.check_entry(plan)
        record = {"decisionId": decision_id, "planId": plan["plan"]["id"],
            "planHash": digest(plan["plan"]), "assignmentId": self.current["id"], "at": self.now(), "tradeId": None}
        old = self.state["submissions"].get(decision_id)
        if old:
            if old["planHash"] != record["planHash"] or old["assignmentId"] != record["assignmentId"]:
                raise ValueError("Submission provenance cannot change")
            return
        self.state["submissions"][decision_id] = record
        self.save()  # Before the order gateway POST; uncertain orders cannot be cherry-picked away.

    def record_result(self, decision_id, result):
        record = self.state["submissions"].get(decision_id)
        if (record and isinstance(result, dict) and result.get("status") == "ENTRY_REJECTED"
                and result.get("noOrderSubmitted") is True and not record.get("tradeId")
                and (result.get("entryGate") or {}).get("executionVersion") == "astra-final-book-contract-v1-20260909"):
            record["admissionRejected"] = copy.deepcopy(result["entryGate"])
            self.save()  # Explicit no-order result only; generic/uncertain rejections stay pending.
        if record and isinstance(result, dict) and result.get("id") and result.get("state"):
            record["tradeId"] = result["id"]
            self.state["tradeDecisions"][result["id"]] = decision_id
            self.save()

    def phase_data(self, study, phase):
        enrolled = [a for a in self.state["assignments"].values() if a["studyId"] == study["id"] and a["phaseId"] == phase["id"]]
        # Every enrolled cycle counts, whichever declared policy decided it. The policy
        # is lane-global: when it switches it switches for both arms at once, so within
        # any day both arms see the same policy mix and the paired-day delta cannot be
        # a model difference in disguise. What the policy does change is what the arm is
        # evidence about, so the composition is reported beside the metrics rather than
        # silently averaged away, and any day where the arms did NOT see the same set of
        # policies is counted separately — that is the case the pairing cannot absorb.
        assignments = enrolled
        ids = {a["id"]: a for a in assignments}
        e = self.state.get("evidence") or {"closed": [], "noFillIds": []}
        closed = {t["id"]: t for t in e["closed"]}
        decision_trade = {v: k for k, v in self.state["tradeDecisions"].items()}
        trades = {"CONTROL": [], "CANDIDATE": []}
        days = {}
        pending = 0
        for a in assignments:
            d = days.setdefault(a["at"]//DAY, {"CONTROL": {"cycles": 0, "assigned": 0, "net": 0, "roles": {}},
                                               "CANDIDATE": {"cycles": 0, "assigned": 0, "net": 0, "roles": {}}})
            d[a["arm"]]["assigned"] += 1
            # `cycles` is the day-block denominator, so it counts dispatched slots only.
            if was_dispatched(a):
                d[a["arm"]]["cycles"] += 1
            role = a.get("modelRole", "PRIMARY")
            d[a["arm"]]["roles"][role] = d[a["arm"]]["roles"].get(role, 0) + 1
        for decision, submission in self.state["submissions"].items():
            a = ids.get(submission["assignmentId"])
            if not a:
                continue
            if submission.get("admissionRejected") and not submission.get("tradeId"):
                continue  # Keep the assigned cycle denominator; no fill, no win, no pending exposure.
            trade_id = submission["tradeId"] or decision_trade.get(decision)
            if trade_id in e["noFillIds"]:
                continue  # Assigned cycle remains in denominator, net zero, never a winning fill.
            trade = closed.get(trade_id)
            if (not trade or not isinstance(trade.get("openedAt"), (int, float))
                    or trade["openedAt"] < submission["at"] or trade_id in self.state["versions"][study["candidate"]]["sourceClosedIds"]):
                pending += 1
                continue
            trades[a["arm"]].append(trade)
            days[a["at"]//DAY][a["arm"]]["net"] += trade["net"]
        metrics_by_arm = {arm: metrics(trades[arm],
                                       sum(a["arm"] == arm and was_dispatched(a) for a in assignments),
                                       sum(a["arm"] == arm for a in assignments)) for arm in trades}
        # A day where an arm dispatched nothing has no net-per-cycle to compare, so it
        # cannot be a paired day. This filters harder than the assigned-slot version did.
        paired = [d for day, d in sorted(days.items()) if day < self.now()//DAY and all(d[a]["cycles"] for a in trades)]
        roles = sorted({a.get("modelRole", "PRIMARY") for a in assignments})
        composition = {arm: {r: sum(1 for a in assignments
                                    if a["arm"] == arm and a.get("modelRole", "PRIMARY") == r) for r in roles}
                       for arm in trades}
        skewed = sum(set(d["CONTROL"]["roles"]) != set(d["CANDIDATE"]["roles"]) for d in paired)
        rates = {arm: (m["cycles"]/m["assignedCycles"] if m["assignedCycles"] else None)
                 for arm, m in metrics_by_arm.items()}
        both = [r for r in rates.values() if r]
        return {"arms": metrics_by_arm, "pending": pending, "assignments": assignments,
                "dispatchRateByArm": rates,
                # Dispatch is not perfectly arm-independent: an arm holding eligible plans
                # forms on the hourly interval instead of the empty-pipeline one, so it can
                # dispatch less and earn a smaller denominator. Same numerator, flattering
                # per-cycle figure. The ratio makes that visible instead of silent.
                "dispatchRateRatio": max(both)/min(both) if len(both) == 2 and min(both) else None,
                "dispatchRateMeaning": "Dispatched slots over enrolled slots, per arm. netPerDispatchedCycle "
                                       "divides by the dispatched count, so a ratio far from 1.0 means the "
                                       "arms were not measured over comparable opportunity.",
                "modelComposition": composition, "modelSkewedPairedDays": skewed,
                "modelCompositionMeaning": "Every enrolled cycle counts toward the comparison whichever declared "
                                           "policy decided it. The policy is lane-global, so a switch moves both "
                                           "arms together; modelSkewedPairedDays counts paired days where the arms "
                                           "did not see the same set of policies, the only case the pairing cannot "
                                           "absorb. A non-zero count makes the delta partly a model difference.",
                "pairedDays": paired, **completion(assignments)}

    def judge(self, study, phase, data):
        c, b = data["arms"]["CANDIDATE"], data["arms"]["CONTROL"]
        deltas = [d["CANDIDATE"]["net"]/d["CANDIDATE"]["cycles"] - d["CONTROL"]["net"]/d["CONTROL"]["cycles"] for d in data["pairedDays"]]
        rng = random.Random(digest([study["id"], phase["id"], "fixed-look-bootstrap"]))
        draws = sorted(statistics.mean(rng.choices(deltas, k=len(deltas))) for _ in range(GATES["bootstrapDraws"]))
        lower = draws[int(GATES["lowerQuantile"]*len(draws))]
        checks = {"positiveNet": c["net"] > 0, "positiveExpectancy": c["expectancy"] > 0,
            "profitFactor": (c["noLosses"] and c["net"] > 0) or (c["profitFactor"] or 0) >= GATES["minProfitFactor"],
            "betterNetPerCycle": c["netPerDispatchedCycle"] > b["netPerDispatchedCycle"],
            "betterCostAdjustedBps": c["netBps"] > b["netBps"], "positiveDayBlockLowerBound": lower > 0,
            "drawdown": c["sumTradeReturnDrawdownBps"] <= max(GATES["drawdownBpsFloor"], b["sumTradeReturnDrawdownBps"]*GATES["maxDrawdownRatio"]),
            "comparableExposure": c["notionalPerDispatchedCycle"] <= b["notionalPerDispatchedCycle"]*GATES["maxNotionalPerCycleRatio"],
            "symbolBreadth": c["symbolN"] >= GATES["minSymbols"] and b["symbolN"] >= GATES["minSymbols"],
            "concentration": (c["maxSymbolAbsPnlShare"] or 0) <= GATES["maxSymbolAbsPnlShare"],
            "reliability": data["completionRate"] >= GATES["minCompletionRate"]}
        return {"at": self.now(), "passed": all(checks.values()), "checks": checks,
            "arms": data["arms"], "pairedDays": len(deltas), "bootstrapLowerNetPerCycle": lower,
            # A verdict has to say which decision policies produced the evidence it rests on,
            # or a later reader cannot tell a strategy result from a model result.
            "modelComposition": data["modelComposition"], "modelSkewedPairedDays": data["modelSkewedPairedDays"],
            # The per-cycle gates divide by dispatched slots, so a verdict has to record
            # whether the two arms were dispatched at comparable rates.
            "dispatchRateByArm": data["dispatchRateByArm"], "dispatchRateRatio": data["dispatchRateRatio"],
            "caveat": "Fixed-look day-block empirical screen; dependence, regime change, shared-wallet interference and repeated candidate tests prevent any guaranteed causal/profit claim. Arms may mix decision policies; see modelComposition and modelSkewedPairedDays"}

    def advance(self):
        self.check_watch()
        study = self.active()
        if not study or not self.fresh():
            return
        if study.get("kind") == hermes_learner.STUDY_KIND:
            return  # judged lesson by lesson in hermes_learner, never by the 30-trade screen
        phase = study["phases"][-1]
        data = self.phase_data(study, phase)
        enough = (len(data["pairedDays"]) >= GATES["minPairedDays"] and
                  all(m["closedN"] >= GATES["minClosedPerArm"] for m in data["arms"].values()))
        timed_out = self.now()-phase["start"] >= GATES["maxStageDays"]*DAY
        if not enough and not timed_out:
            return
        if not phase["sealedAt"]:
            phase["sealedAt"] = self.now()
            self.save()  # Stop enrollment. Future cycles use incumbent while old exposures settle.
        if data["pending"]:
            return
        result = self.judge(study, phase, data) if enough else {"at": self.now(), "passed": False, "reason": "INSUFFICIENT_EVIDENCE_AT_DEADLINE", "arms": data["arms"]}
        phase["result"] = result
        previous = self.state["champion"]
        if not result["passed"]:
            study["status"] = "ROLLED_BACK" if phase["name"] == "MONITOR" else "REJECTED"
            if phase["name"] == "MONITOR":
                self.state["champion"] = study["control"]
        elif phase["name"] == "HOLDOUT":
            self.new_phase(study, "FORWARD")
        elif phase["name"] == "FORWARD":
            self.state["champion"] = study["candidate"]
            self.new_phase(study, "MONITOR")
        else:
            # Three separate fixed windows passed; allow a subsequent new candidate.
            # A separate non-overlapping actual-return watch remains on the champion.
            study["status"] = "PROMOTED_SCREEN_PASSED"
            self.state["watch"] = {"champion": study["candidate"], "fallback": study["control"],
                "after": self.now(), "seen": [], "drawdownLimitBps": max(GATES["drawdownBpsFloor"],
                    result["arms"]["CANDIDATE"]["sumTradeReturnDrawdownBps"]*GATES["maxDrawdownRatio"])}
        self.state["events"].append({"at": self.now(), "studyId": study["id"], "finishedPhase": phase["id"],
            "result": result, "previousChampion": previous, "champion": self.state["champion"], "status": study["status"]})
        self.save()

    def check_watch(self):
        watch = self.state.get("watch")
        if not watch or watch["champion"] != self.state["champion"] or not self.fresh():
            return
        eligible = []
        for trade in self.state["evidence"]["closed"]:
            submission = self.state["submissions"].get(self.state["tradeDecisions"].get(trade["id"]), {})
            a = self.state["assignments"].get(submission.get("assignmentId"), {})
            if a.get("version") == watch["champion"] and submission.get("at", 0) > watch["after"] and trade["id"] not in watch["seen"]:
                eligible.append(trade)
        eligible.sort(key=lambda t: (t["closedAt"], t["id"]))
        if len(eligible) < GATES["minClosedPerArm"]:
            return
        window = eligible[:GATES["minClosedPerArm"]]
        # A fixed window of closed outcomes, not a span of enrolled slots: this screen
        # reads only net and drawdown, so both counts are the window itself.
        m = metrics(window, len(window), len(window))
        watch["seen"].extend(t["id"] for t in window)
        if m["net"] <= 0 or m["sumTradeReturnDrawdownBps"] > watch["drawdownLimitBps"]:
            previous = self.state["champion"]
            self.state["champion"] = watch["fallback"]
            active = self.active()
            if active:
                active["status"] = "BASELINE_ROLLED_BACK"
            self.state["events"].append({"at": self.now(), "status": "WATCH_ROLLBACK", "previousChampion": previous,
                "champion": self.state["champion"], "metrics": m, "meaning": "Failed fixed 30-outcome operational screen; no forced position close"})
            self.state["watch"] = None
        self.save()

    def summary(self, offset=0):
        if type(offset) is not int or not 0 <= offset <= len(self.state["studies"]):
            raise ValueError("Invalid study offset")
        study = self.active()
        data = self.phase_data(study, study["phases"][-1]) if study else None
        history = list(reversed(self.state["studies"]))[offset:offset+3]
        assigned = self.state["versions"].get(self.current["version"]) if self.current else None
        assigned_view = {k: v for k, v in assigned.items() if k != "sourceClosedIds"} if assigned else None
        if assigned_view is not None:
            assigned_view["trainingClosedN"] = len(assigned.get("sourceClosedIds", []))
        return {"version": "STRATEGY_TRIAL_V1", "champion": self.state["champion"], "freshEvidence": self.fresh(),
            "assignment": self.current, "assignedStrategy": assigned_view,
            "activeStudy": {k: study[k] for k in ("id", "candidate", "control", "status")} if study else None,
            "progress": {"arms": data["arms"], "pairedDays": len(data["pairedDays"]), "pending": data["pending"],
                         "sealedAt": study["phases"][-1]["sealedAt"], "completionRate": data["completionRate"],
                         "scoredAssignments": data["scoredAssignments"], "excludedAssignments": data["excludedAssignments"],
                         "outcomes": data["outcomes"], "unclassifiedLegacy": data["unclassifiedLegacy"],
                         "completedAssignments": data["completedAssignments"],
                         **reliability_outlook(study["phases"][-1], data, self.now()),
                         "reliabilityMeaning": "Slots lost to the provider or the daily model budget are excluded as resource constraints, not scored as model behaviour"} if data else None,
            "executionVersion": self.state.get("executionVersion"),
            "gates": GATES, "studyN": len(self.state["studies"]),
            "postPromotionWatch": {k: v for k, v in self.state["watch"].items() if k != "seen"} if self.state.get("watch") else None,
            "recentStudies": [{"id": s["id"], "status": s["status"], "phases": s["phases"][-3:]} for s in history],
            "nextOffset": offset+len(history) if offset+len(history) < len(self.state["studies"]) else None,
            "warning": "HOLDOUT and FORWARD use only future actual Testnet entries after registration, not historical backtests. 50/50 blocked cycles through a separate post-promotion MONITOR stage; later non-overlapping 30-outcome rollback watch. LLM instructions are versioned, not deterministic signals; shared-memory and shared-wallet interference can weaken causal interpretation. Profit NOT guaranteed. Exits never reset."}


EXPERIMENT_SCHEMA = {"name": "astra_experiment", "description": "Versioned strategy trial. LIST current host-assigned arm and immutable promotion criteria. PROPOSE one evidence-linked hypothesis change for FUTURE cycles, never edit active rules, assign own arm, relabel trades or force promotion. No code, tools, credential or LIVE authority.",
    "parameters": {"type": "object", "properties": {"operation": {"type": "string", "enum": ["LIST", "PROPOSE"]}, "offset": {"type": "integer", "minimum": 0},
        "proposal": {"type": "object", "properties": {**{k: {"type": "string"} for k in ("name", "oneChange", "hypothesis", "entryApplication", "invalidation", "disconfirmingEvidence")},
            "dimension": {"type": "string", "enum": list(DIMENSIONS)},
            "lessonIds": {"type": "array", "items": {"type": "string"}}},
            "required": ["name", "dimension", "oneChange", "hypothesis", "entryApplication", "invalidation", "disconfirmingEvidence", "lessonIds"], "additionalProperties": False}}, "required": ["operation"], "additionalProperties": False}}

"""Lessons as versioned procedures that reach the next decision, and are then checked.

A lesson is delivered as an instruction the model can follow or refuse, never as a
silent veto: hard safety and active policy outrank it, and Astra still judges context.
Delivery is not obedience and obedience is not improvement, so the host verifies the
chain separately: lesson delivered, its data condition actually held, and what the
recorded action then did.
"""
import copy
import json
import os
import time

STATUSES = ("PROVISIONAL", "SUPPORTED", "REJECTED", "RETIRED")
DELIVERABLE = ("PROVISIONAL", "SUPPORTED")
APPLICATION = ("COMPLIANT", "DEPARTED", "NOT_APPLICABLE", "UNVERIFIABLE",
               "CORRECTLY_IGNORED", "SILENT_OMISSION", "DISPUTED_SCOPE")
# Conflict order. A lesson never outranks a risk limit or an active policy gate.
PRIORITY = ("HARD_SAFETY", "ACTIVE_POLICY", "APPLICABLE_LESSON", "DISCRETIONARY_ACTION")

FIELDS = ("applicability", "mechanism", "recommendedCheck", "exceptions")

# A procedure leaves PROVISIONAL only on repeated, distinct, model-cited evidence
# that the host could verify. SUPPORTED means "so far consistent with the cases
# looked at", never "proven" and never "profitable": these counts are cases, not
# a test, and the samples here are far too small to be one.
MIN_SUPPORTING = 3
MIN_CONTRADICTING = 2


def scope_holds(scope, context):
    """Does this procedure's scope cover the decision at hand?

    `action` is matched against what was being EVALUATED as well as what was
    finally done. A procedure that says "check this before entering long" applies
    to a long candidate that was considered and declined; scoring only the
    decisions that ended in an entry would make "procedure applied" mean "a trade
    happened", and would never credit correctly deciding not to trade.
    """
    if not scope:
        return True
    for key, wanted in scope.items():
        if key == "action":
            if wanted not in (context.get("action"), context.get("evaluatingAction")):
                return False
        elif context.get(key) != wanted:
            return False
    return True


def relevance(procedure, context):
    """How well a procedure matches the decision at hand. Deterministic, host-side."""
    scope = procedure.get("scope") or {}
    score = 0
    if scope.get("side") and scope["side"] == context.get("side"):
        score += 2
    if scope.get("symbol") and scope["symbol"] == context.get("symbol"):
        score += 3
    if scope.get("triggerKind") and scope["triggerKind"] == context.get("triggerKind"):
        score += 1
    if scope.get("action") and scope["action"] in (context.get("action"), context.get("evaluatingAction")):
        score += 2
    if not scope:
        score += 1  # a general procedure is weakly relevant to everything
    if procedure.get("status") == "SUPPORTED":
        score += 2
    return score


class ProcedureBook:
    def __init__(self, root, now=None):
        self.path = root / "hermes-home/astra-procedures.json"
        self.now = now or (lambda: int(time.time() * 1000))
        self.state = json.loads(self.path.read_text()) if self.path.exists() else {
            "version": 1, "procedures": {}, "deliveries": [], "verifications": []}
        self.state.setdefault("declined", {})
        for key, kind in (("procedures", dict), ("deliveries", list), ("verifications", list),
                          ("declined", dict)):
            if not isinstance(self.state.get(key), kind):
                raise ValueError("Invalid procedure journal; history not reset")
        if self.state.get("version") != 1:
            raise ValueError("Invalid procedure journal version; explicit migration required")

    def save(self):
        keep = self.path.stat() if self.path.exists() else None
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        with tmp.open("w") as stream:
            os.chmod(tmp, 0o600)
            json.dump(self.state, stream, allow_nan=False, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        tmp.replace(self.path)
        if keep and (keep.st_uid, keep.st_gid) != (os.geteuid(), os.getegid()):
            os.chown(self.path, keep.st_uid, keep.st_gid)
            os.chmod(self.path, keep.st_mode & 0o777)

    # --- authoring -------------------------------------------------------
    def publish(self, lesson_id, body, evidence_ids, scope=None):
        """Create or supersede a procedure. Model text; the host owns the evidence ids."""
        if not isinstance(lesson_id, str) or not 8 <= len(lesson_id) <= 80:
            raise ValueError("Invalid lesson id")
        if not isinstance(body, dict) or set(body) != set(FIELDS):
            raise ValueError("Procedure requires exactly " + ", ".join(FIELDS))
        for key in FIELDS:
            if not isinstance(body[key], str) or not 20 <= len(body[key]) <= 600:
                raise ValueError("Procedure text must be 20-600 characters per field: " + key)
        if not isinstance(evidence_ids, list) or not evidence_ids or len(set(evidence_ids)) != len(evidence_ids):
            raise ValueError("Cite at least one distinct evidence id")
        existing = self.state["procedures"].get(lesson_id)
        version = (existing["version"] + 1) if existing else 1
        procedure = {"lessonId": lesson_id, "version": version, "at": self.now(),
                     "body": copy.deepcopy(body), "evidenceIds": list(evidence_ids),
                     "scope": copy.deepcopy(scope) if isinstance(scope, dict) else {},
                     # A new hypothesis starts provisional however convincing it reads.
                     "status": "PROVISIONAL", "supporting": [], "contradicting": [],
                     "authorship": "MODEL_INTERPRETATION; evidence ids attached by the host"}
        self.state["procedures"][lesson_id] = procedure
        self.save()
        return procedure

    def retire(self, lesson_id, reason):
        procedure = self.state["procedures"].get(lesson_id)
        if not procedure:
            raise ValueError("Unknown procedure")
        if not isinstance(reason, str) or not 20 <= len(reason) <= 600:
            raise ValueError("Record a 20-600 character reason")
        procedure["status"] = "RETIRED"
        procedure["retiredAt"] = self.now()
        procedure["retiredReason"] = reason
        self.save()
        return procedure

    # --- evidence lifecycle ---------------------------------------------
    def record_outcome(self, lesson_id, evidence_id, supports, rationale=None):
        """Host-counted. One case never promotes on its own."""
        procedure = self.state["procedures"].get(lesson_id)
        if not procedure:
            raise ValueError("Unknown procedure")
        if procedure["status"] in ("RETIRED", "REJECTED"):
            raise ValueError("Procedure is already " + procedure["status"] + "; reopen it by publishing a new version")
        if not isinstance(evidence_id, str) or not evidence_id:
            raise ValueError("Cite the evidence id the host can verify")
        if rationale is not None and (not isinstance(rationale, str) or not 20 <= len(rationale) <= 600):
            raise ValueError("Evidence rationale must be 20-600 characters")
        bucket = "supporting" if supports else "contradicting"
        if evidence_id in procedure[bucket]:
            return self.assess(lesson_id)
        other = "contradicting" if supports else "supporting"
        if evidence_id in procedure[other]:
            raise ValueError("Evidence already counted the other way; do not double-book an outcome")
        procedure[bucket].append(evidence_id)
        procedure.setdefault("evidenceNotes", []).append(
            {"at": self.now(), "evidenceId": evidence_id, "supports": bool(supports), "rationale": rationale})
        procedure["evidenceNotes"] = procedure["evidenceNotes"][-50:]
        self.save()
        return self.assess(lesson_id)

    def assess(self, lesson_id):
        """Host gate. The model cites cases; only the host moves the status.

        A contradicted procedure is rejected ahead of promotion: evidence against
        a rule matters more than more evidence for it, and a rule that keeps
        failing should stop being delivered rather than accumulate defenders.
        """
        procedure = self.state["procedures"][lesson_id]
        if procedure["status"] in ("RETIRED", "REJECTED"):
            return procedure
        supporting, contradicting = len(procedure["supporting"]), len(procedure["contradicting"])
        previous = procedure["status"]
        if contradicting >= MIN_CONTRADICTING and contradicting >= supporting:
            procedure["status"] = "REJECTED"
        elif supporting >= MIN_SUPPORTING and contradicting == 0:
            procedure["status"] = "SUPPORTED"
        else:
            procedure["status"] = "PROVISIONAL"
        if procedure["status"] != previous:
            procedure["statusChangedAt"] = self.now()
            procedure["statusMeaning"] = (
                "Repeatedly consistent with the distinct cases looked at so far. Not proven, "
                "not a profitability claim, and not a licence to size up."
                if procedure["status"] == "SUPPORTED" else
                "Contradicted by cited cases and no longer delivered." if procedure["status"] == "REJECTED"
                else "Back to provisional as the evidence balance changed.")
        self.save()
        return procedure

    def decline(self, lesson_id, reason):
        """Record that a lesson was considered and deliberately not published.

        Without this the publication backlog can never reach zero: a lesson too
        weak or too narrow to guide a future decision would be offered forever.
        """
        if not isinstance(reason, str) or not 20 <= len(reason) <= 600:
            raise ValueError("Record a 20-600 character reason for not publishing")
        declined = self.state.setdefault("declined", {})
        if lesson_id in self.state["procedures"]:
            raise ValueError("Already published; retire it instead of declining it")
        declined[lesson_id] = {"at": self.now(), "reason": reason}
        self.save()
        return declined[lesson_id]

    # --- delivery --------------------------------------------------------
    def backlog(self, lesson_ids):
        """Lessons that have never become a procedure.

        The host already surfaces the review backlog; without the same for
        publication the model is never told this work exists, and silence gets
        misread as unwillingness.
        """
        known = set(self.state["procedures"])
        passed = set(self.state.get("declined") or {})
        pending = [x for x in (lesson_ids or []) if x not in known and x not in passed]
        return {"lessonsWithoutProcedure": len(pending), "examples": pending[:3],
                "declinedN": len(passed),
                "instruction": "Use astra_learn PUBLISH to turn a lesson you consider durable into a "
                               "versioned procedure for later decisions, or DECLINE it with a reason if "
                               "it is too weak or too specific to guide a future decision. Declining is a "
                               "valid outcome and clears it from this list. Use EVIDENCE to cite a case "
                               "that supports or contradicts a published procedure; the host counts the "
                               "cases and decides the status."}

    def deliver(self, context, limit=3, lesson_ids=None):
        """The few most relevant live procedures, not the whole journal."""
        live = [p for p in self.state["procedures"].values() if p["status"] in DELIVERABLE]
        ranked = sorted(live, key=lambda p: (-relevance(p, context), -p["at"]))[:max(0, limit)]
        delivered = [{"lessonId": p["lessonId"], "version": p["version"], "status": p["status"],
                      "body": p["body"], "scope": p["scope"], "evidenceIds": p["evidenceIds"],
                      "supportingN": len(p["supporting"]), "contradictingN": len(p["contradicting"])}
                     for p in ranked]
        return {"version": "PROCEDURE_DELIVERY_V1", "context": copy.deepcopy(context),
                "procedures": delivered, "liveN": len(live), "totalN": len(self.state["procedures"]),
                "backlog": self.backlog(lesson_ids),
                "priority": PRIORITY,
                "instruction": "Follow an applicable procedure or state why you departed from it. "
                               "A procedure never overrides a risk limit or an execution gate, and "
                               "never forces a trade. Naming a lessonId you did not use is a false claim.",
                "meaning": "Delivered into the decision context. Delivery is not obedience, and "
                           "obedience is not proof of improvement."}

    def record_delivery(self, decision_id, delivery):
        row = {"at": self.now(), "decisionId": decision_id,
               "delivered": [(p["lessonId"], p["version"]) for p in delivery["procedures"]],
               "context": delivery["context"]}
        self.state["deliveries"].append(row)
        self.state["deliveries"] = self.state["deliveries"][-500:]
        self.save()
        return row

    # --- verification ----------------------------------------------------
    def verify(self, decision_id, claimed_applied, claimed_rejected, condition_holds,
               claimed_not_applicable=None):
        """Did the claimed chain actually happen?

        `condition_holds` maps lessonId to whether the host could confirm the
        procedure's data condition in the snapshot. A lesson the model never
        received cannot have been applied, whatever the decision text says.
        """
        row = next((d for d in reversed(self.state["deliveries"]) if d["decisionId"] == decision_id), None)
        delivered = {lesson: version for lesson, version in (row["delivered"] if row else [])}
        results = {}
        # Every delivered procedure is accounted for, claimed or not. Scoring only
        # the ones the model named would hide both halves of the discrimination:
        # ignoring an inapplicable procedure is correct and should be visible,
        # and silently skipping an applicable one should not look like nothing.
        claimed = set(claimed_applied or []) | set(claimed_rejected or []) | set(claimed_not_applicable or [])
        for lesson in sorted(delivered):
            if lesson in claimed:
                continue
            holds = condition_holds.get(lesson)
            if holds is None:
                results[lesson] = {"application": "UNVERIFIABLE", "version": delivered[lesson],
                                   "why": "Host could not evaluate the procedure's data condition"}
            elif holds:
                results[lesson] = {"application": "SILENT_OMISSION", "version": delivered[lesson],
                                   "why": "Delivered and applicable, but the decision neither applied "
                                          "nor explicitly departed from it"}
            else:
                results[lesson] = {"application": "CORRECTLY_IGNORED", "version": delivered[lesson],
                                   "why": "Delivered but out of scope for this decision, and rightly not claimed"}
        # Judging a procedure out of scope is a third answer, not a refusal to follow
        # it. Where the host disagrees, that disagreement is the finding: it usually
        # means the scope means something different to each side.
        for lesson in sorted(claimed_not_applicable or []):
            if lesson not in delivered:
                results[lesson] = {"application": "UNVERIFIABLE", "version": None,
                                   "why": "Not delivered into this decision context; the claim cannot be checked"}
            elif condition_holds.get(lesson):
                results[lesson] = {"application": "DISPUTED_SCOPE", "version": delivered[lesson],
                                   "why": "The decision judged it out of scope while the host matched it; "
                                          "read the scope and the reason, not the label"}
            else:
                results[lesson] = {"application": "NOT_APPLICABLE", "version": delivered[lesson],
                                   "why": "Both the decision and the host place it out of scope"}
        for lesson in sorted(set(list(claimed_applied or []) + list(claimed_rejected or []))):
            if lesson not in delivered:
                results[lesson] = {"application": "UNVERIFIABLE", "version": None,
                                   "why": "Not delivered into this decision context; the claim cannot be checked"}
                continue
            holds = condition_holds.get(lesson)
            if holds is None:
                results[lesson] = {"application": "UNVERIFIABLE", "version": delivered[lesson],
                                   "why": "Host could not evaluate the procedure's data condition"}
            elif not holds:
                results[lesson] = {"application": "NOT_APPLICABLE", "version": delivered[lesson],
                                   "why": "Condition did not hold in the pre-decision snapshot"}
            else:
                applied = lesson in (claimed_applied or [])
                results[lesson] = {"application": "COMPLIANT" if applied else "DEPARTED",
                                   "version": delivered[lesson],
                                   "why": "Condition held and the decision followed it" if applied
                                          else "Condition held and the decision departed from it, with a stated reason"}
        record = {"at": self.now(), "decisionId": decision_id, "results": results,
                  "deliveredN": len(delivered),
                  "meaning": "Compliance with a procedure, not evidence that the procedure improves results"}
        self.state["verifications"].append(record)
        self.state["verifications"] = self.state["verifications"][-500:]
        self.save()
        return record

    def summary(self):
        procedures = list(self.state["procedures"].values())
        counted = [v for r in self.state["verifications"] for v in r["results"].values()]
        return {"version": "PROCEDURE_BOOK_V1",
                "byStatus": {s: sum(p["status"] == s for p in procedures) for s in STATUSES},
                "declinedN": len(self.state.get("declined") or {}),
                "promotionGate": {"minSupporting": MIN_SUPPORTING, "minContradicting": MIN_CONTRADICTING,
                                  "meaning": "Distinct host-verified cases the model cited. Cases, not a test."},
                "deliveries": len(self.state["deliveries"]),
                "applications": {a: sum(v["application"] == a for v in counted) for a in APPLICATION},
                "meaning": "Counts delivery and compliance only. No causal claim about profitability."}

"""Pre-entry lifecycle only. Replans have no order authority or gate exemptions.

Each version remains immutable; transitions and the child are committed in one
PlanBook transaction. Unknown submissions and owned exposure forbid reassessment.
"""
import copy
import hashlib
import json

from astra_plans import PlanBook as FrozenBook, finite

from hermes_model_policy_v1 import COHORT
ACTIONS = ("WAIT", "REPLAN", "ABANDON_SETUP")
RECOVERABLE = frozenset(("unexpired", "entryBand", "riskEnvelope", "spread", "cost",
                         "targetCoversCost", "fundingCovered"))
TERMINAL = frozenset(("REPLANNED", "ABANDONED", "EXPIRED"))
EXPLANATIONS = ("whatChanged", "whatRemainsValid", "newEvidence", "contradictingEvidence",
                "updatedInvalidation", "replanReason")


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                    allow_nan=False).encode()).hexdigest()


class PlanBook(FrozenBook):
    def recoverable_no_order(self, p):
        submission = self.state.get("submissions", {}).get(p.get("submissionId"), {})
        result = submission.get("result") or {}
        gate = result.get("entryGate") or {}
        return (result.get("status") == "ENTRY_REJECTED" and result.get("noOrderSubmitted") is True
                and gate.get("executionVersion") == "astra-final-book-contract-v1-20260909"
                and gate.get("planId") == p["plan"]["id"]
                and gate.get("failedPredicate") in RECOVERABLE)

    def record_rejection(self, p):
        if p.get("v2") and self.recoverable_no_order(p):
            gate = self.state["submissions"][p["submissionId"]]["result"]["entryGate"]
            p["v2"].update(status="REASSESS_REQUIRED", failedAt=p["v2"].get("failedAt", self.now()),
                           failedPredicates=[gate["failedPredicate"]], finalGatewayRejection=copy.deepcopy(gate))
            self.save()

    def save(self):
        if not getattr(self, "_in_transaction", False):
            super().save()

    def snapshot(self, symbol):
        row = self.rows.get(symbol) or {}
        now = self.now()
        stamp = row.get("observedAt")
        book = row.get("book") or {}
        candles = [c for c in row.get("candles", []) if finite(c.get("closeTime"))
                   and 0 <= now - c["closeTime"] <= 600000 and c["closeTime"] < now]
        quote_at = book.get("time")
        if (not finite(stamp) or not 0 <= now - stamp <= 120000 or not candles
                or not finite(quote_at) or not 0 <= now - quote_at <= 120000
                or not all(finite(book.get(k)) for k in ("bid", "ask"))
                or not 0 < book["bid"] <= book["ask"]
                or self.status.get("environment") != "testnet"):
            raise ValueError("Fresh verified Testnet snapshot required; no stale/future references")
        payload = {"symbol": symbol, "observedAt": stamp, "book": copy.deepcopy(book),
                   "candle": copy.deepcopy(max(candles, key=lambda c: c["closeTime"])),
                   "economics": copy.deepcopy(row.get("economics")),
                   "filters": copy.deepcopy(row.get("filters"))}
        identity = copy.deepcopy(payload)
        identity.pop('observedAt', None)
        identity['book'].pop('time', None)
        economics = identity.get('economics') or {}
        economics.pop('bookTime', None)
        for key in ('commission', 'funding'):
            if isinstance(economics.get(key), dict):
                economics[key].pop('observedAt', None)
                economics[key].pop('exchangeTime', None)
        return {**payload, 'snapshotMethodVersion': 'MATERIAL_ID_WITH_FRESHNESS_V2',
                'snapshotDataHash': fingerprint(payload), 'snapshotId': fingerprint(identity)}

    def create(self, plan):
        # A different id cannot silently reset an existing opportunity's budget.
        if isinstance(plan, dict) and not getattr(self, "_creating_child", False):
            for old in self.state["plans"]:
                if old["plan"]["id"] == plan.get("id"):
                    if not old.get("v2"):
                        raise ValueError("Legacy plan cannot be retroactively assigned to V2")
                    continue
                if old["plan"]["symbol"] != plan.get("symbol") or old.get("submissionId"):
                    continue
                if old.get("v2"):
                    if old["v2"]["status"] == "EXPIRED":
                        if self.snapshot(plan["symbol"])["candle"]["closeTime"] > old["plan"]["expiresAt"]:
                            continue  # A new closed hypothesis, not reuse of the expired plan.
                    if old["v2"]["status"] == "ABANDONED":
                        last = old["v2"]["transitions"][-1]["result"]["snapshot"]["candle"]["closeTime"]
                        if self.snapshot(plan["symbol"])["candle"]["closeTime"] > last:
                            continue
                    if old["v2"]["status"] == "REPLANNED":
                        continue  # the active descendant, not an ancestor, owns the opportunity
                    raise ValueError("Existing V2 opportunity: WAIT/ABANDON/REPLAN; new id cannot reset its budget")
        before = copy.deepcopy(self.state)
        self._in_transaction = True
        try:
            result = super().create(plan)
            p = self.get(result["plan"]["id"])
            if "v2" not in p:
                snap = self.snapshot(p["plan"]["symbol"])
                p["v2"] = {"rootPlanId": p["plan"]["id"], "parentPlanId": None,
                           "replanVersion": 0, "attempts": 0, "status": "FROZEN",
                           "createdSnapshot": snap, "transitions": [], "receipts": {}}
                self.evaluate(p)
            self._in_transaction = False
            self.save()
            return self.view(p)
        except BaseException:
            self.state = before
            raise
        finally:
            self._in_transaction = False

    def expire_unsubmitted(self, status):
        """Retire an expired executable plan, never declare its thesis false."""
        if status.get('environment') != 'testnet' or not isinstance(status.get('active'), list):
            raise ValueError('Verified ownership required for plan expiry')
        retired = []
        for p in self.state['plans']:
            if (not p.get('v2') or p['v2']['status'] in TERMINAL or p.get('submissionId')
                    or any(x.get('symbol') == p['plan']['symbol'] for x in status['active'])
                    or self.now() < p['plan']['expiresAt']):
                continue
            p['v2Retired'] = True
            p['v2'].update(status='EXPIRED', expiredAt=self.now(),
                           expiryMeaning='OLD_PLAN_EXPIRED_THESIS_NOT_ADJUDICATED')
            p['v2'].setdefault('transitions', []).append({'at': self.now(),
                'event': 'PLAN_EXPIRY', 'reason': 'ADMISSION_WINDOW_ENDED_NO_ORDER',
                'thesisValidity': 'NOT_ADJUDICATED'})
            retired.append(p['plan']['id'])
        if retired:
            self.save()
        return retired

    def evaluate(self, p):
        a = super().evaluate(p)
        v = p.get("v2")
        if not v:
            return a
        failed = set(a["failed"])
        # Waiting on the approach side of a not-yet-triggered entry is not a
        # failed executable plan. Never clear a genuine prior failure latch.
        q = p["plan"]
        px = a.get("executableReference")
        approach_wait = ("trigger" in failed and finite(px) and
                         (px < q["entryMin"] if q["side"] == "LONG" else px > q["entryMax"]))
        lifecycle_failures = failed - ({"entryBand"} if approach_wait else set())
        if v["status"] not in TERMINAL:
            if lifecycle_failures - RECOVERABLE - {"trigger"}:
                v["status"] = "REJECTED_HARD"
            elif lifecycle_failures & RECOVERABLE:
                if not v.get("failedAt"):
                    v["failedAt"] = self.now()
                    v["failedPredicates"] = sorted(failed)
                v["status"] = "WAITING" if v["status"] == "WAITING" else "REASSESS_REQUIRED"
            elif v["status"] in ("REJECTED_HARD", "AWAITING_ENTRY"):
                # A hard failure clearing grants no automatic entry to a retired plan.
                v["status"] = "REASSESS_REQUIRED" if v.get("failedAt") else "FROZEN"
        if v["status"] in TERMINAL or v.get("failedAt") or v["status"] == "WAITING":
            a["ready"] = False
            if "planLifecycle" not in a["failed"]:
                a["failed"].append("planLifecycle")
            # Current geometry passing does not revive a historically failed plan.
            # Expose both facts instead of presenting READY alongside ready=false.
            a["marketPlanStatus"] = a.get("planStatus")
            a["planStatus"] = "LIFECYCLE_BLOCKED"
            a["lifecycleStatus"] = v["status"]
            a["priorFailedPredicates"] = copy.deepcopy(v.get("failedPredicates", []))
            a["planStatusMeaning"] = ("Old plan is not executable. WAIT does not clear a prior failure. "
                "Use bounded REPLAN only with genuinely new structure/evidence, otherwise WAIT or ABANDON_SETUP. "
                "Current market checks passing is not order permission.")
        return a

    def view(self, p):
        view = super().view(p)
        if p.get("v2"):
            v = p["v2"]
            view["reassessment"] = {k: copy.deepcopy(v.get(k)) for k in
                                      ("rootPlanId", "parentPlanId", "replanVersion", "status",
                                       "failedAt", "failedPredicates", "createdSnapshot")}
            root = self.get(v["rootPlanId"])
            view["reassessment"]["attemptsUsed"] = root["v2"]["attempts"]
            view["reassessment"]["attemptsRemaining"] = max(0, 2-root["v2"]["attempts"])
            if v["status"] in TERMINAL or v.get("failedAt") or v["status"] == "WAITING":
                view["assessment"]["ready"] = False
        return view

    def reassess(self, args):
        required = {"id", "action", "setupId", "reason", "snapshotId"}
        allowed = required | {"plan", *EXPLANATIONS, "setupType", "playbooks", "evidenceCandleAt"}
        if not required <= set(args) or set(args)-allowed or args["action"] not in ACTIONS:
            raise ValueError("Explicit bounded V2 reassessment fields required")
        import re
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", str(args["id"])):
            raise ValueError("Invalid reassessment decision id")
        if not isinstance(args["reason"], str) or not 10 <= len(args["reason"]) <= 4000:
            raise ValueError("Concrete reassessment reason required")
        parent = self.get(args["setupId"])
        if not parent.get("v2"):
            raise ValueError("Legacy plan belongs to its original policy; create a V2 opportunity")
        root = self.get(parent["v2"]["rootPlanId"])
        old = root["v2"]["receipts"].get(args["id"])
        if old:
            if old["input"] != args:
                raise ValueError("Reassessment id reused with different input")
            return copy.deepcopy(old["result"])
        symbol = parent["plan"]["symbol"]
        if ((parent.get("submissionId") and not self.recoverable_no_order(parent))
                or (root.get("submissionId") and not self.recoverable_no_order(root))
                or symbol in self.unavailable
                or any(p.get("symbol") == symbol for p in self.status.get("active", []))):
            raise ValueError("Owned/submitted/unknown exposure cannot be replanned")
        if parent["v2"]["status"] in TERMINAL:
            raise ValueError("Terminal plan cannot be reassessed")
        snapshot = self.snapshot(symbol)
        if args['action'] == 'REPLAN' and snapshot["snapshotId"] != args["snapshotId"]:
            raise ValueError("STALE_REASSESSMENT: inspect the current supplied snapshot first")
        if args["action"] == "REPLAN" and root["v2"]["attempts"] >= 2:
            raise ValueError("Reassessment budget exhausted; WAIT or ABANDON_SETUP only")
        before = copy.deepcopy(self.state)
        self._in_transaction = True
        try:
            assessment = self.evaluate(parent)
            v = parent["v2"]
            action = args["action"]
            observation_only = False
            if action == "REPLAN":
                if not v.get("failedAt") or v["status"] == "REJECTED_HARD":
                    raise ValueError("Only a recoverable OLD PLAN failure permits REPLAN")
                if root["v2"]["attempts"] >= 2:
                    raise ValueError("Reassessment budget exhausted; WAIT or ABANDON_SETUP only")
                if any(not isinstance(args.get(k), str) or not 10 <= len(args[k]) <= 1000 for k in EXPLANATIONS):
                    raise ValueError("Changed/remaining thesis, evidence, contradiction and invalidation required")
                if args.get("setupType") not in ("KNOWN", "HYBRID", "NOVEL"):
                    raise ValueError("Explicit setupType required")
                if not isinstance(args.get("playbooks"), list) or any(k not in ("P1", "P2", "P3") for k in args["playbooks"]):
                    raise ValueError("P4/P5 are reference only; execution is unsupported")
                bar = snapshot["candle"]["closeTime"]
                if args.get("evidenceCandleAt") != bar or bar <= v["createdSnapshot"]["candle"]["closeTime"]:
                    raise ValueError("REPLAN needs newly closed market evidence, not a cosmetic quote reanchor")
                child = args.get("plan")
                if not isinstance(child, dict) or child.get("symbol") != symbol or child.get("id") == parent["plan"]["id"]:
                    raise ValueError("Child needs a new id and the same opportunity symbol")
                # User discretion cannot turn a cost rejection into a looser cost cap.
                for k in ("maxSpreadBps", "maxCostBps"):
                    if not finite(child.get(k)) or child[k] > parent["plan"][k]:
                        raise ValueError("REPLAN cannot loosen " + k)
                for k in ("entrySlippageBps", "exitSlippageBps", "fundingAllowanceBps"):
                    if not finite(child.get(k)) or child[k] < parent["plan"][k]:
                        raise ValueError("REPLAN cannot hide cost by reducing " + k)
                changed = {k: {"old": parent["plan"][k], "new": value} for k, value in child.items()
                           if k not in ("id", "thesis", "expiresAt") and parent["plan"].get(k) != value}
                if not changed:
                    raise ValueError("Cosmetic replan: no material plan field changed")
                # Validate with the exact incumbent constructor; no exemption from any gate.
                parent["v2Retired"] = True
                v["status"] = "REPLANNED"
                self._creating_child = True
                result = super().create(child)
                childrow = self.get(child["id"])
                childrow["v2"] = {"rootPlanId": v["rootPlanId"], "parentPlanId": parent["plan"]["id"],
                                  "replanVersion": v["replanVersion"]+1, "status": "FROZEN",
                                  "createdSnapshot": snapshot, "transitions": [], "receipts": {}}
                self.evaluate(childrow)
                v["childPlanId"] = child["id"]
            else:
                changed = {}
                if "plan" in args:
                    raise ValueError("WAIT/ABANDON cannot alter geometry or sizing")
                observation_only = (action == "WAIT" and not v.get("failedAt")
                                    and not set(assessment["failed"]) - {"trigger", "entryBand"})
                v["status"] = ("AWAITING_ENTRY" if observation_only else
                               "WAITING" if action == "WAIT" else "ABANDONED")
                parent["v2Retired"] = action == "ABANDON_SETUP"
            if action == "REPLAN" or not observation_only:
                root["v2"]["attempts"] = min(2, root["v2"]["attempts"]+1)
            result = {"status": v["status"], "action": action, "setupId": parent["plan"]["id"],
                      "childPlanId": v.get("childPlanId"), "rootPlanId": v["rootPlanId"],
                      "attemptsUsed": root["v2"]["attempts"], "changedFields": changed,
                      "snapshot": snapshot, "decisionSnapshotId": args['snapshotId'],
                      "hostValidation": copy.deepcopy(assessment),
                      "noOrderSubmitted": True, "thesisValidity": "MODEL_JUDGMENT_NOT_HOST_PROOF"}
            if action == "REPLAN":
                result["child"] = self.view(childrow)
            v["transitions"].append({"at": self.now(), "input": copy.deepcopy(args), "result": copy.deepcopy(result)})
            root["v2"]["receipts"][args["id"]] = {"input": copy.deepcopy(args), "result": copy.deepcopy(result)}
            self._in_transaction = False
            self.save()
            return result
        except ValueError as error:
            # Invalid geometry/evidence is still an attempted reassessment, not a
            # free retry. Preserve the parent and durably consume its shared budget.
            self.state = before
            parent = self.get(args["setupId"])
            root = self.get(parent["v2"]["rootPlanId"])
            root["v2"]["attempts"] = min(2, root["v2"]["attempts"]+1)
            result = {"status": "REASSESSMENT_REJECTED", "error": str(error),
                      "action": args["action"], "setupId": args["setupId"],
                      "attemptsUsed": root["v2"]["attempts"], "noOrderSubmitted": True,
                      "snapshot": snapshot}
            root["v2"]["receipts"][args["id"]] = {"input": copy.deepcopy(args), "result": copy.deepcopy(result)}
            parent["v2"]["transitions"].append({"at": self.now(), "input": copy.deepcopy(args), "result": copy.deepcopy(result)})
            self._in_transaction = False
            self.save()
            return result
        except BaseException:
            self.state = before
            raise
        finally:
            self._in_transaction = False
            self._creating_child = False

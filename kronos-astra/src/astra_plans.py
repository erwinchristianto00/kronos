"""Immutable prospective setup journal. No exchange access, orders, credentials or arbitrary paths.

Sampled opportunity paths are NOT fills, strategy PnL, or a full stop/target replay.
"""
import copy
import json
import math
import os
import re
import time
from pathlib import Path


FIELDS = {"id", "symbol", "side", "thesis", "triggerKind", "triggerPrice", "entryMin", "entryMax",
          "stopPrice", "targetPrice", "notionalUsd", "maxHoldMs", "expiresAt", "maxSpreadBps",
          "maxCostBps", "entrySlippageBps", "exitSlippageBps", "fundingAllowanceBps"}


# The system's existing "materially the same exposure" tolerance, reused from the
# trial gate's maxNotionalPerCycleRatio. Chosen a priori, NOT fitted to observed fills.
MAX_RISK_INFLATION = 1.25


def finite(value):
    return type(value) in (float, int) and math.isfinite(value)


ARRIVAL_TESTS = ("trigger", "entryBand")


def quote_economics(q, px, cost_bps=None, cap=MAX_RISK_INFLATION, cost_floor_bps=None):
    """Entry economics recomputed at an actual executable price.

    A plan freezes a trigger, a stop and a target. Entering far past the trigger
    leaves the reward where it was but moves the invalidation further away, so
    the trade actually taken is no longer the trade that was frozen and reviewed.
    riskInflation measures exactly that, and unlike a reward/risk ratio it cannot
    be improved by moving the target. Everything derives from frozen plan fields
    plus one observed price; nothing here is a forecast.
    """
    if not finite(px) or px <= 0:
        return None
    long, trigger, stop, target = q["side"] == "LONG", q["triggerPrice"], q["stopPrice"], q["targetPrice"]
    planned_risk = ((trigger - stop) if long else (stop - trigger)) / trigger * 10000
    risk = ((px - stop) if long else (stop - px)) / px * 10000
    economics = {
        "executablePrice": px,
        "plannedRiskBps": planned_risk,
        "riskAtQuoteBps": risk,
        "entryDisplacementBps": ((px - trigger) if long else (trigger - px)) / trigger * 10000,
        "rewardAtQuoteBps": ((target - px) if long else (px - target)) / px * 10000,
        "riskInflation": None, "withinRiskEnvelope": False, "maxRiskInflation": cap,
        "provenance": "FROZEN_PLAN_FIELDS_AND_ONE_OBSERVED_QUOTE_NOT_A_FILL"}
    if planned_risk > 0 and risk > 0:
        economics["riskInflation"] = risk / planned_risk
        economics["withinRiskEnvelope"] = economics["riskInflation"] <= cap
    if finite(cost_floor_bps):
        # The irreducible part of the cost: spread plus round-trip commission. Slippage
        # and the funding allowance are assumptions on top of it, so a reader can see
        # which portion of the modelled cost is certain and which is an estimate.
        economics["costFloorBps"] = cost_floor_bps
    if finite(cost_bps):
        reward_at_trigger = ((target - trigger) if long else (trigger - target)) / trigger * 10000
        economics["modelledAllInCostBps"] = cost_bps
        if finite(cost_floor_bps):
            economics["costAssumedBps"] = cost_bps - cost_floor_bps
        economics["netRewardAtQuoteBps"] = economics["rewardAtQuoteBps"] - cost_bps
        # Gross, before any cost. Stated so the three ratios below cannot be confused.
        economics["rrGrossAtQuote"] = (economics["rewardAtQuoteBps"] / risk) if risk > 0 else None
        economics["rrGrossAtPlan"] = (reward_at_trigger / planned_risk) if planned_risk > 0 else None
        # LEGACY: cost is taken off the reward but NOT added to the risk, so these
        # overstate the trade. Kept under an explicit name for backward compatibility;
        # do not read them as the economics of the trade.
        economics["rrAtQuoteDiagnosticLegacy"] = (economics["netRewardAtQuoteBps"] / risk) if risk > 0 else None
        economics["rrAtPlanDiagnosticLegacy"] = ((reward_at_trigger - cost_bps) / planned_risk) if planned_risk > 0 else None
        # Cost-symmetric: a win nets reward-cost, a loss costs risk+cost. This is the
        # ratio the trade actually offers. Still never a gate — a reward ratio rises
        # whenever the target is moved further away, which changes nothing real.
        economics["rrCostSymmetricAtQuote"] = (
            (economics["rewardAtQuoteBps"] - cost_bps) / (risk + cost_bps)) if (risk + cost_bps) > 0 else None
        economics["rrCostSymmetricAtPlan"] = (
            (reward_at_trigger - cost_bps) / (planned_risk + cost_bps)) if (planned_risk + cost_bps) > 0 else None
        economics["rrMeaning"] = ("rrCostSymmetric applies the modelled cost to BOTH outcomes and is the "
                                  "economics of the trade; rr*Legacy applies it to the reward only and reads "
                                  "higher. No ratio here is a gate.")
    return economics


class GeometryError(ValueError):
    def __init__(self, diagnostic):
        self.diagnostic = diagnostic
        super().__init__(
            "Entry band cannot satisfy the frozen stop's risk envelope. "
            + json.dumps(diagnostic, allow_nan=False, separators=(",", ":")))


def validate_entry_geometry(plan, cap=MAX_RISK_INFLATION):
    """Pure rejection-only preflight shared with admission. Never edits a plan.

    Bounds are continuous-price diagnostics, not rounded exchange prices or
    execution authority. quote_economics remains the authoritative predicate.
    """
    if plan.get("side") not in ("LONG", "SHORT"):
        raise ValueError("Invalid setup direction")
    keys = ("entryMin", "entryMax", "stopPrice", "targetPrice", "triggerPrice")
    if any(not finite(plan.get(k)) or plan[k] <= 0 for k in keys):
        raise ValueError("Positive finite geometry fields required")
    lo, hi, stop, target, trigger = (plan[k] for k in keys)
    long = plan["side"] == "LONG"
    if not lo <= hi or not (stop < lo <= hi < target if long else target < lo <= hi < stop):
        raise ValueError("Stop/target must bracket the entire entry band")
    best = quote_economics(plan, lo if long else hi, None, cap)
    if best and best["withinRiskEnvelope"]:
        return
    r = ((trigger-stop) if long else (stop-trigger)) / trigger
    denominator = (1-cap*r) if long else (1+cap*r)
    bound = stop/denominator if r > 0 and denominator > 0 else None
    if bound is not None and not finite(bound):
        bound = None
    raise GeometryError({
        "failureSubtype": "INFEASIBLE_ENTRY_GEOMETRY",
        "failedPredicate": "bestCaseRiskInflation <= maxRiskInflation",
        "bestCaseRiskInflation": best["riskInflation"], "maxRiskInflation": cap,
        "side": plan["side"], "triggerPrice": trigger, "stopPrice": stop,
        "entryMin": lo, "entryMax": hi,
        "continuousPriceLimit": bound, "limitOperator": "LTE" if long else "GTE",
        "plannedRiskValid": r > 0, "orderAuthority": False,
        "guidance": "Keep a structurally justified trigger/stop. Move entry toward trigger, not farther away; "
                    "narrowing away worsens inflation. If current quote is beyond this limit, WAIT or "
                    "reassess on new evidence. Do not alter stop/trigger/target or cap merely to pass. "
                    "Continuous limit is diagnostic; tick rounding and all execution guards still apply. "
                    "No plan frozen by this rejection; do not infer REPLAN attempts exhausted."})


class PlanBook:
    def __init__(self, root: Path, now=None, max_risk_inflation=None):
        if max_risk_inflation is None:
            max_risk_inflation = MAX_RISK_INFLATION
        elif not finite(max_risk_inflation) or not 1 <= max_risk_inflation <= 5:
            raise ValueError("maxRiskInflation must be a number between 1 and 5")
        self.cap = max_risk_inflation
        self.path = root / "hermes-home/astra-plans.json"
        self.now = now or (lambda: int(time.time() * 1000))
        self.rows = {}  # Only tool-observed current market evidence, never supplied by the model.
        self.status = {}
        self.unavailable = []
        self.state = json.loads(self.path.read_text()) if self.path.exists() else {"version": 1, "plans": [], "submissions": {}}
        if self.state.get("version") != 1 or not isinstance(self.state.get("plans"), list) or not isinstance(self.state.get("submissions"), dict):
            raise ValueError("Invalid setup journal; history not reset")

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        with tmp.open("w") as stream:
            os.chmod(tmp, 0o600)
            json.dump(self.state, stream, allow_nan=False, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        tmp.replace(self.path)

    def get(self, plan_id):
        p = next((p for p in self.state["plans"] if p["plan"]["id"] == plan_id), None)
        if not p:
            raise ValueError("Unknown setupId")
        return p

    def create(self, plan):
        if not isinstance(plan, dict) or set(plan) != FIELDS:
            raise ValueError("Complete frozen setup fields required; unknown fields rejected")
        existing = next((p for p in self.state["plans"] if p["plan"]["id"] == plan["id"]), None)
        if existing:
            if existing["plan"] != plan:
                raise ValueError("FROZEN_PLAN: thresholds, expiry and sizing cannot be edited")
            return self.view(existing)
        if not isinstance(plan["id"], str) or not re.fullmatch(r"[a-zA-Z0-9_-]{8,80}", plan["id"]):
            raise ValueError("Invalid setup id")
        if plan["side"] not in ("LONG", "SHORT") or plan["triggerKind"] not in ("CLOSE_ABOVE", "CLOSE_BELOW"):
            raise ValueError("Invalid setup direction/trigger")
        if not isinstance(plan["thesis"], str) or not 10 <= len(plan["thesis"]) <= 1000:
            length = len(plan["thesis"]) if isinstance(plan["thesis"], str) else None
            raise ValueError("Bounded falsifiable thesis required: 10-1000 characters; received %s. Shorten the explanation, not the frozen numeric rules." % length)
        for key in FIELDS - {"id", "symbol", "side", "thesis", "triggerKind"}:
            if not finite(plan[key]) or plan[key] < 0:
                raise ValueError("Invalid numeric field: " + key)
        if not 0 < plan["notionalUsd"] <= 25 or not 0 < plan["entrySlippageBps"] <= 100:
            raise ValueError("Preserve <=25 notional and gateway slippage range")
        if not 0 < plan["maxHoldMs"] <= 30 * 86400000 or not self.now() < plan["expiresAt"] <= self.now() + 86400000:
            raise ValueError("Positive hold <=30 days; admission expiry within24h")
        validate_entry_geometry(plan, self.cap)
        row = self.rows.get(plan["symbol"])
        if not row or self.now() - row["observedAt"] > 120000:
            raise ValueError("Inspect fresh selected-symbol candles/economics before freezing setup")
        if plan["notionalUsd"] < row.get("filters", {}).get("minNotional", math.inf):
            raise ValueError("Setup size below venue minimum; no automatic upsizing")
        commission = (row.get("economics") or {}).get("commission") or {}
        fee = commission.get("takerRate")
        # A nonnegative spread can never repair an internally contradictory cost
        # contract. Reject before freezing it, not after repeated paid reviews.
        # Unknown fees remain unknown; current spread alone is NOT a rejection
        # here because a prospective watch can legitimately await compression.
        if commission.get("status") == "AVAILABLE" and finite(fee) and fee >= 0:
            minimum = (2 * fee * 10000 + plan["entrySlippageBps"]
                       + plan["exitSlippageBps"] + plan["fundingAllowanceBps"])
            if minimum > plan["maxCostBps"]:
                raise ValueError(
                    "INFEASIBLE_COST_CONTRACT: zero-spread modelled cost %.8g bps "
                    "exceeds maxCostBps %.8g. Waiting for price/spread cannot repair "
                    "this contract at the observed fee. No plan frozen or order sent. "
                    "Do not inflate the cap or understate allowances merely to pass; "
                    "reassess the economics or select a different opportunity."
                    % (minimum, plan["maxCostBps"]))
        for old in self.state["plans"]:
            q = old["plan"]
            if q["symbol"] == plan["symbol"] and q["side"] == plan["side"] and self.now() < q["expiresAt"] and not old.get("submissionId") and not old.get("v2Retired"):
                raise ValueError("Existing unexpired setup: evaluate its frozen trigger, do not move the goalposts")
        p = {"plan": copy.deepcopy(plan), "createdAt": self.now(), "evaluations": [], "vetoes": [], "shadow": None}
        self.state["plans"].append(p)
        self.evaluate(p)
        self.save()
        return self.view(p)

    def observe(self, context):
        if context.get("source") != "BINANCE_USDM_TESTNET" or context.get("status", {}).get("environment") != "testnet":
            return
        self.status = context["status"]
        self.status_observed_at = self.now()
        self.unavailable = context.get("unavailableSymbols", [])
        for row in context.get("rows", []):
            self.rows[row["symbol"]] = {**copy.deepcopy(row), "observedAt": self.now()}
        # Overview quotes can measure already-triggered paths, but never replace missing candle evidence.
        books = {r["symbol"]: r.get("book") for r in context.get("overview") or []}
        for p in self.state["plans"]:
            if p["plan"]["symbol"] in self.rows:
                self.evaluate(p)
            book = books.get(p["plan"]["symbol"])
            if book:
                self.observe_path(p, book)
        if self.state["plans"]:
            self.save()

    def evaluate(self, p):
        q, now = p["plan"], self.now()
        row = self.rows.get(q["symbol"], {})
        book = row.get("book") or {}
        candle = max((c for c in row.get("candles", []) if finite(c.get("closeTime")) and c["closeTime"] < now),
                     key=lambda c: c["closeTime"], default={})
        bid, ask, stamp = book.get("bid"), book.get("ask"), book.get("time")
        quote_ok = all(finite(x) for x in (bid, ask, stamp)) and 0 < bid <= ask and 0 <= now - stamp <= 120000
        data_ok = quote_ok and finite(candle.get("close")) and 0 <= now - candle.get("closeTime", 0) <= 600000
        econ = row.get("economics") or {}
        fee = (econ.get("commission") or {}).get("takerRate")
        fees_ok = (econ.get("commission") or {}).get("status") == "AVAILABLE" and finite(fee) and fee >= 0
        px = ask if q["side"] == "LONG" else bid
        spread = (ask - bid) / ((ask + bid) / 2) * 10000 if quote_ok else None
        extra_cost = (2 * fee * 10000 + q["entrySlippageBps"] + q["exitSlippageBps"] + q["fundingAllowanceBps"]) if fees_ok else None
        cost = spread + extra_cost if quote_ok and fees_ok else None
        wallet = self.status.get("wallet") or {}
        available = (wallet.get("snapshot") or {}).get("availableBalance")
        funding = econ.get("funding") or {}
        settlement = funding.get("nextFundingTime")
        funding_cost = (funding.get("nextSettlementCostBpsIfRateUnchanged") or {}).get(q["side"])
        funding_ok = funding.get("status") == "INDICATIVE" and finite(settlement) and settlement > now and (
            settlement > now + q["maxHoldMs"] or finite(funding_cost) and q["fundingAllowanceBps"] >= max(0, funding_cost))
        cost_floor = (spread + 2 * fee * 10000) if quote_ok and fees_ok else None
        economics = quote_economics(q, px, cost, self.cap, cost_floor) if quote_ok else None
        tests = {
            "unexpired": now < q["expiresAt"], "dataFresh": data_ok, "feesAvailable": fees_ok,
            "trigger": data_ok and (candle["close"] >= q["triggerPrice"] if q["triggerKind"] == "CLOSE_ABOVE" else candle["close"] <= q["triggerPrice"]),
            "entryBand": quote_ok and q["entryMin"] <= px <= q["entryMax"],
            "spread": quote_ok and spread <= q["maxSpreadBps"],
            "cost": cost is not None and cost <= q["maxCostBps"],
            "fundingCovered": funding_ok,
            "targetCoversCost": cost is not None and abs(q["targetPrice"] - px) / px * 10000 > cost,
            "walletFresh": self.status.get("wallet", {}).get("fresh") is True,
            "walletAvailable": finite(available) and available >= q["notionalUsd"] * 1.002,
            "entryNotBlocked": self.status.get("entryBlock") is None and not self.status.get("lastError"),
            "symbolFree": q["symbol"] not in self.unavailable and not any(t.get("symbol") == q["symbol"] for t in self.status.get("active", [])),
            # The frozen stop defines the risk this thesis declared. An executable
            # price far past the trigger takes a materially different trade.
            "riskEnvelope": bool(economics and economics["withinRiskEnvelope"]),
        }
        ready = all(tests.values()) and not p.get("submissionId")
        failed = [k for k, v in tests.items() if not v]
        # A frozen plan is not a valid setup. `trigger` and `entryBand` only say the
        # price has not arrived yet; everything else says the trade would not be
        # admissible even if it did. Reporting one number for both made a plan that
        # failed spread/cost/riskEnvelope look like a setup merely waiting for price.
        blocking = [k for k in failed if k not in ARRIVAL_TESTS]
        status = ("READY" if ready else "ADMISSIBLE" if not blocking else "FROZEN")
        assessment = {"at": now, "ready": ready, "failed": failed,
                      "planStatus": status, "blockingFailures": blocking,
                      "awaitingPrice": [k for k in failed if k in ARRIVAL_TESTS],
                      "planStatusMeaning": "READY = every check passes now. ADMISSIBLE = only the price "
                                           "has not arrived (trigger/entryBand). FROZEN = at least one "
                                           "non-arrival check fails, so it is not a valid setup as it stands.",
                      "candleClose": candle.get("close"), "candleAt": candle.get("closeTime"),
                      "executableReference": px, "spreadBps": spread, "costBps": cost,
                      "quoteEconomics": economics}
        p["assessment"] = assessment
        if not p["evaluations"] or {k:v for k,v in assessment.items() if k != "at"} != {k:v for k,v in p["evaluations"][-1].items() if k != "at"}:
            p["evaluations"].append(assessment)
            p["evaluations"] = p["evaluations"][-100:]
        # Sample the path for setups this gate alone blocked, so the cost of the
        # gate is measurable in both directions: bad entries avoided AND good
        # opportunities forgone. These remain sampled quotes, never realised PnL.
        blocked_only_by_envelope = failed == ["riskEnvelope"] and not p.get("submissionId")
        if (ready or blocked_only_by_envelope) and p["shadow"] is None:
            p["shadow"] = {"startedAt": now, "entryQuote": px, "assumedCostExSpreadBps": extra_cost,
                           "sampleN": 0, "bestObservedGrossBps": None, "worstObservedGrossBps": None,
                           "lastAt": None, "status": "OBSERVING", "provenance": "SAMPLED_EXECUTABLE_QUOTES_NOT_FILLS",
                           "blockedBy": None if ready else "riskEnvelope"}
        self.observe_path(p, book)
        return assessment

    def observe_path(self, p, book):
        shadow, q, now = p.get("shadow"), p["plan"], self.now()
        if not shadow or shadow["status"] != "OBSERVING":
            return
        px, stamp = book.get("bid" if q["side"] == "LONG" else "ask"), book.get("time")
        if not finite(px) or px <= 0 or not finite(stamp) or not 0 <= now - stamp <= 120000 or stamp < shadow["startedAt"] or stamp <= (shadow["lastAt"] or 0):
            return
        gross = (px / shadow["entryQuote"] - 1) * (1 if q["side"] == "LONG" else -1) * 10000
        shadow.update(lastAt=stamp, lastObservedGrossBps=gross,
                      lastObservedNetEstimateBps=gross - shadow["assumedCostExSpreadBps"], sampleN=shadow["sampleN"] + 1)
        shadow["bestObservedGrossBps"] = max(gross, shadow["bestObservedGrossBps"] if shadow["bestObservedGrossBps"] is not None else gross)
        shadow["worstObservedGrossBps"] = min(gross, shadow["worstObservedGrossBps"] if shadow["worstObservedGrossBps"] is not None else gross)
        if stamp >= shadow["startedAt"] + q["maxHoldMs"]:
            lag = stamp - shadow["startedAt"] - q["maxHoldMs"]
            shadow.update(status="SAMPLED_HORIZON" if lag <= 600000 else "UNKNOWN_HORIZON_GAP", horizonLagMs=lag)

    def view(self, p):
        assessment = copy.deepcopy(p.get("assessment", {}))
        if self.now() - assessment.get("at", 0) > 120000 or self.now() >= p["plan"]["expiresAt"] or p.get("submissionId"):
            assessment["ready"] = False
            assessment["refreshRequired"] = self.now() - assessment.get("at", 0) > 120000
        return {"plan": p["plan"], "createdAt": p["createdAt"], "expired": self.now() >= p["plan"]["expiresAt"],
                "assessment": assessment, "submissionId": p.get("submissionId"), "vetoes": p["vetoes"][-3:], "shadow": p["shadow"]}

    def summary(self, offset=0):
        if type(offset) is not int or offset < 0:
            raise ValueError("Invalid setup offset")
        plans = sorted(self.state["plans"], key=lambda p: (self.now() >= p["plan"]["expiresAt"], -p["createdAt"]))
        blocked = sum(1 for p in plans if not p.get("submissionId")
                      and self.view(p)["assessment"].get("failed") == ["riskEnvelope"])
        return {"version": "FROZEN_SETUP_V1", "total": len(plans), "readyN": sum(bool(self.view(p)["assessment"].get("ready")) for p in plans),
                "blockedByRiskEnvelopeN": blocked,
                "riskEnvelopeMeaning": "Executable price would take a materially different trade than the frozen stop declared; both admitted and blocked setups keep sampled paths so the gate's cost is measurable in both directions",
                "submittedN": sum(bool(p.get("submissionId")) for p in plans), "declinedReadyN": sum(any(v["ready"] for v in p["vetoes"]) for p in plans),
                "plans": [self.view(p) for p in plans[offset:offset+10]], "nextOffset": offset+10 if offset+10 < len(plans) else None,
                "warning": "Prospective sampled quote paths, NOT earned PnL, complete candle replay, or proven missed profits. Refresh selected-symbol context before acting."}

    def veto(self, plan_id, decision_id, reason):
        p = self.get(plan_id)
        if not any(v["decisionId"] == decision_id for v in p["vetoes"]):
            p["vetoes"].append({"at": self.now(), "decisionId": decision_id, "ready": p.get("assessment", {}).get("ready", False), "reason": reason[:1000]})
            self.save()


PLAN_SCHEMA = {"name": "astra_plan", "description": "Freeze a falsifiable entry setup before waiting for it, or list previously frozen setups. Cannot edit/replace an unexpired same-symbol/side setup. Thresholds do not silently move when price reaches them. Does not place orders. Values are your prospective experiment, not a proven edge.",
    "parameters": {"type": "object", "properties": {
        "operation": {"type": "string", "enum": ["CREATE", "LIST"]}, "offset": {"type": "integer", "minimum": 0},
        "plan": {"type": "object", "properties": {
            **{k: {"type": "number"} for k in FIELDS - {"id", "symbol", "side", "thesis", "triggerKind"}},
            "id": {"type": "string", "minLength": 8, "maxLength": 80, "pattern": "^[a-zA-Z0-9_-]+$"}, "symbol": {"type": "string"},
            "thesis": {"type": "string", "minLength": 10, "maxLength": 1000,
                       "description": "Falsifiable thesis, 10-1000 characters. Put numeric thresholds in their dedicated fields; do not repeat the full audit here."},
            "side": {"type": "string", "enum": ["LONG", "SHORT"]},
            "triggerKind": {"type": "string", "enum": ["CLOSE_ABOVE", "CLOSE_BELOW"]}}, "required": sorted(FIELDS), "additionalProperties": False}},
        "required": ["operation"], "additionalProperties": False}}

PLAN_SCHEMA["parameters"]["properties"]["plan"]["properties"]["maxCostBps"]["description"] = (
    "All-in cap: spread + round-trip taker commission + entrySlippageBps + "
    "exitSlippageBps + fundingAllowanceBps. A cap below commission plus allowances "
    "is impossible even at zero spread. Do not increase it merely to force entry.")


ENTER_SCHEMA = {"name": "astra_enter", "description":
    "Explicit immediate OPEN decision in ONE call: freeze a new plan OR use an existing setupId, optionally bind an existing lesson prospectively, then recheck fresh execution conditions and submit through the same guarded Testnet gateway. Prefer this when you have ALREADY DECIDED to enter now; do not insert CREATE/LIST/APPLY round trips before OPEN. For watch-only plans use astra_plan CREATE. No future auto-execution, no chasing, no guard overrides. Do optional REVIEW/research after the entry decision. Reuse the exact id and payload after transport uncertainty.",
    "parameters": {"type": "object", "properties": {
        "id": {"type": "string", "minLength": 8, "maxLength": 80, "pattern": "^[a-zA-Z0-9_-]+$"},
        "reason": {"type": "string", "minLength": 10, "maxLength": 4000,
                   "description": "Your explicit entry decision and ex-ante risk/edge rationale; not a request merely to watch."},
        "plan": PLAN_SCHEMA["parameters"]["properties"]["plan"],
        "setupId": {"type": "string", "description": "Existing frozen plan; supply exactly ONE of plan or setupId."},
        "lesson": {"type": "object", "properties": {
            "lessonId": {"type": "string"},
            "rationale": {"type": "string", "minLength": 20, "maxLength": 800}},
            "required": ["lessonId", "rationale"], "additionalProperties": False}},
        "required": ["id", "reason"], "additionalProperties": False}}

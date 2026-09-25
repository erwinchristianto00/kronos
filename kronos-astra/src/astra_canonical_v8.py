"""Pure host canonical learning candidate. No filesystem, network or trading I/O.

Integration API (all inputs MUST come from host-owned records, never model JSON):

* canonical_evidence(report, status, legacy_journal, *, bindings={}, plans=(),
  decisions=(), post_fix_execution_versions=()) -> canonical rows. Accepts actual
  OWNED_ASTRA_LEDGER report and lane /status, not LearningBook's lossy projection.
  `plans` are PlanBook records (plan + submissionId). `bindings` maps trade/decision
  IDs to exact executionPolicyVersion/tradePolicyVersion/decisionVersion, cohort,
  fingerprint. Never pass the current release as historical default metadata.
  `decisions` are optional host receipts: id, action, outcome, validated=True,
  noOrderConfirmed=True, pending=False, at. A model's NO_TRADE alone proves nothing.
* CanonicalBook(overlay=None) -> append-only, versioned IN-MEMORY overlay.
  ingest(rows, legacy_journal) audits legacy without rewriting its source. export()
  returns a detached JSON-compatible journal for the integrating host to persist
  separately. Caller owns serialization, locking, atomic persistence and source
  authenticity. Restore checks the chain and per-entity version sequence.
* review(review_id, evidence_id, body) accepts model interpretation with `axes`
  (all seven AXES mapped to nonempty text), observedMechanism, requiredAction,
  exceptions and optional outcomeClassification. Stores model claims separately
  from host numeric/process findings; cannot promote a lesson or overwrite PnL.
* publish(lesson_id, body, evidence_ids, scope, condition, check, support, error_type)
  authors a procedure; status is computed from distinct canonical cases, never PnL.
  body requires observedMechanism/requiredAction/exceptions; predicates have `op`
  (eq/lte/gte/between), `field` (dotted host field), and value or min/max. Numeric
  operands can use {"field": "other.path"}. Unknown data yields UNKNOWN.
  check = {predicate, passActions, failActions}; both branches are explicit.
  support is a predicate against canonical evidence; >=3 distinct true cases and
  no false cases gives SUPPORTED, any false case CONTRADICTED, else PROVISIONAL.
* deliver(id, context, include_legacy=False, allowed_lesson_ids=None) freezes <=3 relevant SUPPORTED
  procedures. Context carries exact cohort/version/fingerprint, evaluated side,
  evaluatingAction, symbol, phase and pre-decision numeric observations. Entry
  LONG scope also matches a LONG evaluation whose final action is NO_TRADE.
* run_checks(id) computes checks over that frozen host snapshot BEFORE verify().
  verify(id, action, claimed_applied=(), rejected={}) records host compliance.
  No API accepts model-supplied "check performed" or "condition holds" booleans.
  Compliance means host check + consistent recorded action, not model cognition
  or profit improvement. Claims are diagnostic only. Repeats are idempotent;
  conflicting replay is an error. Re-evaluation needs a new decision ID.
* cohort_metrics(rows, applications=()) keeps exact cohort/fingerprint/version
  partitions, unknown exclusions, and separate application/repeat-error samples.
* ingest_applications(base_overlay, events) merges a FAST branch into a newer
  coaching overlay. Base must be an exact known prefix. Only DELIVERY/CHECKS/
  APPLICATION events are accepted, replayed against the original base to verify
  original frozen checks/actions. Then exact historical payloads are appended to
  the current chain, with an IMPORT_PROVENANCE record retaining source hashes.

Numeric missing values use the JSON string UNKNOWN (including PF without losses).
No planned entry, stop, target, quantity, prose or winning result becomes execution
evidence. Report PnL must reconcile to actual fills and accounting completion.
Legacy source IDs always retain LEGACY_EXECUTION and LEGACY_13 regardless of tags.
Old untagged executions remain LEGACY_EXECUTION; dates never imply a version.
Overlay provenance protects accidental edits, not a malicious host rewriting hashes.
"""

import copy
import hashlib
import json
import math
import re

UNKNOWN = "UNKNOWN"
V8 = "ASTRA_HERMES_FAST_LEARNING_V8"
ROUTER_V1 = "ASTRA_HERMES_ROUTER_V1"
# Every cohort this build treats as its own current execution. Renaming the cohort
# without listing it here would silently reclassify all new evidence as legacy and
# stop the lane's own lessons ever reaching a decision.
from hermes_model_policy_v1 import COHORT as SONNET_COHORT
CURRENT_COHORTS = (ROUTER_V1, V8, SONNET_COHORT)
LEGACY = "LEGACY_13"
VERSIONS = ("executionPolicyVersion", "tradePolicyVersion", "decisionVersion")
AXES = ("SETUP_SELECTION", "ENTRY_TIMING", "ENTRY_DISPLACEMENT",
        "POSITION_MANAGEMENT", "EXIT_DECISION", "EXECUTION_QUALITY",
        "UNFORESEEABLE_MARKET_CHANGE")
ACTIONS = {"ENTER_LONG", "ENTER_SHORT", "NO_TRADE", "HOLD", "HOLD_WITH_REASON",
           "TAKE_PROFIT", "CUT_LOSS"}
STATUSES = {"PROVISIONAL", "SUPPORTED", "CONTRADICTED", "RETIRED"}
# The module can express existing execution checks only, never new alpha rules.
PROCEDURAL_CHECKS = (
    {"op": "between", "field": "executableQuote", "min": {"field": "entryMin"}, "max": {"field": "entryMax"}},
    *({"op": "lte", "field": value, "value": {"field": limit}} for value, limit in
      (("spreadBps", "maxSpreadBps"), ("costBps", "maxCostBps"),
       ("riskUsd", "maxRiskUsd"), ("quoteAgeMs", "maxQuoteAgeMs"))),
)
SUPPORT_FIELDS = {"entryBoundaryViolation", "entryBandViolation", "entrySpreadViolation"}
CONDITION_FIELDS = {"side", "symbol", "phase", "action", "evaluatingAction"}


def _num(x):
    return type(x) in (int, float) and math.isfinite(x)


def _positive(x):
    return _num(x) and x > 0


def _known(x):
    return x is not None and x != UNKNOWN


def _value(x):
    return x if _num(x) else UNKNOWN


def _same(a, b):
    return _num(a) and _num(b) and math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-8)


def _median(values):
    """Exact middle of the observed numbers; an empty sample stays UNKNOWN."""
    values = sorted(x for x in values if _num(x))
    if not values:
        return UNKNOWN
    middle = len(values) // 2
    return values[middle] if len(values) % 2 else (values[middle - 1] + values[middle]) / 2


def _hash(x):
    return hashlib.sha256(json.dumps(x, sort_keys=True, separators=(",", ":"),
                                    allow_nan=False).encode()).hexdigest()


def _index(rows):
    result = {}
    for row in rows:
        key = row.get("id")
        if not isinstance(key, str) or not key:
            raise ValueError("Host record needs an ID")
        if key in result and result[key] != row:
            raise ValueError("Conflicting host records for " + key)
        result[key] = row
    return result


def _tags(*sources):
    out = {}
    # modelRole rides along but is deliberately NOT part of _partition: the operator
    # chose one cohort for both decision policies, so the merged numbers stay merged
    # and this field is what still lets them be told apart afterwards.
    for key in (*VERSIONS, "cohort", "fingerprint", "modelRole"):
        values = {s[key] for s in sources if isinstance(s.get(key), str) and s[key] not in ("", UNKNOWN)}
        out[key] = next(iter(values)) if len(values) == 1 else UNKNOWN
    return out


def _legacy_ids(journal):
    return {(x.get("review") or {}).get("tradeId") for x in journal.get("lessons", [])} - {None}


def _base(identifier, tags, legacy_ids, post_fix):
    old = identifier in legacy_ids
    if old:
        tags = {**tags, "cohort": LEGACY}
    current = (not old and tags["cohort"] in CURRENT_COHORTS and tags["executionPolicyVersion"] in post_fix
               and all(_known(tags[k]) for k in (*VERSIONS, "cohort", "fingerprint")))
    return {"evidenceId": identifier, **tags,
            "executionClass": "CURRENT_EXECUTION" if current else "LEGACY_EXECUTION",
            "evidenceQuality": "INSUFFICIENT_EVIDENCE", "eligible": False,
            "gross": UNKNOWN, "fees": UNKNOWN, "funding": UNKNOWN, "net": UNKNOWN,
            "executedQty": UNKNOWN, "averageFillPrice": UNKNOWN,
            "actualStopPrice": UNKNOWN, "actualTargetPrice": UNKNOWN,
            "decisionAt": UNKNOWN, "orderSubmittedAt": UNKNOWN, "orderFilledAt": UNKNOWN,
            "closedAt": UNKNOWN, "positionState": UNKNOWN,
            "entryBoundaryViolation": UNKNOWN, "adverseDisplacementBps": UNKNOWN,
            "entryBandViolation": UNKNOWN, "entrySpreadViolation": UNKNOWN,
            "marketDriftBps": UNKNOWN, "executionGapBps": UNKNOWN,
            "reviewAxes": dict.fromkeys(AXES, UNKNOWN), "repeatErrorType": UNKNOWN,
            "outcomeClassification": "INSUFFICIENT_EVIDENCE", "issues": []}


def _fills(trade):
    """Return normalized entry evidence only if every recorded fill is sound."""
    fills = trade.get("fills")
    entry = (trade.get("entry") or {}).get("order") or {}
    if not isinstance(fills, list) or not fills or not _known(entry.get("orderId")):
        return None
    seen = set()
    for f in fills:
        key = (f.get("orderId"), f.get("tradeId"))
        if (any(not _known(x) for x in key) or key in seen
                or not all(_positive(f.get(k)) for k in ("qty", "price", "time"))
                or not all(_num(f.get(k)) for k in ("commission", "realizedPnl"))
                or f["commission"] < 0 or f.get("commissionAsset") != "USDT"):
            return None
        seen.add(key)
    entered = [f for f in fills if f["orderId"] == entry["orderId"]]
    if not entered:
        return None
    qty = sum(f["qty"] for f in entered)
    average = sum(f["qty"] * f["price"] for f in entered) / qty
    if not _same(qty, trade.get("entryQty")) or not _same(qty, entry.get("executedQty")):
        return None
    if not _same(average, trade.get("entryPrice")):
        return None
    # avgPrice=0 on acknowledgements is NOT used as a price or a contradiction.
    if _positive(entry.get("avgPrice")) and not _same(average, entry["avgPrice"]):
        return None
    # Scoped host /status projections can omit exit handles, but retain the full
    # owned trade's fills. Non-entry fills then prove the closing quantity; full
    # handles, when supplied, must agree. Never accept unowned account-wide fills.
    exits = {f["orderId"] for f in fills if f["orderId"] != entry["orderId"]}
    if "exits" in trade:
        handles = {(x.get("order") or {}).get("orderId") for x in trade["exits"]}
        handles.add(trade.get("stopExitId"))
        if not exits <= handles:
            return None
    exit_qty = sum(f["qty"] for f in fills if f["orderId"] in exits)
    return {"qty": qty, "average": average, "exitQty": exit_qty,
            "gross": sum(f["realizedPnl"] for f in fills),
            "fees": sum(f["commission"] for f in fills),
            "firstAt": min(f["time"] for f in entered),
            "lastAt": max(f["time"] for f in fills),
            "fillIds": [[f["orderId"], f["tradeId"]] for f in fills]}


def _displacement(side, price, reference):
    if side not in ("LONG", "SHORT") or not _positive(price) or not _positive(reference):
        return UNKNOWN
    return (1 if side == "LONG" else -1) * (price / reference - 1) * 10000


def _boundary(row, plan_record, fill):
    plan = plan_record.get("plan") or {}
    # A matching submission binding and prospectively frozen plan are essential.
    if (not plan or plan_record.get("submissionId") != row["decisionId"]
            or plan.get("symbol") != row["symbol"] or plan.get("side") != row["side"]
            or not _positive(plan_record.get("createdAt"))
            or not _positive(row["orderSubmittedAt"])
            or plan_record["createdAt"] > row["orderSubmittedAt"]):
        return
    lo, hi = plan.get("entryMin"), plan.get("entryMax")
    if _positive(lo) and _positive(hi) and lo <= hi:
        row["entryBandViolation"] = not lo <= fill["average"] <= hi
        row["entryBoundaryViolation"] = row["entryBandViolation"]
        row["frozenEntryBand"] = [lo, hi]
        row["boundaryEvidenceId"] = plan.get("id", UNKNOWN)
        row["boundaryProvenance"] = {"source": "HOST_FROZEN_PLAN_AND_OWNED_FILLS",
                                     "planHash": _hash(plan_record), "fillIds": fill["fillIds"],
                                     "submissionId": plan_record["submissionId"],
                                     "createdAt": plan_record["createdAt"],
                                     "orderSubmittedAt": row["orderSubmittedAt"],
                                     "actualAverage": fill["average"], "entryMin": lo, "entryMax": hi}
        row["reviewAxes"]["ENTRY_DISPLACEMENT"] = "BAD" if row["entryBoundaryViolation"] else "GOOD"
        if row["entryBoundaryViolation"]:
            row["repeatErrorType"] = "ENTRY_BOUNDARY_VIOLATION"
    row["adverseDisplacementBps"] = _displacement(row["side"], fill["average"], plan.get("triggerPrice"))
    # Only an explicitly retained pre-decision quote is usable, not latest assessment.
    quote = plan_record.get("decisionQuote") or {}
    if (quote.get("decisionId") == row["decisionId"] and _positive(quote.get("at"))
            and _positive(row["decisionAt"]) and quote["at"] <= row["decisionAt"]):
        px = quote.get("ask" if row["side"] == "LONG" else "bid")
        row["marketDriftBps"] = _displacement(row["side"], px, plan.get("triggerPrice"))
        row["executionGapBps"] = _displacement(row["side"], fill["average"], px)


def _spread_boundary(row, plan_record, trade, fill):
    if "boundaryProvenance" not in row:
        return
    plan, book = plan_record["plan"], trade.get("book") or {}
    bid, ask, stamp, cap = (book.get("bid"), book.get("ask"), book.get("time"), plan.get("maxSpreadBps"))
    # The retained execution book must precede submission/fill; no latest quote or
    # model-stated spread substitutes for the actual gateway book.
    if (all(_positive(x) for x in (bid, ask, stamp)) and bid <= ask and _num(cap) and cap >= 0
            and stamp <= row["orderSubmittedAt"] <= fill["firstAt"]
            and fill["firstAt"] - stamp <= 120000):
        spread = (ask - bid) / ((ask + bid) / 2) * 10000
        row["entrySpreadViolation"] = spread > cap
        row["actualEntrySpreadBps"] = spread
        row["boundaryProvenance"]["spread"] = {"bookHash": _hash(book), "bid": bid, "ask": ask,
                                               "time": stamp, "spreadBps": spread, "maxSpreadBps": cap}
        if spread > cap:
            row["reviewAxes"]["EXECUTION_QUALITY"] = "BAD"
    flags = (row["entryBandViolation"], row["entrySpreadViolation"])
    row["entryBoundaryViolation"] = True if any(x is True for x in flags) else False if all(x is False for x in flags) else UNKNOWN
    if row["entryBoundaryViolation"] is True:
        row["repeatErrorType"] = "ENTRY_BOUNDARY_VIOLATION"


def canonical_evidence(report, status, legacy_journal, *, bindings=None, plans=(),
                       decisions=(), post_fix_execution_versions=()):
    """Adapt host report/status without altering input; keep incomplete cases visible."""
    for source in (report, status):
        if source.get("environment") != "testnet" or source.get("laneId") != "ASTRA_HERMES_TESTNET":
            raise ValueError("Expected owned Astra Testnet identity")
    if report.get("source") != "OWNED_ASTRA_LEDGER" or not _positive(report.get("generatedAt")):
        raise ValueError("Expected timestamped owned ledger report")
    bindings = bindings or {}
    old_ids = _legacy_ids(legacy_journal)
    raw = _index(list(status.get("active", [])) + list(status.get("closed", [])))
    fill_owners = {}
    for tid, trade in raw.items():
        for fill in trade.get("fills") or []:
            key = (fill.get("orderId"), fill.get("tradeId"))
            if all(_known(x) for x in key):
                if key in fill_owners and fill_owners[key] != tid:
                    raise ValueError("One exchange fill cannot evidence multiple owned trades")
                fill_owners[key] = tid
    reported = _index(list(report.get("closed", [])) + list(report.get("open", [])) + list(report.get("noFill", [])))
    lane_decisions = _index([{**x["decision"], "at": x.get("at"), "result": x.get("result")}
                             for x in status.get("decisions", []) if isinstance(x.get("decision"), dict)])
    plan_map = {}
    for p in plans:
        if p.get("submissionId"):
            if p["submissionId"] in plan_map and plan_map[p["submissionId"]] != p:
                raise ValueError("Ambiguous frozen plan binding")
            plan_map[p["submissionId"]] = p
    rows = []
    for tid in sorted(set(raw) | set(reported)):
        trade, r = raw.get(tid, {}), reported.get(tid, {})
        d = trade.get("decision") or {}
        did = d.get("id", UNKNOWN)
        tags = _tags(trade, d, bindings.get(tid, {}), bindings.get(did, {}))
        row = _base(tid, tags, old_ids, post_fix_execution_versions)
        row["provenance"] = {"source": "OWNED_ASTRA_LEDGER_AND_STATUS", "reportAt": report["generatedAt"],
                             "reportRowHash": _hash(r), "statusTradeHash": _hash(trade),
                             "fillChecksPassed": False, "settlementChecksPassed": False,
                             "boundaryChecksPassed": False}
        row.update(kind="TRADE", decisionId=did, symbol=trade.get("symbol", r.get("symbol", UNKNOWN)),
                   side=trade.get("side", r.get("side", UNKNOWN)),
                   positionState=trade.get("state", UNKNOWN), closedAt=_value(r.get("closedAt")),
                   decisionAt=_value(lane_decisions.get(did, {}).get("at")),
                   orderSubmittedAt=_value((trade.get("entry") or {}).get("attemptedAt")),
                   exitReason=r.get("exitReason") or UNKNOWN)
        consistent = bool(trade and r and row["side"] in ("LONG", "SHORT") and
                          all(trade.get(k) == r.get(k) for k in ("symbol", "side", "state")))
        clean = consistent and not report.get("lastError") and not status.get("lastError") and not trade.get("error") and not r.get("error")
        fill = _fills(trade) if consistent else None
        if fill:
            row["provenance"]["fillChecksPassed"] = True
            row.update(executedQty=fill["qty"], averageFillPrice=fill["average"],
                       orderFilledAt=fill["firstAt"], fillIds=fill["fillIds"])
            for source_key, out_key in (("stopPrice", "actualStopPrice"), ("targetPrice", "actualTargetPrice")):
                if _positive(trade.get(source_key)) and _same(trade[source_key], r.get(source_key)):
                    row[out_key] = trade[source_key]
            _boundary(row, plan_map.get(did, {}), fill)
            _spread_boundary(row, plan_map.get(did, {}), trade, fill)
            row["provenance"]["boundaryChecksPassed"] = "boundaryProvenance" in row
        else:
            row["issues"].append("ACTUAL_FILLS_UNAVAILABLE_OR_INCONSISTENT")
        settled = (clean and fill is not None and trade.get("state") == "CLOSED"
                   and trade.get("settlementComplete") is True and r.get("settled") is True
                   and r.get("accountingComplete") is True and _same(trade.get("qty"), 0)
                   and _same(r.get("remainingQty"), 0) and _same(fill["qty"], fill["exitQty"])
                   and _same(fill["qty"], r.get("entryQty"))
                   and _same(fill["average"], r.get("entryPrice"))
                   and _same(fill["qty"] * fill["average"], r.get("entryNotional"))
                   and _positive(r.get("closedAt")) and r["closedAt"] >= fill["lastAt"]
                   and _same(trade.get("closedAt"), r.get("closedAt"))
                   and _num(report.get("fundingThrough")) and report["fundingThrough"] >= r["closedAt"]
                   and _num(status.get("fundingThrough")) and status["fundingThrough"] >= r["closedAt"]
                   and all(_num(r.get(k)) for k in ("gross", "fees", "funding", "net"))
                   and _same(fill["gross"], r.get("gross")) and _same(fill["fees"], r.get("fees"))
                   and _same(r["gross"] - r["fees"] + r["funding"], r["net"]))
        if settled:
            row["provenance"]["settlementChecksPassed"] = True
            row.update(eligible=True, evidenceQuality="SETTLED_ACTUAL", outcome="SETTLED",
                       **{k: r[k] for k in ("gross", "fees", "funding", "net")})
            if row["entryBoundaryViolation"] is True:
                row["outcomeClassification"] = "BAD_PROCESS_GOOD_OUTCOME" if row["net"] > 0 else "BAD_PROCESS_BAD_OUTCOME"
        else:
            order = (trade.get("entry") or {}).get("order") or {}
            no_fill = (clean and trade.get("state") == "NO_FILL" and r.get("accountingComplete") is True
                       and trade.get("fills") == [] and order.get("status") in ("CANCELED", "EXPIRED", "REJECTED")
                       and _known(order.get("orderId")) and _same(order.get("executedQty"), 0)
                       and all(_same(trade.get(k), 0) for k in ("qty", "entryQty"))
                       and all(_same(r.get(k), 0) for k in ("remainingQty", "entryQty", "gross", "fees", "funding", "net")))
            if no_fill:
                row.update(eligible=True, evidenceQuality="CONFIRMED_NO_FILL", outcome="NO_FILL_CONFIRMED",
                           executedQty=0, gross=0, fees=0, funding=0, net=0, issues=[])
            else:
                row.update(outcome="PENDING_OR_UNKNOWN")
                row["issues"].append("SETTLEMENT_NOT_VERIFIED")
        rows.append(row)
    # Full lane WAIT receipt can establish a completed no-order decision. Compact
    # report decisions and error strings cannot establish whether submission occurred.
    extra = list(decisions)
    # The lane receipt is a FALLBACK for a decision the host has no record of. When the
    # host already recorded one, appending the receipt put two rows with the same id into
    # `extra` and `_index` refused them as conflicting — which raised on every tick that
    # reached coaching, for any decision present in both sources at once.
    host_recorded = {d.get("id") for d in decisions}
    for d in lane_decisions.values():
        result = d.get("result")
        if d.get("id") in host_recorded:
            continue
        if (d.get("action") == "WAIT" and d.get("reasonCode") == "NO_SETUP"
                and isinstance(result, dict) and result.get("status") == "WAIT_RECORDED"
                and not result.get("error")):
            extra.append({**d, "action": "NO_TRADE", "outcome": "VALID_NO_TRADE",
                          "validated": True, "noOrderConfirmed": True, "pending": False})
    attached = {row["decisionId"] for row in rows}
    for did, d in _index(extra).items():
        if did in attached:
            continue  # one economic case, never zero plus a filled trade
        row = _base("decision:" + did, _tags(d, bindings.get(did, {})), set(), post_fix_execution_versions)
        row.update(kind="DECISION", decisionId=did, decisionAt=_value(d.get("at")),
                   symbol=d.get("symbol", UNKNOWN), side=d.get("side", UNKNOWN),
                   action=d.get("action", UNKNOWN), outcome="PENDING_OR_UNKNOWN")
        if d.get('decisionContext'):
            row['decisionContext'] = copy.deepcopy(d['decisionContext'])
            row['independentEpisodeId'] = d['decisionContext']['episodeId']
        valid = (d.get("validated") is True and d.get("noOrderConfirmed") is True
                 and d.get("pending") is False and _positive(d.get("at"))
                 and not d.get("error") and d.get("action") in ACTIONS | {'WAIT','REPLAN','ABANDON_SETUP'}
                 and d.get("outcome") in ("VALID_NO_TRADE", "REJECTED_BY_POLICY",'PLAN_UPDATED')
                 and (d['outcome']!='PLAN_UPDATED' or d['action'] in {'WAIT','REPLAN','ABANDON_SETUP'})
                 and (d["outcome"] != "VALID_NO_TRADE" or d["action"] == "NO_TRADE"))
        if valid:
            row.update(eligible=True, evidenceQuality="CONFIRMED_NO_ORDER", outcome=d["outcome"],
                       executedQty=0, gross=0, fees=0, funding=0, net=0)
        else:
            row["issues"].append("NO_ORDER_NOT_VERIFIED")
        rows.append(row)
    contexts={d['id']:d['decisionContext'] for d in decisions if d.get('decisionContext')}
    for row in rows:
        if row['decisionId'] in contexts:
            row['decisionContext']=copy.deepcopy(contexts[row['decisionId']])
            row['independentEpisodeId']=row['decisionContext']['episodeId']
    return copy.deepcopy(rows)


def _field(data, path):
    if not isinstance(path, str):
        return UNKNOWN
    for key in path.split("."):
        if not isinstance(data, dict) or key not in data:
            return UNKNOWN
        data = data[key]
    return data if _known(data) else UNKNOWN


def _operand(value, data):
    return _field(data, value["field"]) if isinstance(value, dict) and set(value) == {"field"} else value


def predicate(spec, data):
    """Three-valued, finite-only deterministic host predicate, no eval/callbacks."""
    if not isinstance(spec, dict) or not isinstance(spec.get("field"), str):
        return UNKNOWN
    actual = _field(data, spec["field"])
    op = spec.get("op")
    if not _known(actual):
        return UNKNOWN
    if op == "eq":
        expected = _operand(spec.get("value", UNKNOWN), data)
        if not _known(expected) or type(actual) not in (bool, int, float, str) or type(expected) not in (bool, int, float, str):
            return UNKNOWN
        if isinstance(actual, (int, float)) and not isinstance(actual, bool) and not _num(actual):
            return UNKNOWN
        return type(actual) is type(expected) and actual == expected
    if not _num(actual):
        return UNKNOWN
    if op == "between":
        lo, hi = (_operand(spec.get(k, UNKNOWN), data) for k in ("min", "max"))
        return lo <= actual <= hi if _num(lo) and _num(hi) and lo <= hi else UNKNOWN
    other = _operand(spec.get("value", UNKNOWN), data)
    if not _num(other):
        return UNKNOWN
    return actual <= other if op == "lte" else actual >= other if op == "gte" else UNKNOWN


def scope_holds(scope, context):
    if not scope:
        return False  # no generic advice delivered
    for key, value in scope.items():
        if key == "action":
            evaluated = context.get("evaluatingAction")
            if value not in (evaluated, context.get("action")):
                return False
        elif not _known(context.get(key)) or context.get(key) != value:
            return False
    return True


class CanonicalBook:
    """Append-only functional journal wrapper; persistence is explicitly external."""

    def __init__(self, overlay=None):
        self._events = copy.deepcopy(overlay if overlay is not None else [])
        previous = "GENESIS"
        versions = {}
        for e in self._events:
            body = {k: v for k, v in e.items() if k != "hash"}
            key = (e["kind"], e["id"])
            if (e.get("schemaVersion") != 8 or e.get("previousHash") != previous
                    or e.get("version") != versions.get(key, 0) + 1 or e.get("hash") != _hash(body)):
                raise ValueError("Invalid canonical append-only overlay")
            versions[key] = e["version"]
            previous = e["hash"]

    def export(self):
        return copy.deepcopy(self._events)

    def ingest_applications(self, base_overlay, events):
        """Merge trusted host FAST records; preserve original pre-action context.

        Never pass model-generated events. Hashes detect corruption, not hostile
        host authorship. Concurrent persistence still needs the integrating lock.
        Validation is atomic in memory: any mismatch leaves this book untouched.
        """
        if self._events[:len(base_overlay)] != base_overlay:
            raise ValueError("FAST base is not a known canonical prefix")
        CanonicalBook(base_overlay + events)  # verify the original hash chain
        branch = CanonicalBook(base_overlay)
        for event in events:
            kind, identifier, p = event["kind"], event["id"], event["payload"]
            if kind == "DELIVERY":
                branch.deliver(identifier, p["context"], p["includeLegacy"], p.get("allowedLessonIds"))
            elif kind == "CHECKS":
                branch.run_checks(identifier)
            elif kind == "APPLICATION":
                branch.verify(identifier, p["action"], p["claimedAppliedLessonIds"], p["rejectedLessonIds"])
            else:
                raise ValueError("FAST may only import delivery, checks and application records")
            if branch._events[-1] != event:
                raise ValueError("FAST receipt differs from original host-verifiable replay")
        merged = CanonicalBook(self.export())
        for event in events:
            merged._append(event["kind"], event["id"], event["payload"], immutable=True)
        if events:
            merged._append("IMPORT_PROVENANCE", _hash(events),
                           {"baseHash": base_overlay[-1]["hash"] if base_overlay else "GENESIS",
                            "sourceEventHashes": [e["hash"] for e in events],
                            "historical": True}, immutable=True)
        self._events = merged._events
        return len(events)

    def _latest(self, kind):
        result = {}
        for e in self._events:
            if e["kind"] == kind:
                result[e["id"]] = copy.deepcopy(e["payload"])
        return result

    def _append(self, kind, identifier, payload, immutable=False):
        old = [e for e in self._events if e["kind"] == kind and e["id"] == identifier]
        if old and old[-1]["payload"] == payload:
            return copy.deepcopy(payload)
        if old and immutable:
            raise ValueError("Conflicting immutable " + kind + " record")
        event = {"schemaVersion": 8, "kind": kind, "id": identifier, "version": len(old) + 1,
                 "previousHash": self._events[-1]["hash"] if self._events else "GENESIS",
                 "payload": copy.deepcopy(payload)}
        event["hash"] = _hash(event)
        self._events.append(event)
        return copy.deepcopy(payload)

    def ingest(self, rows, legacy_journal):
        for row in rows:
            self._append("EVIDENCE", row["evidenceId"], row)
        evidence = self._latest("EVIDENCE")
        for lesson in legacy_journal.get("lessons", []):
            identifier = lesson["id"]
            # Immutable source copy and hash are separate from the revisable audit.
            self._append("LEGACY_SOURCE", identifier, lesson, immutable=True)
            trade_id = (lesson.get("review") or {}).get("tradeId")
            e = evidence.get(trade_id, {})
            text = " ".join(str((lesson.get("review") or {}).get(k, ""))
                            for k in ("observation", "hypothesis"))
            claim = (lesson.get("outcomeClassification") or (lesson.get("review") or {}).get("outcomeClassification")
                     or (lesson.get("review") or {}).get("assessment"))
            good_claim = claim in ("GOOD_PROCESS_GOOD_OUTCOME", "GOOD_PROCESS_BAD_OUTCOME") or bool(
                re.search(r"\bGOOD_PROCESS_(?:GOOD|BAD)_OUTCOME\b", text))
            contradiction = good_claim and e.get("entryBoundaryViolation") is True
            audit = {"lessonId": identifier, "sourceHash": _hash(lesson),
                     "executionClass": "LEGACY_EXECUTION", "cohort": LEGACY, "primaryEligible": False,
                     **{k: e.get(k, UNKNOWN) for k in VERSIONS},
                     "evidenceQuality": e.get("evidenceQuality", "INSUFFICIENT_EVIDENCE"),
                     "evidenceIds": [trade_id] if trade_id else [],
                     "status": "CONTRADICTED" if contradiction else "PROVISIONAL",
                     "supportingEvidence": [], "contradictingEvidence": [trade_id] if contradiction else [],
                     "outcomeClassification": e.get("outcomeClassification", "INSUFFICIENT_EVIDENCE"),
                     "reason": "Verified entry boundary violation contradicts GOOD_PROCESS claim" if contradiction
                     else "Historical interpretation retained; no unverified process claim promoted"}
            self._append("LEGACY_AUDIT", identifier, audit)
        return self._latest("LEGACY_AUDIT")

    def review(self, review_id, evidence_id, body):
        """Coaching REVIEW: host outcomes override prose, and no trading authority."""
        required = {"axes", "observedMechanism", "requiredAction", "exceptions"}
        if (not isinstance(review_id, str) or not review_id or not required <= set(body)
                or set(body) - required - {"outcomeClassification"}
                or not isinstance(body["axes"], dict) or set(body["axes"]) != set(AXES)
                or any(not isinstance(v, str) or not v.strip() for v in body["axes"].values())
                or any(not isinstance(body[k], str) or not body[k].strip() for k in required - {"axes"})):
            raise ValueError("REVIEW requires seven axes, mechanism, required action and exceptions")
        e = self._latest("EVIDENCE").get(evidence_id)
        if not e or e.get("eligible") is not True:
            raise ValueError("Review requires settled actual or confirmed non-trade evidence")
        good_claim = body.get("outcomeClassification") in ("GOOD_PROCESS_GOOD_OUTCOME", "GOOD_PROCESS_BAD_OUTCOME")
        contradiction = good_claim and e.get("entryBoundaryViolation") is True
        result = {"reviewId": review_id, "evidenceId": evidence_id, "evidenceHash": _hash(e),
                  "canonicalEvidence": e, "modelInterpretation": copy.deepcopy(body),
                  "reviewAxes": e["reviewAxes"], "outcomeClassification": e["outcomeClassification"],
                  "status": "CONTRADICTED" if contradiction else "PROVISIONAL",
                  "contradictingEvidence": [evidence_id] if contradiction else [],
                  "supportingEvidence": [], "meaning": "Review is not promotion or profit proof"}
        return self._append("REVIEW", review_id, result, immutable=True)

    def publish(self, lesson_id, body, evidence_ids, scope, condition, check, support,
                error_type=UNKNOWN):
        if not isinstance(lesson_id, str) or not lesson_id:
            raise ValueError("Lesson ID required")
        if (set(body) != {"observedMechanism", "requiredAction", "exceptions"}
                or any(not isinstance(v, str) or not v.strip() for v in body.values()) or not scope):
            raise ValueError("Specific mechanism, action, exceptions and scope required")
        if not evidence_ids or len(set(evidence_ids)) != len(evidence_ids):
            raise ValueError("Distinct canonical evidence IDs required")
        if (set(check) != {"predicate", "passActions", "failActions"}
                or any(not isinstance(check[k], list) or not check[k] or not set(check[k]) <= ACTIONS
                       for k in ("passActions", "failActions"))):
            raise ValueError("Explicit host-verifiable action branches required")
        for p in (condition, check["predicate"], support):
            if not isinstance(p, dict) or p.get("op") not in ("eq", "lte", "gte", "between") or not p.get("field"):
                raise ValueError("Supported deterministic predicate required")
        if (check["predicate"] not in PROCEDURAL_CHECKS
                or condition.get("op") != "eq" or condition.get("field") not in CONDITION_FIELDS
                or not isinstance(condition.get("value"), str)
                or set(condition) != {"op", "field", "value"}
                or support.get("op") != "eq" or support.get("field") not in SUPPORT_FIELDS
                or support.get("value") is not False or set(support) != {"op", "field", "value"}
                or not set(scope) <= CONDITION_FIELDS):
            raise ValueError("Only existing procedural checks and frozen host policy limits are allowed")
        allowed_entries = {"ENTER_" + scope["side"]} if scope.get("side") in ("LONG", "SHORT") else {"ENTER_LONG", "ENTER_SHORT"}
        if set(check["failActions"]) != {"NO_TRADE"} or not set(check["passActions"]) <= allowed_entries | {"NO_TRADE"}:
            raise ValueError("Failed existing entry checks cannot authorize entry or management")
        evidence = self._latest("EVIDENCE")
        if any(x not in evidence for x in evidence_ids):
            raise ValueError("Unknown canonical evidence ID")
        rows = [evidence[x] for x in evidence_ids]
        # A procedure belongs to one immutable execution/policy cohort.
        partitions = {_partition(x) for x in rows}
        if len(partitions) != 1:
            raise ValueError("Do not mix cohorts or policy versions in procedure evidence")
        if support["field"] in ("net", "gross", "fees", "funding", "outcomeClassification"):
            raise ValueError("Profit/outcome alone is not procedure support")
        supporting, contradicting = [], []
        for e in rows:
            finding = predicate(support, e)
            if finding is False:
                contradicting.append(e["evidenceId"])
            elif finding is True and e.get("eligible") is True:
                supporting.append(e["evidenceId"])
        independent = {e.get('independentEpisodeId', e['evidenceId']) for e in rows
                       if e['evidenceId'] in supporting}
        for e in self._latest('EVIDENCE').values():
            if (_partition(e)==_partition(rows[0]) and e.get('eligible') is True
                    and scope_holds(scope,{**e,'evaluatingAction':'ENTER_'+str(e.get('side'))})
                    and predicate(support,e) is False and e['evidenceId'] not in contradicting):
                contradicting.append(e['evidenceId'])
        state = "CONTRADICTED" if contradicting else "SUPPORTED" if len(independent) >= 3 else "PROVISIONAL"
        old = self._latest("PROCEDURE").get(lesson_id, {})
        p = {"lessonId": lesson_id, "version": old.get("version", 0) + 1, "body": body,
             "evidenceIds": list(evidence_ids), "scope": scope, "condition": condition,
             "check": check, "supportPredicate": support, "repeatErrorType": error_type,
             "supportingEvidence": supporting, "contradictingEvidence": contradicting,
             "independentSupportN": len(independent),
             "status": state, **{k: rows[0].get(k, UNKNOWN) for k in (*VERSIONS, "cohort", "fingerprint")},
             "executionClass": "LEGACY_EXECUTION" if any(e.get("executionClass") == "LEGACY_EXECUTION" for e in rows) else "CURRENT_EXECUTION"}
        return self._append("PROCEDURE", lesson_id, p)

    def retire(self, lesson_id, reason):
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError("Retirement reason required")
        p = self._latest("PROCEDURE")[lesson_id]
        p.update(status="RETIRED", retiredReason=reason, version=p["version"] + 1)
        return self._append("PROCEDURE", lesson_id, p)

    def _live(self, procedure):
        # New counterevidence overrides even an old SUPPORTED snapshot immediately.
        evidence = self._latest("EVIDENCE")
        latest = self._latest("PROCEDURE").get(procedure["lessonId"], {})
        return (latest.get("version") == procedure["version"] and latest.get("status") == "SUPPORTED"
                and procedure["status"] == "SUPPORTED" and not procedure["contradictingEvidence"]
                and all(evidence.get(x, {}).get("eligible") is True
                        and predicate(procedure["supportPredicate"], evidence[x]) is True
                        for x in procedure["supportingEvidence"])
                and len({evidence[x].get('independentEpisodeId',x)
                         for x in procedure['supportingEvidence'] if x in evidence}) >= 3
                and not any(_partition(e)==_partition(procedure) and e.get('eligible') is True
                            and scope_holds(procedure['scope'],{**e,'evaluatingAction':'ENTER_'+str(e.get('side'))})
                            and predicate(procedure['supportPredicate'],e) is False
                            for e in evidence.values())
                and not any(self._latest("LEGACY_AUDIT").get(procedure["lessonId"], {}).get("contradictingEvidence", [])))

    def deliver(self, decision_id, context, include_legacy=False, allowed_lesson_ids=None):
        allowed = sorted(set(allowed_lesson_ids)) if allowed_lesson_ids is not None else None
        old = self._latest("DELIVERY").get(decision_id)
        if old:
            if (old["context"] != context or old["includeLegacy"] != include_legacy
                    or old.get("allowedLessonIds") != allowed):
                raise ValueError("Decision context is frozen")
            return old
        candidates = []
        for p in self._latest("PROCEDURE").values():
            if allowed is not None and p["lessonId"] not in allowed:
                continue
            legacy = p["executionClass"] == "LEGACY_EXECUTION"
            if (not self._live(p) or (legacy and not include_legacy) or not scope_holds(p["scope"], context)
                    or (not legacy and _partition(p) != _partition(context))):
                continue
            candidates.append(p)
        candidates.sort(key=lambda p: (p["executionClass"] == "LEGACY_EXECUTION", -len(p["scope"]), p["lessonId"]))
        return self._append("DELIVERY", decision_id, {"decisionId": decision_id, "context": context,
                            "includeLegacy": include_legacy, "allowedLessonIds": allowed,
                            "procedures": candidates[:3]}, immutable=True)

    def run_checks(self, decision_id):
        if decision_id in self._latest("APPLICATION"):
            raise ValueError("Checks must precede decision verification")
        d = self._latest("DELIVERY")[decision_id]
        checks = {}
        for p in d["procedures"]:
            checks[p["lessonId"]] = {"version": p["version"],
                                    "condition": predicate(p["condition"], d["context"]),
                                    "result": predicate(p["check"]["predicate"], d["context"])}
        return self._append("CHECKS", decision_id, {"snapshotHash": _hash(d), "checks": checks}, immutable=True)

    def verify(self, decision_id, action, claimed_applied=(), rejected=None):
        if action not in ACTIONS:
            raise ValueError("Explicit supported action required")
        rejected = rejected or {}
        if any(not isinstance(reason, str) or not reason.strip() for reason in rejected.values()):
            raise ValueError("Rejected lessons require reasons")
        d = self._latest("DELIVERY")[decision_id]
        receipt = self._latest("CHECKS").get(decision_id, {})
        checked = receipt.get("checks", {}) if receipt.get("snapshotHash") == _hash(d) else {}
        results, applicable, applied = {}, [], []
        for p in d["procedures"]:
            key = p["lessonId"]
            condition = predicate(p["condition"], d["context"])
            performed = checked.get(key, {}).get("result", UNKNOWN)
            if condition is True:
                applicable.append(key)
            if not self._live(p):
                result = "CONTRADICTED_OR_RETIRED"
            elif condition is False:
                result = "NOT_APPLICABLE"
            elif condition != True or type(performed) is not bool:
                result = "UNVERIFIABLE"
            else:
                allowed = p["check"]["passActions" if performed else "failActions"]
                result = "COMPLIANT" if action in allowed else "DEPARTED"
                if result == "COMPLIANT":
                    applied.append(key)
            results[key] = {"application": result, "version": p["version"],
                            "condition": condition, "checkResult": performed,
                            "repeatErrorType": p["repeatErrorType"]}
        record = {"decisionId": decision_id, **{k: d["context"].get(k, UNKNOWN) for k in (*VERSIONS, "cohort", "fingerprint")},
                  "action": action, "deliveredLessonIds": [p["lessonId"] for p in d["procedures"]],
                  "applicableLessonIds": applicable, "appliedLessonIds": applied,
                  "rejectedLessonIds": copy.deepcopy(rejected),
                  "procedureVersions": {p["lessonId"]: p["version"] for p in d["procedures"]},
                  "claimedAppliedLessonIds": sorted(set(claimed_applied)),
                  "unverifiedClaims": sorted(set(claimed_applied) - set(applied)), "results": results}
        return self._append("APPLICATION", decision_id, record, immutable=True)


def _model_slice(cases, stamps):
    """Compact per-decision-policy view inside one cohort. Same rules, smaller sample."""
    settled = [x for x in cases if x.get("eligible") is True and x.get("outcome") == "SETTLED" and _num(x.get("net"))]
    entries = [x for x in cases if x.get("kind") == "TRADE" and _positive(x.get("executedQty"))]
    wins = [x["net"] for x in settled if x["net"] > 0]
    losses = [x["net"] for x in settled if x["net"] < 0]
    count = lambda name: sum(x.get("eligible") is True and x.get("outcome") == name and _same(x.get("net"), 0) for x in cases)
    return {"evidenceN": len(cases), "entriesN": len(entries), "closedTradesN": len(settled),
            "netPnl": sum(settled_row["net"] for settled_row in settled) if settled else UNKNOWN,
            "profitFactor": sum(wins) / -sum(losses) if losses else UNKNOWN,
            "winRate": len(wins) / len(settled) if settled else UNKNOWN,
            "noTradesN": count("VALID_NO_TRADE"), "rejectedN": count("REJECTED_BY_POLICY"),
            "noFillN": count("NO_FILL_CONFIRMED"),
            "entryDisplacementBpsMedian": _median(x.get("adverseDisplacementBps") for x in entries),
            "decisionLatencyN": len(stamps),
            "modelDecisionLatencyMsMedian": _median(x.get("modelDecisionLatency") for x in stamps)}


def _partition(row):
    return tuple(row.get(k, UNKNOWN) for k in ("cohort", "fingerprint", *VERSIONS))


def review_content_hash(row):
    value=copy.deepcopy(row)
    value.get('provenance',{}).pop('reportAt',None)
    return _hash(value)


def needs_review(row, events):
    return not any(e['kind']=='REVIEW' and e['payload'].get('evidenceId')==row['evidenceId']
                   and review_content_hash(e['payload'].get('canonicalEvidence',{}))==review_content_hash(row)
                   for e in events)


def coaching_support(rows, selected):
    """Bounded canonical facts, not selected winners or freeform historical memory."""
    partitions={_partition(r) for r in selected}
    matches=[r for r in rows if r.get('eligible') is True
             and r.get('executionClass')=='CURRENT_EXECUTION' and _partition(r) in partitions
             and any(type(r.get(k)) is bool for k in SUPPORT_FIELDS)]
    matches.sort(key=lambda r:(str(r.get('decisionAt')),r['evidenceId']),reverse=True)
    # Include counterevidence alongside support. The full book still blocks a
    # contradicted lesson; these are examples, never an exhaustive denominator.
    matches.sort(key=lambda r:not any(r.get(k) is True for k in SUPPORT_FIELDS))
    fields=('evidenceId','decisionId','independentEpisodeId','executionClass','eligible',
            'cohort','fingerprint',*VERSIONS,'symbol','side','decisionAt','outcome',
            'gross','fees','funding','net',*sorted(SUPPORT_FIELDS))
    return [{**{k:r[k] for k in fields if k in r},'evidenceHash':_hash(r)} for r in matches[:6]]


def learning_health(book, fingerprint):
    rows=[r for r in book._latest('EVIDENCE').values() if r.get('fingerprint')==fingerprint]
    procedures=[p for p in book._latest('PROCEDURE').values() if p.get('fingerprint')==fingerprint]
    apps=[a for a in book._latest('APPLICATION').values() if a.get('fingerprint')==fingerprint]
    delivered=[d for d in book._latest('DELIVERY').values() if d.get('context',{}).get('fingerprint')==fingerprint]
    applied={a['decisionId'] for a in apps if a.get('appliedLessonIds')}
    settled=[r for r in rows if r.get('outcome')=='SETTLED' and r.get('eligible') is True
             and r.get('decisionId') in applied and _num(r.get('net'))]
    review_events=book.export() if rows else []
    return {'schemaVersion':'HERMES_LEARNING_HEALTH_V1','fingerprint':fingerprint,
            'evidenceN':len(rows),'enrichedDecisionN':sum(bool(r.get('decisionContext')) for r in rows),
            'reviewedCurrentContentN':sum(not needs_review(r,review_events) for r in rows),
            'liveSupportedLessonN':sum(book._live(p) for p in procedures),
            'nonemptyDeliveryN':sum(bool(d['procedures']) for d in delivered),
            'hostVerifiedApplicationDecisionN':len(applied),'linkedClosedTradeN':len(settled),
            'linkedNetPnl':sum(r['net'] for r in settled) if settled else UNKNOWN,
            'causalImprovement':'UNPROVEN_REQUIRES_PROSPECTIVE_COMPARISON',
            'meaning':'Delivery counts are receipts, not trades. Compliance is not model causality or alpha validation.'}


def cohort_metrics(rows, applications=(), latency=(), opportunities=()):
    """No mixed PnL, distinct cases, explicit unknowns; rates are descriptive only.

    `latency` and `opportunities` are optional HOST telemetry rows carrying the same
    cohort/fingerprint/version tags: latency records as written by the FAST worker,
    opportunity records as counted by host coverage. They are never derived from
    evidence, because a decision that was never reached leaves no evidence behind.
    Absent telemetry stays UNKNOWN rather than collapsing to zero.
    """
    groups = {}
    evidence = _index([{**x, "id": x["evidenceId"]} for x in rows])
    apps = _index([{**x, "id": x["decisionId"]} for x in applications])
    times = _index([{**x, "id": x.get("decisionId", x.get("jobId"))} for x in latency
                    if _known(x.get("decisionId", x.get("jobId")))])
    chances = _index([{**x, "id": x.get("opportunityId")} for x in opportunities
                      if _known(x.get("opportunityId"))])
    for item in list(evidence.values()) + list(apps.values()) + list(times.values()) + list(chances.values()):
        key = _partition(item)
        groups.setdefault(key, {"cohort": key[0], "fingerprint": key[1], **dict(zip(VERSIONS, key[2:])),
                               "rows": [], "applications": []})
    for row in evidence.values():
        groups[_partition(row)]["rows"].append(row)
    for app in apps.values():
        groups[_partition(app)]["applications"].append(app)
    for record in times.values():
        groups[_partition(record)].setdefault("latency", []).append(record)
    for chance in chances.values():
        groups[_partition(chance)].setdefault("opportunities", []).append(chance)
    output = []
    for group in groups.values():
        cases, checks = group.pop("rows"), group.pop("applications")
        stamps, chance_rows = group.pop("latency", []), group.pop("opportunities", [])
        settled = [x for x in cases if x.get("eligible") is True and x.get("outcome") == "SETTLED" and _num(x.get("net"))]
        zeros = [x for x in cases if x.get("eligible") is True and x.get("outcome") in
                 ("VALID_NO_TRADE", "REJECTED_BY_POLICY", "NO_FILL_CONFIRMED",'PLAN_UPDATED') and _same(x.get("net"), 0)]
        wins, losses = [x["net"] for x in settled if x["net"] > 0], [x["net"] for x in settled if x["net"] < 0]
        # The three confirmed-zero outcomes are separate facts, not one bucket: a
        # refused entry, a decision not to enter and an order that never filled are
        # different failures to learn from even though each realises exactly zero.
        zero_kinds = {name: [x for x in zeros if x.get("outcome") == name] for name in
                      ("VALID_NO_TRADE", "REJECTED_BY_POLICY", "NO_FILL_CONFIRMED",'PLAN_UPDATED')}
        entries = [x for x in cases if x.get("kind") == "TRADE" and _positive(x.get("executedQty"))]
        findings = [r for a in checks for r in a["results"].values()]
        eligible_app = [r for r in findings if r["condition"] is True]
        verified_app = [r for r in eligible_app if r["application"] in ("COMPLIANT", "DEPARTED")]
        repeat = {}
        for row in cases:
            flag = row.get("entryBoundaryViolation")
            if type(flag) is not bool:
                continue
            # Delivery before action defines exposure; missing verification never
            # silently counts as successful learning. No cross-cohort matching.
            app = next((a for a in checks if a["decisionId"] == row.get("decisionId")), {})
            exposed = any(r.get("repeatErrorType") == "ENTRY_BOUNDARY_VIOLATION" and r.get("condition") is True
                          for r in app.get("results", {}).values())
            bucket = "after" if exposed else "before"
            counts = repeat.setdefault("ENTRY_BOUNDARY_VIOLATION", {"beforeN": 0, "afterN": 0, "beforeErrors": 0, "afterErrors": 0})
            counts[bucket + "N"] += 1
            counts[bucket + "Errors"] += int(flag)
        for counts in repeat.values():
            for when in ("before", "after"):
                counts[when + "Rate"] = counts[when + "Errors"] / counts[when + "N"] if counts[when + "N"] else UNKNOWN
        group.update(opportunitiesN=len(chance_rows) if chance_rows else UNKNOWN,
                     planUpdatesN=len(zero_kinds['PLAN_UPDATED']),
                     modelDecisionsN=len({x["decisionId"] for x in cases if _known(x.get("decisionId"))}),
                     entriesN=len(entries), noTradesN=len(zero_kinds["VALID_NO_TRADE"]),
                     rejectedN=len(zero_kinds["REJECTED_BY_POLICY"]), noFillN=len(zero_kinds["NO_FILL_CONFIRMED"]),
                     entryDisplacementBpsMedian=_median(x.get("adverseDisplacementBps") for x in entries),
                     marketDriftBpsMedian=_median(x.get("marketDriftBps") for x in entries),
                     executionGapBpsMedian=_median(x.get("executionGapBps") for x in entries),
                     decisionLatencyN=len(stamps),
                     modelDecisionLatencyMsMedian=_median(x.get("modelDecisionLatency") for x in stamps),
                     hostContextLatencyMsMedian=_median(x.get("hostContextLatency") for x in stamps),
                     totalEventToSubmitLatencyMsMedian=_median(x.get("totalEventToSubmitLatency") for x in stamps),
                     evidenceN=len(cases), closedTradesN=len(settled), confirmedZeroN=len(zeros),
                     excludedN=len(cases) - len(settled) - len(zeros), netPnl=sum(x["net"] for x in settled) if settled or zeros else UNKNOWN,
                     profitFactor=sum(wins) / -sum(losses) if losses else UNKNOWN,
                     winRate=len(wins) / len(settled) if settled else UNKNOWN,
                     avgWin=sum(wins) / len(wins) if wins else UNKNOWN,
                     avgLoss=sum(losses) / len(losses) if losses else UNKNOWN,
                     stopRate=sum(x.get("exitReason") == "NATIVE_STOP" for x in settled) / len(settled) if settled else UNKNOWN,
                     applicationDecisionN=len(checks), lessonApplicableN=len(eligible_app),
                     lessonApplicationN=sum(r["application"] == "COMPLIANT" for r in findings),
                     lessonVerificationN=len(verified_app), lessonUnverifiableN=sum(r["application"] == "UNVERIFIABLE" for r in findings),
                     lessonContradictionN=sum(r["application"] == "CONTRADICTED_OR_RETIRED" for r in findings),
                     lessonApplicationRate=sum(r["application"] == "COMPLIANT" for r in eligible_app) / len(eligible_app) if eligible_app else UNKNOWN,
                     # Same cohort by operator choice, still separable by who decided.
                     # A merged PnL that hides two decision policies is not a fact
                     # about either of them.
                     byModel={role: _model_slice([c for c in cases if c.get("modelRole") == role],
                                                 [t for t in stamps if t.get("modelRole") == role])
                              for role in sorted({str(c.get("modelRole", UNKNOWN)) for c in cases}
                                                 | {str(t.get("modelRole", UNKNOWN)) for t in stamps})},
                     byModelMeaning="One cohort holds both declared decision policies; these slices "
                                    "separate them. Study arms count both and report their own "
                                    "composition rather than dropping either.",
                     repeatErrors=repeat,
                     # Same numbers under the names the V8 contract asks for, so a
                     # reader checking the contract does not have to guess a mapping.
                     repeatErrorBeforeLesson={k: v["beforeErrors"] for k, v in repeat.items()},
                     repeatErrorAfterLesson={k: v["afterErrors"] for k, v in repeat.items()},
                     meaning="Descriptive process compliance; no causal or profitability improvement claim")
        output.append(group)
    return output

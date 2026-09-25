"""Isolated V8 contracts; importing this module does no I/O.

Integration boundaries
----------------------
* The host selects EXISTING PlanBook views and supplies ALL reconciled owned
  positions (the incumbent status.active shape). There is no scanner, ranking,
  alpha, plan creation, gateway, provider call, scheduler, or tool registration.
* build_fast_context, material_events, validate_actions, guard_operation and
  latency_record are pure. Times are host-supplied epoch milliseconds. Capacity
  limits bound prompt size, not trading policy; overflow fails without omitting
  positions. The caller must handle that error outside protective monitoring.
* material_events returns a replacement JSON state. Persist it atomically BEFORE
  dispatching returned events. EventBook is an optional SQLite adapter doing this
  transactionally, including concurrent callers/restarts. Never prune dedup keys
  during a cohort. A crash after commit but before dispatch is an uncertain
  delivery, not permission to issue a fresh order; reconcile through the existing
  gateway with the event's stable id. This is at-most-once dispatch, not an
  exactly-once execution implementation.
* Observations are host evidence, never model input. OPEN plus positive qty and
  entryPrice confirms entry. Target and stop-risk diagnostics use the owned
  position's frozen fields and the existing <=5-second executable BBO freshness.
  STOP_QUOTE_RISK_CROSSING is NOT a native stop trigger: native stops use MARK_PRICE,
  which cannot be inferred from BBO. nativeStopTriggered is therefore always null.
  maxHold uses its existing createdAt + maxHoldMs. Trigger crossings require two
  fresh closed-candle observations. Initial true price predicates cannot prove a
  crossing. No near-stop, giveback, thesis parser, or new time milestone exists.
* Canonical lessons must be host-audited current-policy records, with canonical
  True, EXCHANGE_RECONCILED evidenceQuality, three policy version tags, scope,
  evidenceIds and a requiredCheck from EXISTING_CHECKS. This module delivers only
  those structured checks; arbitrary lesson prose never becomes instructions.
  Delivery/relevance is not proof of application, learning, or profitability.
  CanonicalBook.deliver has a different procedure schema: the V8 runner owns that
  authoritative overlay. Pass canonical_lessons=() here for that path; do not
  relabel its procedure evidence or silently convert checks between schemas.
* guard_operation is an additional semantic lane guard, NOT a tool allowlist.
  The host calls it before dispatch, maps tool operations to these effects, and
  keeps separate coaching budgets. It must keep native protection/reconciliation
  running independently of any model/provider/context failure.
* validate_actions rejects stale decisions. A successful result is still only a
  model intent: the incumbent gateway must revalidate executable price, entry
  band, spread, costs, geometry, risk, ownership and idempotency before submit.
  No REDUCE, SL/TP amendment, runtime wiring, deployment or latency claim here.
"""

import copy
import hashlib
import json
import re
import sqlite3

from astra_decisions import displacement_bps
from astra_plans import FIELDS, finite


FAST_TRADING = "FAST_TRADING"
COACHING = "COACHING"
MAX_PLANS = 8
MAX_CONTEXT_BYTES = 65536
POLICY_KEYS = ("executionPolicyVersion", "tradePolicyVersion", "decisionVersion")
EXISTING_CHECKS = frozenset({
    "unexpired", "dataFresh", "feesAvailable", "trigger", "entryBand", "spread",
    "cost", "fundingCovered", "targetCoversCost", "walletFresh", "walletAvailable",
    "entryNotBlocked", "symbolFree", "riskEnvelope", "stopPrice", "targetPrice",
    "maxHoldMs", "ownership", "reconciliation",
})
POSITION_FIELDS = ("id", "symbol", "side", "state", "qty", "entryQty", "entryPrice",
                   "stopPrice", "targetPrice", "maxHoldMs", "createdAt", "stopId",
                   "stopDone", "setupId")
PRICE_FIELDS = ("triggerPrice", "entryMin", "entryMax", "stopPrice", "targetPrice")
UNSUPPORTED_PREDICATES = ("NEAR_STOP", "NEAR_TARGET", "MFE_GIVEBACK",
                          "THESIS_INVALIDATION", "MARKET_STRUCTURE_CHANGE")
EVENT_REASONS = ("FROZEN_TRIGGER_CROSSING", "CONFIRMED_ENTRY", "TARGET_CROSSING",
                 "STOP_QUOTE_RISK_CROSSING", "MAX_HOLD_MILESTONE")


class ContextCapacityError(ValueError):
    """Host must paginate context, keeping full ownership coverage for validation."""

    def __init__(self, context_bytes, owned_count):
        self.context_bytes = context_bytes
        self.owned_count = owned_count
        self.max_bytes = MAX_CONTEXT_BYTES
        super().__init__("FAST_TRADING context byte capacity exceeded; host pagination required for %d owned positions" % owned_count)


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _hash(value):
    return hashlib.sha256(_json(value).encode()).hexdigest()


def _text(value, limit=160):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError("Missing or unbounded text")
    return value


def _time(value):
    if not finite(value) or value < 0:
        raise ValueError("Expected nonnegative finite host timestamp")
    return value


def _number(value):
    return value if finite(value) else None


def _project(row, fields):
    """Only bounded scalar fields survive; never copy arbitrary nested payloads."""
    result = {}
    for key in fields:
        value = row.get(key)
        if value is None or type(value) is bool or finite(value):
            result[key] = value
        elif isinstance(value, str) and len(value) <= (1000 if key == "thesis" else 160):
            result[key] = value
        else:
            raise ValueError("Invalid bounded field: " + key)
    return result


def _inputs(selected_plans, owned_positions):
    if not isinstance(selected_plans, (list, tuple)) or len(selected_plans) > MAX_PLANS:
        raise ValueError("Host must select at most %d existing plans" % MAX_PLANS)
    if not isinstance(owned_positions, (list, tuple)):
        raise ValueError("Expected complete owned-position list")
    plans, positions = [], []
    for view in selected_plans:
        if not isinstance(view, dict) or not isinstance(view.get("plan"), dict):
            raise ValueError("Expected existing PlanBook view")
        q = _project(view["plan"], sorted(FIELDS))
        _text(q["id"])
        _text(q["symbol"])
        if q["side"] not in ("LONG", "SHORT") or q["triggerKind"] not in ("CLOSE_ABOVE", "CLOSE_BELOW"):
            raise ValueError("Invalid frozen plan direction")
        if any(not finite(q[k]) or q[k] <= 0 for k in PRICE_FIELDS):
            raise ValueError("Missing frozen plan prices")
        plans.append({"plan": q, "submissionId": _project(view, ("submissionId",))["submissionId"]})
    for row in owned_positions:
        if not isinstance(row, dict):
            raise ValueError("Invalid owned position")
        p = _project(row, POSITION_FIELDS)
        for key in ("id", "symbol", "state"):
            _text(p[key])
        if p["side"] not in ("LONG", "SHORT"):
            raise ValueError("Invalid owned position direction")
        positions.append(p)
    for rows, key in (([p["plan"] for p in plans], "id"), (positions, "id")):
        if len({r[key] for r in rows}) != len(rows):
            raise ValueError("Duplicate host identity")
    return plans, positions


def state_version(selected_plans, owned_positions):
    """Material host identity; excludes quotes, PnL, journal and observation time.

    Quote changes are still revalidated by the gateway even with the same version.
    Frozen plan edits/ownership/qty/protection changes invalidate old intentions.
    """
    plans, positions = _inputs(selected_plans, owned_positions)
    return _hash({"plans": sorted(plans, key=lambda p: p["plan"]["id"]),
                  "positions": sorted(positions, key=lambda p: p["id"])})


def _market(row, now_ms):
    row = row if isinstance(row, dict) else {}
    raw = row.get("book") or {}
    raw = raw if isinstance(raw, dict) else {}
    bid, ask, stamp = (_number(raw.get(k)) for k in ("bid", "ask", "time"))
    # Same freshness ceilings as PlanBook.evaluate, not new trading thresholds.
    fresh = (all(x is not None for x in (bid, ask, stamp)) and
             0 < bid <= ask and 0 <= now_ms - stamp <= 120000)
    candles = row.get("candles") or []
    candles = candles if isinstance(candles, (list, tuple)) else []
    candle = max((c for c in candles if isinstance(c, dict) and
                  finite(c.get("closeTime")) and 0 <= c["closeTime"] < now_ms),
                 key=lambda c: c["closeTime"], default={})
    closed = {k: _number(candle.get(k)) for k in ("open", "high", "low", "close", "volume", "closeTime")}
    candle_fresh = (closed["close"] is not None and closed["close"] > 0 and
                    closed["closeTime"] is not None and now_ms - closed["closeTime"] <= 600000)
    return {"book": {"bid": bid, "ask": ask, "time": stamp, "fresh": bool(fresh)},
            "exitQuoteFresh": bool(fresh and now_ms - stamp <= 5000),
            "closedCandle": closed, "closedCandleFresh": bool(candle_fresh)}


def select_lessons(lessons, contexts, policy_versions):
    """At most three canonical checks OVERALL; no free-form lesson instructions.

    Scope uses the evaluated candidate action, including candidates later declined.
    Unknown scope keys fail closed. Latest contradicted/retired versions cannot be
    bypassed by supplying an older supported version of the same lesson.
    """
    versions = {key: _text(policy_versions.get(key)) for key in POLICY_KEYS}
    if not isinstance(lessons, (list, tuple)) or len(lessons) > 256:
        raise ValueError("Host must preselect a bounded canonical lesson set")
    latest = {}
    for lesson in lessons:
        if not isinstance(lesson, dict):
            continue
        if "procedures" in lesson or "check" in lesson and "requiredCheck" not in lesson:
            raise ValueError("CanonicalBook procedure schema requires the authoritative runner overlay, not select_lessons")
        ident, version = lesson.get("lessonId"), lesson.get("version")
        if not isinstance(ident, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", ident) or type(version) is not int or version < 1:
            continue
        previous = latest.get(ident)
        if previous is None or version > previous["version"]:
            latest[ident] = lesson
        elif version == previous["version"] and lesson != previous:
            # Ambiguous duplicate versions must not depend on input order.
            latest[ident] = {"lessonId": ident, "version": version, "status": "CONTRADICTED"}
    delivered = []
    for ident in sorted(latest):
        lesson = latest[ident]
        if (lesson.get("canonical") is not True or
                lesson.get("evidenceQuality") != "EXCHANGE_RECONCILED" or
                lesson.get("status") not in ("PROVISIONAL", "SUPPORTED") or
                any(lesson.get(k) != v for k, v in versions.items()) or
                lesson.get("contradictingEvidence") or
                not isinstance(lesson.get("requiredCheck"), str) or
                lesson["requiredCheck"] not in EXISTING_CHECKS):
            continue
        scope, evidence = lesson.get("scope"), lesson.get("evidenceIds")
        if (not isinstance(scope, dict) or not scope or
                set(scope) - {"symbol", "side", "action", "triggerKind"} or
                any(not isinstance(v, str) or not 1 <= len(v) <= 160 for v in scope.values()) or
                not isinstance(evidence, list) or not 1 <= len(evidence) <= 8 or
                any(not isinstance(e, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", e) for e in evidence)):
            continue
        matches = [c["contextId"] for c in contexts if all(
            (c.get("evaluatingAction") if k == "action" else c.get(k)) == v for k, v in scope.items())]
        if not matches:
            continue
        delivered.append({"lessonId": ident, "version": lesson["version"],
                          "status": lesson["status"], "scope": copy.deepcopy(scope),
                          "requiredCheck": lesson["requiredCheck"], "evidenceIds": list(evidence),
                          "relevantContextIds": matches, **versions})
        if len(delivered) == 3:
            break
    return delivered


def build_fast_context(selected_plans, owned_positions, market_rows, canonical_lessons=(), *,
                       now_ms, policy_versions):
    """Bounded whitelist projection of selected PlanBook views and status.active.

    market_rows is a host map keyed by symbol; only referenced symbols are read.
    Position pnlUsd/mfeBps/maeBps are passed through only when actually supplied as
    finite measurements. We never use plan shadow paths as owned-position MFE/MAE.
    """
    _time(now_ms)
    plans, positions = _inputs(selected_plans, owned_positions)
    opportunities, owned, contexts = [], [], []
    for view, original in zip(plans, selected_plans):
        q = view["plan"]
        market = _market(market_rows.get(q["symbol"]), now_ms)
        book = market["book"]
        px = book["ask" if q["side"] == "LONG" else "bid"] if book["fresh"] else None
        assessment = original.get("assessment") or {}
        failed = assessment.get("failed") or []
        opportunities.append({"opportunityId": q["id"], "frozenPlan": q,
                              "submissionId": view["submissionId"], **market,
                              "executablePrice": px,
                              "adverseDisplacementBps": displacement_bps(q["side"], px, q["triggerPrice"]),
                              "assessment": {"at": _number(assessment.get("at")),
                                             "ready": assessment.get("ready") is True,
                                             "failed": sorted({f for f in failed if isinstance(f, str) and f in EXISTING_CHECKS}),
                                             "costBps": _number(assessment.get("costBps")),
                                             "spreadBps": _number(assessment.get("spreadBps"))},
                              "invalidation": {"stopPrice": q["stopPrice"], "thesisPredicate": "UNSUPPORTED"}})
        contexts.append({"contextId": q["id"], "symbol": q["symbol"], "side": q["side"],
                         "triggerKind": q["triggerKind"], "evaluatingAction": "ENTER_" + q["side"]})
    for p, original in zip(positions, owned_positions):
        market = _market(market_rows.get(p["symbol"]), now_ms)
        book = market["book"]
        owned.append({"positionId": p["id"], **p, **market,
                      "executableExitPrice": book["bid" if p["side"] == "LONG" else "ask"] if market["exitQuoteFresh"] else None,
                      **{k: _number(original.get(k)) for k in ("pnlUsd", "mfeBps", "maeBps")},
                      "requiredAction": ["HOLD", "TAKE_PROFIT", "CUT_LOSS", "HOLD_WITH_REASON"]})
        contexts.append({"contextId": p["id"], "symbol": p["symbol"], "side": p["side"],
                         "evaluatingAction": "HOLD"})
    lessons = select_lessons(canonical_lessons, contexts, policy_versions)
    result = {"mode": FAST_TRADING, "contextBuiltAt": now_ms,
              "stateVersion": state_version(selected_plans, owned_positions),
              "policyVersions": {k: _text(policy_versions.get(k)) for k in POLICY_KEYS},
              "opportunities": opportunities, "positions": owned, "lessons": lessons,
              "deliveredLessonIds": [l["lessonId"] for l in lessons],
              "procedureVersions": [{"lessonId": l["lessonId"], "version": l["version"]} for l in lessons]}
    context_bytes = len(_json(result).encode())
    if context_bytes > MAX_CONTEXT_BYTES:
        raise ContextCapacityError(context_bytes, len(positions))
    return result


def new_event_state():
    return {"version": 1, "observations": {}, "seen": {}}


def _event_state(state):
    if (not isinstance(state, dict) or set(state) != {"version", "observations", "seen"} or
            state["version"] != 1 or not isinstance(state["observations"], dict) or
            not isinstance(state["seen"], dict)):
        raise ValueError("Invalid event history; never reset dedup implicitly")
    for observation in state["observations"].values():
        if (not isinstance(observation, dict) or set(observation) != {"at", "predicates", "stamps", "materialTransitionVersion"} or
                not isinstance(observation["predicates"], dict) or not isinstance(observation["stamps"], dict)):
            raise ValueError("Invalid event observation")
        if type(observation["materialTransitionVersion"]) is not int or observation["materialTransitionVersion"] < 0:
            raise ValueError("Invalid material transition version")
        _time(observation["at"])
        for key, value in observation["predicates"].items():
            if key not in EVENT_REASONS or value is not None and type(value) is not bool:
                raise ValueError("Invalid predicate history")
        for value in observation["stamps"].values():
            if value is not None:
                _time(value)
    for key, event in state["seen"].items():
        if not isinstance(event, dict) or key != event_key(event):
            raise ValueError("Invalid durable event key")
    return copy.deepcopy(state)


def event_key(event):
    """Stable namespaced identity + stateVersion + eventReason; never quote/time."""
    kind = event.get("entityType")
    if kind not in ("POSITION", "OPPORTUNITY") or event.get("eventReason") not in EVENT_REASONS:
        raise ValueError("Invalid event kind/reason")
    ident = event.get("positionId" if kind == "POSITION" else "opportunityId")
    return _hash([kind, _text(ident), _text(event.get("stateVersion")), event["eventReason"]])


def material_events(state, selected_plans, owned_positions, market_rows, *, now_ms):
    """Pure edge detection returning {state, events, unsupported, callModel}.

    Unchanged true predicates do not emit on unrelated version/quantity changes.
    A persisted materialTransitionVersion advances only when an observed known
    predicate changes truth, never on ticks or timestamps. Thus a verified recross
    has a new stateVersion while repeated delivery/restart retains the same key.
    Unknown or out-of-order observations cannot establish a crossing. Baselines
    and seen keys survive restarts; duplicates do not become fresh opportunities.
    """
    _time(now_ms)
    updated = _event_state(state)
    plans, positions = _inputs(selected_plans, owned_positions)
    events, unsupported = [], []

    def observe(kind, row, predicates, stamps, version):
        ident = row["id"]
        entity = _json([kind, ident])
        previous = updated["observations"].get(entity)
        if previous and now_ms < previous["at"]:
            unsupported.append({"entityId": ident, "predicate": "OBSERVATION_ORDER", "status": "UNSUPPORTED"})
            return
        old = previous["predicates"] if previous else {}
        rejected = set()
        for reason, value in list(predicates.items()):
            prior_stamp = (previous or {}).get("stamps", {}).get(reason)
            stamp = stamps.get(reason)
            if prior_stamp is not None and stamp is not None and (stamp < prior_stamp or stamp == prior_stamp and value != old.get(reason)):
                unsupported.append({"entityId": ident, "predicate": reason, "status": "UNSUPPORTED",
                                    "reason": "NON_INCREASING_EVIDENCE_TIMESTAMP"})
                predicates[reason] = old.get(reason)
                stamps[reason] = prior_stamp
                rejected.add(reason)
                continue
            if value is None:
                unsupported.append({"entityId": ident, "predicate": reason, "status": "UNSUPPORTED",
                                    "reason": "MISSING_OR_STALE_EVIDENCE"})
                if prior_stamp is not None:
                    stamps[reason] = max(prior_stamp, stamp) if stamp is not None else prior_stamp
        transition_version = (previous or {}).get("materialTransitionVersion", 0)
        if any(type(old.get(r)) is bool and type(v) is bool and old[r] != v for r, v in predicates.items()):
            transition_version += 1
        event_version = _hash([version, transition_version])
        for reason, value in predicates.items():
            if reason in rejected:
                continue
            first_milestone = reason in ("CONFIRMED_ENTRY", "MAX_HOLD_MILESTONE")
            crossed = value is True and (old.get(reason) is False or first_milestone and old.get(reason) is not True)
            if value is True and old.get(reason) is None and not first_milestone:
                unsupported.append({"entityId": ident, "predicate": reason, "status": "UNSUPPORTED",
                                    "reason": "NO_PREVIOUS_FALSE_OBSERVATION"})
            if crossed:
                event = {"entityType": kind, "positionId": ident if kind == "POSITION" else None,
                         "opportunityId": ident if kind == "OPPORTUNITY" else row.get("setupId"),
                         "stateVersion": event_version, "eventReason": reason, "eventDetectedAt": now_ms}
                if reason == "STOP_QUOTE_RISK_CROSSING":
                    event.update(provenance="EXECUTABLE_BBO_RISK_DIAGNOSTIC_ONLY",
                                 nativeStopTriggered=None, nativeStopWorkingType="MARK_PRICE")
                key = event_key(event)
                if key not in updated["seen"]:
                    event["eventId"] = key
                    updated["seen"][key] = event
                    events.append(copy.deepcopy(event))
        updated["observations"][entity] = {"at": now_ms, "predicates": predicates, "stamps": stamps,
                                           "materialTransitionVersion": transition_version}

    for view in plans:
        q = view["plan"]
        market = _market(market_rows.get(q["symbol"]), now_ms)
        close = market["closedCandle"]["close"]
        eligible = not view["submissionId"] and finite(q["expiresAt"]) and now_ms < q["expiresAt"]
        trigger = None
        if eligible and market["book"]["fresh"] and market["closedCandleFresh"]:
            trigger = close >= q["triggerPrice"] if q["triggerKind"] == "CLOSE_ABOVE" else close <= q["triggerPrice"]
        observe("OPPORTUNITY", q, {"FROZEN_TRIGGER_CROSSING": trigger},
                {"FROZEN_TRIGGER_CROSSING": market["closedCandle"]["closeTime"]}, _hash(view))
    for p in positions:
        market = _market(market_rows.get(p["symbol"]), now_ms)
        book = market["book"]
        opened = p["state"] == "OPEN"
        confirmed = opened and finite(p["qty"]) and p["qty"] > 0 and finite(p["entryPrice"]) and p["entryPrice"] > 0
        entry = True if confirmed else False if p["state"] != "OPEN" else None
        px = book["bid" if p["side"] == "LONG" else "ask"] if market["exitQuoteFresh"] and confirmed else None
        values = {"CONFIRMED_ENTRY": entry}
        for reason, field, above_long in (("TARGET_CROSSING", "targetPrice", True), ("STOP_QUOTE_RISK_CROSSING", "stopPrice", False)):
            level = p[field]
            above = above_long if p["side"] == "LONG" else not above_long
            values[reason] = None if px is None or not finite(level) or level <= 0 else (px >= level if above else px <= level)
        duration, start = p["maxHoldMs"], p["createdAt"]
        values["MAX_HOLD_MILESTONE"] = (now_ms >= start + duration if confirmed and finite(duration) and
                                         duration > 0 and finite(start) and 0 <= start <= now_ms else None)
        stamps = {r: (book["time"] if market["exitQuoteFresh"] else None)
                  if r in ("STOP_QUOTE_RISK_CROSSING", "TARGET_CROSSING") else now_ms for r in values}
        observe("POSITION", p, values, stamps, _hash(p))
        unsupported.extend({"entityId": p["id"], "predicate": name, "status": "UNSUPPORTED",
                            "reason": "NO_EXISTING_FROZEN_PREDICATE"} for name in UNSUPPORTED_PREDICATES)
    return {"state": updated, "events": events, "unsupported": unsupported, "callModel": bool(events)}


class EventBook:
    """Opt-in durable adapter at an explicit host path; no default runtime path.

    SQLite serializes concurrent writers. Transaction commit precedes delivery;
    persistence failure raises and returns no events. No network or model calls.
    This adapter must not be placed on the native protection execution path.
    """

    def __init__(self, path):
        self.path = str(path)
        if self.path == ":memory:":
            raise ValueError("EventBook requires durable storage")

    def observe(self, selected_plans, owned_positions, market_rows, *, now_ms):
        connection = sqlite3.connect(self.path)
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("CREATE TABLE IF NOT EXISTS event_state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)")
            row = connection.execute("SELECT body FROM event_state WHERE id=1").fetchone()
            result = material_events(json.loads(row[0]) if row else new_event_state(), selected_plans,
                                     owned_positions, market_rows, now_ms=now_ms)
            connection.execute("INSERT OR REPLACE INTO event_state(id, body) VALUES(1, ?)", (_json(result["state"]),))
            connection.commit()
            return result
        finally:
            connection.close()


def guard_operation(mode, operation, *, budget_lane):
    """Semantic effects, not tool names. Call BEFORE any tool or budget dispatch."""
    effects = {"READ_CONTEXT", "ENTER_LONG", "ENTER_SHORT", "HOLD", "HOLD_WITH_REASON",
               "TAKE_PROFIT", "CUT_LOSS", "NO_TRADE", "OPEN", "CLOSE", "WAIT",
               "CREATE_PLAN", "APPLY_LESSON", "REVIEW", "PUBLISH", "RETIRE"}
    if mode not in (FAST_TRADING, COACHING) or budget_lane != mode:
        raise ValueError("Separate FAST_TRADING and COACHING budgets required")
    if not isinstance(operation, str) or operation not in effects:
        raise ValueError("Unsupported semantic operation")
    if mode == COACHING and operation not in {"READ_CONTEXT", "REVIEW", "PUBLISH", "RETIRE"}:
        raise ValueError("COACHING prohibits order, position, plan and application actions")
    if mode == FAST_TRADING and operation in {"REVIEW", "PUBLISH", "RETIRE"}:
        raise ValueError("FAST_TRADING prohibits coaching and publication")
    return True


def validate_actions(response, selected_plans, owned_positions, *, expected_state_version,
                     model_started_at, model_finished_at, now_ms, max_age_ms,
                     provider_outcome="MODEL_DECISION"):
    """Validate a complete response; return zero actionable intents on ANY failure.

    Response: {stateVersion, actions: [{positionId OR opportunityId, action, reason}]}.
    max_age_ms is explicitly supplied by the host's current policy; no new timeout
    is invented. Provider termination is host-owned and overrides partial output.
    HOLD_WITH_REASON is accepted only with a reason, normalized to HOLD. Missing
    position actions and silent WAIT are invalid responses, never synthesized HOLD.
    """
    failure = lambda status, reason: {"status": status, "reason": reason, "actions": []}
    if provider_outcome != "MODEL_DECISION":
        status = provider_outcome if provider_outcome in {"PROVIDER_UNAVAILABLE", "PROVIDER_TIMEOUT", "TURN_BUDGET_EXHAUSTED", "MODEL_TIMEOUT"} else "INVALID_MODEL_RESPONSE"
        return failure(status, "Provider attempt did not complete a model decision")
    plans, positions = _inputs(selected_plans, owned_positions)
    try:
        for value in (model_started_at, model_finished_at, now_ms, max_age_ms):
            _time(value)
        if not model_started_at <= model_finished_at <= now_ms:
            raise ValueError("Invalid timestamp order")
    except ValueError as error:
        return failure("INVALID_MODEL_RESPONSE", str(error))
    current = state_version(selected_plans, owned_positions)
    if current != expected_state_version or now_ms - model_started_at > max_age_ms:
        return failure("STALE_ACTION", "Host state or decision age requires a new validation/decision")
    if not isinstance(response, dict) or set(response) != {"stateVersion", "actions"}:
        return failure("INVALID_MODEL_RESPONSE", "Expected complete structured action envelope")
    if response["stateVersion"] != expected_state_version:
        return failure("STALE_ACTION", "Response is bound to another state")
    actions = response["actions"]
    if not isinstance(actions, list) or len(actions) > len(plans) + len(positions):
        return failure("INVALID_MODEL_RESPONSE", "Invalid action list")
    plan_map = {p["plan"]["id"]: p for p in plans}
    position_map = {p["id"]: p for p in positions}
    seen, result = set(), []
    for row in actions:
        try:
            if not isinstance(row, dict):
                raise ValueError("Invalid action")
            key = "positionId" if "positionId" in row else "opportunityId"
            if set(row) != {key, "action", "reason"}:
                raise ValueError("Unknown or missing action fields")
            ident, action, reason = _text(row[key]), _text(row["action"]), _text(row["reason"], 1000)
            if (key, ident) in seen:
                raise ValueError("Duplicate action identity")
            seen.add((key, ident))
            if key == "positionId":
                if ident not in position_map or action not in {"HOLD", "HOLD_WITH_REASON", "TAKE_PROFIT", "CUT_LOSS"}:
                    raise ValueError("Explicit owned-position action required")
                p = position_map[ident]
                if action in {"TAKE_PROFIT", "CUT_LOSS"} and (p["state"] != "OPEN" or not finite(p["qty"]) or p["qty"] <= 0):
                    raise ValueError("Exit requires a currently open owned position")
            else:
                if ident not in plan_map:
                    raise ValueError("Only host-selected existing opportunities may be acted on")
                q = plan_map[ident]["plan"]
                if action not in {"NO_TRADE", "ENTER_" + q["side"]}:
                    raise ValueError("Invalid candidate action/direction")
                if action != "NO_TRADE" and (plan_map[ident]["submissionId"] or not finite(q["expiresAt"]) or now_ms >= q["expiresAt"]):
                    raise ValueError("Expired or already submitted opportunity")
            result.append({key: ident, "action": "HOLD" if action == "HOLD_WITH_REASON" else action, "reason": reason})
        except (ValueError, TypeError) as error:
            return failure("INVALID_MODEL_RESPONSE", str(error))
    if any(("positionId", ident) not in seen for ident in position_map):
        return failure("INVALID_MODEL_RESPONSE", "Every owned position needs an explicit action")
    if not result:
        return failure("INVALID_MODEL_RESPONSE", "Empty response is not a decision")
    return {"status": "VALIDATED_INTENT", "actions": result, "stateVersion": current,
            "decisionValidatedAt": now_ms,
            "gatewayRevalidationRequired": any(r["action"] in {"ENTER_LONG", "ENTER_SHORT", "TAKE_PROFIT", "CUT_LOSS"} for r in result)}


TIMESTAMPS = ("eventDetectedAt", "contextBuiltAt", "modelStartedAt", "modelFinishedAt",
              "decisionValidatedAt", "orderSubmittedAt", "orderFilledAt")
LATENCIES = {"hostContextLatency": ("eventDetectedAt", "contextBuiltAt"),
             "modelDecisionLatency": ("modelStartedAt", "modelFinishedAt"),
             "validationLatency": ("modelFinishedAt", "decisionValidatedAt"),
             "decisionToSubmitLatency": ("decisionValidatedAt", "orderSubmittedAt"),
             "totalEventToSubmitLatency": ("eventDetectedAt", "orderSubmittedAt")}


def latency_record(timestamps, *, turns_used=None, model_calls=None,
                   termination_reason=None, token_usage=None):
    """Observed ms only; absent stages/counters are null, never zero estimates.

    All supplied timestamps must be ordered even across absent intermediate stages.
    A timeout may have modelFinishedAt (attempt ended), but never an invented
    decisionValidatedAt or submit/fill. Zero is a valid recorded time or counter.
    """
    if not isinstance(timestamps, dict) or set(timestamps) - set(TIMESTAMPS):
        raise ValueError("Unknown latency timestamp")
    result = {key: timestamps.get(key) for key in TIMESTAMPS}
    previous = None
    for value in result.values():
        if value is not None:
            _time(value)
            if previous is not None and value < previous:
                raise ValueError("Latency timestamp order violation")
            previous = value
    for value in (turns_used, model_calls):
        if value is not None and (type(value) is not int or value < 0):
            raise ValueError("Invalid observed usage counter")
    if termination_reason is not None:
        _text(termination_reason)
    usage = None
    if token_usage is not None:
        if not isinstance(token_usage, dict):
            raise ValueError("Invalid token usage")
        usage = {k: token_usage.get(k) for k in ("inputTokens", "outputTokens", "totalTokens")}
        if any(v is not None and (type(v) is not int or v < 0) for v in usage.values()):
            raise ValueError("Invalid observed token count")
    for name, (start, end) in LATENCIES.items():
        result[name] = None if result[start] is None or result[end] is None else result[end] - result[start]
    return {**result, "turnsUsed": turns_used, "modelCalls": model_calls,
            "terminationReason": termination_reason, "tokenUsage": usage}

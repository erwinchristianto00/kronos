"""Astra's trading action vocabulary, pre-decision snapshots and execution diagnostics.

The action is the model's. Validation, ownership, sizing, risk, order filters and
idempotency stay in the host and the incumbent gateway; nothing here places an order.

A snapshot records what was knowable BEFORE the action, so a later review reads the
decision as it was made rather than through the outcome.
"""
import copy
import time

# Astra's decision vocabulary.
ACTIONS = ("ENTER_LONG", "ENTER_SHORT", "HOLD", "REDUCE", "TAKE_PROFIT", "CUT_LOSS", "NO_TRADE")
ENTRIES = ("ENTER_LONG", "ENTER_SHORT")
POSITION_ACTIONS = ("HOLD", "REDUCE", "TAKE_PROFIT", "CUT_LOSS")

# How each action reaches the incumbent gateway, which still owns execution.
GATEWAY = {
    "ENTER_LONG": {"action": "OPEN", "side": "LONG", "reasonCode": "EXPERIMENT_OPEN"},
    "ENTER_SHORT": {"action": "OPEN", "side": "SHORT", "reasonCode": "EXPERIMENT_OPEN"},
    "TAKE_PROFIT": {"action": "CLOSE", "reasonCode": "TAKE_PROFIT"},
    "CUT_LOSS": {"action": "CLOSE", "reasonCode": "CUT_LOSS"},
    "HOLD": {"action": "WAIT", "reasonCode": "MANAGING_POSITION"},
    "NO_TRADE": {"action": "WAIT", "reasonCode": "NO_SETUP"},
}

# Declared but not wired. The gateway's close path exits the whole position and
# asserts the exchange quantity matches exactly, so a partial exit needs a guarded
# API release, not a runner change. Refused loudly rather than silently downgraded
# to a full exit, which would be a different trade than the one Astra chose.
UNAVAILABLE = {
    "REDUCE": "REDUCE is not wired end-to-end: the incumbent gateway closes the whole "
              "owned quantity and refuses any exchange-quantity mismatch. Choose HOLD, "
              "TAKE_PROFIT or CUT_LOSS; a partial exit needs a guarded API release."}

# Every attempt ends in exactly one status. A provider or budget loss is neither a
# trading decision nor a loss; an unknown execution state is reconciled, never
# assumed to be a no-fill.
STATUSES = (
    "SKIPPED_UNCHANGED", "PROVIDER_UNAVAILABLE", "VALID_NO_TRADE", "REJECTED_BY_POLICY",
    "NO_FILL_CONFIRMED", "OPEN", "PARTIALLY_FILLED", "SETTLED",
    "TURN_BUDGET_EXHAUSTED", "INVALID_MODEL_RESPONSE", "ACTION_UNAVAILABLE",
    "EXECUTED_MANAGEMENT", "UNRESOLVED_RECONCILE")
# Statuses that mean the lane was evaluated as designed.
EVALUATED = ("VALID_NO_TRADE", "REJECTED_BY_POLICY", "NO_FILL_CONFIRMED", "OPEN",
             "PARTIALLY_FILLED", "SETTLED", "EXECUTED_MANAGEMENT", "SKIPPED_UNCHANGED")


def direction(side):
    return 1 if side == "LONG" else -1


def displacement_bps(side, price, reference):
    """Adverse displacement of `price` from `reference`, in the trade's own direction.

    Positive means the price moved against the entry: a LONG filling above its
    frozen trigger, or a SHORT filling below it.
    """
    if not reference or not price:
        return None
    return direction(side) * (price / reference - 1) * 10000


def execution_diagnostics(side, frozen_trigger, decision_quote, fill_price):
    """Split market drift from execution gap; neither is inferred from the other.

    planToDecision is what the market did between freezing the plan and deciding.
    decisionToFill is what execution cost after the decision was taken. Only actual
    fills belong here: a planned price or a FILLED acknowledgement carrying
    avgPrice=0 is not a fill and must be reconciled first.
    """
    return {
        "adverseDisplacementBps": displacement_bps(side, fill_price, frozen_trigger),
        "planToDecisionBps": displacement_bps(side, decision_quote, frozen_trigger),
        "decisionToFillBps": displacement_bps(side, fill_price, decision_quote),
        "frozenTrigger": frozen_trigger, "decisionQuote": decision_quote, "fillPrice": fill_price,
        "meaning": "Positive is against the entry. Reward ratios are reported elsewhere and "
                   "never gate quality: a further target raises the ratio and changes nothing real.",
        "provenance": "ACTUAL_FILL_REQUIRED_NOT_PLANNED_PRICE_AND_NOT_ZERO_AVGPRICE"}


def state_version(status, plans):
    """Cheap fingerprint of everything a decision could react to.

    Two evaluations with the same version have nothing new to decide, so the model
    is not asked again. Quotes are deliberately excluded: every tick would change
    the fingerprint and defeat the purpose.
    """
    active = sorted((t.get("id"), t.get("symbol"), t.get("state"), round(t.get("qty") or 0, 10))
                    for t in (status.get("active") or []) if isinstance(t, dict))
    closed = sorted(t.get("id") for t in (status.get("closed") or []) if isinstance(t, dict))
    setups = sorted((p["plan"]["id"], bool((p.get("assessment") or {}).get("ready")),
                     tuple((p.get("assessment") or {}).get("failed") or ()), bool(p.get("submissionId")))
                    for p in plans)
    return {"active": active, "closed": closed, "setups": setups,
            "entryBlock": status.get("entryBlock"), "lastError": status.get("lastError")}


def snapshot(opportunity_id, status, plans, procedures, policy_version, market_at=None, now=None):
    """What was knowable before the action. Never rewritten by the outcome."""
    now = now or int(time.time() * 1000)
    active = [t for t in (status.get("active") or []) if isinstance(t, dict)]
    wallet = status.get("wallet") or {}
    balance = (wallet.get("snapshot") or {}).get("availableBalance")
    return {
        "opportunityId": opportunity_id,
        "at": now,
        "marketDataCutoff": market_at,
        "marketDataAgeMs": None if not market_at else now - market_at,
        "walletFresh": wallet.get("fresh") is True,
        "availableBalance": balance,
        "entryBlock": status.get("entryBlock"),
        "lastError": status.get("lastError"),
        "positions": [{k: t.get(k) for k in ("id", "symbol", "side", "state", "qty", "entryPrice",
                                             "stopPrice", "targetPrice", "maxHoldMs", "createdAt")}
                      for t in active],
        # Read defensively: a snapshot is a record of the decision, and a missing
        # field in it must never be able to abort the decision itself.
        "setups": [{"id": p["plan"].get("id"), "symbol": p["plan"].get("symbol"), "side": p["plan"].get("side"),
                    "triggerPrice": p["plan"].get("triggerPrice"), "stopPrice": p["plan"].get("stopPrice"),
                    "targetPrice": p["plan"].get("targetPrice"), "expiresAt": p["plan"].get("expiresAt"),
                    "ready": bool((p.get("assessment") or {}).get("ready")),
                    "failed": (p.get("assessment") or {}).get("failed"),
                    "executableReference": (p.get("assessment") or {}).get("executableReference"),
                    "quoteEconomics": (p.get("assessment") or {}).get("quoteEconomics")}
                   for p in plans],
        "policyVersion": policy_version,
        "procedureVersions": sorted(copy.deepcopy(procedures)),
        "stateVersion": state_version(status, plans),
        "provenance": "HOST_OBSERVED_BEFORE_THE_ACTION_NOT_RECONSTRUCTED_AFTERWARDS"}


def classify(action, gateway_result):
    """Map an executed action plus the gateway's answer onto one durable status."""
    if action in UNAVAILABLE:
        return "ACTION_UNAVAILABLE"
    if not isinstance(gateway_result, dict):
        return "INVALID_MODEL_RESPONSE"
    # Presence is not failure: a successful trade object carries error=null.
    if gateway_result.get("decision_error") or gateway_result.get("error"):
        return "REJECTED_BY_POLICY"
    status = gateway_result.get("status")
    if status in ("SETUP_NOT_READY", "READY_REQUIRES_EXPLICIT_DECISION", "SETUP_DATA_UNAVAILABLE"):
        return "REJECTED_BY_POLICY"
    if status == "REJECTED_OR_UNRESOLVED":
        # An uncertain order is reconciled against the exchange, never booked as a no-fill.
        return "UNRESOLVED_RECONCILE"
    if status == "WAIT_RECORDED":
        return "VALID_NO_TRADE"
    state = gateway_result.get("state")
    if state == "NO_FILL":
        return "NO_FILL_CONFIRMED"
    if state in ("CLOSED", "SETTLING"):
        return "SETTLED"
    if state == "OPEN":
        qty, entry_qty = gateway_result.get("qty"), gateway_result.get("entryQty")
        if action in POSITION_ACTIONS:
            return "EXECUTED_MANAGEMENT"
        if isinstance(qty, (int, float)) and isinstance(entry_qty, (int, float)) and 0 < qty < entry_qty:
            return "PARTIALLY_FILLED"
        return "OPEN"
    if state == "ENTRY_PENDING":
        return "UNRESOLVED_RECONCILE"
    return "INVALID_MODEL_RESPONSE"

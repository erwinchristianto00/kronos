"""Task-typed model policies and the Astra-primary / Claude-fallback router.

Astra is ALWAYS the primary for time-sensitive trading judgement. Claude is a
temporary stand-in for a provider-level Astra failure and is never promoted: the
next opportunity goes back to Astra as soon as Astra answers again.

Three things this module deliberately keeps apart, because conflating them is how a
router starts shopping for the answer it likes:

  * a provider that could not answer          -> a reason to fail over
  * a model that answered something invalid   -> NOT a reason to fail over
  * a model that answered NO_TRADE or HOLD    -> a decision, not a failure

It selects models. It owns no strategy, no risk limit, no threshold, no tool.
"""
import re

FAST_TRADING = "FAST_TRADING"
COACHING = "COACHING"
DEEP_REVIEW = "DEEP_REVIEW"
TASKS = (FAST_TRADING, COACHING, DEEP_REVIEW)

PRIMARY = "PRIMARY"
ESCALATION = "ESCALATION"
FALLBACK = "FALLBACK"

ASTRA_PRIMARY = "ASTRA_PRIMARY"
CLAUDE_FALLBACK = "CLAUDE_FALLBACK"

ASTRA_MODEL = "gpt-6-astra"
ASTRA_PROVIDER = "openai-codex"
CLAUDE_MODEL = "claude-opus-5"
CLAUDE_PROVIDER = "anthropic"

# The complete set of policies any job may declare. Anything not in here is refused
# before a model is constructed, so an unreviewed model or effort cannot reach a
# decision. Astra HIGH is an ESCALATION of Astra's own reasoning, never a fallback.
POLICIES = {
    (FAST_TRADING, PRIMARY): {"task": FAST_TRADING, "role": PRIMARY, "model": ASTRA_MODEL,
                              "provider": ASTRA_PROVIDER, "effort": "medium"},
    (FAST_TRADING, ESCALATION): {"task": FAST_TRADING, "role": ESCALATION, "model": ASTRA_MODEL,
                                 "provider": ASTRA_PROVIDER, "effort": "high"},
    (FAST_TRADING, FALLBACK): {"task": FAST_TRADING, "role": FALLBACK, "model": CLAUDE_MODEL,
                               "provider": CLAUDE_PROVIDER, "effort": "high"},
    (COACHING, PRIMARY): {"task": COACHING, "role": PRIMARY, "model": CLAUDE_MODEL,
                          "provider": CLAUDE_PROVIDER, "effort": "high"},
    (DEEP_REVIEW, PRIMARY): {"task": DEEP_REVIEW, "role": PRIMARY, "model": CLAUDE_MODEL,
                             "provider": CLAUDE_PROVIDER, "effort": "max"},
}

# Provider failures. Each justifies handing the SAME opportunity to the fallback once.
PROVIDER_QUOTA_EXHAUSTED = "PROVIDER_QUOTA_EXHAUSTED"
PROVIDER_RATE_LIMITED = "PROVIDER_RATE_LIMITED"
PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE"
PROVIDER_AUTH_ERROR = "PROVIDER_AUTH_ERROR"
PROVIDER_TRANSIENT_ERROR = "PROVIDER_TRANSIENT_ERROR"
MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE"
FAILOVER_REASONS = (PROVIDER_QUOTA_EXHAUSTED, PROVIDER_RATE_LIMITED, PROVIDER_UNAVAILABLE,
                    PROVIDER_AUTH_ERROR, PROVIDER_TRANSIENT_ERROR, MODEL_UNAVAILABLE)

# Model behaviour. Another model would not fix these, and switching would hide them.
TURN_BUDGET_EXHAUSTED = "TURN_BUDGET_EXHAUSTED"
INVALID_MODEL_RESPONSE = "INVALID_MODEL_RESPONSE"
MODEL_INCOMPLETE = "MODEL_INCOMPLETE"
# Host verdicts. Not failures of anything.
NO_TRADE_STALE_DECISION = "NO_TRADE_STALE_DECISION"
MODEL_DECISION = "MODEL_DECISION"
BEHAVIOUR_REASONS = (TURN_BUDGET_EXHAUSTED, INVALID_MODEL_RESPONSE, MODEL_INCOMPLETE)

# Ordered: the first pattern that matches wins, so a 429 that names a spent quota is
# classified as a spent quota rather than as ordinary rate limiting.
_PATTERNS = (
    (PROVIDER_QUOTA_EXHAUSTED, r"usage[_ ]limit[_ ]reached|quota|usage limit has been reached|insufficient[_ ]quota"),
    (PROVIDER_AUTH_ERROR, r"\b401\b|\b403\b|unauthor|forbidden|authentication|oauth|access token|api key"),
    (PROVIDER_RATE_LIMITED, r"\b429\b|rate[_ ]limit|too many requests"),
    (MODEL_UNAVAILABLE, r"model[_ ](not[_ ]found|unavailable|does not exist)|unknown model|no such model|\b404\b"),
    (PROVIDER_UNAVAILABLE, r"\b50[0234]\b|service unavailable|bad gateway|overloaded|server error"),
    (PROVIDER_TRANSIENT_ERROR, r"timeout|timed out|connection|reset by peer|temporarily|econn|broken pipe"),
)


def classify_provider_error(text):
    """Name the provider failure, or None when the text is not a provider failure.

    A model that answered badly is not a provider that could not answer, so nothing
    here ever matches an ordinary bad response. Returning None means "do not fail over".
    """
    if not text:
        return None
    lowered = str(text).lower()
    for reason, pattern in _PATTERNS:
        if re.search(pattern, lowered):
            return reason
    return None


def policy(task, role=PRIMARY):
    spec = POLICIES.get((task, role))
    if spec is None:
        raise ValueError("Undeclared model policy: " + str(task) + "/" + str(role))
    return dict(spec)


def identity(spec):
    """The exact quadruple that must match the constructed agent, in record form."""
    return {"taskType": spec["task"], "modelRole": spec["role"], "model": spec["model"],
            "modelProvider": spec["provider"], "reasoningEffort": spec["effort"]}


def is_declared(spec):
    return isinstance(spec, dict) and POLICIES.get((spec.get("task"), spec.get("role"))) == spec


# Never retry Astra more often than this while in fallback, unless the provider itself
# told us when it resets. A model call is not a health check you make every few seconds.
RECOVERY_COOLDOWN_MS = 900000
# Two consecutive cheap probes, or one complete real invocation, before believing Astra
# is back. One transient success is not evidence; it is how a router starts ping-ponging.
RECOVERY_PROBES_REQUIRED = 2


def new_state(now):
    return {"routerState": ASTRA_PRIMARY, "routerStateChangedAt": now,
            "primaryModel": ASTRA_MODEL, "primaryFailureReason": None,
            "fallbackStartedAt": None, "nextPrimaryRetryAt": None,
            "astraRecoveryAttempts": 0, "astraRecoverySuccesses": 0, "astraRecoveredAt": None,
            "currentProvider": ASTRA_PROVIDER, "fallbackOpportunities": {}}


class Router:
    """Owns which model decides next. Mutates the dict it is given; never saves."""

    def __init__(self, state, now):
        """Defaults in place. Never replaces the caller's dict: this is constructed on
        every tick over the persisted state, so rebuilding it would erase the routing
        history it exists to keep."""
        self.now = now
        if not state.get("routerState"):
            state.update(new_state(now()))
        self.state = state

    # --- selection -------------------------------------------------------------
    def policy_for(self, task, opportunity_key=None):
        """The policy a NEW job for this task must be frozen to.

        Coaching and deep review never route: they are Claude by definition, and a
        Claude outage postpones them rather than spending Astra's trading quota.
        """
        if task != FAST_TRADING:
            return policy(task)
        if self.state["routerState"] == CLAUDE_FALLBACK:
            return policy(FAST_TRADING, FALLBACK)
        return policy(FAST_TRADING, PRIMARY)

    def may_fall_back(self, opportunity_key):
        """At most one provider fallback per opportunity/stateVersion."""
        return not self.state.setdefault("fallbackOpportunities", {}).get(str(opportunity_key))

    def record_fallback(self, opportunity_key, reason, *, snapshot_age_ms=None):
        """Enter (or stay in) fallback because the primary provider could not answer."""
        if reason not in FAILOVER_REASONS:
            raise ValueError("Not a provider failure; refusing to fail over on " + str(reason))
        stamp = self.now()
        self.state.setdefault("fallbackOpportunities", {})[str(opportunity_key)] = {
            "at": stamp, "reason": reason, "snapshotAgeAtFallback": snapshot_age_ms}
        if self.state["routerState"] != CLAUDE_FALLBACK:
            self.state.update(routerState=CLAUDE_FALLBACK, routerStateChangedAt=stamp,
                              fallbackStartedAt=stamp, currentProvider=CLAUDE_PROVIDER,
                              astraRecoverySuccesses=0)
        self.state["primaryFailureReason"] = reason
        self.state["nextPrimaryRetryAt"] = stamp + RECOVERY_COOLDOWN_MS
        return self.state["routerState"]

    def note_reset_at(self, resets_at_ms):
        """Honour a provider's own reset time over the blind cooldown when it gives one."""
        if isinstance(resets_at_ms, (int, float)) and resets_at_ms > self.now():
            self.state["nextPrimaryRetryAt"] = max(self.state.get("nextPrimaryRetryAt") or 0,
                                                   int(resets_at_ms))

    # --- recovery --------------------------------------------------------------
    def recovery_due(self):
        return (self.state["routerState"] == CLAUDE_FALLBACK
                and self.now() >= (self.state.get("nextPrimaryRetryAt") or 0))

    def record_recovery(self, ok, *, complete_invocation=False):
        """Count evidence that Astra answers again, and switch back once it is enough.

        `complete_invocation=True` means a real Astra job ran to completion with no
        provider error, which is stronger evidence than a probe and counts on its own.
        """
        if self.state["routerState"] != CLAUDE_FALLBACK:
            return self.state["routerState"]
        stamp = self.now()
        self.state["astraRecoveryAttempts"] = self.state.get("astraRecoveryAttempts", 0) + 1
        if not ok:
            self.state["astraRecoverySuccesses"] = 0
            self.state["nextPrimaryRetryAt"] = stamp + RECOVERY_COOLDOWN_MS
            return self.state["routerState"]
        self.state["astraRecoverySuccesses"] = (
            RECOVERY_PROBES_REQUIRED if complete_invocation
            else self.state.get("astraRecoverySuccesses", 0) + 1)
        if self.state["astraRecoverySuccesses"] >= RECOVERY_PROBES_REQUIRED:
            self.state.update(routerState=ASTRA_PRIMARY, routerStateChangedAt=stamp,
                              astraRecoveredAt=stamp, currentProvider=ASTRA_PROVIDER,
                              primaryFailureReason=None, fallbackStartedAt=None,
                              nextPrimaryRetryAt=None)
        return self.state["routerState"]

    def snapshot(self):
        """The persisted routing facts, without the per-opportunity bookkeeping."""
        return {k: v for k, v in self.state.items() if k != "fallbackOpportunities"}


# Decision-time budget for a NEW ENTRY, measured from eventDetectedAt to the final
# validated decision. The deadline gates the fallback re-dispatch this release adds; it
# is NOT a new entry rule and never overrides the engine's own staleness checks.
PREFERRED_DECISION_MS = 60000
DEADLINE_DECISION_MS = 90000
WITHIN_PREFERRED = "WITHIN_PREFERRED"
OVER_PREFERRED = "OVER_PREFERRED"
OVER_DEADLINE = "OVER_DEADLINE"


def budget_verdict(event_detected_at, now_ms):
    """How much of the decision budget an opportunity has already spent."""
    if not isinstance(event_detected_at, (int, float)) or not event_detected_at:
        return WITHIN_PREFERRED
    elapsed = now_ms - event_detected_at
    if elapsed > DEADLINE_DECISION_MS:
        return OVER_DEADLINE
    return OVER_PREFERRED if elapsed > PREFERRED_DECISION_MS else WITHIN_PREFERRED


def fallback_admissible(event_detected_at, now_ms, *, has_open_position=False):
    """May the fallback still decide this opportunity, or is it too late to be worth it?

    An open position is exempt: management and protective action are not chasing an
    entry price, and native protection never waits on any provider anyway.
    """
    if has_open_position:
        return True, None
    if budget_verdict(event_detected_at, now_ms) == OVER_DEADLINE:
        return False, NO_TRADE_STALE_DECISION
    return True, None


def latency_record(marks):
    """Derive the reported latencies from the recorded marks; missing stays None.

    Every field is a difference between two observed instants. Nothing here is
    estimated, so a missing mark yields a missing latency rather than a plausible one.
    """
    def gap(a, b):
        first, second = marks.get(a), marks.get(b)
        if isinstance(first, (int, float)) and isinstance(second, (int, float)):
            return second - first
        return None
    return {"hostContextLatency": gap("eventDetectedAt", "contextBuiltAt"),
            "primaryDecisionLatency": gap("primaryStartedAt", "primaryFinishedAt"),
            "fallbackDecisionLatency": gap("fallbackStartedAt", "fallbackFinishedAt"),
            "decisionToSubmitLatency": gap("validatedAt", "orderSubmittedAt"),
            "totalEventToSubmitLatency": gap("eventDetectedAt", "orderSubmittedAt")}

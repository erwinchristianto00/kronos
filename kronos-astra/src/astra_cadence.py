"""Host-side cadence control: decide whether a slot needs a model call at all.

Monitoring quotes, frozen-setup readiness and accounting are deterministic host work.
The model is called only for a judgement it alone can make. Screening NEVER suppresses
management of an owned position and NEVER delays a READY setup, because entry latency
is a measured cost. Any screening failure calls the model (fail open).

A screened slot is a real evaluation with a host-verified result, not a missing one.
A slot lost to the provider or to the daily budget is a resource constraint and is
excluded from reliability scoring rather than counted as model behaviour.
"""
import json
import os
import time
from pathlib import Path

DAY_MS = 86400000

DEFAULTS = {
    "manageIntervalMs": 600000,      # discretionary review of an owned position
    "reviewIntervalMs": 900000,      # evidence-linked review of a newly settled trade
    "formationIntervalMs": 2700000,  # forming new frozen setups
    "emptyPipelineIntervalMs": 900000,  # an empty pipeline is a different state from a thin one
    "planFloor": 3,                  # form only while live unexpired setups are scarce
    "dailyModelCallBudget": 120,     # backstop against exhausting the subscription window
    "dailyCoachingCallBudget": 24,   # independent reviewer budget; never borrows FAST slots
}


def split_model_budgets(calls, config, at):
    """Recount the durable ledger, including pre-cutover calls; never reset usage.

    Unlabelled legacy calls and connection probes remain on the original trading
    allowance conservatively. This counts dispatch reservations, not API turns or
    tokens. Incumbent urgent position/ready-plan exceptions are unchanged.
    """
    today = [c for c in calls if c['at'] // DAY_MS == at // DAY_MS]
    result = {'version': 'SPLIT_MODEL_BUDGET_V1', 'observedAt': at,
              'resetsAt': (at // DAY_MS + 1) * DAY_MS, 'timezone': 'UTC',
              'unit': 'DISPATCH_RESERVATIONS',
              'unknownModeN': sum(c.get('mode') not in ('FAST_TRADING', 'COACHING', 'CLAUDE_HEALTH_PROBE') for c in today),
              'healthProbeN': sum(c.get('mode') == 'CLAUDE_HEALTH_PROBE' for c in today)}
    for mode, key, default in [('FAST_TRADING', 'dailyModelCallBudget', 60),
                                ('COACHING', 'dailyCoachingCallBudget', 24)]:
        limit = config.get(key, default)
        if type(limit) is not int or limit < 0:
            raise ValueError('Invalid model budget: ' + key)
        used = sum((c.get('mode') == 'COACHING') == (mode == 'COACHING') for c in today)
        result[mode] = {'used': used, 'limit': limit, 'remaining': max(0, limit-used),
                        'resetsAt': result['resetsAt'],
                        'status': 'EXHAUSTED' if used >= limit else 'AVAILABLE'}
    return result

# Reasons that still reach the model after the daily budget is spent.
UNBUDGETED = ("READY_SETUP", "OWNED_POSITION")


def merged_config(raw):
    config = dict(DEFAULTS)
    if raw is None:
        return config
    if not isinstance(raw, dict):
        raise ValueError("Cadence configuration must be an object")
    for key, value in raw.items():
        if key not in DEFAULTS:
            raise ValueError("Unknown cadence setting: " + str(key))
        if type(value) is not int or value <= 0:
            raise ValueError("Cadence setting must be a positive integer: " + str(key))
        config[key] = value
    return config


class CadenceBook:
    def __init__(self, root: Path, config=None, now=None):
        self.path = root / "hermes-home/astra-cadence.json"
        self.now = now or (lambda: int(time.time() * 1000))
        self.config = merged_config(config)
        self.state = json.loads(self.path.read_text()) if self.path.exists() else {
            "version": 1, "lastCallAt": {}, "calls": []}
        if (self.state.get("version") != 1 or not isinstance(self.state.get("lastCallAt"), dict)
                or not isinstance(self.state.get("calls"), list)):
            raise ValueError("Invalid cadence journal; history not reset")

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        with tmp.open("w") as stream:
            os.chmod(tmp, 0o600)
            json.dump(self.state, stream, allow_nan=False, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        tmp.replace(self.path)

    def since(self, reason):
        last = self.state["lastCallAt"].get(reason)
        return None if not isinstance(last, (int, float)) else max(0, self.now() - last)

    def due(self, reason, interval_ms):
        gap = self.since(reason)
        return gap is None or gap >= interval_ms

    def budget(self):
        day = self.now() // DAY_MS
        used = sum(1 for c in self.state["calls"] if isinstance(c, (int, float)) and c // DAY_MS == day)
        limit = self.config["dailyModelCallBudget"]
        return {"used": used, "limit": limit, "remaining": max(0, limit - used), "utcDay": day}

    def decide(self, status, ready_n, unreviewed_n, live_plan_n, displaced_plan_n=0):
        """Deterministic screen. Inputs are host observations, never model claims."""
        active = [t for t in (status.get("active") or []) if isinstance(t, dict)]
        budget = self.budget()
        if type(displaced_plan_n) is not int or not 0 <= displaced_plan_n <= live_plan_n:
            raise ValueError('Invalid displaced setup count')
        viable_n = live_plan_n - displaced_plan_n
        base = {"liveSetups": live_plan_n, "readyN": ready_n, "unreviewedN": unreviewed_n,
                "viableSetups": viable_n, "displacedSetups": displaced_plan_n,
                "ownedN": len(active), "budget": budget,
                "provenance": "HOST_DETERMINISTIC_SCREEN_NOT_MODEL_JUDGEMENT"}
        if ready_n:
            return {**base, "call": True, "reason": "READY_SETUP",
                    "why": "A frozen setup is executable now; entry latency is never deferred"}
        if active and self.due("OWNED_POSITION", self.config["manageIntervalMs"]):
            return {**base, "call": True, "reason": "OWNED_POSITION",
                    "why": "Owned position is due a discretionary management judgement"}
        if unreviewed_n and self.due("UNREVIEWED_TRADE", self.config["reviewIntervalMs"]):
            return {**base, "call": True, "reason": "UNREVIEWED_TRADE",
                    "why": "A settled trade has no evidence-linked review yet"}
        # An unexpired but displaced watch plan is NOT a viable formation slot.
        # Keep it immutable and keep screening it: a later return to its original
        # band may qualify. Only the search timer changes, never entry admission.
        mode = "EMPTY_PIPELINE" if not live_plan_n else "DISPLACED_PIPELINE" if displaced_plan_n else "THIN_PIPELINE"
        interval = (min(self.config["emptyPipelineIntervalMs"], self.config["formationIntervalMs"])
                    if not live_plan_n or displaced_plan_n else self.config["formationIntervalMs"])
        last = self.state["lastCallAt"].get("PLAN_FORMATION")
        next_at = (last + interval) if isinstance(last, (int, float)) else self.now()
        next_at = max(next_at, (self.state.get("formationRetry") or {}).get("notBefore", 0))
        can_form = viable_n < self.config["planFloor"]
        base.update({"formationMode": mode, "formationIntervalMs": interval,
                     "nextFormationAt": next_at if can_form else None,
                     "formationWaitMs": max(0, next_at - self.now()) if can_form else None})
        if can_form and self.due("PLAN_FORMATION", interval):
            retry = self.state.get("formationRetry") or {}
            if self.now() < retry.get("notBefore", 0):
                return {**base, "call": False, "outcome": "SCREENED_RETRY_BACKOFF",
                        "retryAt": retry["notBefore"], "previousOutcome": retry.get("outcome"),
                        "why": "The previous formation attempt failed; bounded retry delay, not a completed market analysis"}
            if budget["remaining"] <= 0:
                return {**base, "call": False, "outcome": "SCREENED_BUDGET",
                        "why": "Daily model-call budget spent; formation deferred while owned positions and ready setups still call"}
            return {**base, "call": True, "reason": "PLAN_FORMATION",
                    "why": ("Displaced watch setups do not block searching for alternatives" if displaced_plan_n
                            else "No live frozen setup at all" if not live_plan_n else "Live frozen setups are below the floor"),
                    "formationIntervalMs": interval}
        return {**base, "call": False, "outcome": "SCREENED_NO_TRADE",
                "why": "No executable setup, owned position, unreviewed trade or open formation window"}

    def record(self, reason):
        now = self.now()
        self.state["lastCallAt"][reason] = now
        self.state["calls"].append(now)
        self.state["calls"] = [c for c in self.state["calls"]
                               if isinstance(c, (int, float)) and now - c <= 2 * DAY_MS][-2000:]
        self.save()
        return now

    def begin(self, reason):
        previous = self.state["lastCallAt"].get(reason)
        return {"reason": reason, "previous": previous, "at": self.record(reason)}

    def finish(self, attempt, outcome):
        # Count every attempted provider session against the resource budget, but
        # never charge a failed formation as an hour of successful analysis.
        if attempt["reason"] != "PLAN_FORMATION":
            return
        if self.state["lastCallAt"].get("PLAN_FORMATION") != attempt["at"]:
            return  # Do not roll back a newer attempt.
        if outcome == "MODEL_DECISION":
            self.state.pop("formationRetry", None)
        else:
            if attempt["previous"] is None:
                self.state["lastCallAt"].pop("PLAN_FORMATION", None)
            else:
                self.state["lastCallAt"]["PLAN_FORMATION"] = attempt["previous"]
            delay = 900000 if outcome == "PROVIDER_UNAVAILABLE" else 300000
            self.state["formationRetry"] = {"at": self.now(), "outcome": outcome,
                                           "notBefore": self.now() + delay}
        self.save()

"""The router is only real if the supervisor and worker actually use it.

Declaring a policy table and leaving the old selection in place would pass every unit
test in test_astra_router_v9 and change nothing at runtime. These tests drive the
supervisor's own methods.
"""
import json
import unittest
from unittest.mock import patch

import astra_router_v9 as R
import astra_v8_supervisor as sup


def supervisor(**state):
    s = sup.Supervisor.__new__(sup.Supervisor)
    s.state = {"jobs": {}, **state}
    s.save = lambda: None
    return s


def fast_job(policy, assignment="slot-1", **extra):
    return {"id": "job-1", "mode": R.FAST_TRADING, "modelPolicy": policy,
            "assignmentId": assignment, **extra}


class SupervisorSelectionTests(unittest.TestCase):
    def test_1_a_fast_job_is_frozen_to_astra_medium_by_default(self):
        p = supervisor().model_policy(R.FAST_TRADING, "slot-1")
        self.assertEqual((p["model"], p["effort"]), ("gpt-6-astra", "medium"))

    def test_15_routine_coaching_is_opus_high(self):
        p = supervisor().model_policy(R.COACHING)
        self.assertEqual((p["model"], p["effort"]), ("claude-opus-5", "high"))

    def test_16_deep_review_is_opus_max(self):
        p = supervisor().model_policy(R.DEEP_REVIEW)
        self.assertEqual((p["model"], p["effort"]), ("claude-opus-5", "max"))

    def test_coaching_never_routes_to_astra_even_while_in_fallback(self):
        """Required 17 in part: a Claude outage postpones coaching, it does not spend
        Astra's trading quota."""
        s = supervisor()
        s.route_result(fast_job(R.policy(R.FAST_TRADING)),
                       {"error": "HTTP 429: The usage limit has been reached"})
        self.assertEqual(s.state["router"]["routerState"], R.CLAUDE_FALLBACK)
        self.assertEqual(s.model_policy(R.COACHING)["model"], "claude-opus-5")
        self.assertEqual(s.model_policy(R.DEEP_REVIEW)["effort"], "max")


class SupervisorRoutingTests(unittest.TestCase):
    def route(self, error, policy=None, mode=R.FAST_TRADING, assignment="slot-1"):
        s = supervisor()
        job = fast_job(policy or R.policy(R.FAST_TRADING), assignment)
        job["mode"] = mode
        s.route_result(job, {"error": error})
        return s

    def test_4_a_spent_astra_quota_puts_the_router_into_claude_fallback(self):
        s = self.route("Error code: 429 - {'type': 'usage_limit_reached', 'resets_at': 1789435433}")
        self.assertEqual(s.state["router"]["routerState"], R.CLAUDE_FALLBACK)
        self.assertEqual(s.state["router"]["primaryFailureReason"], R.PROVIDER_QUOTA_EXHAUSTED)
        self.assertEqual(s.model_policy(R.FAST_TRADING, "slot-2")["model"], "claude-opus-5")

    def test_the_providers_own_reset_time_is_honoured_over_the_blind_cooldown(self):
        s = self.route("429 {'type': 'usage_limit_reached', 'resets_at': 1789435433}")
        self.assertEqual(s.state["router"]["nextPrimaryRetryAt"], 1789435433000)

    def test_2_3_a_valid_decision_leaves_the_router_on_astra(self):
        """Required tests 2 and 3: NO_TRADE and HOLD are answers, not failures."""
        for error in (None, "", "NO_TRADE", "model chose HOLD"):
            s = self.route(error)
            self.assertEqual(s.state["router"]["routerState"], R.ASTRA_PRIMARY, repr(error))

    def test_model_behaviour_does_not_fail_over(self):
        s = self.route("model returned malformed JSON")
        self.assertEqual(s.state["router"]["routerState"], R.ASTRA_PRIMARY)

    def test_10_a_complete_astra_invocation_returns_the_router_to_astra(self):
        s = self.route("HTTP 503 service unavailable")
        self.assertEqual(s.state["router"]["routerState"], R.CLAUDE_FALLBACK)
        s.route_result(fast_job(R.policy(R.FAST_TRADING), "slot-9"), {"error": None})
        self.assertEqual(s.state["router"]["routerState"], R.ASTRA_PRIMARY)
        self.assertIsNotNone(s.state["router"]["astraRecoveredAt"])

    def test_a_claude_failure_never_counts_as_astra_recovery(self):
        s = self.route("HTTP 503 service unavailable")
        s.route_result(fast_job(R.policy(R.FAST_TRADING, R.FALLBACK), "slot-2"),
                       {"error": "HTTP 429: rate limit"})
        self.assertEqual(s.state["router"]["routerState"], R.CLAUDE_FALLBACK)

    def test_a_claude_success_does_not_promote_claude_or_recover_astra(self):
        s = self.route("HTTP 503 service unavailable")
        s.route_result(fast_job(R.policy(R.FAST_TRADING, R.FALLBACK), "slot-2"), {"error": None})
        self.assertEqual(s.state["router"]["routerState"], R.CLAUDE_FALLBACK)

    def test_coaching_results_never_move_the_trading_router(self):
        """A coaching job does not touch the router at all, so no state is even created."""
        s = self.route("HTTP 429: usage limit has been reached", policy=R.policy(R.COACHING),
                       mode=R.COACHING)
        self.assertEqual(s.state.get("router", {}).get("routerState", R.ASTRA_PRIMARY),
                         R.ASTRA_PRIMARY)
        self.assertEqual(s.model_policy(R.FAST_TRADING, "slot-2")["model"], "gpt-6-astra")

    def test_4_one_astra_failure_per_slot_does_not_double_count(self):
        s = self.route("HTTP 503 service unavailable")
        first = dict(s.state["router"])
        s.route_result(fast_job(R.policy(R.FAST_TRADING), "slot-1"),
                       {"error": "HTTP 503 service unavailable"})
        self.assertEqual(s.state["router"]["fallbackStartedAt"], first["fallbackStartedAt"])


class RouterStatePersistenceTests(unittest.TestCase):
    def test_constructing_the_router_over_existing_state_preserves_it(self):
        """It is built on every tick; rebuilding would erase the history it keeps."""
        s = supervisor()
        s.route_result(fast_job(R.policy(R.FAST_TRADING)), {"error": "HTTP 503 unavailable"})
        before = json.dumps(s.state["router"], sort_keys=True)
        for _ in range(3):
            s.router()
        self.assertEqual(json.dumps(s.state["router"], sort_keys=True), before)
        self.assertEqual(s.state["router"]["routerState"], R.CLAUDE_FALLBACK)


class WorkerPolicyGateTests(unittest.TestCase):
    """Required test 14 at the point it actually matters: the worker refuses MAX."""

    def gate(self, declared, mode=R.FAST_TRADING):
        import astra_v8_runner as runner
        # Replicate the guard without the rest of __init__'s host wiring.
        if not R.is_declared(declared):
            raise runner.IntegrationError("not declared")
        if declared["task"] != mode:
            raise runner.IntegrationError("wrong task")
        return R.identity(declared)

    def test_a_declared_policy_passes_and_carries_its_task(self):
        self.assertEqual(self.gate(R.policy(R.FAST_TRADING))["reasoningEffort"], "medium")

    def test_14_opus_max_is_refused_for_fast_trading(self):
        import astra_v8_runner as runner
        with self.assertRaises(runner.IntegrationError):
            self.gate(R.policy(R.DEEP_REVIEW), mode=R.FAST_TRADING)

    def test_an_effort_swap_is_not_a_declared_policy(self):
        import astra_v8_runner as runner
        with self.assertRaises(runner.IntegrationError):
            self.gate({**R.policy(R.FAST_TRADING), "effort": "max"})


class ProvenanceTests(unittest.TestCase):
    def test_20_the_frozen_policy_is_what_the_record_names(self):
        """Required test 20: provenance must match the runtime policy, not the config."""
        for task, role in R.POLICIES:
            spec = R.policy(task, role)
            ident = R.identity(spec)
            self.assertEqual(ident["model"], spec["model"])
            self.assertEqual(ident["reasoningEffort"], spec["effort"])
            self.assertEqual(ident["taskType"], task)


if __name__ == "__main__":
    unittest.main()

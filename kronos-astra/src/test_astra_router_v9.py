"""The twenty required routing cases, plus mutation guards on the invariants.

No network, no provider call, no order. Every test here is about which model is asked
and when — never about what it should decide.
"""
import types
import unittest
from pathlib import Path

import astra_router_v9 as R


class Clock:
    def __init__(self, at=1_800_000_000_000):
        self.at = at

    def __call__(self):
        return self.at

    def advance(self, ms):
        self.at += ms
        return self.at


def router(clock=None):
    clock = clock or Clock()
    state = {}
    return R.Router(state, clock), clock, state


class PolicyDeclarationTests(unittest.TestCase):
    def test_fast_trading_primary_is_astra_medium(self):
        p = R.policy(R.FAST_TRADING, R.PRIMARY)
        self.assertEqual((p["model"], p["provider"], p["effort"]), ("gpt-6-astra", "openai-codex", "medium"))

    def test_fast_trading_fallback_is_claude_opus_high(self):
        p = R.policy(R.FAST_TRADING, R.FALLBACK)
        self.assertEqual((p["model"], p["provider"], p["effort"]), ("claude-opus-5", "anthropic", "high"))

    def test_astra_high_is_an_escalation_of_astra_not_a_fallback(self):
        p = R.policy(R.FAST_TRADING, R.ESCALATION)
        self.assertEqual((p["model"], p["effort"]), ("gpt-6-astra", "high"))

    def test_routine_coaching_is_opus_high_and_deep_review_is_opus_max(self):
        self.assertEqual(R.policy(R.COACHING)["effort"], "high")
        self.assertEqual(R.policy(R.DEEP_REVIEW)["effort"], "max")
        self.assertEqual(R.policy(R.COACHING)["model"], "claude-opus-5")
        self.assertEqual(R.policy(R.DEEP_REVIEW)["model"], "claude-opus-5")

    def test_14_opus_max_is_never_reachable_from_fast_trading(self):
        """Required test 14: MAX must not be available to a time-sensitive decision."""
        for role in (R.PRIMARY, R.ESCALATION, R.FALLBACK):
            self.assertNotEqual(R.policy(R.FAST_TRADING, role)["effort"], "max")
        maxes = [k for k, v in R.POLICIES.items() if v["effort"] == "max"]
        self.assertEqual(maxes, [(R.DEEP_REVIEW, R.PRIMARY)])

    def test_an_undeclared_policy_cannot_be_produced_or_recognised(self):
        with self.assertRaises(ValueError):
            R.policy(R.FAST_TRADING, "SOMETHING_ELSE")
        with self.assertRaises(ValueError):
            R.policy("ARBITRARY_TASK")
        self.assertFalse(R.is_declared({**R.policy(R.FAST_TRADING), "effort": "max"}))
        self.assertTrue(R.is_declared(R.policy(R.FAST_TRADING)))

    def test_identity_names_the_task_as_well_as_the_model(self):
        self.assertEqual(R.identity(R.policy(R.DEEP_REVIEW)), {
            "taskType": "DEEP_REVIEW", "modelRole": "PRIMARY", "model": "claude-opus-5",
            "modelProvider": "anthropic", "reasoningEffort": "max"})


class ErrorClassificationTests(unittest.TestCase):
    def test_each_provider_failure_gets_its_own_name(self):
        cases = {
            "HTTP 429: The usage limit has been reached": R.PROVIDER_QUOTA_EXHAUSTED,
            "HTTP 429: This request would exceed your account's rate limit": R.PROVIDER_RATE_LIMITED,
            "HTTP 401: OAuth access token has expired": R.PROVIDER_AUTH_ERROR,
            "HTTP 503 service unavailable": R.PROVIDER_UNAVAILABLE,
            "Connection timed out": R.PROVIDER_TRANSIENT_ERROR,
            "model_not_found: unknown model": R.MODEL_UNAVAILABLE,
        }
        for text, expected in cases.items():
            self.assertEqual(R.classify_provider_error(text), expected, text)

    def test_a_spent_quota_is_not_merely_a_rate_limit(self):
        """Both arrive as 429; only one of them clears in seconds."""
        self.assertEqual(R.classify_provider_error(
            "Error code: 429 - {'type': 'usage_limit_reached', 'resets_at': 1789435433}"),
            R.PROVIDER_QUOTA_EXHAUSTED)

    def test_2_3_12_a_decision_is_never_a_provider_failure(self):
        """Required tests 2, 3 and 12: NO_TRADE / HOLD / low confidence are answers."""
        for text in ("NO_TRADE", "HOLD", "WAIT: no setup", "low confidence", "", None,
                     "the model declined to enter", "previous PnL was poor"):
            self.assertIsNone(R.classify_provider_error(text))

    def test_model_behaviour_is_not_a_provider_failure(self):
        for reason in R.BEHAVIOUR_REASONS:
            self.assertNotIn(reason, R.FAILOVER_REASONS)


class FailoverTests(unittest.TestCase):
    def test_1_a_normal_event_uses_astra_medium(self):
        r, _, _ = router()
        p = r.policy_for(R.FAST_TRADING, "opp-1")
        self.assertEqual((p["model"], p["effort"], p["role"]), ("gpt-6-astra", "medium", R.PRIMARY))
        self.assertEqual(r.state["routerState"], R.ASTRA_PRIMARY)

    def test_4_a_spent_quota_produces_exactly_one_claude_fallback(self):
        r, _, _ = router()
        self.assertTrue(r.may_fall_back("opp-1"))
        r.record_fallback("opp-1", R.PROVIDER_QUOTA_EXHAUSTED)
        self.assertEqual(r.state["routerState"], R.CLAUDE_FALLBACK)
        p = r.policy_for(R.FAST_TRADING, "opp-1")
        self.assertEqual((p["model"], p["effort"]), ("claude-opus-5", "high"))
        self.assertFalse(r.may_fall_back("opp-1"))  # exactly one, per opportunity

    def test_a_second_opportunity_gets_its_own_single_fallback(self):
        r, _, _ = router()
        r.record_fallback("opp-1", R.PROVIDER_QUOTA_EXHAUSTED)
        self.assertTrue(r.may_fall_back("opp-2"))

    def test_12_a_valid_decision_never_changes_router_state(self):
        """Required test 12: NO_TRADE leaves the router where it was."""
        r, _, _ = router()
        for reason in (R.MODEL_DECISION, R.INVALID_MODEL_RESPONSE, R.TURN_BUDGET_EXHAUSTED):
            with self.assertRaises(ValueError):
                r.record_fallback("opp-x", reason)
        self.assertEqual(r.state["routerState"], R.ASTRA_PRIMARY)

    def test_the_provider_reset_time_wins_over_the_blind_cooldown(self):
        r, clock, _ = router()
        r.record_fallback("opp-1", R.PROVIDER_QUOTA_EXHAUSTED)
        far = clock() + 5 * 24 * 3600 * 1000
        r.note_reset_at(far)
        self.assertEqual(r.state["nextPrimaryRetryAt"], far)
        self.assertFalse(r.recovery_due())

    def test_a_reset_time_already_past_does_not_shorten_the_cooldown(self):
        r, clock, _ = router()
        r.record_fallback("opp-1", R.PROVIDER_RATE_LIMITED)
        due = r.state["nextPrimaryRetryAt"]
        r.note_reset_at(clock() - 1000)
        self.assertEqual(r.state["nextPrimaryRetryAt"], due)


class RecoveryTests(unittest.TestCase):
    def fell_back(self):
        r, clock, _ = router()
        r.record_fallback("opp-1", R.PROVIDER_QUOTA_EXHAUSTED)
        return r, clock

    def test_11_one_probe_success_is_not_enough_to_switch_back(self):
        """Required test 11: hysteresis, so a transient answer cannot ping-pong."""
        r, clock = self.fell_back()
        clock.advance(R.RECOVERY_COOLDOWN_MS)
        r.record_recovery(True)
        self.assertEqual(r.state["routerState"], R.CLAUDE_FALLBACK)
        self.assertEqual(r.state["astraRecoverySuccesses"], 1)

    def test_10_two_consecutive_probes_return_the_router_to_astra(self):
        r, clock = self.fell_back()
        clock.advance(R.RECOVERY_COOLDOWN_MS)
        r.record_recovery(True)
        r.record_recovery(True)
        self.assertEqual(r.state["routerState"], R.ASTRA_PRIMARY)
        self.assertIsNotNone(r.state["astraRecoveredAt"])
        self.assertIsNone(r.state["primaryFailureReason"])
        self.assertEqual(r.policy_for(R.FAST_TRADING, "opp-9")["model"], "gpt-6-astra")

    def test_one_complete_astra_invocation_is_sufficient_evidence(self):
        r, clock = self.fell_back()
        clock.advance(R.RECOVERY_COOLDOWN_MS)
        r.record_recovery(True, complete_invocation=True)
        self.assertEqual(r.state["routerState"], R.ASTRA_PRIMARY)

    def test_9_a_failed_recovery_resets_the_evidence_and_re_arms_the_cooldown(self):
        """Required test 9: a failed attempt must not creep toward a switch."""
        r, clock = self.fell_back()
        clock.advance(R.RECOVERY_COOLDOWN_MS)
        r.record_recovery(True)
        r.record_recovery(False)
        self.assertEqual(r.state["astraRecoverySuccesses"], 0)
        self.assertEqual(r.state["routerState"], R.CLAUDE_FALLBACK)
        self.assertFalse(r.recovery_due())
        self.assertEqual(r.state["astraRecoveryAttempts"], 2)

    def test_recovery_is_not_attempted_before_the_cooldown_elapses(self):
        r, clock = self.fell_back()
        self.assertFalse(r.recovery_due())
        clock.advance(R.RECOVERY_COOLDOWN_MS - 1)
        self.assertFalse(r.recovery_due())
        clock.advance(1)
        self.assertTrue(r.recovery_due())

    def test_recovery_bookkeeping_is_inert_while_astra_is_already_primary(self):
        r, _, _ = router()
        r.record_recovery(True)
        self.assertEqual(r.state["routerState"], R.ASTRA_PRIMARY)
        self.assertEqual(r.state["astraRecoveryAttempts"], 0)

    def test_8_recovery_does_not_move_an_opportunity_already_given_to_claude(self):
        """Required test 8: the in-flight decision keeps its owner; the next one switches.

        The owner is frozen into the job at dispatch, so recovery cannot reach back and
        relabel a decision Claude is still producing.
        """
        r, clock = self.fell_back()
        r.record_fallback("opp-X", R.PROVIDER_QUOTA_EXHAUSTED)
        in_flight_job = {"id": "job-X", "modelPolicy": r.policy_for(R.FAST_TRADING, "opp-X")}
        self.assertEqual(in_flight_job["modelPolicy"]["model"], "claude-opus-5")

        clock.advance(R.RECOVERY_COOLDOWN_MS)
        r.record_recovery(True, complete_invocation=True)
        self.assertEqual(r.state["routerState"], R.ASTRA_PRIMARY)

        # The frozen policy is untouched, and opp-X cannot be failed over a second time.
        self.assertEqual(in_flight_job["modelPolicy"]["model"], "claude-opus-5")
        self.assertFalse(r.may_fall_back("opp-X"))
        self.assertEqual(r.policy_for(R.FAST_TRADING, "opp-Y")["model"], "gpt-6-astra")


class DecisionBudgetTests(unittest.TestCase):
    BASE = 1_800_000_000_000

    def test_6_a_stale_opportunity_is_refused_rather_than_chased(self):
        """Required test 6: provider unavailable + stale opportunity => no entry."""
        ok, reason = R.fallback_admissible(self.BASE, self.BASE + R.DEADLINE_DECISION_MS + 1)
        self.assertFalse(ok)
        self.assertEqual(reason, R.NO_TRADE_STALE_DECISION)

    def test_5_a_fresh_opportunity_may_still_be_decided_by_the_fallback(self):
        ok, reason = R.fallback_admissible(self.BASE, self.BASE + 30000)
        self.assertTrue(ok)
        self.assertIsNone(reason)

    def test_an_open_position_is_never_blocked_by_the_entry_budget(self):
        """Management and protection are not chasing an entry price."""
        ok, _ = R.fallback_admissible(self.BASE, self.BASE + 10 * R.DEADLINE_DECISION_MS,
                                      has_open_position=True)
        self.assertTrue(ok)

    def test_the_budget_verdict_separates_preferred_from_deadline(self):
        self.assertEqual(R.budget_verdict(self.BASE, self.BASE + 1000), R.WITHIN_PREFERRED)
        self.assertEqual(R.budget_verdict(self.BASE, self.BASE + 70000), R.OVER_PREFERRED)
        self.assertEqual(R.budget_verdict(self.BASE, self.BASE + 95000), R.OVER_DEADLINE)

    def test_latency_is_derived_from_marks_and_never_estimated(self):
        marks = {"eventDetectedAt": 100, "contextBuiltAt": 400, "primaryStartedAt": 400,
                 "primaryFinishedAt": 900, "validatedAt": 1000, "orderSubmittedAt": 1200}
        out = R.latency_record(marks)
        self.assertEqual(out["hostContextLatency"], 300)
        self.assertEqual(out["primaryDecisionLatency"], 500)
        self.assertEqual(out["decisionToSubmitLatency"], 200)
        self.assertEqual(out["totalEventToSubmitLatency"], 1100)
        self.assertIsNone(out["fallbackDecisionLatency"])  # never ran, so never a number


class MutationGuardTests(unittest.TestCase):
    """Removing a routing invariant has to turn its own test red."""

    MUTANTS = (
        ("failover_only_on_provider_failure",
         "        if reason not in FAILOVER_REASONS:\n            raise ValueError(",
         "        if False:\n            raise ValueError(",
         "test_12_a_valid_decision_never_changes_router_state"),
        ("one_fallback_per_opportunity",
         'return not self.state.setdefault("fallbackOpportunities", {}).get(str(opportunity_key))',
         'return True',
         "test_4_a_spent_quota_produces_exactly_one_claude_fallback"),
        ("hysteresis_requires_two_probes",
         "RECOVERY_PROBES_REQUIRED = 2",
         "RECOVERY_PROBES_REQUIRED = 1",
         "test_11_one_probe_success_is_not_enough_to_switch_back"),
        ("stale_opportunity_is_refused",
         "    if budget_verdict(event_detected_at, now_ms) == OVER_DEADLINE:\n        return False, NO_TRADE_STALE_DECISION\n",
         "",
         "test_6_a_stale_opportunity_is_refused_rather_than_chased"),
    )

    def test_removing_a_routing_guard_turns_its_test_red(self):
        source = Path(__file__).with_name("astra_router_v9.py").read_text()
        for name, old, new, method in self.MUTANTS:
            with self.subTest(mutant=name):
                self.assertIn(old, source, name + " no longer matches the module source")
                mutated = types.ModuleType("router_mutant_" + name)
                mutated.__dict__["__file__"] = str(Path(__file__).with_name("astra_router_v9.py"))
                exec(compile(source.replace(old, new, 1), "<in-memory-mutant>", "exec"), mutated.__dict__)
                case = next(c for c in (FailoverTests, RecoveryTests, DecisionBudgetTests)
                            if hasattr(c, method))
                original = globals()["R"]
                globals()["R"] = mutated
                try:
                    result = unittest.TestResult()
                    case(method).run(result)
                finally:
                    globals()["R"] = original
                self.assertTrue(result.failures or result.errors,
                                name + " was mutated away and " + method + " still passed")


if __name__ == "__main__":
    unittest.main()

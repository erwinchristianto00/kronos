"""Reporting-only: the numbers must describe the trade, and nothing may gate on them.

A SENT setup reported rrAtPlanDiagnostic 1.477 where the cost-symmetric answer was
0.886 — cost was taken off the reward but never added to the risk. Separately, a frozen
plan failing spread/cost/riskEnvelope was indistinguishable from one merely waiting for
price. Both are reporting defects; no gate, threshold or sizing changes here.
"""
import unittest

from astra_plans import ARRIVAL_TESTS, quote_economics


def short_plan():
    """The real SENTUSDT SHORT that prompted this."""
    return {"side": "SHORT", "triggerPrice": 0.01408, "stopPrice": 0.01415, "targetPrice": 0.01393}


class CostBreakdownTests(unittest.TestCase):
    def test_the_floor_and_the_assumed_part_are_reported_separately(self):
        """17.1 vs 33.1 was not per-side vs round-trip; both are round-trip."""
        e = quote_economics(short_plan(), 0.01408, 33.12, 1.25, 17.12)
        self.assertAlmostEqual(e["costFloorBps"], 17.12)
        self.assertAlmostEqual(e["modelledAllInCostBps"], 33.12)
        self.assertAlmostEqual(e["costAssumedBps"], 16.0)  # slippage + funding allowance

    def test_the_floor_is_optional_and_its_absence_invents_nothing(self):
        e = quote_economics(short_plan(), 0.01408, 33.12, 1.25)
        self.assertNotIn("costFloorBps", e)
        self.assertNotIn("costAssumedBps", e)
        self.assertAlmostEqual(e["modelledAllInCostBps"], 33.12)


class RatioTests(unittest.TestCase):
    """At the trigger: reward 106.53, planned risk 49.72, modelled cost 33.12."""

    def economics(self):
        return quote_economics(short_plan(), 0.01408, 33.12, 1.25, 17.12)

    def test_gross_ratio_carries_no_cost_at_all(self):
        e = self.economics()
        self.assertAlmostEqual(e["rrGrossAtPlan"], 106.5341 / 49.7159, places=2)

    def test_the_legacy_ratio_is_preserved_under_its_own_name(self):
        """Backward compatibility: same arithmetic as before, explicitly named legacy."""
        e = self.economics()
        self.assertAlmostEqual(e["rrAtPlanDiagnosticLegacy"], (106.5341 - 33.12) / 49.7159, places=2)
        self.assertAlmostEqual(e["rrAtPlanDiagnosticLegacy"], 1.477, places=2)

    def test_the_cost_symmetric_ratio_charges_the_cost_to_both_outcomes(self):
        """A win nets reward-cost; a loss costs risk+cost. This is the real figure."""
        e = self.economics()
        self.assertAlmostEqual(e["rrCostSymmetricAtPlan"], (106.5341 - 33.12) / (49.7159 + 33.12), places=2)
        self.assertAlmostEqual(e["rrCostSymmetricAtPlan"], 0.886, places=2)

    def test_the_legacy_ratio_reads_higher_than_the_truthful_one(self):
        """The whole point: 1.48 looked like a good trade; 0.89 is what it offered."""
        e = self.economics()
        self.assertGreater(e["rrAtPlanDiagnosticLegacy"], e["rrCostSymmetricAtPlan"])

    def test_the_quote_side_ratios_follow_the_same_rule(self):
        e = quote_economics(short_plan(), 0.0140, 33.12, 1.25, 17.12)
        risk, reward = e["riskAtQuoteBps"], e["rewardAtQuoteBps"]
        self.assertAlmostEqual(e["rrCostSymmetricAtQuote"], (reward - 33.12) / (risk + 33.12), places=6)
        self.assertAlmostEqual(e["rrAtQuoteDiagnosticLegacy"], (reward - 33.12) / risk, places=6)

    def test_the_meaning_string_says_which_ratio_to_believe(self):
        self.assertIn("BOTH outcomes", self.economics()["rrMeaning"])


class GateInvarianceTests(unittest.TestCase):
    """BEHAVIOR_CHANGED: NO / GATES_CHANGED: NO — proven, not asserted."""

    def test_the_risk_envelope_verdict_is_untouched_by_the_new_fields(self):
        with_floor = quote_economics(short_plan(), 0.0140, 33.12, 1.25, 17.12)
        without = quote_economics(short_plan(), 0.0140, 33.12, 1.25)
        for key in ("withinRiskEnvelope", "riskInflation", "plannedRiskBps",
                    "riskAtQuoteBps", "rewardAtQuoteBps", "entryDisplacementBps"):
            self.assertEqual(with_floor[key], without[key], key)

    def test_no_ratio_is_consulted_by_any_gate(self):
        import inspect
        import astra_plans
        source = inspect.getsource(astra_plans.PlanBook.observe)
        for name in ("rrGross", "rrCostSymmetric", "rrAtPlanDiagnosticLegacy",
                     "rrAtQuoteDiagnosticLegacy", "costFloorBps"):
            self.assertNotIn(name, source, name + " must not be read by the assessment gates")


class PlanStatusTests(unittest.TestCase):
    """A frozen plan is not a valid setup."""

    def status(self, failed):
        blocking = [k for k in failed if k not in ARRIVAL_TESTS]
        ready = not failed
        return "READY" if ready else "ADMISSIBLE" if not blocking else "FROZEN"

    def test_everything_passing_is_ready(self):
        self.assertEqual(self.status([]), "READY")

    def test_only_the_price_missing_is_admissible(self):
        self.assertEqual(self.status(["trigger"]), "ADMISSIBLE")
        self.assertEqual(self.status(["trigger", "entryBand"]), "ADMISSIBLE")

    def test_a_failed_economic_check_is_not_a_setup_waiting_for_price(self):
        """The ORDERUSDT SHORT failed spread, cost and riskEnvelope and still read as
        'frozen', which is what made it look like progress."""
        self.assertEqual(self.status(["trigger", "entryBand", "spread", "cost", "riskEnvelope"]), "FROZEN")
        self.assertEqual(self.status(["riskEnvelope"]), "FROZEN")

    def test_arrival_tests_are_exactly_the_two_price_checks(self):
        self.assertEqual(set(ARRIVAL_TESTS), {"trigger", "entryBand"})


if __name__ == "__main__":
    unittest.main()

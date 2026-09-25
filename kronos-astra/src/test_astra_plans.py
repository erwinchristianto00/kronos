import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
import astra_runner
from astra_plans import PlanBook, quote_economics, MAX_RISK_INFLATION
from hermes_dashboard import learning_snapshot


class GeometryDiagnosticTests(unittest.TestCase):
    def diagnostic(self, plan):
        from astra_plans import validate_entry_geometry, GeometryError
        before = copy.deepcopy(plan)
        with self.assertRaises(GeometryError) as caught:
            validate_entry_geometry(plan)
        self.assertEqual(plan, before)
        return caught.exception.diagnostic

    def test_prom_revisions_worsen_not_repair_and_limit_is_exact(self):
        p = dict(side='LONG',triggerPrice=5.374,stopPrice=5.32,
                 targetPrice=5.55,entryMin=5.4,entryMax=5.44)
        a=self.diagnostic(p)
        b=self.diagnostic(dict(p,entryMin=5.41,entryMax=5.43))
        self.assertGreater(b['bestCaseRiskInflation'], a['bestCaseRiskInflation'])
        self.assertAlmostEqual(a['continuousPriceLimit'],5.32/(1-1.25*(5.374-5.32)/5.374))
        self.assertEqual(a['limitOperator'],'LTE')
        self.assertFalse(a['orderAuthority'])
        for dx,expected in ((-1e-7,True),(1e-7,False)):
            self.assertEqual(quote_economics(p,a['continuousPriceLimit']+dx)['withinRiskEnvelope'],expected)

    def test_short_limit_and_neighbors(self):
        p=dict(side='SHORT',triggerPrice=100,stopPrice=102,targetPrice=90,entryMin=98,entryMax=99)
        d=self.diagnostic(p)
        self.assertEqual(d['limitOperator'],'GTE')
        self.assertAlmostEqual(d['continuousPriceLimit'],102/1.025)
        self.assertTrue(quote_economics(p,d['continuousPriceLimit']+1e-7)['withinRiskEnvelope'])
        self.assertFalse(quote_economics(p,d['continuousPriceLimit']-1e-7)['withinRiskEnvelope'])

    def test_target_and_size_do_not_repair_ratio(self):
        p=dict(side='LONG',triggerPrice=100,stopPrice=99,targetPrice=110,entryMin=102,entryMax=103)
        a=self.diagnostic(p);b=self.diagnostic(dict(p,targetPrice=200,notionalUsd=1))
        self.assertEqual(a['bestCaseRiskInflation'],b['bestCaseRiskInflation'])

    def test_invalid_planned_risk_is_explicit(self):
        d=self.diagnostic(dict(side='LONG',triggerPrice=99,stopPrice=100,targetPrice=110,entryMin=102,entryMax=103))
        self.assertFalse(d['plannedRiskValid']);self.assertIsNone(d['continuousPriceLimit'])

    def test_wide_risk_and_valid_geometry_not_rejected(self):
        from astra_plans import validate_entry_geometry
        p=dict(side='LONG',triggerPrice=100,stopPrice=10,targetPrice=300,entryMin=200,entryMax=210)
        self.assertIsNone(validate_entry_geometry(p))

    def test_bad_numbers_fail_closed(self):
        from astra_plans import validate_entry_geometry
        for value in (None, True, 0, float('nan'), float('inf')):
            with self.assertRaises(ValueError):
                validate_entry_geometry(dict(side='LONG',triggerPrice=value,stopPrice=99,
                                             targetPrice=110,entryMin=100,entryMax=101))


class FrozenPlanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.now = 1800000000000
        self.book = PlanBook(self.root, now=lambda: self.now)
        self.patch = patch.object(astra_runner, "PLAN_BOOK", self.book)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.context = {"source": "BINANCE_USDM_TESTNET", "status": {"environment": "testnet", "executionVersion": "astra-final-book-contract-v1-20260909", "entryBlock": None,
            "lastError": None, "active": [], "wallet": {"fresh": True, "snapshot": {"availableBalance": 1000}}},
            "unavailableSymbols": [], "rows": [{"symbol": "DOGEUSDT", "filters": {"minNotional": 5},
                "book": {"bid": 10, "ask": 10.001, "time": self.now},
                "candles": [{"closeTime": self.now-1, "close": 10}],
                "economics": {"commission": {"status": "AVAILABLE", "takerRate": .0005},
                    "funding": {"status": "INDICATIVE", "nextFundingTime": self.now+3600000,
                                "nextSettlementCostBpsIfRateUnchanged": {"LONG": 1, "SHORT": -1}}}}]}
        self.plan = {"id": "frozen_plan_001", "symbol": "DOGEUSDT", "side": "LONG", "thesis": "Closed breakout remains accepted",
            "triggerKind": "CLOSE_ABOVE", "triggerPrice": 10, "entryMin": 9.99, "entryMax": 10.02,
            "stopPrice": 9.8, "targetPrice": 10.3, "notionalUsd": 6, "maxHoldMs": 600000,
            "expiresAt": self.now+1800000, "maxSpreadBps": 5, "maxCostBps": 30,
            "entrySlippageBps": 5, "exitSlippageBps": 5, "fundingAllowanceBps": 2}
        self.book.observe(copy.deepcopy(self.context))

    def create(self):
        return self.book.create(copy.deepcopy(self.plan))

    def decision(self, **kw):
        return {"id": "decision_open_001", "action": "OPEN", "reason": "Execute the frozen falsifiable setup",
                "reasonCode": "EXPERIMENT_OPEN", "setupId": self.plan["id"], **kw}

    def test_immediate_ready_has_no_mandatory_extra_retest(self):
        p = self.create()
        self.assertTrue(p["assessment"]["ready"])
        self.assertIsNotNone(p["shadow"])

    def test_impossible_zero_spread_cost_rejected_without_frozen_state(self):
        self.plan.update(entrySlippageBps=10, exitSlippageBps=10,
                         fundingAllowanceBps=5, maxCostBps=32)
        self.context["rows"][0]["economics"]["commission"]["takerRate"] = .0004
        self.book.observe(self.context)
        with self.assertRaisesRegex(ValueError, "INFEASIBLE_COST_CONTRACT.*33.*32"):
            self.create()
        self.assertEqual(self.book.state["plans"], [])
        self.assertFalse(self.book.path.exists())

    def test_cost_floor_equality_admitted_but_current_spread_still_blocks(self):
        self.plan["maxCostBps"] = 22
        result = self.create()
        self.assertIn("cost", result["assessment"]["failed"])
        self.context["rows"][0]["book"]["ask"] = 10
        self.book.observe(self.context)
        self.assertTrue(self.book.get(self.plan["id"])["assessment"]["ready"])

    def test_unknown_fee_never_invented_for_cost_admission(self):
        self.context["rows"][0]["economics"]["commission"] = {"status": "UNKNOWN"}
        self.book.observe(self.context)
        result = self.create()
        self.assertFalse(result["assessment"]["ready"])
        self.assertIn("feesAvailable", result["assessment"]["failed"])

    def test_thesis_length_contract_is_visible_before_tool_call(self):
        from astra_plans import PLAN_SCHEMA
        schema = PLAN_SCHEMA["parameters"]["properties"]["plan"]["properties"]["thesis"]
        self.assertEqual((schema["minLength"], schema["maxLength"]), (10, 1000))
        with self.assertRaisesRegex(ValueError, "10-1000 characters; received 1225"):
            self.book.create({**self.plan, "thesis": "x" * 1225})
        self.assertEqual(self.book.state["plans"], [])

    def test_same_id_is_idempotent_but_thresholds_and_expiry_cannot_move(self):
        self.create()
        self.assertEqual(self.create()["plan"], self.plan)
        for key in ("triggerPrice", "entryMax", "stopPrice", "targetPrice", "expiresAt", "notionalUsd"):
            with self.assertRaisesRegex(ValueError, "FROZEN_PLAN"):
                self.book.create({**self.plan, key: self.plan[key]+1})
        with self.assertRaisesRegex(ValueError, "unexpired"):
            self.book.create({**self.plan, "id": "replacement_001", "triggerPrice": 11})

    def test_untriggered_setup_becomes_ready_on_original_threshold(self):
        self.plan["triggerPrice"] = 10.01
        self.assertFalse(self.create()["assessment"]["ready"])
        self.now += 300000
        self.context["rows"][0]["candles"] = [{"closeTime": self.now-1, "close": 10.012}]
        self.context["rows"][0]["book"]["time"] = self.now
        self.book.observe(self.context)
        self.assertTrue(self.book.summary()["plans"][0]["assessment"]["ready"])
        self.assertEqual(self.book.summary()["plans"][0]["plan"]["triggerPrice"], 10.01)

    def test_old_criteria_survive_restart_and_long_prose(self):
        self.create()
        restored = PlanBook(self.root, now=lambda: self.now+300000)
        self.assertEqual(restored.summary()["plans"][0]["plan"], self.plan)
        self.assertFalse(restored.summary()["plans"][0]["assessment"]["ready"])
        self.assertEqual(restored.summary()["readyN"], 0)

    def test_wrong_venue_missing_data_and_corrupt_state_fail_closed(self):
        empty = PlanBook(self.root, now=lambda: self.now)
        empty.observe({**self.context, "source": "MAINNET"})
        with self.assertRaisesRegex(ValueError, "Inspect fresh"):
            empty.create(self.plan)
        self.create()
        self.book.path.write_text('{broken')
        with self.assertRaises(ValueError):
            PlanBook(self.root)

    def test_limits_and_stop_geometry_not_weakened(self):
        for changes in ({"notionalUsd": 25.01}, {"notionalUsd": 4}, {"notionalUsd": True},
                        {"stopPrice": 0}, {"stopPrice": 10}, {"targetPrice": 10}, {"entrySlippageBps": 101},
                        {"maxHoldMs": float("nan")}, {"expiresAt": self.now-1}):
            with self.assertRaises(ValueError):
                self.book.create({**self.plan, **changes})

    def test_stale_wide_cost_funding_wallet_foreign_guards(self):
        self.create()
        variants = []
        for mutate in [lambda c: c["rows"][0]["book"].update(time=self.now-120001),
                       lambda c: c["rows"][0]["book"].update(ask=10.02),
                       lambda c: c["rows"][0]["economics"]["commission"].update(takerRate=.1),
                       lambda c: c["status"]["wallet"].update(fresh=False),
                       lambda c: c["status"]["wallet"]["snapshot"].update(availableBalance=5),
                       lambda c: c.update(unavailableSymbols=["DOGEUSDT"]),
                       lambda c: c["rows"][0]["economics"]["funding"].update(nextFundingTime=self.now+1000, nextSettlementCostBpsIfRateUnchanged={"LONG": 10})]:
            c = copy.deepcopy(self.context); mutate(c); variants.append(c)
        for c in variants:
            self.book.observe(c)
            self.assertFalse(self.book.get(self.plan["id"])["assessment"]["ready"])

    def test_short_direction_and_signed_forward_path(self):
        self.plan.update(side="SHORT", triggerKind="CLOSE_BELOW", entryMin=9.99, entryMax=10.02, stopPrice=10.3, targetPrice=9.7)
        self.assertTrue(self.create()["assessment"]["ready"])
        self.now += 600001
        self.context["overview"] = [{"symbol": "DOGEUSDT", "book": {"bid": 9.79, "ask": 9.8, "time": self.now}}]
        self.book.observe(self.context)
        shadow = self.book.get(self.plan["id"])["shadow"]
        self.assertAlmostEqual(shadow["lastObservedGrossBps"], 200)
        self.assertEqual(shadow["status"], "SAMPLED_HORIZON")
        self.assertEqual(shadow["provenance"], "SAMPLED_EXECUTABLE_QUOTES_NOT_FILLS")

    def test_no_retroactive_shadow_profit_and_large_gaps_unknown(self):
        self.create()
        self.assertEqual(self.book.get(self.plan["id"])["shadow"]["sampleN"], 1)
        self.now += 1300000
        self.context["overview"] = [{"symbol": "DOGEUSDT", "book": {"bid": 10.2, "ask": 10.201, "time": self.now}}]
        self.book.observe(self.context)
        self.assertEqual(self.book.get(self.plan["id"])["shadow"]["status"], "UNKNOWN_HORIZON_GAP")

    def test_setup_no_setup_wait_requires_link_and_ready_needs_explicit_veto(self):
        self.create()
        with patch.object(astra_runner, "gateway", return_value={"status": "WAIT_RECORDED"}) as gateway:
            d = self.decision(action="WAIT", reasonCode="NO_SETUP")
            self.assertEqual(json.loads(astra_runner.decision_result(d))["status"], "READY_REQUIRES_EXPLICIT_DECISION")
            gateway.assert_not_called()
            d["vetoReason"] = "Discretionary rejection: new thesis uncertainty; original tests remain passed."
            self.assertEqual(json.loads(astra_runner.decision_result(d))["status"], "WAIT_RECORDED")
            self.assertEqual(self.book.summary()["declinedReadyN"], 1)

    def test_frozen_open_reaches_gateway_with_exact_fields_and_idempotent_retry(self):
        self.create()
        def gateway(path, body):
            return copy.deepcopy(self.context) if path == "/context" else {"id": "owned", "state": "OPEN"}
        with patch.object(astra_runner, "gateway", side_effect=gateway) as g:
            d = self.decision()
            self.assertEqual(json.loads(astra_runner.decision_result(d))["state"], "OPEN")
            sent = g.call_args.args[1]
            self.assertEqual(sent["notionalUsd"], 6); self.assertEqual(sent["stopPrice"], 9.8)
            self.assertEqual(sent["slippageBps"], 5); self.assertNotIn("setupId", sent)
            self.assertEqual(json.loads(astra_runner.decision_result(d))["state"], "OPEN")
            self.assertEqual(g.call_args.args, ("/decision", sent))
            self.assertIn("decision_error", json.loads(astra_runner.decision_result(self.decision(id="duplicate_new_id"))))

    def test_fresh_preflight_failure_never_falls_back_to_cached_ready(self):
        self.create()
        with patch.object(astra_runner, "gateway", return_value={"gateway_error": "timeout"}) as g:
            self.assertEqual(json.loads(astra_runner.decision_result(self.decision()))["status"], "SETUP_DATA_UNAVAILABLE")
            self.assertEqual(g.call_count, 1)
            self.assertEqual(self.book.summary()["submittedN"], 0)

    def test_price_drift_and_changed_frozen_fields_prevent_post(self):
        self.create()
        with patch.object(astra_runner, "gateway") as g:
            self.assertIn("FROZEN_PLAN", astra_runner.decision_result(self.decision(stopPrice=9.7)))
            g.assert_not_called()
            c = copy.deepcopy(self.context); c["rows"][0]["book"]["ask"] = 11
            g.return_value = c
            self.assertEqual(json.loads(astra_runner.decision_result(self.decision()))["status"], "SETUP_NOT_READY")
            self.assertEqual(g.call_count, 1)

    def test_expired_plan_cannot_be_reused_for_endless_no_setup(self):
        self.create(); self.now = self.plan["expiresAt"]
        with patch.object(astra_runner, "gateway") as g:
            result = json.loads(astra_runner.decision_result(self.decision(action="WAIT", reasonCode="NO_SETUP")))
            self.assertIn("Expired", result["decision_error"])
            g.assert_not_called()

    def test_uncertain_submit_survives_restart_and_only_exact_id_is_reused(self):
        self.create()
        def gateway(path, body):
            if path == "/context": return copy.deepcopy(self.context)
            raise OSError("response lost after accepted order")
        with patch.object(astra_runner, "gateway", side_effect=gateway):
            self.assertIn("decision_error", json.loads(astra_runner.decision_result(self.decision())))
        restored = PlanBook(self.root, now=lambda: self.now)
        with patch.object(astra_runner, "PLAN_BOOK", restored), patch.object(astra_runner, "gateway", return_value={"state": "OPEN"}) as g:
            self.assertEqual(json.loads(astra_runner.decision_result(self.decision()))["state"], "OPEN")
            self.assertEqual(g.call_args.args[0], "/decision")
            self.assertEqual(g.call_args.args[1]["id"], "decision_open_001")
            g.reset_mock()
            self.assertIn("decision_error", json.loads(astra_runner.decision_result(self.decision(id="new_order_after_restart"))))
            g.assert_not_called()

    def test_full_setup_survives_actual_inline_projection_while_old_prose_is_abridged(self):
        self.create()
        c = copy.deepcopy(self.context)
        c["status"]["decisions"] = [{"decision": {"reason": "old context " * 500 + " old trailing trigger"}}]
        with patch.object(astra_runner, "gateway", return_value=c):
            result = json.loads(astra_runner.context_result({"symbols": ["DOGEUSDT"]}))
        self.assertEqual(result["frozenSetups"]["plans"][0]["plan"], self.plan)
        self.assertTrue(result["status"]["decisions"][0]["decision"]["reasonTruncatedInContext"])
        self.assertLess(len(json.dumps(result)), 90000)

    def test_close_and_hold_management_do_not_need_plan_or_wallet(self):
        with patch.object(astra_runner, "gateway", return_value={"state": "CLOSED"}) as g:
            d = {"id": "close_owned_001", "action": "CLOSE", "reasonCode": "CUT_LOSS", "tradeId": "owned", "reason": "Thesis invalidated"}
            self.assertEqual(json.loads(astra_runner.decision_result(d))["state"], "CLOSED")
            g.assert_called_once_with("/decision", d)

    def test_concurrent_open_requests_cannot_create_two_submission_ids(self):
        self.create()
        def gateway(path, body):
            return copy.deepcopy(self.context) if path == "/context" else {"state": "OPEN"}
        with patch.object(astra_runner, "gateway", side_effect=gateway) as g:
            with ThreadPoolExecutor(2) as pool:
                results = list(pool.map(lambda i: astra_runner.serialized_tool(astra_runner.decision_result, self.decision(id=f"parallel_open_{i}")), range(2)))
            self.assertEqual(sum('"state": "OPEN"' in r for r in results), 1)
            self.assertEqual(sum(c.args[0] == "/decision" for c in g.call_args_list), 1)

    def test_cadence_and_display_do_not_invent_actual_pnl(self):
        self.create()
        self.assertEqual(astra_runner.cycle_delay(220), 80)
        self.assertEqual(astra_runner.cycle_delay(350), 5)
        display = learning_snapshot(self.root, now=self.now/1000)
        self.assertIn("FROZEN SETUP JOURNAL", display["memoryText"])
        self.assertIn("NOT trading PnL", display["memoryText"])
        self.assertLessEqual(len(display["memoryText"]), 12000)



class RiskEnvelopeTests(unittest.TestCase):
    """An executable price far past the trigger takes a different trade than the frozen one."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.now = 1800000000000
        self.book = PlanBook(Path(self.tmp.name), now=lambda: self.now)
        self.observe(10, 10.001)
        self.plan = {"id": "envelope_plan_1", "symbol": "DOGEUSDT", "side": "LONG",
            "thesis": "Closed breakout remains accepted", "triggerKind": "CLOSE_ABOVE",
            "triggerPrice": 10, "entryMin": 9.99, "entryMax": 10.02, "stopPrice": 9.98,
            "targetPrice": 10.3, "notionalUsd": 6, "maxHoldMs": 600000,
            "expiresAt": self.now + 1800000, "maxSpreadBps": 5, "maxCostBps": 30,
            "entrySlippageBps": 5, "exitSlippageBps": 5, "fundingAllowanceBps": 2}

    def observe(self, bid, ask, close=10):
        self.book.observe({"source": "BINANCE_USDM_TESTNET", "unavailableSymbols": [],
            "status": {"environment": "testnet", "entryBlock": None, "lastError": None, "active": [],
                       "wallet": {"fresh": True, "snapshot": {"availableBalance": 1000}}},
            "rows": [{"symbol": "DOGEUSDT", "filters": {"minNotional": 5},
                "book": {"bid": bid, "ask": ask, "time": self.now},
                "candles": [{"closeTime": self.now - 1, "close": close}],
                "economics": {"commission": {"status": "AVAILABLE", "takerRate": .0005},
                    "funding": {"status": "INDICATIVE", "nextFundingTime": self.now + 3600000,
                                "nextSettlementCostBpsIfRateUnchanged": {"LONG": 1, "SHORT": -1}}}}]})

    def assess(self):
        return self.book.view(self.book.state["plans"][-1])["assessment"]

    # --- positive control: a well formed setup still executes
    def test_valid_setup_is_still_ready(self):
        self.book.create(copy.deepcopy(self.plan))
        a = self.assess()
        self.assertTrue(a["ready"], a["failed"])
        self.assertTrue(a["quoteEconomics"]["withinRiskEnvelope"])

    def test_gate_blocks_only_the_drifted_price_not_the_setup(self):
        self.book.create(copy.deepcopy(self.plan))
        self.assertTrue(self.assess()["ready"])
        self.observe(10.0195, 10.02)          # still inside the frozen band
        self.book.evaluate(self.book.state["plans"][-1])
        a = self.assess()
        self.assertFalse(a["ready"])
        self.assertEqual(a["failed"], ["riskEnvelope"])   # nothing else went wrong
        self.assertGreater(a["quoteEconomics"]["riskInflation"], MAX_RISK_INFLATION)

    # --- a band that can never qualify is malformed at birth
    def test_band_that_can_never_qualify_is_refused_at_creation(self):
        bad = {**self.plan, "id": "envelope_plan_2", "stopPrice": 9.99,
               "entryMin": 10.05, "entryMax": 10.1}
        with self.assertRaises(ValueError) as caught:
            self.book.create(bad)
        self.assertIn("risk envelope", str(caught.exception))
        self.assertEqual(self.book.state["plans"], [])

    def test_short_setups_are_measured_in_their_own_direction(self):
        short = {**self.plan, "id": "envelope_plan_3", "side": "SHORT", "triggerKind": "CLOSE_BELOW",
                 "triggerPrice": 10, "stopPrice": 10.1, "targetPrice": 9.7,
                 "entryMin": 9.98, "entryMax": 9.99}
        economics = quote_economics(short, 9.99)
        self.assertAlmostEqual(economics["plannedRiskBps"], 100.0, places=3)
        self.assertGreater(economics["entryDisplacementBps"], 0)   # bid below trigger is progress
        self.assertTrue(economics["withinRiskEnvelope"])
        drifted = quote_economics(short, 9.90)
        self.assertGreater(drifted["riskInflation"], MAX_RISK_INFLATION)

    def test_stop_on_the_wrong_side_of_the_trigger_fails_closed(self):
        economics = quote_economics({"side": "LONG", "triggerPrice": 10,
                                     "stopPrice": 10.5, "targetPrice": 11}, 10.1)
        self.assertIsNone(economics["riskInflation"])
        self.assertFalse(economics["withinRiskEnvelope"])

    # --- a reward ratio is reported, never used as the gate
    def test_moving_the_target_changes_the_ratio_but_not_admission(self):
        near = quote_economics(self.plan, 10.001, cost_bps=30)
        far = quote_economics({**self.plan, "targetPrice": 12}, 10.001, cost_bps=30)
        # Both the legacy and the cost-symmetric ratio move with the target; neither
        # is a gate, which is exactly why the ratio is reported and not consulted.
        self.assertGreater(far["rrAtQuoteDiagnosticLegacy"], near["rrAtQuoteDiagnosticLegacy"])
        self.assertGreater(far["rrCostSymmetricAtQuote"], near["rrCostSymmetricAtQuote"])
        self.assertEqual(far["withinRiskEnvelope"], near["withinRiskEnvelope"])
        self.assertEqual(far["riskInflation"], near["riskInflation"])

    # --- the gate's cost must be measurable in both directions
    def test_blocked_setup_still_samples_its_path_and_is_counted(self):
        # The band itself is admissible at its low end, so the setup is created;
        # only the drifted executable price is refused.
        self.observe(10.0195, 10.02)
        self.book.create({**self.plan, "id": "envelope_plan_4"})
        a = self.assess()
        self.assertEqual(a["failed"], ["riskEnvelope"])
        shadow = self.book.state["plans"][-1]["shadow"]
        self.assertIsNotNone(shadow)
        self.assertEqual(shadow["blockedBy"], "riskEnvelope")
        self.assertEqual(shadow["provenance"], "SAMPLED_EXECUTABLE_QUOTES_NOT_FILLS")
        self.assertEqual(self.book.summary()["blockedByRiskEnvelopeN"], 1)



class RiskEnvelopeConfigTests(unittest.TestCase):
    """The cap is an operator policy choice, tunable without a code deploy."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_default_matches_the_module_constant(self):
        self.assertEqual(PlanBook(self.root).cap, MAX_RISK_INFLATION)

    def test_override_is_applied_and_bounded(self):
        self.assertEqual(PlanBook(self.root, max_risk_inflation=1.5).cap, 1.5)
        for bad in (0.5, 6, "1.5", None if False else float("inf")):
            with self.assertRaises(ValueError):
                PlanBook(self.root, max_risk_inflation=bad)

    def test_a_looser_cap_admits_a_price_the_default_refuses(self):
        plan = {"side": "LONG", "triggerPrice": 10, "stopPrice": 9.98, "targetPrice": 10.3}
        self.assertFalse(quote_economics(plan, 10.02, cap=1.25)["withinRiskEnvelope"])
        self.assertTrue(quote_economics(plan, 10.02, cap=2.5)["withinRiskEnvelope"])


if __name__ == "__main__":
    unittest.main()

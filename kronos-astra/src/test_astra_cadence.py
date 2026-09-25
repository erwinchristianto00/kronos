import json
import unittest
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import astra_runner
from astra_cadence import CadenceBook, DEFAULTS, DAY_MS


class CadenceTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        (self.root / "hermes-home").mkdir()
        self.clock = 1788800000000
        self.book = self.make()

    def tearDown(self):
        self.dir.cleanup()

    def make(self, config=None):
        return CadenceBook(self.root, config, now=lambda: self.clock)

    def decide(self, owned=0, ready=0, unreviewed=0, live=0):
        status = {"active": [{"symbol": "X%d" % i} for i in range(owned)]}
        return self.book.decide(status, ready, unreviewed, live)

    # --- configuration
    def test_defaults_apply_when_absent(self):
        self.assertEqual(self.book.config, DEFAULTS)

    def test_unknown_or_invalid_setting_rejected(self):
        with self.assertRaises(ValueError):
            self.make({"nope": 1})
        with self.assertRaises(ValueError):
            self.make({"planFloor": 0})
        with self.assertRaises(ValueError):
            self.make({"planFloor": "3"})

    def test_override_applies(self):
        self.assertEqual(self.make({"planFloor": 9}).config["planFloor"], 9)

    # --- priority order
    def test_ready_setup_always_calls(self):
        d = self.decide(ready=1, live=5)
        self.assertTrue(d["call"])
        self.assertEqual(d["reason"], "READY_SETUP")

    def test_ready_setup_is_never_rate_limited(self):
        self.book.record("READY_SETUP")
        self.assertEqual(self.decide(ready=1)["reason"], "READY_SETUP")

    def test_owned_position_calls_then_waits_for_interval(self):
        self.assertEqual(self.decide(owned=1, live=5)["reason"], "OWNED_POSITION")
        self.book.record("OWNED_POSITION")
        self.assertFalse(self.decide(owned=1, live=5)["call"])
        self.clock += DEFAULTS["manageIntervalMs"]
        self.assertEqual(self.decide(owned=1, live=5)["reason"], "OWNED_POSITION")

    def test_unreviewed_trade_calls_then_waits(self):
        self.assertEqual(self.decide(unreviewed=1, live=5)["reason"], "UNREVIEWED_TRADE")
        self.book.record("UNREVIEWED_TRADE")
        self.assertFalse(self.decide(unreviewed=1, live=5)["call"])

    def test_formation_only_below_floor_and_after_interval(self):
        self.assertEqual(self.decide(live=0)["reason"], "PLAN_FORMATION")
        self.book.record("PLAN_FORMATION")
        self.assertFalse(self.decide(live=0)["call"])
        self.clock += DEFAULTS["formationIntervalMs"]
        self.assertEqual(self.decide(live=0)["reason"], "PLAN_FORMATION")
        # At or above the floor there is nothing to form.
        self.assertFalse(self.decide(live=DEFAULTS["planFloor"])["call"])

    def test_empty_pipeline_reforms_sooner_than_a_thin_one(self):
        self.book.record("PLAN_FORMATION")
        self.clock += DEFAULTS["emptyPipelineIntervalMs"]
        # One live setup still waits for the full formation interval.
        self.assertFalse(self.decide(live=1)["call"])
        # Nothing live at all is a different state and reforms now.
        d = self.decide(live=0)
        self.assertEqual(d["reason"], "PLAN_FORMATION")
        self.assertEqual(d["formationIntervalMs"], DEFAULTS["emptyPipelineIntervalMs"])

    def test_empty_pipeline_still_respects_the_daily_budget(self):
        self.spend_budget()
        self.clock += DEFAULTS["emptyPipelineIntervalMs"]
        self.assertEqual(self.decide(live=0)["outcome"], "SCREENED_BUDGET")

    def test_idle_slot_is_a_screened_evaluation(self):
        self.book.record("PLAN_FORMATION")
        d = self.decide(live=5)
        self.assertFalse(d["call"])
        self.assertEqual(d["outcome"], "SCREENED_NO_TRADE")

    # --- budget backstop
    def spend_budget(self):
        for _ in range(DEFAULTS["dailyModelCallBudget"]):
            self.book.record("PLAN_FORMATION")

    def test_budget_defers_formation_only(self):
        self.spend_budget()
        self.clock += DEFAULTS["formationIntervalMs"]
        d = self.decide(live=0)
        self.assertFalse(d["call"])
        self.assertEqual(d["outcome"], "SCREENED_BUDGET")

    def test_budget_never_blocks_owned_position_or_ready_setup(self):
        self.spend_budget()
        self.clock += DEFAULTS["manageIntervalMs"]
        self.assertEqual(self.decide(owned=1)["reason"], "OWNED_POSITION")
        self.assertEqual(self.decide(ready=1)["reason"], "READY_SETUP")

    def test_budget_counts_per_utc_day(self):
        self.spend_budget()
        self.assertEqual(self.book.budget()["remaining"], 0)
        self.clock += DAY_MS
        self.assertEqual(self.book.budget()["remaining"], DEFAULTS["dailyModelCallBudget"])

    # --- durability
    def test_journal_survives_restart(self):
        self.book.record("OWNED_POSITION")
        reopened = self.make()
        self.assertFalse(reopened.decide({"active": [{"symbol": "X"}]}, 0, 0, 5)["call"])

    def test_corrupt_journal_is_rejected_not_reset(self):
        (self.root / "hermes-home/astra-cadence.json").write_text(json.dumps({"version": 2}))
        with self.assertRaises(ValueError):
            self.make()

    def test_records_are_trimmed_but_recent_history_kept(self):
        self.book.record("PLAN_FORMATION")
        self.clock += 3 * DAY_MS
        self.book.record("PLAN_FORMATION")
        self.assertEqual(len(self.book.state["calls"]), 1)

    def test_failed_formation_retries_without_spending_a_successful_hour(self):
        self.book = self.make({"formationIntervalMs": 3600000})
        attempt = self.book.begin("PLAN_FORMATION")
        self.book.finish(attempt, "PROVIDER_UNAVAILABLE")
        self.assertEqual(self.book.budget()["used"], 1)
        self.assertEqual(self.decide(live=1)["outcome"], "SCREENED_RETRY_BACKOFF")
        self.clock += 900000
        self.assertEqual(self.decide(live=1)["reason"], "PLAN_FORMATION")
        attempt = self.book.begin("PLAN_FORMATION")
        self.book.finish(attempt, "MODEL_DECISION")
        self.clock += 900000
        self.assertFalse(self.decide(live=1)["call"])

    def test_retry_backoff_never_suppresses_ready_or_management(self):
        attempt = self.book.begin("PLAN_FORMATION")
        self.book.finish(attempt, "MODEL_INCOMPLETE")
        self.assertEqual(self.decide(live=1)["outcome"], "SCREENED_RETRY_BACKOFF")
        self.assertEqual(self.decide(ready=1)["reason"], "READY_SETUP")
        self.assertEqual(self.decide(owned=1)["reason"], "OWNED_POSITION")
        self.clock += 300000
        self.assertEqual(self.decide(live=1)["reason"], "PLAN_FORMATION")

    def test_failed_attempt_does_not_rewrite_a_later_call(self):
        old = self.book.begin("PLAN_FORMATION")
        self.clock += 1
        newer = self.book.begin("PLAN_FORMATION")
        self.book.finish(old, "PROVIDER_UNAVAILABLE")
        self.assertEqual(self.book.state["lastCallAt"]["PLAN_FORMATION"], newer["at"])



class ScreenCycleTests(unittest.TestCase):
    """The screen decides whether a slot needs the model. It must never trade by itself."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "hermes-home").mkdir()
        (self.root / "runner-config.json").write_text(json.dumps({"enabled": True, "gatewayPort": 3112}))
        self.plans = SimpleNamespace(state={"plans": []}, observe=lambda c: None,
                                     summary=lambda: {"readyN": 0},
                                     view=lambda p: {"assessment": p.get("assessment", {"ready": False, "failed": []})})
        self.calls = []
        # run_cycle/screen_cycle assign these module globals; patch them all so no stub leaks.
        patcher = patch.multiple(astra_runner, ROOT=self.root, PLAN_BOOK=self.plans,
                                 LEARNING_BOOK=None, EXPERIMENT_BOOK=None, CADENCE_BOOK=None, EXPERIMENT_REQUIRED=False)
        patcher.start()
        self.addCleanup(patcher.stop)

    def fake_gateway(self, path, payload=None):
        self.calls.append((path, payload))
        offset = payload.get("offset", 0)
        rows = payload["symbols"][offset:offset + 20]
        end = offset + len(rows)
        return {"source": "BINANCE_USDM_TESTNET", "status": {"environment": "testnet"},
                "rows": [{"symbol": s} for s in rows],
                "historyPage": {"offset": offset, "returned": len(rows),
                                "nextOffset": end if end < len(payload["symbols"]) else None}}

    def live_plan(self, symbol="AAAUSDT"):
        far = int(__import__("time").time() * 1000) + 3600000
        return {"plan": {"id": "p1", "symbol": symbol, "expiresAt": far}}

    def test_no_live_setup_means_no_exchange_read(self):
        with patch.object(astra_runner, "gateway", self.fake_gateway):
            decision = astra_runner.screen_cycle({"active": []})
        self.assertEqual(self.calls, [])
        self.assertEqual(decision["reason"], "PLAN_FORMATION")

    def test_readiness_screen_reads_only_its_own_setup_symbols(self):
        self.plans.state["plans"] = [self.live_plan("AAAUSDT"), self.live_plan("BBBUSDT")]
        with patch.object(astra_runner, "gateway", self.fake_gateway):
            astra_runner.screen_cycle({"active": []})
        self.assertEqual(self.calls, [("/context", {"symbols": ["AAAUSDT", "BBBUSDT"]})])

    def test_idle_slot_is_screened_without_a_model_call(self):
        self.plans.state["plans"] = [self.live_plan() for _ in range(DEFAULTS["planFloor"])]
        with patch.object(astra_runner, "gateway", self.fake_gateway):
            decision = astra_runner.screen_cycle({"active": []})
        self.assertFalse(decision["call"])
        self.assertEqual(decision["outcome"], "SCREENED_NO_TRADE")

    def test_ready_setup_reaches_the_model(self):
        self.plans.state["plans"] = [self.live_plan()]
        self.plans.state["plans"][0]["assessment"] = {"ready": True, "failed": []}
        with patch.object(astra_runner, "gateway", self.fake_gateway):
            decision = astra_runner.screen_cycle({"active": []})
        self.assertTrue(decision["call"])
        self.assertEqual(decision["reason"], "READY_SETUP")

    def test_screen_failure_calls_the_model(self):
        self.plans.state["plans"] = [self.live_plan()]

        def broken(path, payload=None):
            return {"gateway_error": {"reason": "transport"}}

        with patch.object(astra_runner, "gateway", broken):
            decision = astra_runner.screen_cycle({"active": []})
        self.assertTrue(decision["call"])
        self.assertEqual(decision["reason"], "SCREEN_UNAVAILABLE")

    def test_owned_position_always_reaches_the_model_when_due(self):
        self.plans.state["plans"] = [self.live_plan() for _ in range(DEFAULTS["planFloor"])]
        with patch.object(astra_runner, "gateway", self.fake_gateway):
            decision = astra_runner.screen_cycle({"active": [{"symbol": "KASUSDT"}]})
        self.assertEqual(decision["reason"], "OWNED_POSITION")
        self.assertEqual(self.calls, [])

    def test_foreign_arm_plans_do_not_suppress_formation_or_trigger_false_ready(self):
        self.plans.state["plans"] = [self.live_plan() for _ in range(3)]
        for p in self.plans.state["plans"]:
            p["assessment"] = {"ready": True, "failed": []}
        def reject(p):
            raise ValueError("Plan belongs to a different strategy version")
        experiment = SimpleNamespace(check_entry=reject, current={"version": "candidate"})
        with patch.object(astra_runner, "EXPERIMENT_BOOK", experiment), patch.object(astra_runner, "gateway", self.fake_gateway):
            d = astra_runner.screen_cycle({"active": []})
        self.assertEqual(d["reason"], "PLAN_FORMATION")
        self.assertEqual((d["liveSetups"], d["readyN"], d["allLiveSetups"]), (0, 0, 3))
        self.assertEqual(len(d["ineligibleSetups"]), 3)
        self.assertEqual(self.calls, [])

    def test_screen_covers_more_than_one_history_page(self):
        self.plans.state["plans"] = [self.live_plan("COIN%02dUSDT" % i) for i in range(21)]
        self.plans.state["plans"][-1]["assessment"] = {"ready": True, "failed": []}
        with patch.object(astra_runner, "gateway", self.fake_gateway):
            d = astra_runner.screen_cycle({"active": []})
        self.assertEqual([a[1].get("offset", 0) for a in self.calls], [0, 20])
        self.assertEqual(self.calls[0][1]["symbols"], self.calls[1][1]["symbols"])
        self.assertEqual(d["reason"], "READY_SETUP")

    def test_time_bounded_short_history_pages_follow_the_exact_continuation(self):
        self.plans.state["plans"] = [self.live_plan("COIN%02dUSDT" % i) for i in range(4)]
        def short_page(path, payload):
            self.calls.append((path, payload))
            offset = payload.get("offset", 0)
            return {"source": "BINANCE_USDM_TESTNET", "status": {"environment": "testnet"},
                    "rows": [{"symbol": payload["symbols"][offset]}],
                    "historyPage": {"offset": offset, "returned": 1, "nextOffset": offset + 1 if offset < 3 else None}}
        with patch.object(astra_runner, "gateway", short_page):
            d = astra_runner.screen_cycle({"active": []})
        self.assertFalse(d["call"])
        self.assertEqual([p.get("offset", 0) for _, p in self.calls], [0, 1, 2, 3])

    def test_nonadvancing_history_cursor_is_a_fault_not_an_infinite_loop(self):
        self.plans.state["plans"] = [self.live_plan(), self.live_plan("BBBUSDT")]
        response = {"source": "BINANCE_USDM_TESTNET", "status": {"environment": "testnet"},
                    "rows": [{"symbol": "AAAUSDT"}], "historyPage": {"offset": 0, "returned": 1, "nextOffset": 0}}
        with patch.object(astra_runner, "gateway", return_value=response) as gateway:
            d = astra_runner.screen_cycle({"active": []})
        self.assertEqual(d["reason"], "SCREEN_UNAVAILABLE")
        self.assertEqual(gateway.call_count, 1)

    def test_missing_history_wrong_venue_or_stale_data_is_not_no_trade(self):
        self.plans.state["plans"] = [self.live_plan() for _ in range(3)]
        for context in ({"source": "BINANCE_USDM_TESTNET", "status": {"environment": "testnet"}, "rows": []},
                        {"source": "MAINNET", "status": {"environment": "testnet"}, "rows": [{"symbol": "AAAUSDT"}]}):
            with patch.object(astra_runner, "gateway", return_value=context):
                self.assertEqual(astra_runner.screen_cycle({"active": []})["reason"], "SCREEN_UNAVAILABLE")
        self.plans.state["plans"][0]["assessment"] = {"ready": False, "failed": ["dataFresh"]}
        with patch.object(astra_runner, "gateway", self.fake_gateway):
            self.assertEqual(astra_runner.screen_cycle({"active": []})["reason"], "SCREEN_UNAVAILABLE")



class RunCycleScreeningTests(unittest.TestCase):
    """A screened slot must cost zero model calls and still be recorded as an evaluation."""

    def test_screened_cycle_never_constructs_an_agent(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / "logs").mkdir()
        (root / "runner-config.json").write_text(json.dumps({"enabled": True, "gatewayPort": 3112}))
        recorded = []
        plans = SimpleNamespace(state={"plans": []}, observe=lambda c: None,
                                summary=lambda: {"readyN": 0, "total": 0})
        experiment = SimpleNamespace(start_cycle=lambda: {"arm": "CONTROL"},
                                     finish_cycle=recorded.append, summary=lambda: {"stub": True})
        learning = SimpleNamespace(observe_context=lambda c: None, delivered=set(),
                                   state={"lessons": []}, summary=lambda *a, **k: {"unreviewedN": 0})

        def boom(*args, **kwargs):
            raise AssertionError("screened cycle must not reach the provider")

        with patch.multiple(astra_runner, ROOT=root,
                            PLAN_BOOK=None, LEARNING_BOOK=None, EXPERIMENT_BOOK=None,
                            CADENCE_BOOK=None, EXPERIMENT_REQUIRED=False,
                            gateway=lambda path, payload=None: {"active": []},
                            validate_capital_identity=lambda before: None,
                            PlanBook=lambda r, **kwargs: plans,
                            ExperimentBook=lambda r, h, **k: experiment,
                            LearningBook=lambda r: learning,
                            refresh_learning_report=lambda: None,
                            screen_cycle=lambda before: {"call": False, "outcome": "SCREENED_NO_TRADE",
                                                         "why": "idle"},
                            make_agent=boom, sync_dashboard=lambda: None):
            astra_runner.run_cycle(True)

        self.assertEqual(recorded, ["SCREENED_NO_TRADE"])
        receipt = json.loads((root / "logs/cycles.jsonl").read_text().strip())
        self.assertFalse(receipt["modelCalled"])
        self.assertTrue(receipt["evaluationComplete"])
        self.assertEqual(receipt["turnsUsed"], 0)
        self.assertEqual(receipt["turnsLimit"], astra_runner.MAX_TURNS)


if __name__ == "__main__":
    unittest.main()

"""Synthetic fixtures only: never call provider, exchange or real order gateway."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, Mock
import astra_runner
from astra_experiments import ExperimentBook, GATES, DAY, SLOT, metrics, completion, reliability_outlook
from hermes_dashboard import learning_snapshot


class StrategyTrialTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.now = 1800000000000
        self.book = ExperimentBook(self.root, "test_policy_hash", now=lambda: self.now)
        self.learning = SimpleNamespace(fresh=lambda: True, state={"lessons": [{"id": "lesson_001"}],
            "tradeDecisions": {}, "report": {"at": self.now, "closed": [], "excludedClosedN": 0}})
        self.proposal = {"name": "Continuation evidence variant", "dimension": "entryEvidence",
            "oneChange": "Prefer a different predeclared entry-evidence hypothesis.",
            "hypothesis": "Changed evidence may improve net results; this is not proven.",
            "entryApplication": "Freeze the precise numeric plan before sending an order.",
            "invalidation": "Use original frozen native stop and original hold duration.",
            "disconfirmingEvidence": "Future negative net or worse baseline comparison contradicts it.",
            "lessonIds": ["lesson_001"]}
        self.book.start_cycle()
        self.baseline = self.book.state["champion"]
        self.candidate = self.book.propose(self.proposal, self.learning)
        self.raw = {"noFill": []}
        self.closed = []

    def sync(self):
        self.learning.state["report"] = {"at": self.now, "closed": copy.deepcopy(self.closed), "excludedClosedN": 0}
        self.book.sync_evidence(self.learning, self.raw)

    def test_model_sees_plan_assignment_without_relabeling(self):
        plan = {"createdAt": self.now, "plan": {"id": "assigned_plan_01"}}
        self.book.bind_plan(plan)
        original = copy.deepcopy(self.book.state["planVersions"])
        plans = SimpleNamespace(get=lambda _: plan)
        with patch.multiple(astra_runner, PLAN_BOOK=plans, EXPERIMENT_BOOK=self.book):
            view = astra_runner.annotated_plan({"plan": plan["plan"], "assessment": {"ready": True}})
            self.assertTrue(view["strategyEligibility"]["eligible"])
            self.book.current = {"version": "different-version"}
            view = astra_runner.annotated_plan({"plan": plan["plan"], "assessment": {"ready": True}})
            self.assertFalse(view["strategyEligibility"]["eligible"])
            self.assertTrue(view["assessment"]["ready"])
        self.assertEqual(self.book.state["planVersions"], original)

    def one(self, candidate_net=.04, control_net=.01, symbol=None):
        a = self.book.start_cycle()
        plan = {"createdAt": self.now, "plan": {"id": "plan_"+a["id"], "symbol": symbol or "COIN"+str(int(a["id"])%3), "notionalUsd": 6}}
        self.book.bind_plan(plan)
        decision = "decision_"+a["id"]
        self.book.record_submission(decision, plan)
        trade_id = "trade_"+a["id"]
        self.book.record_result(decision, {"id": trade_id, "state": "OPEN"})
        self.learning.state["tradeDecisions"][trade_id] = decision
        net = candidate_net if a["arm"] == "CANDIDATE" else control_net
        t = {"id": trade_id, "openedAt": self.now+1, "closedAt": self.now+2,
             "net": net, "gross": net+.005, "fees": .005, "funding": 0,
             "entryNotional": 6, "symbol": plan["plan"]["symbol"]}
        self.closed.append(t)
        self.book.finish_cycle(True)
        return a, plan, t

    def phase(self, candidate_net=.04, control_net=.01, symbol=None):
        start = (self.now//DAY+1)*DAY
        # 10 complete calendar blocks, balanced assignment BEFORE any result per block.
        # Each arm gets exactly 30 entries, with rotating symbols independent of arm.
        for d in range(10):
            for i in range(6):
                self.now = start+d*DAY+(i+1)*300000
                self.one(candidate_net, control_net, symbol or "COIN"+str(d%3))
        self.now = start+10*DAY
        self.sync()

    def test_candidate_immutable_and_current_cycle_not_reassigned(self):
        self.assertEqual(self.book.current["version"], self.baseline)
        same = self.book.propose(copy.deepcopy(self.proposal), self.learning)
        self.assertEqual(same["id"], self.candidate["id"])
        with self.assertRaises(ValueError):
            self.book.propose({**self.proposal, "oneChange": "Alter threshold after observing losses."}, self.learning)
        self.assertEqual(self.book.state["champion"], self.baseline)

    def test_invalid_proposals_missing_lessons_and_unfresh_data_rejected(self):
        for changes in ({"lessonIds": ["invented"]}, {"dimension": "leverage"}, {"forcePromote": True}):
            with self.assertRaises(ValueError):
                self.book.propose({**self.proposal, **changes}, self.learning)
        self.learning.fresh = lambda: False
        with self.assertRaises(ValueError):
            self.book.propose(self.proposal, self.learning)

    def test_assignment_balanced_persisted_and_idempotent_same_slot(self):
        arms = []
        for i in range(10):
            self.now += 300000
            a = self.book.start_cycle()
            arms.append(a["arm"])
            restored = ExperimentBook(self.root, "test_policy_hash", now=lambda: self.now)
            self.assertEqual(restored.start_cycle(), a)
        for i in range(0, 10, 2):
            self.assertEqual(set(arms[i:i+2]), {"CANDIDATE", "CONTROL"})

    def test_baseline_and_candidate_plans_cannot_be_relabeled(self):
        self.now += 300000
        self.book.start_cycle()
        p = {"createdAt": self.now, "plan": {"id": "new_plan_01", "threshold": 1}}
        self.book.bind_plan(p)
        self.book.check_entry(p)
        with self.assertRaises(ValueError):
            self.book.check_entry({**p, "plan": {**p["plan"], "threshold": 2}})
        self.now += 300000
        self.book.start_cycle()
        with self.assertRaises(ValueError):
            self.book.check_entry(p)

    def test_existing_pre_cutover_plan_only_grandfathered_baseline(self):
        p = {"createdAt": self.book.state["createdAt"]-1, "plan": {"id": "legacy_plan"}}
        self.book.check_entry(p)
        with self.assertRaises(ValueError):
            self.book.check_entry({**p, "createdAt": self.now})

    def test_duplicate_create_cannot_relabel_legacy_plan_as_candidate(self):
        p = {"createdAt": self.book.state["createdAt"]-1, "plan": {"id": "legacy_plan"}}
        while self.book.current["version"] == self.baseline:
            self.now += 300000
            self.book.start_cycle()
        self.book.bind_plan(p)
        self.assertEqual(self.book.state["planVersions"]["legacy_plan"]["version"], self.baseline)
        with self.assertRaises(ValueError):
            self.book.check_entry(p)
        with self.assertRaises(ValueError):
            self.book.bind_plan({"createdAt": self.book.current["at"]-1, "plan": {"id": "untracked_old"}})

    def test_past_unassigned_results_do_not_enter_candidate_performance(self):
        self.closed = [{"id": "old", "openedAt": self.now-100, "closedAt": self.now-50,
            "net": 1000, "gross": 1001, "fees": 1, "funding": 0, "entryNotional": 6, "symbol": "X"}]
        self.sync()
        self.assertEqual(self.book.summary()["progress"]["arms"]["CANDIDATE"]["closedN"], 0)
        self.book.advance()
        self.assertEqual(self.book.active()["status"], "HOLDOUT")

    def test_single_winner_cannot_promote_and_wait_denominator_retained(self):
        self.now += 300000
        self.one(candidate_net=100)
        self.now += 300000
        self.book.start_cycle()
        self.book.finish_cycle(True)
        self.sync()
        self.book.advance()
        d = self.book.summary()["progress"]
        self.assertEqual(sum(x["cycles"] for x in d["arms"].values()), 2)
        self.assertEqual(sum(x["closedN"] for x in d["arms"].values()), 1)
        self.assertEqual(self.book.state["champion"], self.baseline)

    def test_three_disjoint_fixed_windows_then_new_candidate_allowed(self):
        self.phase()
        study = self.book.active()
        self.book.advance()
        self.assertEqual(study["status"], "FORWARD")
        self.assertEqual(self.book.state["champion"], self.baseline)
        self.assertEqual(self.book.summary()["progress"]["arms"]["CANDIDATE"]["closedN"], 0)
        self.phase()
        self.book.advance()
        self.assertEqual(study["status"], "MONITOR")
        self.assertEqual(self.book.state["champion"], self.candidate["id"])
        self.phase()
        self.book.advance()
        self.assertIsNone(self.book.active())
        self.assertIsNotNone(self.book.state["watch"])
        self.now += 300000
        self.book.start_cycle()
        child = self.book.propose({**self.proposal, "dimension": "opportunityRanking", "oneChange": "Compare a second distinct independently registered hypothesis."}, self.learning)
        self.assertEqual(set(child["effectiveChanges"]), {"entryEvidence", "opportunityRanking"})

    def test_failed_forward_screen_does_not_replace_incumbent(self):
        self.phase()
        self.book.advance()
        self.phase(candidate_net=-.02)
        self.book.advance()
        self.assertIsNone(self.book.active())
        self.assertEqual(self.book.state["studies"][-1]["status"], "REJECTED")
        self.assertEqual(self.book.state["champion"], self.baseline)

    def test_no_optional_repeated_peeking_until_same_candidate_passes(self):
        self.phase(candidate_net=-.1)
        self.book.advance()
        original = copy.deepcopy(self.book.state["studies"][-1]["phases"][0]["result"])
        self.closed = [{**t, "net": 10, "gross": 10.005} for t in self.closed]
        self.sync()
        self.book.advance()
        self.assertEqual(self.book.state["studies"][-1]["phases"][0]["result"], original)
        # Resubmitting the identical candidate is refused outright rather than
        # silently returning the old version, which could read as a fresh trial.
        with self.assertRaises(ValueError):
            self.book.propose(self.proposal, self.learning)
        self.assertIsNone(self.book.active())
        self.assertEqual(self.book.state["studies"][-1]["status"], "REJECTED")

    def test_unknown_submission_seals_and_waits_without_losing_denominator(self):
        self.phase()
        self.now += 300000
        # Avoid advance until recording an unknown submission at the end of this window.
        with patch.object(self.book, "advance"):
            self.book.start_cycle()
        p = {"createdAt": self.now, "plan": {"id": "unknown_plan"}}
        self.book.bind_plan(p)
        self.book.record_submission("uncertain_order_01", p)
        self.book.finish_cycle(True)
        self.sync()
        self.book.advance()
        self.assertEqual(self.book.active()["status"], "HOLDOUT")
        self.assertIsNotNone(self.book.active()["phases"][-1]["sealedAt"])
        self.assertEqual(self.book.summary()["progress"]["pending"], 1)
        self.now += 300000
        self.assertEqual(self.book.start_cycle()["arm"], "INCUMBENT")

    def test_no_fill_not_a_profit_or_settled_trade(self):
        self.now += 300000
        self.book.start_cycle()
        p = {"createdAt": self.now, "plan": {"id": "no_fill_plan"}}
        self.book.bind_plan(p)
        self.book.record_submission("no_fill_decision", p)
        self.book.record_result("no_fill_decision", {"id": "no_fill_trade", "state": "NO_FILL"})
        self.raw["noFill"] = [{"id": "no_fill_trade", "state": "NO_FILL"}]
        self.sync()
        d = self.book.summary()["progress"]
        self.assertEqual(d["pending"], 0)
        self.assertEqual(sum(a["closedN"] for a in d["arms"].values()), 0)

    def test_deadline_with_no_evidence_stops_candidate_enrollment(self):
        self.now += 31*DAY
        a = self.book.start_cycle()
        self.assertEqual(a["arm"], "INCUMBENT")
        self.sync()
        self.book.advance()
        self.assertIsNone(self.book.active())
        self.assertEqual(self.book.state["studies"][-1]["phases"][-1]["result"]["reason"], "INSUFFICIENT_EVIDENCE_AT_DEADLINE")

    def test_stale_or_partial_accounting_prevents_promotion(self):
        self.phase()
        self.now += 120001
        self.book.advance()
        self.assertEqual(self.book.active()["status"], "HOLDOUT")
        self.sync()
        self.book.state["evidence"]["excludedClosedN"] = 1
        self.book.advance()
        self.assertEqual(self.book.active()["status"], "HOLDOUT")

    def test_concentrated_wins_cannot_pass(self):
        self.phase(symbol="ONLY_ONE_SYMBOL")
        self.book.advance()
        result = self.book.state["studies"][-1]["phases"][-1]["result"]
        self.assertFalse(result["passed"])
        self.assertFalse(result["checks"]["symbolBreadth"])

    def test_cost_drag_cannot_be_disguised_as_gross_alpha(self):
        m = metrics([{"id": "x", "closedAt": 1, "net": -.1, "gross": .5, "fees": .6, "funding": 0, "entryNotional": 5, "symbol": "A"}], 3, 9)
        self.assertLess(m["expectancy"], 0)
        # Per dispatched cycle, not per enrolled slot: 3 of the 9 slots reached the model.
        self.assertAlmostEqual(m["netPerDispatchedCycle"], -.1/3)
        self.assertEqual((m["cycles"], m["assignedCycles"]), (3, 9))
        self.assertGreater(m["closedDrawdownUsd"], 0)

    def test_post_promotion_failed_monitor_restores_previous_without_order_calls(self):
        self.phase(); self.book.advance()
        self.phase(); self.book.advance()
        self.assertEqual(self.book.state["champion"], self.candidate["id"])
        self.phase(candidate_net=-.02); self.book.advance()
        self.assertEqual(self.book.state["champion"], self.baseline)
        self.assertEqual(self.book.state["studies"][-1]["status"], "ROLLED_BACK")

    def test_later_nonoverlapping_champion_watch_rolls_back_and_invalidates_new_trial(self):
        for _ in range(3):
            self.phase(); self.book.advance()
        for i in range(30):
            self.now += 300000
            # Unscored incumbent entries after the monitor, tracked for the 30-outcome watch.
            self.one(candidate_net=-.01, control_net=-.01)
        self.sync()
        self.book.check_watch()
        self.assertEqual(self.book.state["champion"], self.baseline)
        self.assertIsNone(self.book.state["watch"])
        self.assertEqual(self.book.state["events"][-1]["status"], "WATCH_ROLLBACK")

    def test_larger_exposure_alone_does_not_pass_promotion(self):
        self.phase()
        study = self.book.active()
        data = self.book.phase_data(study, study["phases"][-1])
        data["arms"]["CANDIDATE"]["notionalPerDispatchedCycle"] = 100
        result = self.book.judge(study, study["phases"][-1], data)
        self.assertFalse(result["checks"]["comparableExposure"])
        self.assertFalse(result["passed"])

    def test_missing_result_recovery_uses_durable_decision_mapping(self):
        self.now += 300000
        a, p, trade = self.one()
        self.book.state["submissions"]["decision_"+a["id"]]["tradeId"] = None
        self.sync()
        data = self.book.summary()["progress"]
        self.assertEqual(data["pending"], 0)
        self.assertEqual(sum(m["closedN"] for m in data["arms"].values()), 1)

    def test_unknown_submissions_never_reassigned_by_retry(self):
        self.now += 300000
        a, p, trade = self.one()
        self.now += 600000
        self.book.start_cycle()
        with self.assertRaises(ValueError):
            self.book.record_submission("decision_"+a["id"], p)

    def test_corrupt_or_changed_identity_gates_fail_closed(self):
        with self.assertRaises(ValueError):
            ExperimentBook(self.root, "other_policy_hash")
        self.book.state["gates"]["minClosedPerArm"] = 1
        self.book.save()
        with self.assertRaises(ValueError):
            ExperimentBook(self.root, "test_policy_hash")

    def test_tool_cannot_force_promotion(self):
        with patch.object(astra_runner, "EXPERIMENT_BOOK", self.book):
            response = json.loads(astra_runner.experiment_result({"operation": "PROMOTE"}))
        self.assertIn("experiment_error", response)
        self.assertEqual(self.book.state["champion"], self.baseline)

    def test_full_final_gateway_submission_has_persisted_strategy_before_post(self):
        self.now += 300000
        self.book.start_cycle()
        p = {"createdAt": self.now, "plan": {"id": "full_plan", "symbol": "XUSDT", "side": "LONG", "notionalUsd": 6,
             "stopPrice": 1, "targetPrice": 3, "maxHoldMs": 300000, "entrySlippageBps": 5,
             "expiresAt": self.now+300000, "triggerPrice": 2, "entryMin": 1.99, "entryMax": 2.01,
             "maxSpreadBps": 10, "maxCostBps": 40, "exitSlippageBps": 10, "fundingAllowanceBps": 5}}
        self.book.bind_plan(p)
        plans = SimpleNamespace(get=lambda _: p, state={"submissions": {}}, observe=lambda _: None,
                                rows={}, path=self.root / "hermes-home/astra-plans.json",
                                evaluate=lambda _: {"ready": True, "failed": []}, save=lambda: None, now=lambda: self.now)
        request = {"id": "integration_open", "action": "OPEN", "setupId": "full_plan", "reason": "frozen plan", "reasonCode": "EXPERIMENT_OPEN"}
        def gateway(path, body):
            if path == "/context":
                return {"source": "BINANCE_USDM_TESTNET", "status": {"environment": "testnet", "executionVersion": "astra-final-book-contract-v1-20260909"}, "rows": [{"symbol": "XUSDT", "economics": {"commission": {"takerRate": .0005}}}]}
            restored = ExperimentBook(self.root, "test_policy_hash", now=lambda: self.now)
            self.assertIn(request["id"], restored.state["submissions"])
            self.assertEqual(body["notionalUsd"], 6)
            self.assertEqual(body["stopPrice"], 1)
            self.assertEqual(body["entryContract"]["entryMax"], 2.01)
            self.assertEqual(body["entryContract"]["takerRate"], .0005)
            return {"id": "integration_trade", "state": "OPEN"}
        with patch.object(astra_runner, "EXPERIMENT_BOOK", self.book), patch.object(astra_runner, "PLAN_BOOK", plans), patch.object(astra_runner, "gateway", side_effect=gateway):
            result = json.loads(astra_runner.decision_result(request))
        self.assertEqual(result["state"], "OPEN")
        self.assertEqual(self.book.state["submissions"][request["id"]]["tradeId"], "integration_trade")

    def test_management_allowed_when_trial_journal_unavailable(self):
        with patch.object(astra_runner, "EXPERIMENT_REQUIRED", True), patch.object(astra_runner, "EXPERIMENT_BOOK", None), patch.object(astra_runner, "PLAN_BOOK", SimpleNamespace(state={"submissions": {}})), patch.object(astra_runner, "gateway", return_value={"ok": True}) as gateway:
            closed = json.loads(astra_runner.decision_result({"action": "CLOSE", "id": "close_001", "tradeId": "old"}))
            self.assertTrue(closed["ok"])
            rejected = json.loads(astra_runner.decision_result({"action": "OPEN", "id": "open_001"}))
            self.assertIn("decision_error", rejected)
            gateway.assert_called_once()

    def test_dashboard_and_context_show_version_and_unproven_status(self):
        summary = learning_snapshot(self.root, now=self.now/1000)
        self.assertIn("STRATEGY VERSION TRIALS", summary["memoryText"])
        self.assertIn("HOLDOUT", summary["memoryText"])
        with patch.object(astra_runner, "EXPERIMENT_BOOK", self.book), patch.object(astra_runner, "gateway", return_value={}):
            output = json.loads(astra_runner.context_result({"symbols": []}))
        self.assertEqual(output["strategyTrial"]["assignment"]["version"], self.baseline)



class CycleOutcomeTests(unittest.TestCase):
    """Provider and budget losses must never score as model behaviour."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.now = 1800000000000
        self.book = ExperimentBook(Path(self.tmp.name), "test_policy_hash", now=lambda: self.now)

    def slot(self, outcome):
        self.now += 300000
        a = self.book.start_cycle()
        self.book.finish_cycle(outcome)
        return a

    def rate(self):
        return completion(list(self.book.state["assignments"].values()))

    def test_outcome_is_recorded_on_the_assignment(self):
        self.assertEqual(self.slot("SCREENED_NO_TRADE")["outcome"], "SCREENED_NO_TRADE")

    def test_unknown_outcome_rejected(self):
        self.book.start_cycle()
        with self.assertRaises(ValueError):
            self.book.finish_cycle("SOMETHING_ELSE")

    def test_bool_stays_valid_for_older_callers(self):
        self.book.start_cycle()
        self.assertEqual(self.book.finish_cycle(True), "MODEL_DECISION")
        self.now += 300000
        self.book.start_cycle()
        self.assertEqual(self.book.finish_cycle(False), "MODEL_INCOMPLETE")

    def test_provider_outage_is_excluded_not_counted_as_failure(self):
        self.slot("MODEL_DECISION")
        for _ in range(50):
            self.slot("PROVIDER_UNAVAILABLE")
        r = self.rate()
        self.assertEqual(r["completionRate"], 1.0)
        self.assertEqual(r["scoredAssignments"], 1)
        self.assertEqual(r["excludedAssignments"], 50)

    def test_budget_deferral_is_excluded_too(self):
        self.slot("MODEL_DECISION")
        self.slot("SCREENED_BUDGET")
        self.assertEqual(self.rate()["completionRate"], 1.0)

    def test_screened_slot_is_a_completed_evaluation(self):
        self.slot("SCREENED_NO_TRADE")
        self.slot("MODEL_DECISION")
        r = self.rate()
        self.assertEqual(r["completionRate"], 1.0)
        self.assertEqual(r["scoredAssignments"], 2)

    def test_model_incompleteness_still_lowers_reliability(self):
        self.slot("MODEL_DECISION")
        self.slot("MODEL_INCOMPLETE")
        self.assertEqual(self.rate()["completionRate"], 0.5)

    def test_legacy_assignments_keep_their_recorded_history(self):
        legacy = [{"completed": True}, {"completed": False}, {"completed": False}]
        r = completion(legacy)
        self.assertEqual(r["scoredAssignments"], 3)
        self.assertEqual(r["unclassifiedLegacy"], 3)
        self.assertAlmostEqual(r["completionRate"], 1/3)

    def test_outcome_breakdown_is_reported(self):
        self.slot("PROVIDER_UNAVAILABLE")
        self.slot("SCREENED_NO_TRADE")
        self.assertEqual(self.rate()["outcomes"]["PROVIDER_UNAVAILABLE"], 1)
        self.assertEqual(self.rate()["outcomes"]["SCREENED_NO_TRADE"], 1)


class OutcomeClassificationTests(unittest.TestCase):
    def test_completed_cycle_is_a_model_decision(self):
        self.assertEqual(astra_runner.classify_outcome({"completed": True}), "MODEL_DECISION")

    def test_rate_limit_is_provider_unavailable(self):
        for text in ("API call failed after 3 retries: HTTP 429: The usage limit has been reached",
                     "Connection reset by peer", "HTTP 503 service unavailable", "Request timed out"):
            self.assertEqual(astra_runner.classify_outcome({"completed": False, "final_response": text}),
                             "PROVIDER_UNAVAILABLE", text)

    def test_model_failure_is_not_blamed_on_the_provider(self):
        self.assertEqual(astra_runner.classify_outcome(
            {"completed": False, "final_response": "Reached maximum iterations without a decision"}),
            "MODEL_INCOMPLETE")

    def test_missing_response_is_model_incomplete(self):
        self.assertEqual(astra_runner.classify_outcome({"completed": False}), "MODEL_INCOMPLETE")



class InvalidationTests(unittest.TestCase):
    """Ending a study for infrastructure reasons must not read as a strategy verdict."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.now = 1800000000000
        self.book = ExperimentBook(Path(self.tmp.name), "test_policy_hash", now=lambda: self.now)
        self.learning = SimpleNamespace(fresh=lambda: True, state={"lessons": [{"id": "lesson_001"}],
            "tradeDecisions": {}, "report": {"at": self.now, "closed": [], "excludedClosedN": 0}})
        self.proposal = {"name": "Continuation evidence variant", "dimension": "entryEvidence",
            "oneChange": "Prefer a different predeclared entry-evidence hypothesis.",
            "hypothesis": "Changed evidence may improve net results; this is not proven.",
            "entryApplication": "Freeze the precise numeric plan before sending an order.",
            "invalidation": "Use original frozen native stop and original hold duration.",
            "disconfirmingEvidence": "Future negative net or worse baseline comparison contradicts it.",
            "lessonIds": ["lesson_001"]}
        self.book.start_cycle()
        self.baseline = self.book.state["champion"]
        self.candidate = self.book.propose(self.proposal, self.learning)
        self.study = self.book.active()

    def note(self):
        return "Provider outage poisoned the enrollment denominator; no arm comparison is possible."

    def kill(self, reason="INFRASTRUCTURE"):
        return self.book.invalidate(self.study["id"], reason, self.note())

    def test_invalidation_ends_the_study_without_a_verdict(self):
        result = self.kill()
        self.assertFalse(result["passed"])
        self.assertEqual(result["reason"], "INVALIDATED_INFRASTRUCTURE")
        self.assertIn("neither supported nor refuted", result["verdict"])
        self.assertIsNone(self.book.active())
        self.assertEqual(self.book.state["studies"][-1]["status"], "INVALIDATED_INFRASTRUCTURE")

    def test_champion_is_untouched(self):
        self.kill()
        self.assertEqual(self.book.state["champion"], self.baseline)

    def test_evidence_is_preserved_not_relabelled(self):
        before = copy.deepcopy(self.book.state["assignments"])
        self.kill()
        self.assertEqual(self.book.state["assignments"], before)

    def test_reliability_snapshot_and_audit_event_are_recorded(self):
        result = self.kill()
        self.assertIn("completionRate", result["reliabilityAtInvalidation"])
        self.assertEqual(result["note"], self.note())
        event = self.book.state["events"][-1]
        self.assertEqual(event["studyId"], self.study["id"])
        self.assertEqual(event["previousStatus"], "HOLDOUT")
        self.assertEqual(event["champion"], self.baseline)

    def test_bad_reason_or_missing_note_refused(self):
        with self.assertRaises(ValueError):
            self.book.invalidate(self.study["id"], "BECAUSE", self.note())
        with self.assertRaises(ValueError):
            self.book.invalidate(self.study["id"], "INFRASTRUCTURE", "too short")

    def test_unknown_or_already_finished_study_refused(self):
        with self.assertRaises(ValueError):
            self.book.invalidate("study_missing", "INFRASTRUCTURE", self.note())
        self.kill()
        with self.assertRaises(ValueError):
            self.kill()

    def test_identical_candidate_cannot_be_restarted_after_invalidation(self):
        self.kill()
        with self.assertRaises(ValueError):
            self.book.propose(self.proposal, self.learning)
        self.assertIsNone(self.book.active())

    def test_a_different_candidate_may_start_a_clean_study(self):
        self.kill()
        self.now += SLOT
        self.book.start_cycle()
        other = {**self.proposal, "oneChange": "Prefer an entirely different predeclared entry hypothesis."}
        self.book.propose(other, self.learning)
        fresh = self.book.active()
        self.assertIsNotNone(fresh)
        self.assertNotEqual(fresh["id"], self.study["id"])
        # A new phase starts with an empty denominator; the old slots stay with the old study.
        data = self.book.phase_data(fresh, fresh["phases"][-1])
        self.assertEqual(data["scoredAssignments"], 0)


class ReliabilityOutlookTests(unittest.TestCase):
    """A dead denominator must be visible immediately, not at the deadline."""

    def outlook(self, scored, completed, days_left=30):
        now = 1800000000000
        phase = {"start": now - (GATES["maxStageDays"] - days_left) * DAY}
        data = {"scoredAssignments": scored, "completedAssignments": completed}
        return reliability_outlook(phase, data, now)

    def test_clean_run_needs_nothing(self):
        self.assertEqual(self.outlook(100, 100)["perfectSlotsToReachReliability"], 0)

    def test_above_the_gate_needs_no_recovery(self):
        self.assertEqual(self.outlook(100, 99)["perfectSlotsToReachReliability"], 0)

    def test_below_the_gate_each_failure_costs_about_nineteen(self):
        # 94/100 is under the 0.95 gate; 20 flawless slots restore exactly 114/120.
        self.assertEqual(self.outlook(100, 94)["perfectSlotsToReachReliability"], 20)

    def test_contaminated_denominator_consumes_most_of_the_deadline(self):
        # The real case: 291 failed slots against a 0.95 gate with 29 days left.
        out = self.outlook(302, 11, days_left=29)
        self.assertEqual(out["perfectSlotsToReachReliability"], 5518)
        # Arithmetically it still fits, but two thirds of every remaining slot
        # must succeed, which is the number an operator can actually judge.
        self.assertTrue(out["reliabilityReachable"])
        self.assertGreater(out["perfectShareOfRemaining"], 0.6)

    def test_a_denominator_past_saving_is_flagged_unreachable(self):
        out = self.outlook(302, 11, days_left=10)
        self.assertFalse(out["reliabilityReachable"])

    def test_expired_phase_has_no_slots_left(self):
        self.assertEqual(self.outlook(100, 50, days_left=0)["slotsBeforeDeadline"], 0)



class JournalOwnershipTests(unittest.TestCase):
    """A root-run maintenance script must not lock the runner out of its journal."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.book = ExperimentBook(Path(self.tmp.name), "test_policy_hash")
        self.book.save()  # the journal must already exist for ownership to be carried

    def test_same_user_save_does_not_touch_ownership(self):
        with patch("astra_experiments.os.chown") as chown:
            self.book.save()
        chown.assert_not_called()

    def test_foreign_owner_is_restored_after_the_atomic_replace(self):
        original = self.book.path.stat()
        with patch("astra_experiments.os.geteuid", return_value=original.st_uid + 1), \
             patch("astra_experiments.os.chown") as chown, patch("astra_experiments.os.chmod"):
            self.book.save()
        chown.assert_called_once_with(self.book.path, original.st_uid, original.st_gid)


if __name__ == "__main__":
    unittest.main()

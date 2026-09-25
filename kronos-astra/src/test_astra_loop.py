"""Integration tests for the Astra trade-management and Hermes learning loop.

Fixtures and stubs prove mechanism only. Nothing here is exchange evidence, and no
synthetic result ever reaches a deployed journal.
"""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import astra_runner
import astra_decisions as AD
from astra_procedures import ProcedureBook, scope_holds, MIN_SUPPORTING, MIN_CONTRADICTING
from astra_plans import PlanBook


class ActionVocabularyTests(unittest.TestCase):
    """Astra's actions must reach the gateway as the trade Astra actually chose."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.snapshot = {"positions": [], "at": 1, "opportunityId": "opp_1"}
        patcher = patch.multiple(astra_runner, SNAPSHOT=self.snapshot, PROCEDURE_BOOK=None, COACHING=False)
        patcher.start()
        self.addCleanup(patcher.stop)

    def own(self, trade_id="astra-1", symbol="DOGEUSDT", side="LONG"):
        self.snapshot["positions"] = [{"id": trade_id, "symbol": symbol, "side": side, "state": "OPEN"}]

    def test_entries_map_to_open_with_their_own_side(self):
        self.assertEqual(astra_runner.translate({"id": "d1", "action": "ENTER_LONG", "reason": "x"})["side"], "LONG")
        self.assertEqual(astra_runner.translate({"id": "d1", "action": "ENTER_SHORT", "reason": "x"})["side"], "SHORT")
        self.assertEqual(astra_runner.translate({"id": "d1", "action": "ENTER_SHORT", "reason": "x"})["action"], "OPEN")

    def test_action_and_side_cannot_disagree(self):
        with self.assertRaises(ValueError):
            astra_runner.translate({"id": "d1", "action": "ENTER_LONG", "side": "SHORT", "reason": "x"})

    def test_management_actions_reach_the_owned_position(self):
        self.own()
        for action, code in (("TAKE_PROFIT", "TAKE_PROFIT"), ("CUT_LOSS", "CUT_LOSS")):
            request = astra_runner.translate({"id": "d1", "action": action, "positionId": "astra-1", "reason": "x"})
            self.assertEqual((request["action"], request["reasonCode"], request["tradeId"]),
                             ("CLOSE", code, "astra-1"))

    def test_hold_is_a_recorded_management_decision(self):
        self.own()
        request = astra_runner.translate({"id": "d1", "action": "HOLD", "positionId": "astra-1", "reason": "x"})
        self.assertEqual((request["action"], request["reasonCode"]), ("WAIT", "MANAGING_POSITION"))

    def test_management_requires_a_genuinely_owned_position(self):
        self.own()
        with self.assertRaises(ValueError):
            astra_runner.translate({"id": "d1", "action": "HOLD", "positionId": "not-mine", "reason": "x"})
        with self.assertRaises(ValueError):
            astra_runner.translate({"id": "d1", "action": "HOLD", "reason": "x"})

    def test_an_owned_position_cannot_be_left_implicit(self):
        self.own()
        for action in ("NO_TRADE", "ENTER_LONG"):
            with self.assertRaises(ValueError) as caught:
                astra_runner.translate({"id": "d1", "action": action, "reason": "x"})
            self.assertIn("astra-1", str(caught.exception))

    def test_a_review_cycle_may_record_no_trade_while_holding_a_position(self):
        self.own()
        with self.assertRaises(ValueError):
            astra_runner.translate({"id": "d1", "action": "NO_TRADE", "reason": "x"})
        with patch.object(astra_runner, "COACHING", True):
            request = astra_runner.translate({"id": "d1", "action": "NO_TRADE", "reason": "x"})
        self.assertEqual(request["action"], "WAIT")

    def test_a_review_cycle_still_cannot_manage_a_position_it_does_not_own(self):
        self.own()
        with patch.object(astra_runner, "COACHING", True):
            with self.assertRaises(ValueError):
                astra_runner.translate({"id": "d1", "action": "HOLD", "positionId": "not-mine", "reason": "x"})

    def test_reduce_is_refused_not_silently_turned_into_a_full_exit(self):
        self.own()
        with self.assertRaises(ValueError) as caught:
            astra_runner.translate({"id": "d1", "action": "REDUCE", "positionId": "astra-1", "reason": "x"})
        self.assertIn("not wired", str(caught.exception))

    def test_model_only_fields_never_reach_the_gateway(self):
        request = astra_runner.translate({"id": "d1", "action": "NO_TRADE", "reason": "x",
                                          "appliedLessonIds": ["l1"], "rejectedLessonIds": [],
                                          "notApplicableLessonIds": ["l2"],
                                          "lessonRationale": "y", "invalidation": "z", "nextReview": "w"})
        for field in astra_runner.MODEL_ONLY:
            self.assertNotIn(field, request)


class ExecutionDiagnosticTests(unittest.TestCase):
    def test_market_drift_and_execution_gap_are_separated(self):
        d = AD.execution_diagnostics("LONG", 0.6493, 0.658, 0.6595)
        self.assertAlmostEqual(d["adverseDisplacementBps"], 157.1, places=0)
        self.assertAlmostEqual(d["planToDecisionBps"], 134.0, places=0)
        self.assertAlmostEqual(d["decisionToFillBps"], 22.8, places=0)

    def test_short_direction_is_inverted(self):
        self.assertGreater(AD.displacement_bps("SHORT", 9.9, 10.0), 0)
        self.assertLess(AD.displacement_bps("LONG", 9.9, 10.0), 0)

    def test_a_missing_fill_yields_no_diagnostic_rather_than_a_planned_price(self):
        self.assertIsNone(AD.execution_diagnostics("LONG", 10, 10.01, None)["adverseDisplacementBps"])
        self.assertIsNone(AD.execution_diagnostics("LONG", 10, 10.01, 0)["adverseDisplacementBps"])


class StatusTests(unittest.TestCase):
    def test_provider_and_policy_failures_are_not_trading_outcomes(self):
        self.assertEqual(AD.classify("ENTER_LONG", {"status": "SETUP_NOT_READY"}), "REJECTED_BY_POLICY")
        self.assertEqual(AD.classify("ENTER_LONG", {"decision_error": "x"}), "REJECTED_BY_POLICY")
        self.assertEqual(AD.classify("REDUCE", {}), "ACTION_UNAVAILABLE")

    def test_an_uncertain_order_is_reconciled_not_booked_as_a_no_fill(self):
        self.assertEqual(AD.classify("ENTER_LONG", {"status": "REJECTED_OR_UNRESOLVED"}), "UNRESOLVED_RECONCILE")
        self.assertEqual(AD.classify("ENTER_LONG", {"state": "ENTRY_PENDING"}), "UNRESOLVED_RECONCILE")
        self.assertEqual(AD.classify("ENTER_LONG", {"state": "NO_FILL"}), "NO_FILL_CONFIRMED")

    def test_a_successful_trade_carrying_a_null_error_is_not_a_rejection(self):
        # The gateway returns the trade object, which always has an error field.
        opened = {"state": "OPEN", "qty": 5, "entryQty": 5, "error": None}
        self.assertEqual(AD.classify("ENTER_LONG", opened), "OPEN")
        self.assertEqual(AD.classify("ENTER_LONG", dict(opened, error="rejected by venue")), "REJECTED_BY_POLICY")

    def test_fills_and_management_are_distinguished(self):
        self.assertEqual(AD.classify("ENTER_LONG", {"state": "OPEN", "qty": 5, "entryQty": 5}), "OPEN")
        self.assertEqual(AD.classify("ENTER_LONG", {"state": "OPEN", "qty": 2, "entryQty": 5}), "PARTIALLY_FILLED")
        self.assertEqual(AD.classify("HOLD", {"state": "OPEN", "qty": 5, "entryQty": 5}), "EXECUTED_MANAGEMENT")
        self.assertEqual(AD.classify("NO_TRADE", {"status": "WAIT_RECORDED"}), "VALID_NO_TRADE")

    def test_unchanged_state_produces_the_same_version(self):
        status = {"active": [{"id": "a", "symbol": "S", "state": "OPEN", "qty": 1}], "closed": []}
        plans = [{"plan": {"id": "p"}, "assessment": {"ready": False, "failed": ["trigger"]}}]
        self.assertEqual(AD.state_version(status, plans), AD.state_version(copy.deepcopy(status), copy.deepcopy(plans)))
        moved = copy.deepcopy(plans)
        moved[0]["assessment"]["ready"] = True
        self.assertNotEqual(AD.state_version(status, plans), AD.state_version(status, moved))


class ProcedureLoopTests(unittest.TestCase):
    """Delivered, applied and verified are three different things."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "hermes-home").mkdir()
        self.clock = 1788900000000
        self.book = ProcedureBook(self.root, now=lambda: self.clock)
        self.body = {"applicability": "Breakout continuation setups on any USDT perpetual contract.",
                     "mechanism": "Deciding on a plan frozen before a large move takes a different trade.",
                     "recommendedCheck": "Recheck the executable quote against the frozen trigger before entry.",
                     "exceptions": "Not applicable when the quote is still at or below the original trigger."}

    def publish(self, lesson="lesson_aero", scope=None):
        return self.book.publish(lesson, self.body, ["astra-aero"], scope)

    def test_a_new_procedure_is_provisional_however_convincing(self):
        self.assertEqual(self.publish()["status"], "PROVISIONAL")

    def test_republishing_supersedes_with_a_new_version(self):
        self.publish()
        self.assertEqual(self.publish()["version"], 2)

    def test_delivery_is_bounded_and_ranked_not_the_whole_journal(self):
        for i in range(6):
            self.book.publish("lesson_%02d" % i, self.body, ["e%d" % i], {"symbol": "AAAUSDT"})
        delivery = self.book.deliver({"symbol": "AAAUSDT"}, limit=3)
        self.assertEqual(len(delivery["procedures"]), 3)
        self.assertEqual(delivery["totalN"], 6)

    def test_scope_ranks_relevance(self):
        self.book.publish("general_rule", self.body, ["e1"])
        self.book.publish("specific_rule", self.body, ["e2"], {"symbol": "AAAUSDT", "side": "LONG"})
        first = self.book.deliver({"symbol": "AAAUSDT", "side": "LONG"}, limit=1)["procedures"][0]
        self.assertEqual(first["lessonId"], "specific_rule")

    def test_publication_backlog_is_surfaced_like_the_review_backlog(self):
        self.publish("lesson_done")
        delivery = self.book.deliver({}, lesson_ids=["lesson_done", "lesson_todo_a", "lesson_todo_b"])
        self.assertEqual(delivery["backlog"]["lessonsWithoutProcedure"], 2)
        self.assertIn("lesson_todo_a", delivery["backlog"]["examples"])

    def test_publishing_is_offered_not_demanded(self):
        instruction = self.book.deliver({}, lesson_ids=["l1"])["backlog"]["instruction"]
        self.assertIn("DECLINE", instruction)
        self.assertIn("valid outcome", instruction)

    def test_retired_and_rejected_procedures_are_not_delivered(self):
        self.publish()
        self.book.retire("lesson_aero", "Contradicted by later evidence; the mechanism did not reproduce.")
        self.assertEqual(self.book.deliver({})["procedures"], [])

    def test_a_claim_about_an_undelivered_procedure_is_unverifiable(self):
        self.publish()
        result = self.book.verify("d1", ["lesson_aero"], [], {"lesson_aero": True})
        self.assertEqual(result["results"]["lesson_aero"]["application"], "UNVERIFIABLE")

    def test_the_full_chain_is_verified_only_when_it_actually_happened(self):
        self.publish(scope={"symbol": "AAAUSDT"})
        delivery = self.book.deliver({"symbol": "AAAUSDT"})
        self.book.record_delivery("d1", delivery)
        applied = self.book.verify("d1", ["lesson_aero"], [], {"lesson_aero": True})
        self.assertEqual(applied["results"]["lesson_aero"]["application"], "COMPLIANT")

    def test_departing_from_an_applicable_procedure_is_recorded_not_blocked(self):
        self.publish()
        self.book.record_delivery("d2", self.book.deliver({}))
        result = self.book.verify("d2", [], ["lesson_aero"], {"lesson_aero": True})
        self.assertEqual(result["results"]["lesson_aero"]["application"], "DEPARTED")

    def test_a_procedure_whose_condition_did_not_hold_is_not_applicable(self):
        self.publish()
        self.book.record_delivery("d3", self.book.deliver({}))
        result = self.book.verify("d3", ["lesson_aero"], [], {"lesson_aero": False})
        self.assertEqual(result["results"]["lesson_aero"]["application"], "NOT_APPLICABLE")

    def test_ignoring_an_out_of_scope_procedure_is_recorded_as_correct(self):
        self.publish(scope={"symbol": "AAAUSDT"})
        self.book.record_delivery("d9", self.book.deliver({}))
        result = self.book.verify("d9", [], [], {"lesson_aero": False})
        self.assertEqual(result["results"]["lesson_aero"]["application"], "CORRECTLY_IGNORED")

    def test_silently_skipping_an_applicable_procedure_is_visible(self):
        self.publish()
        self.book.record_delivery("d10", self.book.deliver({}))
        result = self.book.verify("d10", [], [], {"lesson_aero": True})
        self.assertEqual(result["results"]["lesson_aero"]["application"], "SILENT_OMISSION")

    def test_every_delivered_procedure_is_accounted_for(self):
        self.publish("lesson_one", scope={"symbol": "AAAUSDT"})
        self.publish("lesson_two")
        self.book.record_delivery("d11", self.book.deliver({"symbol": "AAAUSDT"}))
        result = self.book.verify("d11", ["lesson_one"], [], {"lesson_one": True, "lesson_two": False})
        self.assertEqual(set(result["results"]), {"lesson_one", "lesson_two"})
        self.assertEqual(result["results"]["lesson_one"]["application"], "COMPLIANT")
        self.assertEqual(result["results"]["lesson_two"]["application"], "CORRECTLY_IGNORED")

    def test_out_of_scope_is_a_third_answer_not_a_refusal(self):
        self.publish()
        self.book.record_delivery("d12", self.book.deliver({}))
        agreed = self.book.verify("d12", [], [], {"lesson_aero": False}, ["lesson_aero"])
        self.assertEqual(agreed["results"]["lesson_aero"]["application"], "NOT_APPLICABLE")

    def test_a_scope_disagreement_is_recorded_as_such(self):
        # Astra read KAS v1's scope literally (action == ENTER_LONG) while the host
        # matched it to a long candidate that was declined. That is a disagreement
        # about meaning, not a skipped procedure.
        self.publish()
        self.book.record_delivery("d13", self.book.deliver({}))
        disputed = self.book.verify("d13", [], [], {"lesson_aero": True}, ["lesson_aero"])
        self.assertEqual(disputed["results"]["lesson_aero"]["application"], "DISPUTED_SCOPE")

    def test_silent_omission_now_means_never_mentioned_at_all(self):
        self.publish()
        self.book.record_delivery("d14", self.book.deliver({}))
        self.assertEqual(self.book.verify("d14", [], [], {"lesson_aero": True})["results"]
                         ["lesson_aero"]["application"], "SILENT_OMISSION")

    def test_one_winner_does_not_promote_a_procedure(self):
        self.publish()
        self.book.record_outcome("lesson_aero", "trade_1", True)
        self.assertEqual(self.book.state["procedures"]["lesson_aero"]["status"], "PROVISIONAL")

    def test_an_outcome_cannot_be_counted_both_ways(self):
        self.publish()
        self.book.record_outcome("lesson_aero", "trade_1", True)
        with self.assertRaises(ValueError):
            self.book.record_outcome("lesson_aero", "trade_1", False)

    def test_a_loss_does_not_blacklist_anything_by_itself(self):
        self.publish(scope={"symbol": "AAAUSDT"})
        self.book.record_outcome("lesson_aero", "losing_trade", False)
        procedure = self.book.state["procedures"]["lesson_aero"]
        self.assertEqual(procedure["status"], "PROVISIONAL")
        self.assertEqual(len(self.book.deliver({"symbol": "AAAUSDT"})["procedures"]), 1)

    def test_procedures_never_outrank_safety_or_policy(self):
        self.publish()
        self.assertEqual(self.book.deliver({})["priority"][:2], ("HARD_SAFETY", "ACTIVE_POLICY"))

    def test_journal_survives_restart(self):
        self.publish()
        self.assertIn("lesson_aero", ProcedureBook(self.root, now=lambda: self.clock).state["procedures"])


class SnapshotTests(unittest.TestCase):
    def test_snapshot_records_what_was_knowable_before_the_action(self):
        status = {"active": [{"id": "a", "symbol": "S", "side": "LONG", "state": "OPEN", "qty": 1}],
                  "closed": [], "wallet": {"fresh": True, "snapshot": {"availableBalance": 100}},
                  "entryBlock": None, "lastError": None}
        plans = [{"plan": {"id": "p", "symbol": "S", "side": "LONG", "triggerPrice": 1, "stopPrice": .9,
                           "targetPrice": 1.2, "expiresAt": 9}, "assessment": {"ready": True, "failed": []}}]
        snap = AD.snapshot("opp_1", status, plans, ["l1@v1"], "policy_v7", market_at=5, now=1005)
        self.assertEqual(snap["marketDataAgeMs"], 1000)
        self.assertEqual(snap["procedureVersions"], ["l1@v1"])
        self.assertEqual(snap["positions"][0]["id"], "a")
        self.assertTrue(snap["setups"][0]["ready"])
        self.assertIn("stateVersion", snap)



class RunnerChainTests(unittest.TestCase):
    """The whole point: a lesson reaches the decision context, the decision names it,
    and the host verifies the chain instead of trusting the claim."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "hermes-home").mkdir()
        self.procedures = ProcedureBook(self.root)
        self.procedures.publish("lesson_aero", {
            "applicability": "Breakout continuation setups where the plan was frozen earlier.",
            "mechanism": "A quote far past the frozen trigger is a different trade than the one reviewed.",
            "recommendedCheck": "Recheck the executable quote against the frozen trigger before entering.",
            "exceptions": "Not applicable when the quote is still at or below the original trigger."},
            ["astra-aero"], {"symbol": "DOGEUSDT"})
        self.plans = SimpleNamespace(save=lambda: None, veto=lambda *a: None,
            evaluate=lambda p: p["assessment"], now=lambda: 1788900000000,
            get=lambda pid: next(x for x in self.plans.state["plans"] if x["plan"]["id"] == pid),
            state={"submissions": {}, "plans": [{"plan": {
            "id": "setup_1", "symbol": "DOGEUSDT", "side": "LONG", "triggerKind": "CLOSE_ABOVE",
            "triggerPrice": 10.0, "stopPrice": 9.8, "targetPrice": 10.5, "notionalUsd": 6,
            "maxHoldMs": 600000, "expiresAt": 1788999999999},
            "assessment": {"ready": False, "failed": ["trigger"], "executableReference": 10.01,
            "quoteEconomics": {"riskInflation": 1.05}}}]})
        self.sent = []
        patcher = patch.multiple(astra_runner,
            PLAN_BOOK=self.plans, PROCEDURE_BOOK=self.procedures, EXPERIMENT_BOOK=None,
            LEARNING_BOOK=None, EXPERIMENT_REQUIRED=False,
            SNAPSHOT={"at": 1, "opportunityId": "opp_1", "positions": []},
            DELIVERED=self.procedures.deliver({"symbol": "DOGEUSDT"}))
        patcher.start()
        self.addCleanup(patcher.stop)
        astra_runner.DECISION_RECEIPTS.clear()

    def decide(self, **overrides):
        request = {"id": "decision_0001", "action": "NO_TRADE", "reason": "considered pass",
                   "reasonCode": "NO_SETUP", "setupId": "setup_1"}
        request.update(overrides)
        with patch.object(astra_runner, "gateway", lambda path, payload=None: self.sent.append(payload) or {"status": "WAIT_RECORDED"}):
            return json.loads(astra_runner.decision_result(request))

    def receipt(self):
        return astra_runner.DECISION_RECEIPTS[-1]

    def test_lesson_reaches_the_decision_and_compliance_is_verified(self):
        self.decide(appliedLessonIds=["lesson_aero"], lessonRationale="Rechecked the live quote first.")
        verification = self.receipt()["procedureVerification"]["results"]["lesson_aero"]
        self.assertEqual(verification["application"], "COMPLIANT")
        self.assertEqual(verification["version"], 1)

    def test_a_named_but_undelivered_procedure_is_not_accepted_as_evidence(self):
        with patch.object(astra_runner, "DELIVERED", {"procedures": [], "context": {}}):
            self.decide(appliedLessonIds=["lesson_invented"])
        self.assertEqual(self.receipt()["procedureVerification"]["results"]["lesson_invented"]["application"],
                         "UNVERIFIABLE")

    def test_departure_is_recorded_with_the_decision_still_going_through(self):
        result = self.decide(rejectedLessonIds=["lesson_aero"], lessonRationale="Quote is still below the trigger.")
        self.assertEqual(result["status"], "WAIT_RECORDED")
        self.assertEqual(self.receipt()["procedureVerification"]["results"]["lesson_aero"]["application"], "DEPARTED")

    def test_a_provisional_procedure_is_not_a_hard_veto(self):
        # Nothing about the procedure blocks the decision; only the host's gates can.
        self.assertEqual(self.decide()["status"], "WAIT_RECORDED")
        self.assertEqual(self.receipt()["status"], "VALID_NO_TRADE")

    def test_receipt_carries_the_decision_as_taken(self):
        self.decide(invalidation="Close back below 10.0", nextReview="Next closed 5m bar")
        receipt = self.receipt()
        self.assertEqual(receipt["triggerBenchmark"], 10.0)
        self.assertEqual(receipt["entryReference"], 10.01)
        self.assertEqual(receipt["stopPrice"], 9.8)
        self.assertEqual(receipt["invalidation"], "Close back below 10.0")
        self.assertEqual(receipt["nextReview"], "Next closed 5m bar")
        self.assertEqual(receipt["opportunityId"], "opp_1")

    def test_refused_action_is_recorded_as_unavailable_not_as_a_trade(self):
        with patch.object(astra_runner, "SNAPSHOT",
                          {"at": 1, "opportunityId": "opp_1",
                           "positions": [{"id": "astra-1", "symbol": "DOGEUSDT", "side": "LONG", "state": "OPEN"}]}):
            result = self.decide(action="REDUCE", positionId="astra-1")
        self.assertIn("decision_error", result)
        self.assertEqual(self.sent, [])   # nothing reached the gateway
        self.assertEqual(self.receipt()["status"], "ACTION_UNAVAILABLE")

    def test_model_only_fields_are_stripped_before_the_gateway(self):
        self.decide(appliedLessonIds=["lesson_aero"], invalidation="x", nextReview="y")
        self.assertTrue(self.sent)
        for field in astra_runner.MODEL_ONLY:
            self.assertNotIn(field, self.sent[-1])



class ReviewQuadrantTests(unittest.TestCase):
    """A loss is not automatically a mistake; a win is not automatically a method."""

    def setUp(self):
        from astra_learning import LearningBook, QUADRANTS
        self.QUADRANTS = QUADRANTS
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        (root / "hermes-home").mkdir()
        self.now = 1788900000000
        self.book = LearningBook(root, now=lambda: self.now)
        self.book.state["report"] = {"at": self.now, "closed": [
            {"id": "trade_win", "net": 1.0}, {"id": "trade_loss", "net": -1.0}], "excludedClosedN": 0}

    def review(self, trade_id, assessment=None, lesson="lesson_x1"):
        body = {"id": lesson, "tradeId": trade_id,
                "observation": "Settled outcome recorded with actual fills and fees attached.",
                "hypothesis": "The mechanism behind this outcome is not yet established by one trade.",
                "nextTest": "Compare the next independently frozen setup of the same shape.",
                "disconfirmingEvidence": "A repeat with the opposite result contradicts this reading."}
        if assessment:
            body["assessment"] = assessment
        return self.book.review(body)

    def test_a_losing_trade_can_be_recorded_as_good_process(self):
        lesson = self.review("trade_loss", "GOOD_PROCESS_BAD_OUTCOME")
        self.assertEqual(lesson["review"]["assessment"], "GOOD_PROCESS_BAD_OUTCOME")
        self.assertEqual(lesson["status"], "UNPROVEN_HYPOTHESIS")

    def test_a_winning_trade_can_be_recorded_as_bad_process(self):
        lesson = self.review("trade_win", "BAD_PROCESS_GOOD_OUTCOME", lesson="lesson_x2")
        self.assertEqual(lesson["review"]["assessment"], "BAD_PROCESS_GOOD_OUTCOME")

    def test_unknown_is_allowed_rather_than_forcing_a_causal_story(self):
        self.assertIn("INSUFFICIENT_EVIDENCE", self.QUADRANTS)
        self.review("trade_loss", "INSUFFICIENT_EVIDENCE", lesson="lesson_x3")

    def test_an_invented_quadrant_is_refused(self):
        with self.assertRaises(ValueError):
            self.review("trade_loss", "TOTALLY_FINE", lesson="lesson_x4")

    def test_the_field_stays_optional_for_older_reviews(self):
        self.assertEqual(self.review("trade_win", lesson="lesson_x5")["review"].get("assessment"), None)



class UnfilledReviewTests(unittest.TestCase):
    """A decision that never became a trade is still reviewable experience."""

    def setUp(self):
        from astra_learning import LearningBook
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        (root / "hermes-home").mkdir()
        self.now = 1788900000000
        self.book = LearningBook(root, now=lambda: self.now)
        self.report = {"environment": "testnet", "laneId": "ASTRA_HERMES_TESTNET",
            "source": "OWNED_ASTRA_LEDGER", "generatedAt": self.now, "lastError": None,
            "fundingThrough": self.now, "closed": [],
            "noFill": [{"id": "astra-nofill-1", "state": "NO_FILL", "symbol": "AAAUSDT",
                        "side": "LONG", "createdAt": self.now - 1000, "reason": "IOC did not fill"}],
            "decisions": [
                # The durable ledger writes an object; the report writes a bare string.
                {"id": "dec_refused", "at": self.now - 2000, "symbol": "BBBUSDT",
                 "reason": "entry refused", "result": {"status": "REJECTED_OR_UNRESOLVED"}},
                {"id": "dec_refused_str", "at": self.now - 2500, "symbol": "CCCUSDT",
                 "reason": "setup not ready", "result": "SETUP_NOT_READY"},
                {"id": "dec_plain_wait", "at": self.now - 3000, "reason": "no setup",
                 "result": "WAIT_RECORDED"},
                {"id": "dec_became_a_trade", "at": self.now - 3500, "reason": "opened",
                 "result": "OPEN"}]}
        self.book.observe_report(self.report)

    def body(self, evidence_id, lesson="lesson_nf1"):
        return {"id": lesson, "tradeId": evidence_id,
                "observation": "The opportunity never became a position and realised nothing at all.",
                "hypothesis": "The entry band may sit where the executable quote rarely reaches it.",
                "nextTest": "Compare the next independently frozen setup of the same shape.",
                "disconfirmingEvidence": "A later fill on the same shape contradicts this reading."}

    def test_no_fill_is_reviewable_evidence(self):
        lesson = self.book.review(self.body("astra-nofill-1"))
        self.assertEqual(lesson["evidenceKind"], "NO_FILL")
        self.assertEqual(lesson["evidenceAtReview"]["realisedNet"], 0)
        self.assertIn("counterfactual proxy", lesson["caveat"])

    def test_a_refused_decision_is_reviewable(self):
        lesson = self.book.review(self.body("dec_refused", lesson="lesson_nf2"))
        self.assertEqual(lesson["evidenceKind"], "REJECTED_OR_UNRESOLVED")

    def test_a_bare_status_string_is_read_like_an_object(self):
        ids = {t["id"] for t in self.book.state["report"]["unfilled"]}
        self.assertIn("dec_refused_str", ids)

    def test_a_plain_wait_or_a_real_trade_is_not_dredged_into_the_backlog(self):
        ids = {t["id"] for t in self.book.state["report"]["unfilled"]}
        self.assertNotIn("dec_plain_wait", ids)
        self.assertNotIn("dec_became_a_trade", ids)
        with self.assertRaises(ValueError):
            self.book.review(self.body("dec_plain_wait", lesson="lesson_nf3"))

    def test_unknown_evidence_is_still_refused(self):
        with self.assertRaises(ValueError):
            self.book.review(self.body("nothing_at_all", lesson="lesson_nf4"))

    def test_backlog_reports_both_pools_separately(self):
        summary = self.book.summary()
        self.assertEqual(summary["unreviewedN"], 0)
        self.assertEqual(summary["unreviewedUnfilledN"], 3)
        self.book.review(self.body("astra-nofill-1"))
        self.assertEqual(self.book.summary()["unreviewedUnfilledN"], 2)

    def test_settled_trades_keep_their_original_shape(self):
        self.report["closed"] = [{"id": "astra-settled-1", "settled": True, "accountingComplete": True,
            "error": None, "closedAt": self.now - 500, "net": -0.1, "fees": 0.01, "gross": -0.09,
            "funding": 0.0, "entryNotional": 6.0}]
        self.book.observe_report(self.report)
        lesson = self.book.review(self.body("astra-settled-1", lesson="lesson_nf5"))
        self.assertEqual(lesson["evidenceKind"], "SETTLED_TRADE")
        self.assertIsNone(lesson["caveat"])



class ScopeMatchTests(unittest.TestCase):
    """Deciding not to trade is still an occasion where an entry procedure applied."""

    ENTRY_SCOPE = {"side": "LONG", "action": "ENTER_LONG"}

    def context(self, final, evaluating="ENTER_LONG", side="LONG"):
        return {"action": final, "evaluatingAction": evaluating, "side": side,
                "symbol": "KASUSDT", "triggerKind": "CLOSE_ABOVE"}

    def test_an_entry_procedure_covers_a_candidate_that_was_declined(self):
        # The whole point: running the check and concluding "do not enter" is
        # correct use, and must not be scored as if the procedure did not apply.
        self.assertTrue(scope_holds(self.ENTRY_SCOPE, self.context("NO_TRADE")))
        self.assertTrue(scope_holds(self.ENTRY_SCOPE, self.context("ENTER_LONG")))

    def test_it_does_not_cover_a_decision_with_no_long_candidate_on_the_table(self):
        self.assertFalse(scope_holds(self.ENTRY_SCOPE, self.context("NO_TRADE", evaluating=None, side=None)))

    def test_it_does_not_cover_the_other_side(self):
        self.assertFalse(scope_holds(self.ENTRY_SCOPE, self.context("NO_TRADE", "ENTER_SHORT", "SHORT")))

    def test_it_does_not_cover_managing_an_existing_position(self):
        self.assertFalse(scope_holds(self.ENTRY_SCOPE, self.context("HOLD", evaluating=None)))

    def test_non_action_keys_still_match_exactly(self):
        self.assertFalse(scope_holds({"symbol": "AAAUSDT"}, self.context("ENTER_LONG")))
        self.assertTrue(scope_holds({"symbol": "KASUSDT"}, self.context("ENTER_LONG")))

    def test_an_empty_scope_still_covers_everything(self):
        self.assertTrue(scope_holds({}, self.context("NO_TRADE", evaluating=None, side=None)))

    def test_the_decision_context_reports_what_was_evaluated(self):
        plans = SimpleNamespace(state={"plans": [{"plan": {
            "id": "s1", "symbol": "KASUSDT", "side": "LONG", "triggerKind": "CLOSE_ABOVE"}}]})
        with patch.object(astra_runner, "PLAN_BOOK", plans):
            ctx = astra_runner.decision_context({"action": "NO_TRADE", "setupId": "s1"})
        self.assertEqual(ctx["action"], "NO_TRADE")
        self.assertEqual(ctx["evaluatingAction"], "ENTER_LONG")



class ProcedureLifecycleTests(unittest.TestCase):
    """A procedure that can never leave PROVISIONAL is unfinished work, not caution."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "hermes-home").mkdir()
        self.clock = 1788900000000
        self.book = ProcedureBook(self.root, now=lambda: self.clock)
        self.body = {"applicability": "Breakout continuation setups on any USDT perpetual contract.",
                     "mechanism": "Stop fills can land adversely against their own trigger price.",
                     "recommendedCheck": "State the stop scenario including both legs before entering.",
                     "exceptions": "Not applicable when no native stop is installed on the position."}
        self.book.publish("lesson_stop", self.body, ["astra-kas"])

    def why(self):
        return "The settled fills matched the mechanism this procedure describes."

    def test_cases_accumulate_and_the_host_alone_promotes(self):
        for i in range(MIN_SUPPORTING - 1):
            p = self.book.record_outcome("lesson_stop", "case_%d" % i, True, self.why())
            self.assertEqual(p["status"], "PROVISIONAL")
        p = self.book.record_outcome("lesson_stop", "case_last", True, self.why())
        self.assertEqual(p["status"], "SUPPORTED")
        self.assertIn("not proven", p["statusMeaning"].lower())

    def test_contradiction_outranks_further_support(self):
        for i in range(MIN_CONTRADICTING):
            self.book.record_outcome("lesson_stop", "against_%d" % i, False, self.why())
        self.assertEqual(self.book.state["procedures"]["lesson_stop"]["status"], "REJECTED")

    def test_a_rejected_procedure_stops_being_delivered(self):
        for i in range(MIN_CONTRADICTING):
            self.book.record_outcome("lesson_stop", "against_%d" % i, False, self.why())
        self.assertEqual(self.book.deliver({})["procedures"], [])
        with self.assertRaises(ValueError):
            self.book.record_outcome("lesson_stop", "later", True, self.why())

    def test_one_case_never_promotes_and_a_single_loss_never_rejects(self):
        self.book.record_outcome("lesson_stop", "one", True, self.why())
        self.assertEqual(self.book.state["procedures"]["lesson_stop"]["status"], "PROVISIONAL")
        self.book.record_outcome("lesson_stop", "two", False, self.why())
        self.assertEqual(self.book.state["procedures"]["lesson_stop"]["status"], "PROVISIONAL")

    def test_the_same_case_cannot_be_counted_twice_or_both_ways(self):
        self.book.record_outcome("lesson_stop", "one", True, self.why())
        self.book.record_outcome("lesson_stop", "one", True, self.why())
        self.assertEqual(len(self.book.state["procedures"]["lesson_stop"]["supporting"]), 1)
        with self.assertRaises(ValueError):
            self.book.record_outcome("lesson_stop", "one", False, self.why())

    def test_evidence_notes_keep_the_reason_with_the_count(self):
        self.book.record_outcome("lesson_stop", "one", True, self.why())
        note = self.book.state["procedures"]["lesson_stop"]["evidenceNotes"][-1]
        self.assertEqual((note["evidenceId"], note["supports"]), ("one", True))
        self.assertEqual(note["rationale"], self.why())

    def test_declining_clears_the_backlog_instead_of_offering_forever(self):
        backlog = self.book.deliver({}, lesson_ids=["lesson_weak"])["backlog"]
        self.assertEqual(backlog["lessonsWithoutProcedure"], 1)
        self.book.decline("lesson_weak", "Too specific to one symbol to guide any future decision.")
        cleared = self.book.deliver({}, lesson_ids=["lesson_weak"])["backlog"]
        self.assertEqual(cleared["lessonsWithoutProcedure"], 0)
        self.assertEqual(cleared["declinedN"], 1)

    def test_a_published_lesson_cannot_be_declined(self):
        with self.assertRaises(ValueError):
            self.book.decline("lesson_stop", "Changed my mind about publishing this one entirely.")

    def test_status_counts_are_reported(self):
        for i in range(MIN_SUPPORTING):
            self.book.record_outcome("lesson_stop", "case_%d" % i, True, self.why())
        summary = self.book.summary()
        self.assertEqual(summary["byStatus"]["SUPPORTED"], 1)
        self.assertEqual(summary["promotionGate"]["minSupporting"], MIN_SUPPORTING)


if __name__ == "__main__":
    unittest.main()

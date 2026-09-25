import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import astra_runner
from astra_learning import LearningBook
from hermes_dashboard import learning_snapshot


class LearningTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.now = 1800000000000
        self.book = LearningBook(self.root, now=lambda: self.now)
        self.trade = {"id": "trade1", "symbol": "DOODUSDT", "side": "LONG", "settled": True,
            "accountingComplete": True, "closedAt": self.now-1000, "openedAt": self.now-100000,
            "net": -.11, "gross": -.1, "fees": .01, "funding": 0, "entryNotional": 6,
            "reason": "Original prospective experiment; no inferred guarantee", "exitReason": "MAX_HOLD"}
        self.report = {"environment": "testnet", "laneId": "ASTRA_HERMES_TESTNET", "source": "OWNED_ASTRA_LEDGER",
            "generatedAt": self.now, "fundingThrough": self.now, "closed": [self.trade]}
        self.review = {"id": "lesson_dood_001", "tradeId": "trade1",
            "observation": "One observed continuation trade lost after costs.",
            "hypothesis": "Continuation may fail even with positive historical momentum.",
            "nextTest": "Record original trigger and horizon on the next independent eligible setup.",
            "disconfirmingEvidence": "Independent future net profitable trades contradict a general loss claim."}
        self.book.observe_report(self.report)
        self.plans = SimpleNamespace(state={"plans": [{"plan": {"id": "setup_001", "expiresAt": self.now+600000}}]})
        self.application = {"lessonId": self.review["id"], "setupId": "setup_001",
                            "rationale": "Evaluate the same documented question in a future independent trade."}

    def test_numeric_evidence_is_host_copied_and_review_immutable(self):
        lesson = self.book.review(self.review)
        self.assertEqual(lesson["evidenceAtReview"]["net"], -.11)
        self.assertEqual(lesson["status"], "UNPROVEN_HYPOTHESIS")
        self.book.review(copy.deepcopy(self.review))
        self.assertEqual(len(self.book.state["lessons"]), 1)
        for changes in ({"net": 100}, {"hypothesis": "Changed story to match future winners."}):
            with self.assertRaises(ValueError):
                self.book.review({**self.review, **changes})

    def test_wrong_environment_stale_or_failed_accounting_report_rejected(self):
        for change in ({"environment": "live"}, {"source": "OTHER"}, {"generatedAt": self.now-120001}, {"lastError": "gap"}):
            with self.assertRaises(ValueError):
                self.book.observe_report({**self.report, **change})

    def test_incomplete_or_unreconciled_trades_not_learning_evidence(self):
        for change in ({"settled": False}, {"accountingComplete": False}, {"net": 5},
                       {"net": float("nan")}, {"fees": -1}, {"error": "missing fills"}):
            self.book.observe_report({**self.report, "closed": [{**self.trade, **change}]})
            self.assertEqual(self.book.summary()["verifiedClosedN"], 0)
            with self.assertRaises(ValueError):
                self.book.review(self.review)
        self.book.observe_report({**self.report, "fundingThrough": self.now-2000})
        self.assertEqual(self.book.summary()["verifiedClosedN"], 0)

    def test_missing_source_or_stale_cache_cannot_generate_lesson(self):
        with self.assertRaises(ValueError):
            self.book.review({**self.review, "tradeId": "invented_winner"})
        self.now += 120001
        with self.assertRaises(ValueError):
            self.book.review(self.review)
        self.assertFalse(self.book.summary()["fresh"])

    def test_restart_preserves_lesson_and_receipt_tracks_delivery_not_improvement(self):
        self.book.review(self.review)
        restored = LearningBook(self.root, now=lambda: self.now)
        self.assertEqual(restored.summary(deliver=True)["lessonN"], 1)
        self.assertEqual(restored.delivered, {self.review["id"]})
        self.assertEqual(restored.summary()["lessons"][0]["prospectiveClosedN"], 0)

    def test_cannot_apply_after_entry_or_expiry_or_rewrite_binding(self):
        self.book.review(self.review)
        self.plans.state["plans"][0]["submissionId"] = "old_entry"
        with self.assertRaises(ValueError):
            self.book.apply(self.application, self.plans)
        del self.plans.state["plans"][0]["submissionId"]
        self.book.apply(self.application, self.plans)
        self.book.apply(self.application, self.plans)
        with self.assertRaises(ValueError):
            self.book.apply({**self.application, "rationale": "A different interpretation after seeing a known outcome."}, self.plans)

    def test_forward_outcomes_use_ex_ante_binding_not_old_trade_or_shadow(self):
        self.book.review(self.review)
        self.book.apply(self.application, self.plans)
        self.plans.state["plans"][0]["submissionId"] = "future_decision"
        self.now += 100000
        future = {**self.trade, "id": "future_trade", "openedAt": self.now-50000, "closedAt": self.now-1,
                  "gross": .2, "net": .19}
        self.book.observe_context({"source": "BINANCE_USDM_TESTNET", "status": {"environment": "testnet",
            "closed": [{"id": "future_trade", "decision": {"id": "future_decision"}}]}})
        self.book.observe_report({**self.report, "generatedAt": self.now, "fundingThrough": self.now,
                                  "closed": [self.trade, future]})
        lesson = self.book.summary(self.plans)["lessons"][0]
        self.assertEqual(lesson["prospectiveClosedN"], 1)
        self.assertAlmostEqual(lesson["prospectiveNet"], .19)
        self.assertEqual(lesson["status"], "UNPROVEN_HYPOTHESIS")
        self.assertEqual(self.book.summary()["verifiedClosedN"], 2)

    def test_full_lesson_and_original_trade_thesis_reach_model_context(self):
        self.book.review(self.review)
        result = {"source": "BINANCE_USDM_TESTNET", "status": {"environment": "testnet"}, "rows": []}
        with patch.object(astra_runner, "LEARNING_BOOK", self.book), patch.object(astra_runner, "PLAN_BOOK", None), patch.object(astra_runner, "gateway", return_value=result):
            context = json.loads(astra_runner.context_result({"symbols": []}))
        self.assertEqual(context["learningFeedback"]["lessons"][0]["review"], self.review)
        self.assertIn(self.review["id"], self.book.delivered)

    def test_pagination_keeps_all_lessons_accessible(self):
        for i in range(7):
            self.book.review({**self.review, "id": "lesson_000"+str(i)})
        offset = 0
        ids = []
        while offset is not None:
            page = self.book.summary(offset=offset)
            ids.extend(x["id"] for x in page["lessons"])
            offset = page["nextOffset"]
        self.assertEqual(len(set(ids)), 7)

    def test_learning_failure_never_blocks_management_close(self):
        with patch.object(astra_runner, "LEARNING_BOOK", None), patch.object(astra_runner, "PLAN_BOOK", SimpleNamespace(state={"submissions": {}})), patch.object(astra_runner, "gateway", return_value={"ok": True}) as gateway:
            response = astra_runner.decision_result({"id": "close_0001", "action": "CLOSE", "tradeId": "trade1", "reason": "cut loss", "reasonCode": "CUT_LOSS"})
            self.assertTrue(json.loads(response)["ok"])
            self.assertEqual(gateway.call_args.args[0], "/decision")
            self.assertIn("learning_error", json.loads(astra_runner.learning_result({"operation": "LIST"})))

    def test_dashboard_shows_learning_without_claiming_profit(self):
        self.book.review(self.review)
        snapshot = learning_snapshot(self.root, now=self.now/1000)
        self.assertIn("UNPROVEN_HYPOTHESIS", snapshot["memoryText"])
        self.assertIn("EVIDENCE-LINKED LEARNING", snapshot["memoryText"])
        self.assertNotIn("summary", snapshot)

    def test_corrupt_journal_is_not_silently_reset(self):
        self.book.path.write_text('{broken')
        with self.assertRaises(ValueError):
            LearningBook(self.root)


if __name__ == "__main__":
    unittest.main()

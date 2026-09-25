import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock
from hermes_dashboard import learning_snapshot, publish_learning


class LearningProjectionTests(unittest.TestCase):
    def test_missing_history_is_explicit_empty(self):
        with tempfile.TemporaryDirectory() as d:
            result = learning_snapshot(Path(d), now=1800000000)
            self.assertEqual(result["cycleCount"], 0)
            self.assertEqual(result["memoryText"], "")
            self.assertIsNone(result["memoryUpdatedAt"])

    def test_history_is_bounded_and_never_exports_raw_sessions_or_credentials(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "logs").mkdir()
            (root / "hermes-home/memories").mkdir(parents=True)
            (root / "hermes-home/memories/MEMORY.md").write_text("Observed wick recovery, not a win.")
            records = [{"at": 1800000000 + i, "model": "gpt-6-astra", "tradingEnabled": True, "completed": i % 2 == 0,
                        "apiCalls": 2, "response": "WAIT", "auth": "DO_NOT_EXPORT", "messages": [
                        {"reasoning": "DO_NOT_EXPORT", "tool_calls": [{"function": {"name": "astra_context", "arguments": '{"symbols":["TUSDT","币安人生USDT"]}'}}]}]} for i in range(12)]
            (root / "logs/cycles.jsonl").write_text("\n".join(json.dumps(r) for r in records) + '\n{"incomplete":')
            result = learning_snapshot(root, now=1800000020)
            self.assertEqual(result["cycleCount"], 12)
            self.assertEqual(result["completedCycles"], 6)
            self.assertEqual(len(result["cycles"]), 10)
            self.assertEqual(result["cycles"][0]["inspectedSymbols"], ["TUSDT", "币安人生USDT"])
            self.assertNotIn("DO_NOT_EXPORT", json.dumps(result))

    def test_sync_failure_is_not_silently_successful(self):
        with tempfile.TemporaryDirectory() as d:
            gateway = Mock(return_value={"gateway_error": "unavailable"})
            with self.assertRaises(RuntimeError):
                publish_learning(Path(d), gateway)
            self.assertEqual(gateway.call_args.args[0], "/learning")



class OutcomeProjectionTests(unittest.TestCase):
    def snapshot(self, rows):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / "logs").mkdir()
        with (root / "logs/cycles.jsonl").open("w") as stream:
            for row in rows:
                stream.write(json.dumps({"tradingEnabled": True, "model": "gpt-6-astra",
                                         "at": 1788800000.0, **row}) + "\n")
        return learning_snapshot(root)

    def test_screened_slot_counts_as_an_evaluation_without_a_model_call(self):
        snap = self.snapshot([{"outcome": "SCREENED_NO_TRADE", "completed": False,
                               "evaluationComplete": True, "modelCalled": False}])
        self.assertEqual(snap["completedCycles"], 1)
        self.assertEqual(snap["modelCalls"], 0)
        self.assertEqual(snap["outcomeCounts"], {"SCREENED_NO_TRADE": 1})

    def test_provider_loss_is_not_a_completed_evaluation(self):
        snap = self.snapshot([{"outcome": "PROVIDER_UNAVAILABLE", "completed": False,
                               "evaluationComplete": False, "modelCalled": True}])
        self.assertEqual(snap["completedCycles"], 0)
        self.assertEqual(snap["outcomeCounts"], {"PROVIDER_UNAVAILABLE": 1})

    def test_legacy_rows_keep_their_recorded_meaning(self):
        snap = self.snapshot([{"completed": True}, {"completed": False}])
        self.assertEqual(snap["completedCycles"], 1)
        self.assertEqual(snap["outcomeCounts"], {"MODEL_DECISION": 1, "UNCLASSIFIED_LEGACY": 1})


class V8CycleProjectionTests(unittest.TestCase):
    """The V8 supervisor replaced the loop that wrote cycles.jsonl, so the learning
    panel froze at the cutover and reported itself STALE for hours."""

    def root(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        root = Path(d.name)
        (root / "logs").mkdir()
        return root

    def v8(self, at, model="claude-opus-5", outcome="MODEL_DECISION", completed=True, **extra):
        return {"kind": "CYCLE_COMPLETION", "mode": "FAST_TRADING", "recordedAt": at,
                "model": model, "modelRole": "FALLBACK" if "opus" in model else "PRIMARY",
                "outcome": outcome, "completed": completed, "modelCompleted": completed,
                "modelCalled": True, "apiCalls": 3, "turnsUsed": 3, "turnsLimit": 12,
                "fingerprint": "f" * 64, "response": "NO_TRADE persisted",
                "assessedSymbols": ["BTCUSDT", "ETHUSDT"], **extra}

    def write(self, root, rows, name="astra-v8-fast_trading.jsonl"):
        (root / "logs" / name).write_text("\n".join(json.dumps(r) for r in rows) + "\n")

    def test_host_receipt_is_not_labelled_raw_model_response(self):
        report={'decisionId':'d','decisionExecutionOutcome':'NO_NEW_POSITION',
                'reportingStatus':'COMPLETE','candidates':[]}
        for source,label in (('HOST_CONFIRMED_DECISIONS','HOST-CONFIRMED RECEIPT'),
                             ('MODEL_RESPONSE','RAW MODEL RESPONSE')):
            root=self.root()
            self.write(root,[self.v8(1789969771357,responseSource=source,candidateReports=[report])])
            row=learning_snapshot(root)['cycles'][0]
            self.assertIn(label,row['response'])
            if source=='HOST_CONFIRMED_DECISIONS':self.assertNotIn('RAW MODEL RESPONSE',row['response'])

    def test_v8_cycles_reach_the_panel_at_all(self):
        root = self.root()
        self.write(root, [self.v8(1800000000000), self.v8(1800000300000, completed=False,
                                                          outcome="INVALID_MODEL_RESPONSE")])
        result = learning_snapshot(root, now=1800000400)
        self.assertEqual(result["cycleCount"], 2)
        self.assertEqual(result["completedCycles"], 1)
        self.assertEqual(result["cycles"][0]["at"], 1800000300000)

    def test_a_fallback_cycle_is_not_dropped_for_being_the_wrong_model(self):
        """The projection filtered on model == "gpt-6-astra", so every cycle the declared
        fallback decided vanished — which is most of them while the primary is out."""
        root = self.root()
        self.write(root, [self.v8(1800000000000, model="claude-opus-5")])
        (root / "logs/cycles.jsonl").write_text(json.dumps(
            {"at": 1799999000, "model": "claude-opus-5", "tradingEnabled": True,
             "completed": True, "evaluationComplete": True, "apiCalls": 1, "response": "WAIT"}) + "\n")
        result = learning_snapshot(root, now=1800000400)
        self.assertEqual(result["cycleCount"], 2)

    def test_coaching_cycles_are_not_counted_as_trading_evaluations(self):
        root = self.root()
        self.write(root, [self.v8(1800000000000), self.v8(1800000060000, **{"mode": "COACHING"})])
        self.assertEqual(learning_snapshot(root, now=1800000400)["cycleCount"], 1)

    def test_the_symbols_the_host_delivered_are_shown(self):
        root = self.root()
        self.write(root, [self.v8(1800000000000)])
        self.assertEqual(learning_snapshot(root, now=1800000400)["cycles"][0]["inspectedSymbols"],
                         ["BTCUSDT", "ETHUSDT"])

    def test_legacy_history_is_kept_and_ordered_before_v8(self):
        """Dropping cycles.jsonl would silently erase every pre-cutover evaluation."""
        root = self.root()
        (root / "logs/cycles.jsonl").write_text("\n".join(json.dumps(
            {"at": 1799999000 + i, "model": "gpt-6-astra", "tradingEnabled": True, "completed": True,
             "evaluationComplete": True, "apiCalls": 1, "response": "WAIT"}) for i in range(3)) + "\n")
        self.write(root, [self.v8(1800000000000)])
        result = learning_snapshot(root, now=1800000400)
        self.assertEqual(result["cycleCount"], 4)
        self.assertEqual(result["cycles"][0]["at"], 1800000000000)  # newest first


class CanonicalReviewVisibilityTests(unittest.TestCase):
    """COACHING writes reviews to the canonical overlay, not the legacy learning journal.

    The panel read only the journal, so it reported no learning while four real reviews
    sat on disk. Data right, view blind — the same defect class as the model name.
    """

    def root(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        root = Path(d.name)
        (root / "logs").mkdir()
        (root / "hermes-home").mkdir()
        return root

    def overlay(self, root, entries):
        (root / "hermes-home/astra-canonical-v8.json").write_text(json.dumps(entries))

    def review(self, rid="review_1", evidence="astra-abc", mechanism="Closed on time limit"):
        return {"kind": "REVIEW", "id": rid, "payload": {
            "reviewId": rid, "evidenceId": evidence, "status": "PROVISIONAL",
            "outcomeClassification": "INSUFFICIENT_EVIDENCE",
            "modelInterpretation": {"observedMechanism": mechanism,
                                    "requiredAction": "Check the thesis window",
                                    "exceptions": "None"}}}

    def test_a_recorded_review_reaches_the_panel(self):
        root = self.root()
        self.overlay(root, [self.review()])
        text = learning_snapshot(root, now=1800000000)["memoryText"]
        self.assertIn("CANONICAL COACHING REVIEWS", text)
        self.assertIn("Closed on time limit", text)
        self.assertIn("astra-abc", text)

    def test_the_count_of_reviews_is_stated(self):
        root = self.root()
        self.overlay(root, [self.review("r1"), self.review("r2"), {"kind": "EVIDENCE", "payload": {}}])
        self.assertIn("2 review(s)", learning_snapshot(root, now=1800000000)["memoryText"])

    def test_only_the_recent_reviews_are_carried_so_the_text_stays_bounded(self):
        root = self.root()
        self.overlay(root, [self.review("r%d" % i, mechanism="M%d" % i) for i in range(9)])
        text = learning_snapshot(root, now=1800000000)["memoryText"]
        self.assertIn("M8", text)
        self.assertNotIn('"M0"', text)
        self.assertIn("9 review(s)", text)   # the count is still the true total

    def test_the_host_classification_is_carried_not_the_models_self_claim(self):
        root = self.root()
        entry = self.review()
        entry["payload"]["modelInterpretation"]["outcomeClassification"] = "GOOD_PROCESS_GOOD_OUTCOME"
        self.overlay(root, [entry])
        text = learning_snapshot(root, now=1800000000)["memoryText"]
        self.assertIn("INSUFFICIENT_EVIDENCE", text)

    def test_an_unreadable_overlay_says_so_instead_of_implying_no_learning(self):
        root = self.root()
        (root / "hermes-home/astra-canonical-v8.json").write_text("{not json")
        text = learning_snapshot(root, now=1800000000)["memoryText"]
        self.assertIn("Do not read this as no learning", text)

    def test_no_overlay_at_all_changes_nothing(self):
        text = learning_snapshot(self.root(), now=1800000000)["memoryText"]
        self.assertNotIn("CANONICAL COACHING REVIEWS", text)


if __name__ == "__main__":
    unittest.main()

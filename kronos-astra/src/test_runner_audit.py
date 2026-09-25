"""End-to-end receipt/cadence tests with no exchange, provider or session DB I/O."""
import json
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import astra_runner as runner
from astra_cadence import CadenceBook


class FailureReceiptTests(unittest.TestCase):
    def test_agent_initialization_failure_records_receipt_and_releases_formation_clock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "runner-config.json").write_text('{}')
            cadence = CadenceBook(root)
            plans = types.SimpleNamespace(summary=lambda: {})
            experiment = types.SimpleNamespace(start_cycle=lambda: None, finish_cycle=lambda _: None, summary=lambda: {})
            learning = types.SimpleNamespace(observe_context=lambda _: None, delivered=set(), state={"lessons": []})
            def screen(_):
                runner.CADENCE_BOOK = cadence
                return {"call": True, "reason": "PLAN_FORMATION"}
            def unavailable(*args):
                raise RuntimeError("HTTP 429 usage limit reached")
            session = types.SimpleNamespace(SessionDB=lambda: types.SimpleNamespace(close=lambda: None))
            with patch.dict("sys.modules", {"hermes_state": session}), patch.multiple(
                runner, ROOT=root, PLAN_BOOK=None, LEARNING_BOOK=None, EXPERIMENT_BOOK=None,
                CADENCE_BOOK=None, EXPERIMENT_REQUIRED=False,
                gateway=lambda *a: {}, validate_capital_identity=lambda _: None,
                PlanBook=lambda *a, **k: plans, ExperimentBook=lambda *a, **k: experiment,
                LearningBook=lambda *a: learning, refresh_learning_report=lambda: None,
                screen_cycle=screen, make_agent=unavailable, sync_dashboard=lambda: None):
                with self.assertRaisesRegex(RuntimeError, "PROVIDER_UNAVAILABLE"):
                    runner.run_cycle(True)
            receipt = json.loads((root / "logs/cycles.jsonl").read_text())
            self.assertEqual(receipt["outcome"], "PROVIDER_UNAVAILABLE")
            self.assertFalse(receipt["evaluationComplete"])
            self.assertEqual(receipt["hostRevision"], runner.HOST_REVISION)
            self.assertNotIn("PLAN_FORMATION", cadence.state["lastCallAt"])
            self.assertEqual(cadence.budget()["used"], 1)
            self.assertEqual(cadence.decide({}, 0, 0, 1)["outcome"], "SCREENED_RETRY_BACKOFF")

    def test_provider_error_is_not_hidden_by_nonempty_final_response(self):
        self.assertEqual(runner.classify_outcome({"completed": False,
                         "final_response": "No completed evaluation", "error": "HTTP 429 quota exceeded"}),
                         "PROVIDER_UNAVAILABLE")


if __name__ == "__main__":
    unittest.main()

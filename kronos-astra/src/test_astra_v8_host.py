import copy
import tempfile
import unittest
from pathlib import Path
from astra_v8_host import CoverageBook, fetch_histories, release_gate, COHORT, GATEWAY_VERSION


class CoverageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "coverage.json"
        self.book = CoverageBook(self.path)
        self.universe = ["AUSDT", "BUSDT", "CUSDT", "DUSDT"]

    def test_priority_does_not_starve_complete_universe(self):
        self.book.observe(self.universe, {"strongest24h": ["DUSDT"]}, 1)
        first = self.book.reserve("j1", 2, 1)
        self.assertEqual(first["symbols"], ["DUSDT", "AUSDT"])
        self.book.progress("j1", fetched=first["symbols"], delivered=first["symbols"], assessed=first["symbols"], outcome="VALID_NO_TRADE")
        self.book.observe(self.universe, {"strongest24h": ["DUSDT", "AUSDT"]}, 2)
        second = self.book.reserve("j2", 2, 2)
        self.assertEqual(second["symbols"], ["BUSDT", "CUSDT"])

    def test_restart_preserves_pending_job(self):
        self.book.observe(self.universe, {}, 1)
        first = self.book.reserve("j1", 2, 1)
        resumed = CoverageBook(self.path)
        self.assertEqual(resumed.reserve("j1", 2, 2), first)
        with self.assertRaises(ValueError):
            resumed.reserve("other", 2, 2)

    def test_no_assessment_without_delivery(self):
        self.book.observe(self.universe, {}, 1)
        self.book.reserve("j1", 2, 1)
        with self.assertRaises(ValueError):
            self.book.progress("j1", assessed=["AUSDT"])
        self.assertEqual(CoverageBook(self.path).state["jobs"]["j1"]["assessed"], [])

    def test_provider_failure_retains_denominator_not_fake_analysis(self):
        self.book.observe(self.universe, {}, 1)
        self.book.reserve("j1", 2, 1)
        self.book.progress("j1", outcome="PROVIDER_UNAVAILABLE")
        self.assertEqual(self.book.state["jobs"]["j1"]["assessed"], [])
        self.assertEqual(self.book.state["queue"], ["CUSDT", "DUSDT"])

    def test_universe_addition_and_removal(self):
        self.book.observe(self.universe, {}, 1)
        self.book.observe(["BUSDT", "CUSDT", "DUSDT", "EUSDT"], {}, 2)
        self.assertEqual(set(self.book.state["queue"]), {"BUSDT", "CUSDT", "DUSDT", "EUSDT"})

    def test_history_continuation(self):
        calls = []
        def gateway(path, args):
            calls.append(args)
            i = args["offset"]
            return {"source": "BINANCE_USDM_TESTNET", "status": {"environment": "testnet"},
                    "rows": [{"symbol": self.universe[i]}],
                    "historyPage": {"offset": i, "returned": 1, "nextOffset": i+1 if i < 3 else None}}
        result = fetch_histories(gateway, self.universe)
        self.assertEqual([r["symbol"] for r in result["rows"]], self.universe)
        self.assertEqual(len(calls), 4)
        self.assertTrue(all(c["symbols"] == self.universe for c in calls))

    def test_history_reordered_rejected(self):
        def gateway(path, args):
            return {"source": "BINANCE_USDM_TESTNET", "status": {"environment": "testnet"},
                    "rows": [{"symbol": "BUSDT"}], "historyPage": {"offset": 0, "returned": 1, "nextOffset": 1}}
        with self.assertRaises(ValueError):
            fetch_histories(gateway, self.universe)

    def test_release_fails_closed_for_mutations(self):
        manifest = {"cohortId": COHORT, "armed": True, "runtimeFiles": {"a.py": "sha"},
                    "testsPassed": True, "integrationVerified": True}
        status = {"laneId": "ASTRA_HERMES_TESTNET", "environment": "testnet", "executionVersion": GATEWAY_VERSION,
                  "capital": {"mode": "BINANCE_TESTNET_WALLET", "maxEntryNotionalUsd": 25,
                              "maxOpenPositions": None, "totalLaneAllocationUsd": None},
                  "leverage": 1, "dailyLossCap": None}
        self.assertTrue(release_gate(manifest, current_hashes={"a.py": "sha"}, gateway_status=status))
        for key, value in [("environment", "live"), ("executionVersion", "old"), ("leverage", 2)]:
            mutated = copy.deepcopy(status)
            mutated[key] = value
            with self.assertRaises(ValueError):
                release_gate(manifest, current_hashes={"a.py": "sha"}, gateway_status=mutated)
        for key in ("armed", "testsPassed", "integrationVerified"):
            mutated = {**manifest, key: False}
            with self.assertRaises(ValueError):
                release_gate(mutated, current_hashes={"a.py": "sha"}, gateway_status=status)


if __name__ == "__main__":
    unittest.main()

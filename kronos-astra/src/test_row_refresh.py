"""The freeze must be judged against the market NOW, not the snapshot the model read.

PlanBook.create requires the selected symbol's row to be under 120s old. Measured model
latency is 130s-1200s, so every entry attempt over 48h failed that gate with gaps of
230s, 254s, 984s, 1036s and 136s. The model cannot meet a window shorter than its own
thinking time; the host has to re-read the symbol before validating.
"""
import unittest
from unittest.mock import patch

import astra_v8_runner as runner


class FakePlanBook:
    def __init__(self, rows):
        self.rows = rows
        self.unavailable = []


class Session:
    """Only the parts refresh_selected_row touches."""
    def __init__(self, rows, fetched=None, fail=False):
        self.engine = type("E", (), {"PLAN_BOOK": FakePlanBook(rows),
            "gateway": lambda *a, **k: {"environment": "testnet", "active": []},
            "validate_capital_identity": lambda *a: None})()
        self.job = {"id": "job-1"}
        self.appended = []
        self.journal = type("J", (), {"append": lambda _s, kind, **f: self.appended.append((kind, f))})()
        self._fetched = fetched
        self._fail = fail

    refresh_selected_row = runner.JobSession.refresh_selected_row


def row(symbol, observed_at, price=100):
    return {"symbol": symbol, "observedAt": observed_at, "book": {"bid": price, "ask": price}}


class RowRefreshTests(unittest.TestCase):
    NOW = 1_800_000_000_000

    def run_refresh(self, rows, fetched_rows, symbol="AUSDT"):
        s = Session(rows)
        with patch.object(runner, "now_ms", return_value=self.NOW), \
             patch("astra_v8_host.fetch_histories",
                   return_value={"rows": fetched_rows, "unavailableSymbols": [],
                                 "status": {"environment": "testnet", "active": []}}) as fetch, \
             patch("quant_candidate_refresh.refresh_candidates", side_effect=lambda raw: {**raw, "marketDataComplete": True}):
            result = s.refresh_selected_row(symbol)
        return s, result, fetch

    def test_a_row_older_than_the_window_is_re_read_before_the_freeze(self):
        """The exact production failure: a 230s-old row against a 120s gate."""
        stale = {"AUSDT": row("AUSDT", self.NOW - 230_000, price=100)}
        s, result, fetch = self.run_refresh(stale, [row("AUSDT", 0, price=111)])
        fetch.assert_called_once()
        self.assertEqual(s.engine.PLAN_BOOK.rows["AUSDT"]["observedAt"], self.NOW)
        self.assertEqual(s.engine.PLAN_BOOK.rows["AUSDT"]["book"]["bid"], 111)  # real new data
        self.assertEqual(result["observedAt"], self.NOW)

    def test_a_still_fresh_row_is_not_re_read(self):
        """A refresh per freeze would be an extra gateway call for nothing."""
        fresh = {"AUSDT": row("AUSDT", self.NOW - 1000)}
        s, result, fetch = self.run_refresh(fresh, [row("AUSDT", 0)])
        fetch.assert_not_called()
        self.assertIsNone(result)
        self.assertEqual(s.engine.PLAN_BOOK.rows["AUSDT"]["observedAt"], self.NOW - 1000)

    def test_stale_candles_are_never_restamped_young(self):
        """The refreshed row must be the FETCHED data, not the old row with a new clock."""
        stale = {"AUSDT": row("AUSDT", self.NOW - 500_000, price=100)}
        s, _, _ = self.run_refresh(stale, [row("AUSDT", 0, price=250)])
        self.assertEqual(s.engine.PLAN_BOOK.rows["AUSDT"]["book"]["bid"], 250)

    def test_an_unreadable_symbol_refuses_rather_than_falling_back_to_the_stale_row(self):
        """No fresh data means no freeze. Falling through would enter on old prices."""
        stale = {"AUSDT": row("AUSDT", self.NOW - 300_000)}
        s = Session(stale)
        with patch.object(runner, "now_ms", return_value=self.NOW), \
             patch("astra_v8_host.fetch_histories", return_value={"rows": [], "unavailableSymbols": ["AUSDT"]}), \
             patch("quant_candidate_refresh.refresh_candidates", return_value={"marketDataComplete": False}):
            with self.assertRaises(ValueError):
                s.refresh_selected_row("AUSDT")
        self.assertEqual(s.engine.PLAN_BOOK.rows["AUSDT"]["observedAt"], self.NOW - 300_000)

    def test_the_refresh_is_recorded_with_the_staleness_it_repaired(self):
        """Provenance: a reader must be able to see the window this was closing."""
        stale = {"AUSDT": row("AUSDT", self.NOW - 230_000)}
        s, _, _ = self.run_refresh(stale, [row("AUSDT", 0)])
        kind, fields = s.appended[-1]
        self.assertEqual(kind, "HOST_ROW_REFRESH")
        self.assertEqual(fields["stalenessMs"], 230_000)
        self.assertEqual(fields["symbol"], "AUSDT")

    def test_the_threshold_leaves_margin_under_the_gate_it_must_satisfy(self):
        """Refreshing at the gate's own limit would age out during the fetch itself."""
        self.assertLess(runner.ROW_REFRESH_AFTER_MS, 120000)


class MutationGuardTests(unittest.TestCase):
    def test_removing_the_refresh_call_turns_a_test_red(self):
        """The call site is the whole fix; a method nothing calls changes nothing."""
        import inspect
        source = inspect.getsource(runner.JobSession._call)
        self.assertIn("self.refresh_selected_row(symbol)", source,
                      "astra_plan CREATE no longer refreshes the row before freezing")


if __name__ == "__main__":
    unittest.main()

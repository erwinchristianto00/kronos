import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import types

import astra_experiments as experiments
import astra_v8_supervisor as s
from astra_experiments import ExperimentBook


class SupervisorHelpers(unittest.TestCase):
    def test_periodic_review_backlog_is_satisfied_by_successful_management(self):
        supervisor = s.Supervisor.__new__(s.Supervisor)
        def event(eid, at, reason='OWNED_POSITION_REVIEW_DUE', position='AXL'):
            return dict(eventId=eid,eventDetectedAt=at,eventReason=reason,positionId=position)
        supervisor.state = {'lastManagedAt': {'AXL': 200}, 'pendingEvents': [
            event('old',100),event('duplicate',199),event('new',201),
            event('stop',100,'STOP_QUOTE_RISK_CROSSING'),
            event('target',100,'TARGET_CROSSING'),event('other',100,position='OTHER')]}
        supervisor.prune_completed_periodic_reviews()
        self.assertEqual([e['eventId'] for e in supervisor.state['pendingEvents']],
                         ['new','stop','target','other'])
        self.assertEqual(supervisor.state['periodicReviewCoalescing']['retiredCount'],2)
        supervisor.prune_completed_periodic_reviews()
        self.assertEqual(supervisor.state['periodicReviewCoalescing']['retiredCount'],2)

    def test_failed_or_unanswered_review_keeps_pending_request(self):
        supervisor = s.Supervisor.__new__(s.Supervisor)
        event = dict(eventId='due',positionId='AXL',eventDetectedAt=100,
                     eventReason='OWNED_POSITION_REVIEW_DUE')
        for managed in ({}, {'AXL': 90}):
            supervisor.state={'lastManagedAt':managed,'pendingEvents':[event.copy()]}
            supervisor.prune_completed_periodic_reviews()
            self.assertEqual(supervisor.state['pendingEvents'],[event])

    def test_refresh_failure_releases_batch_and_next_batch_can_run(self):
        with tempfile.TemporaryDirectory() as root:
            coverage=s.CoverageBook(Path(root)/'coverage.json')
            coverage.observe(['AAAUSDT','币安人生USDT','ZZZUSDT'],{},1)
            reservation=coverage.reserve('failed',2,2)
            with patch.object(s,'fetch_histories',return_value={}), patch.object(s,'refresh_candidates',side_effect=ValueError('refresh failed')):
                with self.assertRaisesRegex(ValueError,'refresh failed'):
                    s.fetch_formation(coverage,reservation)
            loaded=s.CoverageBook(Path(root)/'coverage.json')
            self.assertEqual(loaded.state['jobs']['failed']['outcome'],'DATA_UNAVAILABLE')
            self.assertEqual(loaded.state['jobs']['failed']['assessed'],[])
            self.assertEqual(len(loaded.reserve('next',2,3)['symbols']),1)

    def test_candidate_is_attention_only_not_host_alpha(self):
        row = {"symbol": "AUSDT", "features": {"change4hPct": 12},
               "book": {"bid": 10, "ask": 11, "time": 100}, "filters": {"minNotional": 5},
               "economics": {"commission": {"takerRate": .0005}},
               "candles": [{"closeTime": i, "close": 10} for i in range(50)]}
        candidate = s.compact_candidate(row, 48)
        self.assertIsNone(candidate["trigger"])
        self.assertIsNone(candidate["entryBand"])
        self.assertNotIn("side", candidate)
        self.assertEqual(candidate["candidateClass"], "ATTENTION_ONLY")
        self.assertEqual(len(candidate["closedCandles"]), 12)
        self.assertEqual(candidate["closedCandles"][-1]["closeTime"], 47)

    def test_complete_measured_row_is_formation_context_not_host_alpha(self):
        at = 61 * 300000
        candles = []
        for i in range(61):
            close = 100 + i
            candles.append({"closeTime": (i + 1) * 300000 - 1, "open": close - .2,
                            "high": close + .5, "low": close - .5, "close": close,
                            "volume": 10, "quoteVolume": close * 10})
        row = {"symbol": "AUSDT", "features": {}, "candles": candles,
               "book": {"bid": 160, "ask": 160.1, "time": at - 1},
               "filters": {"minNotional": 5},
               "economics": {"bookFresh": True, "feeAndSpreadBps": 12.5}}
        candidate = s.compact_candidate(row, at)
        self.assertEqual(candidate["candidateClass"], "FRESH_FORMATION_CONTEXT")
        self.assertTrue(candidate["formation"]["eligibleForHypothesis"])
        self.assertEqual(candidate["formation"]["measurementStatus"], "MEASURED")
        self.assertIsNone(candidate["trigger"])
        self.assertNotIn("side", candidate)

    def test_worker_only_status_drops_old_history(self):
        result = s.safe_status({"active": [{"id": "owned"}], "closed": ["old"], "decisions": ["old"], "environment": "testnet"})
        self.assertNotIn("closed", result)
        self.assertNotIn("decisions", result)
        self.assertEqual(result["active"][0]["id"], "owned")

    def test_sampled_excursions_use_new_actual_quotes_only(self):
        supervisor = s.Supervisor.__new__(s.Supervisor)
        supervisor.state = {}
        position = {"id": "owned", "symbol": "AUSDT", "side": "LONG", "entryPrice": 10}
        status = {"active": [position]}
        with patch.object(s, "report", return_value={"open": [{"id": "owned", "quoteFresh": True,
                            "quoteAt": 100, "quotePrice": 11, "unrealized": 1}]}):
            result = supervisor.owned_context(status)
        self.assertAlmostEqual(result[0]["mfeBps"], 1000)
        self.assertAlmostEqual(result[0]["maeBps"], 1000)
        with patch.object(s, "report", return_value={"open": [{"id": "owned", "quoteFresh": True,
                            "quoteAt": 90, "quotePrice": 100, "unrealized": 90}]}):
            result = supervisor.owned_context(status)
        self.assertAlmostEqual(result[0]["mfeBps"], 1000)
        with patch.object(s, "report", return_value={"open": [{"id": "owned", "quoteFresh": True,
                            "quoteAt": 110, "quotePrice": 9, "unrealized": -1}]}):
            result = supervisor.owned_context(status)
        self.assertAlmostEqual(result[0]["maeBps"], -1000)
        self.assertEqual(position, status["active"][0])
        self.assertNotIn("mfeBps", position)

    def test_finished_job_identity_cannot_be_spoofed(self):
        supervisor = s.Supervisor.__new__(s.Supervisor)
        supervisor.state = {"jobs": {"job": {"mode": "FAST_TRADING", "finishedAt": None}}}
        with self.assertRaises(ValueError):
            supervisor.finish("job", {"jobId": "different"})
        self.assertIsNone(supervisor.state["jobs"]["job"]["finishedAt"])

    def test_slow_model_does_not_skip_host_position_poll(self):
        supervisor = s.Supervisor.__new__(s.Supervisor)
        supervisor.state = {"events": s.new_event_state(), "pendingEvents": [], "jobs": {}, "lastManagedAt": {}}
        supervisor.market_rows = {}
        supervisor.config = {}
        supervisor.manifest = {"gatewayExecutionVersion": "expected"}
        calls = []
        supervisor.dynamic_scan = types.SimpleNamespace(poll=lambda at: calls.append('candidate-scan') or {})
        supervisor.reap = lambda: calls.append("reap")
        supervisor.owned_context = lambda status: calls.append("position-poll") or []
        supervisor.save = lambda: None
        supervisor.live_job = lambda mode: {"model": "slow"}
        supervisor.coach_if_due = lambda: calls.append("independent-coach-check")
        with patch.object(s.engine, "gateway", return_value={"executionVersion": "expected"}), patch.object(s.engine, "validate_capital_identity"):
            supervisor.tick()
        self.assertIn("position-poll", calls)
        self.assertIn("independent-coach-check", calls)


class EnrolledSlotOutcomeTests(unittest.TestCase):
    """Every enrolled slot must end in exactly one outcome.

    `start_cycle` enrols a slot on every tick; only a dispatched job ever reached
    `finish_cycle`. Slots the host screened out kept `outcome: None` and were then
    scored as failed evaluations — the lane was marked down for cycles it was never
    asked to run, which is what made the 0.95 reliability gate unreachable.
    """

    def supervisor(self, root, **overrides):
        sup = s.Supervisor.__new__(s.Supervisor)
        sup.root = Path(root)
        sup.dynamic_scan = types.SimpleNamespace(poll=lambda at: {})
        sup.state = {"events": s.new_event_state(), "pendingEvents": [], "jobs": {}, "lastManagedAt": {},
                     "readyStates": {}, "calls": [], "lastFormationAt": s.now(), "seenDispatchEvents": [],
                     "planCursor": 0, **overrides}
        sup.market_rows = {}
        sup.config = {"emptyPipelineIntervalMs": 900000, "dailyModelCallBudget": 60}
        sup.manifest = {"gatewayExecutionVersion": "expected", "fingerprint": "f" * 64}
        sup.common_hash = "c" * 64
        sup.reap = lambda: None
        sup.owned_context = lambda status: []
        sup.save = lambda: None
        sup.live_job = lambda mode: None
        sup.coach_if_due = lambda: None
        return sup

    def run_tick(self, sup, admitted=True):
        plans = types.SimpleNamespace(state={"plans": []}, observe=lambda raw: None, view=lambda p: p,
                                      expire_unsubmitted=lambda status: [])
        admit = (lambda *a, **k: True) if admitted else _refuse
        with patch.object(s.engine, "gateway", return_value={"executionVersion": "expected"}), \
             patch.object(s.engine, "validate_capital_identity"), \
             patch.object(s.engine, "execution_config", return_value={}), \
             patch.object(s, "validate_assignment", admit), \
             patch.object(s, "PlanBook", lambda *a, **k: plans):
            sup.tick()

    def outcome(self, root):
        book = ExperimentBook(Path(root), "c" * 64)
        slots = list(book.state["assignments"].values())
        self.assertEqual(len(slots), 1, "exactly one slot should have been enrolled")
        return slots[0]

    def test_a_quiet_slot_is_closed_as_screened_not_left_open(self):
        with tempfile.TemporaryDirectory() as root:
            sup = self.supervisor(root)
            self.run_tick(sup)
            slot = self.outcome(root)
            self.assertEqual(slot["outcome"], "SCREENED_NO_TRADE")
            self.assertTrue(slot["completed"])

    def test_a_slot_lost_to_the_daily_budget_is_a_resource_constraint(self):
        """Not a failed evaluation: another model call would not have been allowed."""
        with tempfile.TemporaryDirectory() as root:
            sup = self.supervisor(root, lastFormationAt=0,
                                  calls=[{"at": s.now(), "mode": "FAST_TRADING"} for _ in range(60)])
            self.run_tick(sup)
            slot = self.outcome(root)
            self.assertEqual(slot["outcome"], "SCREENED_BUDGET")
            self.assertIn(slot["outcome"], experiments.OUTCOME_EXCLUDED)

    def test_a_barred_slot_is_closed_before_the_tick_fails_loudly(self):
        """It raises on every tick of the slot, so an open slot would never close."""
        with tempfile.TemporaryDirectory() as root:
            sup = self.supervisor(root)
            with self.assertRaises(ValueError):
                self.run_tick(sup, admitted=False)
            slot = self.outcome(root)
            self.assertEqual(slot["outcome"], "SCREENED_NOT_ADMITTED")
            self.assertFalse(slot["completed"])

    def test_a_position_at_max_hold_does_not_wake_the_model(self):
        """25 Sep: the gateway closed COOKIEUSDT one second after the host woke Sonnet."""
        with tempfile.TemporaryDirectory() as root:
            at = s.now()
            position = {"id": "cookie", "symbol": "COOKIEUSDT", "side": "LONG", "state": "OPEN", "qty": 10,
                        "entryQty": 10, "entryPrice": 1.0, "stopPrice": 0.9, "targetPrice": 1.2,
                        "maxHoldMs": 4 * 3600000, "createdAt": at - 4 * 3600000 + 1000, "stopId": "1",
                        "stopDone": False, "setupId": "plan"}
            sup = self.supervisor(root, pendingEvents=[{"eventId": "review", "positionId": "cookie",
                                                        "eventReason": "OWNED_POSITION_REVIEW_DUE",
                                                        "eventDetectedAt": at}])
            sup.owned_context = lambda status: [dict(position)]
            dispatched = []
            sup.dispatch = lambda job: dispatched.append(job)
            raw = {"source": "BINANCE_USDM_TESTNET", "rows": [], "unavailableSymbols": [],
                   "status": {"executionVersion": "expected", "environment": "testnet", "active": [position]}}
            with patch.object(s, "fetch_histories", lambda *a, **k: raw):
                self.run_tick(sup)
            self.assertEqual(dispatched, [])
            self.assertEqual(self.outcome(root)["outcome"], "SCREENED_NO_TRADE")
            self.assertIn("review", {r["eventId"] for r in sup.state["gatewayExitRetired"]})
            self.assertFalse([e for e in sup.state["pendingEvents"] if e.get("positionId") == "cookie"])

    def test_a_screen_never_overwrites_what_the_model_actually_did(self):
        """A later tick in the same five-minute slot must not relabel a real cycle."""
        with tempfile.TemporaryDirectory() as root:
            book = ExperimentBook(Path(root), "c" * 64)
            book.start_cycle()
            book.finish_cycle("MODEL_DECISION")
            self.assertEqual(book.record_screen_outcome("SCREENED_NO_TRADE"), "MODEL_DECISION")
            self.assertEqual(book.current["outcome"], "MODEL_DECISION")

    def test_screened_slots_leave_the_reliability_denominator_alone(self):
        """The whole point: a never-asked slot is not a cycle the model failed."""
        rows = [{"completed": True, "outcome": "MODEL_DECISION"},
                {"completed": True, "outcome": "SCREENED_NO_TRADE"},
                {"completed": False, "outcome": "SCREENED_BUDGET"},
                {"completed": False, "outcome": "SCREENED_NOT_ADMITTED"}]
        result = experiments.completion(rows)
        self.assertEqual(result["scoredAssignments"], 2)
        self.assertEqual(result["completionRate"], 1.0)
        self.assertEqual(result["unclassifiedLegacy"], 0)


def _refuse(*args, **kwargs):
    raise ValueError("V8 phase not admitted")


if __name__ == "__main__":
    unittest.main()

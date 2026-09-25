"""Supervisor working-set compaction: synthetic state only, no model/gateway calls."""
import gzip
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import astra_v8_supervisor as S
from astra_canonical_v8 import _hash

NOW = 1800000000000
DAY = 86400000


def delta(n, pad=2000):
    return [{"kind": "DELIVERY", "id": "d%d" % n, "payload": {"blob": "x" * pad}, "previousHash": "GENESIS"}]


def fake(root, jobs):
    state = {"jobs": jobs}
    sv = SimpleNamespace(state=state, dir=root, path=root / "supervisor.json")
    sv.save = lambda: (root / "supervisor.json").write_text(json.dumps(state))
    return sv


class CompactionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def archive(self):
        path = self.root / S.JOB_ARCHIVE
        if not path.exists():
            return []
        with gzip.open(path, "rt") as stream:
            return [json.loads(line) for line in stream]

    def test_only_imported_deltas_leave_and_they_are_archived_first(self):
        imported, pending = delta(1), delta(2)
        jobs = {
            "a": {"id": "a", "mode": "FAST_TRADING", "finishedAt": NOW - 3600000,
                  "result": {"outcome": "MODEL_DECISION", "canonicalDelta": imported}},
            "b": {"id": "b", "mode": "FAST_TRADING", "finishedAt": NOW - 3600000,
                  "result": {"outcome": "MODEL_DECISION", "canonicalDelta": pending}},
            "c": {"id": "c", "mode": "FAST_TRADING", "result": {"canonicalDelta": delta(3)}},  # running
        }
        sv = fake(self.root, jobs)
        moved = S.Supervisor.compact_jobs(sv, {_hash(imported)}, NOW)
        self.assertEqual(moved, 1)
        self.assertEqual(jobs["a"]["result"]["canonicalDelta"], [])
        self.assertEqual(jobs["a"]["result"]["canonicalDeltaImported"], _hash(imported))
        self.assertEqual(jobs["b"]["result"]["canonicalDelta"], pending)   # not merged yet: kept
        self.assertEqual(jobs["c"]["result"]["canonicalDelta"], delta(3))   # unfinished: untouched
        rows = self.archive()
        self.assertEqual([(r["jobId"], r["kind"]) for r in rows], [("a", "IMPORTED_CANONICAL_DELTA")])
        self.assertEqual(rows[0]["delta"], imported)

    def test_old_finished_jobs_are_slimmed_but_keep_what_readers_use(self):
        result = {"id": "old", "outcome": "MODEL_DECISION", "error": None, "completed": True, "modelRole": "PRIMARY",
                  "response": "y" * 5000, "candidateReports": [{"r": "z" * 5000}],
                  "actions": [{"action": "WAIT", "outcome": "PLAN_UPDATED", "orderFilledAt": None, "detail": "w" * 3000}]}
        jobs = {"old": {"id": "old", "mode": "FAST_TRADING", "at": NOW - 5 * DAY, "finishedAt": NOW - 5 * DAY,
                        "modelPolicy": {"model": "claude-sonnet-5", "task": "FAST_TRADING"}, "result": result},
                "new": {"id": "new", "mode": "FAST_TRADING", "finishedAt": NOW - 3600000,
                        "result": {"outcome": "MODEL_DECISION", "response": "keep" * 100}}}
        sv = fake(self.root, jobs)
        S.Supervisor.compact_jobs(sv, set(), NOW)
        old = jobs["old"]["result"]
        self.assertEqual((old["outcome"], old["completed"], old["modelRole"], old["slim"]),
                         ("MODEL_DECISION", True, "PRIMARY", True))
        self.assertEqual(old["actions"], [{"action": "WAIT", "outcome": "PLAN_UPDATED", "orderFilledAt": None}])
        self.assertNotIn("response", old)
        self.assertEqual(jobs["old"]["modelPolicy"]["model"], "claude-sonnet-5")
        self.assertIn("response", jobs["new"]["result"])   # recent jobs stay whole
        full = [r for r in self.archive() if r["kind"] == "FINISHED_JOB_RESULT"]
        self.assertEqual(full[0]["result"]["response"], "y" * 5000)
        # idempotent: a second pass moves nothing and never double-archives
        self.assertEqual(S.Supervisor.compact_jobs(sv, set(), NOW + DAY), 0)

    def test_old_job_with_unimported_delta_is_not_slimmed(self):
        pending = delta(9)
        jobs = {"x": {"id": "x", "mode": "FAST_TRADING", "finishedAt": NOW - 5 * DAY,
                      "result": {"outcome": "MODEL_DECISION", "canonicalDelta": pending, "response": "r" * 100}}}
        sv = fake(self.root, jobs)
        S.Supervisor.compact_jobs(sv, set(), NOW)
        self.assertEqual(jobs["x"]["result"]["canonicalDelta"], pending)
        self.assertIn("response", jobs["x"]["result"])

    def test_realistic_growth_stays_far_below_the_api_read_cap(self):
        jobs = {}
        for i in range(400):   # ~2 weeks of FAST jobs with 20 KB deltas, all merged
            d = delta(i, pad=20000)
            jobs["j%d" % i] = {"id": "j%d" % i, "mode": "FAST_TRADING", "at": NOW - (400 - i) * 3600000,
                               "finishedAt": NOW - (400 - i) * 3600000,
                               "result": {"outcome": "MODEL_DECISION", "canonicalDelta": d,
                                          "response": "r" * 2000, "actions": [{"action": "WAIT", "outcome": "X"}]}}
        imported = {_hash(j["result"]["canonicalDelta"]) for j in jobs.values()}
        sv = fake(self.root, jobs)
        before = len(json.dumps(sv.state))
        S.Supervisor.compact_jobs(sv, imported, NOW)
        after = len(json.dumps(sv.state))
        self.assertGreater(before, 8 * 1024 * 1024)
        self.assertLess(after, 1024 * 1024)

    def test_a_broken_overlay_never_breaks_the_tick(self):
        home = self.root / "hermes-home"
        home.mkdir()
        (home / "astra-canonical-v8.json").write_text("{not json")
        sv = fake(self.root, {})
        sv.root, sv.dir = self.root, self.root
        self.assertEqual(S.Supervisor.maybe_compact(sv), 0)
        self.assertIn("lastCompactionAt", sv.state)   # and it will not retry every tick


class JobFileGzipTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def write(self, name, age_ms, body='{"x": 1}'):
        path = self.dir / name
        path.write_text(body)
        stamp = (NOW - age_ms) / 1000
        import os
        os.utime(path, (stamp, stamp))
        return path

    def test_only_old_unprotected_files_are_gzipped_losslessly(self):
        old = self.write("v8-coach-aaa.json", 3 * DAY, '{"big": "' + "x" * 5000 + '"}')
        self.write("v8-coach-aaa.result.json", 3 * DAY)
        young = self.write("v8-fast-bbb.json", 3600000)
        running = self.write("v8-fast-run.json", 3 * DAY)
        reserved = self.write("v8-fast-cov.json", 3 * DAY)
        watched = self.write("v8-fast-wat.json", 3 * DAY)
        other = self.write("supervisor.pre-abc.json", 3 * DAY)
        state = {"jobs": {"v8-fast-run": {"id": "v8-fast-run"}},
                 "watchQueue": {"version": "WATCH_REASSESSMENT_V1", "items": {"w": {"status": "IN_FLIGHT", "jobId": "v8-fast-wat"}}}}
        sv = SimpleNamespace(state=state, dir=self.dir,
                             coverage=SimpleNamespace(state={"jobs": {"v8-fast-cov": {"outcome": None}}}))
        original = old.read_text()
        self.assertEqual(S.Supervisor.gzip_job_files(sv, NOW), 2)
        self.assertFalse(old.exists())
        with gzip.open(self.dir / "v8-coach-aaa.json.gz", "rt") as stream:
            self.assertEqual(stream.read(), original)
        self.assertTrue((self.dir / "v8-coach-aaa.result.json.gz").exists())
        for kept in (young, running, reserved, watched, other):
            self.assertTrue(kept.exists(), kept.name)


class GatewayExitTests(unittest.TestCase):
    """25 Sep 19:03:37Z: COOKIEUSDT hit max hold, the host woke Sonnet, the gateway
    closed the position one second later and both HOLDs were STALE_ACTION."""

    def sv(self, events):
        return SimpleNamespace(state={"pendingEvents": events})

    def test_events_for_a_position_at_max_hold_are_retired_not_dispatched(self):
        created, hold = NOW - 4 * 3600000, 4 * 3600000   # max hold reached right now
        owned = [{"id": "cookie", "createdAt": created, "maxHoldMs": hold},
                 {"id": "young", "createdAt": NOW - 3600000, "maxHoldMs": hold}]
        events = [{"eventId": "e1", "positionId": "cookie", "eventReason": "MAX_HOLD_MILESTONE"},
                  {"eventId": "e2", "positionId": "cookie", "eventReason": "OWNED_POSITION_REVIEW_DUE"},
                  {"eventId": "e3", "positionId": "young", "eventReason": "OWNED_POSITION_REVIEW_DUE"},
                  {"eventId": "e4", "opportunityId": "plan1", "eventReason": "FROZEN_TRIGGER_CROSSING"}]
        sv = self.sv(events)
        retired = S.Supervisor.retire_gateway_exit_events(sv, owned, NOW - 1000)   # 1s before the exit
        self.assertEqual({e["eventId"] for e in retired}, {"e1", "e2"})
        self.assertEqual([e["eventId"] for e in sv.state["pendingEvents"]], ["e3", "e4"])
        self.assertEqual({r["reason"] for r in sv.state["gatewayExitRetired"]}, {"GATEWAY_MAX_HOLD_EXIT"})

    def test_positions_well_before_max_hold_keep_their_events(self):
        owned = [{"id": "p", "createdAt": NOW - 3600000, "maxHoldMs": 4 * 3600000}]
        events = [{"eventId": "e", "positionId": "p", "eventReason": "TARGET_CROSSING"}]
        sv = self.sv(events)
        self.assertEqual(S.Supervisor.retire_gateway_exit_events(sv, owned, NOW), [])
        self.assertEqual(sv.state["pendingEvents"], events)
        self.assertNotIn("gatewayExitRetired", sv.state)

    def test_missing_hold_data_never_retires(self):
        sv = self.sv([{"eventId": "e", "positionId": "p"}])
        self.assertEqual(S.Supervisor.retire_gateway_exit_events(sv, [{"id": "p", "createdAt": None, "maxHoldMs": None}], NOW), [])


if __name__ == "__main__":
    unittest.main()

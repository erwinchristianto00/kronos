import copy
import json
import tempfile
import unittest
from pathlib import Path
from astra_experiments import ExperimentBook
from astra_v8_phase import prepare_v8_phase, membership, fail_fast_review
from astra_v8_host import COHORT
import migrate_supervisor_cohort


class PhaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.book = ExperimentBook(Path(self.temp.name), "a" * 64, now=lambda: 1000000)
        baseline = self.book.state["champion"]
        self.book.state["versions"]["candidate"] = {"id": "candidate", "kind": "CANDIDATE"}
        self.book.state["studies"].append({"id": "study", "status": "HOLDOUT", "candidate": "candidate",
            "control": baseline, "seed": "seed", "phases": [{"id": 0, "name": "HOLDOUT", "start": 0, "sealedAt": None, "result": None}]})

    def test_phase_boundary_preserves_history(self):
        original = copy.deepcopy(self.book.state)
        event = prepare_v8_phase(self.book, 1000000, "b" * 64, ["old"])
        self.assertEqual(event["phaseId"], 1)
        self.assertEqual(event["resumeAfterMs"], 1200000)
        for key in ("versions", "assignments", "gates", "champion", "basePolicyHash"):
            self.assertEqual(self.book.state[key], original[key])
        self.assertEqual(self.book.active()["phases"][0]["result"]["reason"], "ORCHESTRATION_BOUNDARY")
        with self.assertRaises(ValueError):
            prepare_v8_phase(self.book, 1000001, "b" * 64, ["old"])

    def test_recohort_is_the_only_way_past_an_initialized_cohort(self):
        """Changing a runtime source changes the fingerprint, and an assignment
        enrolled under the old one stops matching. Saying so explicitly seals the
        running phase and opens a new one; it never silently continues the old."""
        prepare_v8_phase(self.book, 1000000, "b" * 64, ["old"])
        original = copy.deepcopy(self.book.state)
        # Same fingerprint is not a new cohort, and a bare retry is still refused.
        with self.assertRaises(ValueError):
            prepare_v8_phase(self.book, 1000001, "b" * 64, ["old"], recohort=True)
        with self.assertRaises(ValueError):
            prepare_v8_phase(self.book, 1000001, "c" * 64, ["old"])
        self.assertEqual(self.book.state, original)

        event = prepare_v8_phase(self.book, 1000001, "c" * 64, ["old"], recohort=True)
        self.assertTrue(event["recohort"])
        self.assertEqual(event["previousFingerprint"], "b" * 64)
        self.assertEqual(event["fingerprint"], "c" * 64)
        phases = self.book.active()["phases"]
        self.assertEqual(len(phases), 3)
        self.assertEqual(phases[1]["result"]["reason"], "V8_RECOHORT_BOUNDARY")
        self.assertIn("NO STRATEGY CONCLUSION", phases[1]["result"]["verdict"])
        self.assertEqual(phases[2]["fingerprint"], "c" * 64)
        # The first boundary and every protected record survive untouched.
        self.assertEqual(phases[0]["result"]["reason"], "ORCHESTRATION_BOUNDARY")
        for key in ("versions", "assignments", "gates", "champion", "basePolicyHash"):
            self.assertEqual(self.book.state[key], original[key])

    def test_recohort_refused_before_the_cohort_exists(self):
        with self.assertRaises(ValueError):
            prepare_v8_phase(self.book, 1000000, "b" * 64, ["old"], recohort=True)

    def test_closed_does_not_imply_v8_membership(self):
        manifest = {"fingerprint": "b"*64, "startedAt": 100, "legacyDecisionIds": ["old"]}
        current = {"id": "new", "cohortId": COHORT, "fingerprint": "b"*64, "validatedAt": 110}
        self.assertTrue(membership(current, manifest))
        for mutation in ({"id": "old"}, {"validatedAt": 90}, {"fingerprint": "c"*64}, {"cohortId": "V7"}):
            self.assertFalse(membership({**current, **mutation}, manifest))
        self.assertFalse(membership({"closedAt": 200, "net": 100}, manifest))

    def test_early_reviews_never_promote_or_tune(self):
        for n in (0, 3, 5, 6, 10, 15):
            result = fail_fast_review([{"net": 1}] * n)
            self.assertFalse(result["automaticAction"])
            self.assertNotIn("PROMOT", str(result))
        self.assertEqual(fail_fast_review([], operational_failures=["duplicate"])["recommendation"], "STOP")


class CohortRenameTests(unittest.TestCase):
    """Renaming the cohort is not a re-cohort: the previous cohort was a different name,
    so `already` is False and the plain arm path seals it and opens the new one.

    This is the transition V9 actually performs, and it is checked here because the
    dry run cannot check it: prepare_v8_phase is imported from the runtime, which still
    carries the old name until the install that precedes arming has happened.
    """

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.book = ExperimentBook(Path(self.temp.name), "a" * 64, now=lambda: 2000000)
        baseline = self.book.state["champion"]
        self.book.state["versions"]["candidate"] = {"id": "candidate", "kind": "CANDIDATE"}
        self.book.state["studies"].append({"id": "study", "status": "HOLDOUT", "candidate": "candidate",
            "control": baseline, "seed": "seed", "phases": [{"id": 0, "name": "HOLDOUT", "start": 0,
                                                             "sealedAt": None, "result": None}]})
        # The lane as it stands before V9: initialised under the PREVIOUS cohort name.
        self.book.state["decisionVersion"] = "ASTRA_HERMES_FAST_LEARNING_V8"
        self.book.state["events"].append({"type": "ORCHESTRATION_BOUNDARY", "at": 1000,
                                          "cohortId": "ASTRA_HERMES_FAST_LEARNING_V8",
                                          "fingerprint": "d" * 64, "studyId": "study",
                                          "phaseId": 0, "resumeAfterMs": 1000})

    def test_the_previous_cohort_is_sealed_and_the_new_one_opened(self):
        before = len(self.book.state["studies"][-1]["phases"])
        event = prepare_v8_phase(self.book, 2000000, "f" * 64, [])
        study = self.book.state["studies"][-1]
        self.assertEqual(len(study["phases"]), before + 1)
        self.assertIsNotNone(study["phases"][-2]["sealedAt"])          # old phase sealed
        self.assertEqual(study["phases"][-1]["cohortId"], COHORT)      # new phase tagged
        self.assertEqual(self.book.state["decisionVersion"], COHORT)
        self.assertEqual(event["cohortId"], COHORT)

    def test_the_previous_cohorts_history_is_kept_not_deleted(self):
        """Required by the spec: no lesson, trade or phase is reset."""
        prepare_v8_phase(self.book, 2000000, "f" * 64, [])
        kinds = [e.get("cohortId") for e in self.book.state["events"]
                 if e.get("type") == "ORCHESTRATION_BOUNDARY"]
        self.assertIn("ASTRA_HERMES_FAST_LEARNING_V8", kinds)
        self.assertIn(COHORT, kinds)


class SupervisorCohortMigrationTests(unittest.TestCase):
    """The supervisor refuses a state file from another fingerprint. Arming without
    migrating it left the service crash-looping on that guard, so the migration is
    part of the re-cohort now and these pin what it may and may not carry."""

    OLD, NEW = "7" * 64, "1" * 64

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "hermes-home/v8").mkdir(parents=True)
        self.path = self.root / "hermes-home/v8/supervisor.json"

    def write(self, **overrides):
        state = {"version": 8, "fingerprint": self.OLD, "jobs": {}, "pendingEvents": [],
                 "readyStates": {}, "calls": [1, 2], "lastFormationAt": 500, "seenDispatchEvents": ["e"],
                 "modelHealth": {"role": "FALLBACK", "since": 10, "primaryFailures": 0,
                                 "fallbackFailures": 0, "lastProbe": {"FALLBACK": {"available": True}},
                                 "switches": [{"at": 10, "to": "FALLBACK", "reason": "PRIMARY_UNAVAILABLE_FALLBACK_ANSWERED"}]},
                 **overrides}
        self.path.write_text(json.dumps(state))
        return state

    def migrate(self, apply_changes=True):
        return migrate_supervisor_cohort.migrate(self.root, self.NEW, apply_changes=apply_changes)

    def test_the_new_cohort_starts_with_no_scheduling_state(self):
        self.write(jobs={"j": {"finishedAt": 1}}, pendingEvents=[{"eventId": "x"}])
        self.assertEqual(self.migrate()["state"], "MIGRATED")
        state = json.loads(self.path.read_text())
        self.assertEqual(state["fingerprint"], self.NEW)
        self.assertEqual((state["jobs"], state["pendingEvents"], state["lastFormationAt"]), ({}, [], None))
        self.assertEqual(state["seenDispatchEvents"], [])

    def test_the_router_state_survives_the_cohort_change(self):
        """Dropping it reset the router to ASTRA_PRIMARY on every re-cohort, so the lane
        re-tried a quota-exhausted provider and burned a cycle on a 429 per deploy."""
        self.write(router={"routerState": "CLAUDE_FALLBACK", "routerStateChangedAt": 10,
                           "primaryModel": "gpt-6-astra",
                           "primaryFailureReason": "PROVIDER_QUOTA_EXHAUSTED",
                           "fallbackStartedAt": 10, "nextPrimaryRetryAt": 1789435433000,
                           "astraRecoveryAttempts": 3, "astraRecoverySuccesses": 0,
                           "astraRecoveredAt": None, "currentProvider": "anthropic",
                           "fallbackOpportunities": {"slot-old": {"at": 10}}})
        receipt = self.migrate()
        self.assertEqual(receipt["carriedRouterState"], "CLAUDE_FALLBACK")
        router = json.loads(self.path.read_text())["router"]
        self.assertEqual(router["routerState"], "CLAUDE_FALLBACK")
        self.assertEqual(router["primaryFailureReason"], "PROVIDER_QUOTA_EXHAUSTED")
        self.assertEqual(router["nextPrimaryRetryAt"], 1789435433000)
        self.assertEqual(router["astraRecoveryAttempts"], 3)

    def test_the_per_opportunity_fallback_ledger_is_not_carried(self):
        """Those keys are five-minute slots of the SEALED cohort; carrying them would
        deny the new cohort's slots a fallback they never used."""
        self.write(router={"routerState": "CLAUDE_FALLBACK",
                           "fallbackOpportunities": {"slot-old": {"at": 10}}})
        self.migrate()
        router = json.loads(self.path.read_text())["router"]
        self.assertNotIn("fallbackOpportunities", router)

    def test_a_lane_on_the_primary_still_migrates_cleanly(self):
        self.write(router={"routerState": "ASTRA_PRIMARY", "currentProvider": "openai-codex"})
        self.assertEqual(self.migrate()["carriedRouterState"], "ASTRA_PRIMARY")
        self.assertEqual(json.loads(self.path.read_text())["router"]["routerState"], "ASTRA_PRIMARY")

    def test_state_predating_the_router_migrates_without_inventing_one(self):
        self.write()
        self.migrate()
        self.assertNotIn("router", json.loads(self.path.read_text()))

    def test_which_provider_answers_survives_the_cohort_change(self):
        """Resetting to the primary would spend a cycle rediscovering a known outage
        and record that cycle as a failed evaluation."""
        self.write()
        self.migrate()
        health = json.loads(self.path.read_text())["modelHealth"]
        self.assertEqual(health["role"], "FALLBACK")
        self.assertEqual(len(health["switches"]), 1)

    def test_the_previous_state_is_archived_not_deleted(self):
        self.write()
        receipt = self.migrate()
        self.assertEqual(json.loads(Path(receipt["archive"]).read_text())["fingerprint"], self.OLD)

    def test_an_unfinished_job_blocks_the_migration(self):
        """Its result would otherwise land in a cohort that never dispatched it."""
        self.write(jobs={"running": {"finishedAt": None}})
        with self.assertRaises(SystemExit):
            self.migrate()
        self.assertEqual(json.loads(self.path.read_text())["fingerprint"], self.OLD)

    def coverage(self, *rows):
        import astra_v8_host as host
        book = host.CoverageBook(self.root / "hermes-home/v8/coverage.json")
        book.observe(["AUSDT", "BUSDT", "CUSDT"], {}, 1000)
        for jid, closed in rows:
            book.reserve(jid, 1, 1000)
            if closed:
                book.progress(jid, outcome="MODEL_DECISION")
        return book

    def test_a_reservation_left_by_a_dropped_job_wedges_the_lane_and_is_closed(self):
        """CoverageBook.reserve refuses while any reservation is open and only the owning
        job can close one, so dropping the job table without this wedges the lane."""
        import astra_v8_host as host
        self.write()
        self.coverage(("gone", False))
        with self.assertRaises(ValueError):  # the wedge, before the fix
            host.CoverageBook(self.root / "hermes-home/v8/coverage.json").reserve("next", 1, 2000)
        self.migrate()
        book = host.CoverageBook(self.root / "hermes-home/v8/coverage.json")
        self.assertEqual(book.state["jobs"]["gone"]["outcome"], "COHORT_MIGRATION_DISCARDED")
        book.reserve("next", 1, 2000)  # no longer wedged

    def test_a_reservation_whose_job_still_exists_is_left_alone(self):
        self.write()
        self.coverage(("owned", False))
        receipt = migrate_supervisor_cohort.reconcile_orphaned_coverage(
            self.root, ["owned"], apply_changes=True)
        self.assertEqual(receipt["state"], "NOTHING_ORPHANED")
        self.assertEqual(receipt["stillOwned"], ["owned"])

    def test_a_closed_reservation_is_never_rewritten(self):
        self.write()
        self.coverage(("done", True))
        self.assertEqual(migrate_supervisor_cohort.reconcile_orphaned_coverage(
            self.root, [], apply_changes=True)["state"], "NOTHING_ORPHANED")

    def test_the_two_ordinary_no_ops_are_not_failures(self):
        self.assertEqual(migrate_supervisor_cohort.migrate(
            self.root, self.NEW, apply_changes=True)["state"], "NO_STATE_TO_MIGRATE")
        self.write(fingerprint=self.NEW)
        self.assertEqual(self.migrate()["state"], "ALREADY_ON_COHORT")

    def test_a_dry_run_writes_nothing(self):
        self.write()
        self.assertEqual(self.migrate(apply_changes=False)["state"], "WOULD_MIGRATE")
        self.assertEqual(json.loads(self.path.read_text())["fingerprint"], self.OLD)


if __name__ == "__main__":
    unittest.main()

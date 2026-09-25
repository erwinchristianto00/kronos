"""Failover to the declared fallback policy and the return to Astra.

No network, no provider call, no order: every probe is replaced by a fake result.
The point of these tests is that a *different decision policy* can take over without
the record of who decided being lost, and without a dead fallback trapping the lane.
"""
import json
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import astra_models_v8 as models
import astra_v8_supervisor as sup
from astra_canonical_v8 import cohort_metrics
from astra_experiments import DAY, ExperimentBook, digest


def supervisor(root, **state):
    s = sup.Supervisor.__new__(sup.Supervisor)
    s.root = s.dir = Path(root)
    s.state = {"jobs": {}, **state}
    s.saved, s.started = [], []
    s.save = lambda: s.saved.append(True)
    # The decision logic is what these tests are about; launching a real probe
    # subprocess would only test subprocess.Popen.
    s.start_probe = lambda role: s.started.append(role)
    return s


def probe_answer(role, available, reason="OK"):
    return {"role": role, "available": available, "reason": reason}


class FailoverTests(unittest.TestCase):
    def stage(self, s, role, available):
        """Leave a finished probe for model_health_tick to collect, as it would live."""
        s.probe = SimpleNamespace(poll=lambda: 0, kill=lambda: None)
        s.probe_target = role
        (s.dir / "probe.json").write_text(json.dumps(probe_answer(role, available)))

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def supervisor(self, **state):
        return supervisor(self.tmp.name, **state)

    def test_primary_failure_alone_never_switches_policy(self):
        """Failing over to a policy that cannot answer would only hide the outage.

        With no Anthropic credential the fallback probe fails, and the lane keeps the
        behaviour it had before this existed: PROVIDER_UNAVAILABLE, protection intact.
        """
        s = self.supervisor()
        s.state["jobs"]["j1"] = {"id": "j1", "mode": "FAST_TRADING", "finishedAt": None}
        s.finish("j1", {"jobId": "j1", "outcome": "PROVIDER_UNAVAILABLE", "modelRole": "PRIMARY"})
        self.assertEqual(s.health()["role"], models.PRIMARY)
        self.assertEqual(s.health()["primaryFailures"], 1)
        self.stage(s, models.FALLBACK, False)
        s.model_health_tick()
        self.assertEqual(s.health()["role"], models.PRIMARY)
        self.assertEqual(s.health()["fallbackFailures"], 1)

    def test_switch_only_after_the_fallback_actually_answers(self):
        s = self.supervisor()
        s.state["jobs"]["j1"] = {"id": "j1", "mode": "FAST_TRADING", "finishedAt": None}
        s.finish("j1", {"jobId": "j1", "outcome": "PROVIDER_UNAVAILABLE", "modelRole": "PRIMARY"})
        self.stage(s, models.FALLBACK, True)
        s.model_health_tick()
        self.assertEqual(s.health()["role"], models.FALLBACK)
        self.assertEqual(s.health()["switches"][-1]["reason"], "PRIMARY_UNAVAILABLE_FALLBACK_ANSWERED")
        # Superseded by the V9 router: modelHealth still records probe health, but the
        # policy a job is frozen to comes from the router, and its fallback is HIGH.
        import astra_router_v9 as R
        s.route_result({"id": "j1", "mode": R.FAST_TRADING, "assignmentId": "slot-1",
                        "modelPolicy": R.policy(R.FAST_TRADING)},
                       {"error": "HTTP 503 service unavailable"})
        self.assertEqual(s.model_policy(R.FAST_TRADING, "slot-2")["model"], "claude-opus-5")
        self.assertEqual(s.model_policy(R.FAST_TRADING, "slot-2")["effort"], "high")

    def test_one_successful_primary_probe_returns_to_astra(self):
        s = self.supervisor(modelHealth={"role": models.FALLBACK, "since": 0, "primaryFailures": 0,
                                    "fallbackFailures": 0, "lastProbe": {}, "switches": []})
        self.stage(s, models.PRIMARY, True)
        s.model_health_tick()
        self.assertEqual(s.health()["role"], models.PRIMARY)
        self.assertEqual(s.model_policy()["model"], "gpt-6-astra")
        self.assertEqual(s.health()["switches"][-1]["reason"], "PRIMARY_PROBE_RECOVERED")

    def test_a_failing_probe_does_not_return_to_astra(self):
        s = self.supervisor(modelHealth={"role": models.FALLBACK, "since": 0, "primaryFailures": 0,
                                    "fallbackFailures": 0, "lastProbe": {}, "switches": []})
        self.stage(s, models.PRIMARY, False)
        s.model_health_tick()
        self.assertEqual(s.health()["role"], models.FALLBACK)
        self.assertEqual(s.health()["lastProbe"][models.PRIMARY]["available"], False)

    def test_never_switches_while_a_worker_is_still_running(self):
        """A running session holds its own frozen policy; relabelling it mid-flight
        would attribute its decisions to a model that never saw them."""
        s = self.supervisor()
        s.state["jobs"]["running"] = {"id": "running", "mode": "FAST_TRADING", "finishedAt": None}
        s.health()["primaryFailures"] = 1
        self.stage(s, models.FALLBACK, True)
        s.model_health_tick()
        self.assertEqual(s.health()["role"], models.PRIMARY)
        s.state["jobs"]["running"]["finishedAt"] = 1
        self.stage(s, models.FALLBACK, True)
        s.model_health_tick()
        self.assertEqual(s.health()["role"], models.FALLBACK)

    def health_with(self, primary_probe):
        return {"role": models.FALLBACK, "since": 0, "primaryFailures": 0, "fallbackFailures": 0,
                "lastProbe": ({models.PRIMARY: primary_probe} if primary_probe else {}), "switches": []}

    def fail_a_fallback_job(self, s, jid="j2"):
        s.state["jobs"][jid] = {"id": jid, "mode": "FAST_TRADING", "finishedAt": None}
        s.finish(jid, {"jobId": jid, "outcome": "PROVIDER_UNAVAILABLE", "modelRole": "FALLBACK"})

    def test_a_fallback_that_also_fails_returns_to_a_primary_known_to_answer(self):
        s = self.supervisor(modelHealth=self.health_with(
            {"role": models.PRIMARY, "available": True, "at": sup.now()}))
        self.fail_a_fallback_job(s)
        self.assertEqual(s.health()["role"], models.PRIMARY)
        self.assertEqual(s.health()["switches"][-1]["reason"], "FALLBACK_ALSO_UNAVAILABLE")

    def test_it_does_not_bounce_to_a_primary_whose_own_probe_failed(self):
        """The lane spent 2h38m on a quota-dead primary this way. Both providers failing
        is not a reason to move to the one with no evidence it answers."""
        s = self.supervisor(modelHealth=self.health_with(
            {"role": models.PRIMARY, "available": False, "reason": "PROBE_INCOMPLETE", "at": sup.now()}))
        self.fail_a_fallback_job(s)
        self.assertEqual(s.health()["role"], models.FALLBACK)
        self.assertEqual(s.health()["switches"], [])
        self.assertEqual(s.health()["fallbackFailures"], 1)  # the outage stays visible

    def test_a_primary_probe_older_than_its_ttl_is_not_evidence(self):
        """PROBE_TTL_MS existed as a constant and was never applied to anything."""
        stale = sup.now() - models.PROBE_TTL_MS - 1
        s = self.supervisor(modelHealth=self.health_with(
            {"role": models.PRIMARY, "available": True, "at": stale}))
        self.fail_a_fallback_job(s)
        self.assertEqual(s.health()["role"], models.FALLBACK)

    def test_never_having_probed_the_primary_is_not_evidence_either(self):
        s = self.supervisor(modelHealth=self.health_with(None))
        self.fail_a_fallback_job(s)
        self.assertEqual(s.health()["role"], models.FALLBACK)

    def test_holding_on_the_fallback_still_returns_once_the_primary_recovers(self):
        """Holding must not become trapping: the primary is still probed from FALLBACK."""
        s = self.supervisor(modelHealth=self.health_with(
            {"role": models.PRIMARY, "available": False, "at": sup.now()}))
        self.fail_a_fallback_job(s)
        self.assertEqual(s.health()["role"], models.FALLBACK)
        self.stage(s, models.PRIMARY, True)
        s.model_health_tick()
        self.assertEqual(s.health()["role"], models.PRIMARY)
        self.assertEqual(s.health()["switches"][-1]["reason"], "PRIMARY_PROBE_RECOVERED")

    def test_model_behaviour_is_not_a_provider_outage(self):
        """Another model would not fix a spent turn budget or an invalid response."""
        s = self.supervisor()
        for outcome in ("TURN_BUDGET_EXHAUSTED", "INVALID_MODEL_RESPONSE", "MODEL_INCOMPLETE"):
            s.state["jobs"][outcome] = {"id": outcome, "mode": "FAST_TRADING", "finishedAt": None}
            s.finish(outcome, {"jobId": outcome, "outcome": outcome, "modelRole": "PRIMARY"})
        self.assertEqual(s.health()["primaryFailures"], 0)
        self.assertEqual(s.health()["role"], models.PRIMARY)

    def test_a_noisy_probe_file_is_still_read_correctly(self):
        """The agent prints retry warnings to the same stream as the result.

        Reading the file as a whole would turn a real recovery into PROBE_NO_RESULT
        and leave the lane on the fallback after the primary came back.
        """
        s = self.supervisor(modelHealth={"role": models.FALLBACK, "since": 0, "primaryFailures": 0,
                                         "fallbackFailures": 0, "lastProbe": {}, "switches": []})
        s.probe = SimpleNamespace(poll=lambda: 0, kill=lambda: None)
        s.probe_target = models.PRIMARY
        (s.dir / "probe.json").write_text(
            "\u26a0\ufe0f  API call failed (attempt 1/3): RateLimitError\n"
            "   Details: {'type': 'usage_limit_reached'}\n"
            + json.dumps(probe_answer(models.PRIMARY, True)) + "\n")
        s.model_health_tick()
        self.assertEqual(s.health()["role"], models.PRIMARY)
        self.assertEqual(s.health()["lastProbe"][models.PRIMARY]["available"], True)

    def test_an_unparseable_probe_file_is_unavailable_not_a_crash(self):
        s = self.supervisor(modelHealth={"role": models.FALLBACK, "since": 0, "primaryFailures": 0,
                                         "fallbackFailures": 0, "lastProbe": {}, "switches": []})
        s.probe = SimpleNamespace(poll=lambda: 0, kill=lambda: None)
        s.probe_target = models.PRIMARY
        (s.dir / "probe.json").write_text("traceback only, no result\n")
        s.model_health_tick()
        self.assertEqual(s.health()["role"], models.FALLBACK)
        self.assertEqual(s.health()["lastProbe"][models.PRIMARY]["reason"], "PROBE_NO_RESULT")

    def test_a_running_probe_never_delays_the_host_position_poll(self):
        s = self.supervisor(events=sup.new_event_state(), pendingEvents=[], lastManagedAt={})
        s.probe = SimpleNamespace(poll=lambda: None, kill=lambda: None)   # still running
        s.probe_target = models.PRIMARY
        s.health()["probeStartedAt"] = sup.now()
        s.manifest = {"gatewayExecutionVersion": "gw", "fingerprint": "f"}
        s.market_rows = {}
        s.config = {}
        s.processes = {}
        s.common_hash = "common"
        status = {"active": [], "laneId": "ASTRA_HERMES_TESTNET", "environment": "testnet",
                  "executionVersion": "gw"}
        with patch.object(sup.engine, "gateway", return_value=status), \
             patch.object(sup.engine, "validate_capital_identity", return_value=None), \
             patch.object(sup, "report", return_value={"open": []}), \
             patch.object(sup.Supervisor, "coach_if_due", lambda self: None), \
             patch.object(sup.Supervisor, "reap", lambda self: None), \
             patch.object(sup, "ExperimentBook", side_effect=AssertionError("poll must happen first")):
            with self.assertRaises(AssertionError):
                s.tick()
        self.assertIsNotNone(s.state.get("lastPollAt"))
        self.assertIsNotNone(s.probe)  # collection is polled, never waited on


class ArmIsolationTests(unittest.TestCase):
    """phase_data reads assignments directly, so a literal study/phase pair is enough
    and avoids depending on the proposal flow that is tested elsewhere."""

    STUDY = {"id": "study-1", "candidate": "cand-1", "control": "ctrl-1"}
    PHASE = {"id": "phase-1", "name": "HOLDOUT", "start": 0, "sealedAt": None}

    def book(self, *assignments):
        """Each assignment is (id, modelRole) or (id, modelRole, arm, dayOffset)."""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        book = ExperimentBook(Path(tmp.name), digest({"base": "system", "common": "rules"}))
        book.state["submissions"] = {}
        for entry in assignments:
            ident, role = entry[0], entry[1]
            arm = entry[2] if len(entry) > 2 else "CONTROL"
            at = book.now() - DAY * (entry[3] if len(entry) > 3 else 0)
            row = {"id": ident, "at": at, "version": self.STUDY["control"], "arm": arm,
                   "studyId": self.STUDY["id"], "phaseId": self.PHASE["id"], "completed": True,
                   "outcome": "MODEL_DECISION"}
            if role is not None:
                row["modelRole"] = role
            book.state["assignments"][ident] = row
        return book

    def test_fallback_and_mixed_cycles_count_in_the_arm_comparison(self):
        """The operator asked for evidence to keep accruing while the lane runs on the
        declared fallback, so no enrolled cycle is dropped for the policy that made it."""
        book = self.book(("1", "PRIMARY"), ("2", "PRIMARY"), ("3", "FALLBACK"), ("4", "MIXED"))
        data = book.phase_data(self.STUDY, self.PHASE)
        self.assertEqual({a["id"] for a in data["assignments"]}, {"1", "2", "3", "4"})
        self.assertEqual(data["scoredAssignments"], 4)
        self.assertNotIn("heldOutNonPrimaryAssignments", data)

    def test_the_arm_composition_names_every_policy_that_produced_it(self):
        """Counting a fallback cycle is only honest if the verdict can still say so."""
        book = self.book(("1", "PRIMARY"), ("2", "FALLBACK"), ("3", "FALLBACK", "CANDIDATE"))
        data = book.phase_data(self.STUDY, self.PHASE)
        self.assertEqual(data["modelComposition"],
                         {"CONTROL": {"FALLBACK": 1, "PRIMARY": 1}, "CANDIDATE": {"FALLBACK": 1, "PRIMARY": 0}})

    def test_an_untagged_historical_assignment_still_counts_as_primary(self):
        book = self.book(("old", None))
        data = book.phase_data(self.STUDY, self.PHASE)
        self.assertEqual({a["id"] for a in data["assignments"]}, {"old"})
        self.assertEqual(data["modelComposition"]["CONTROL"], {"PRIMARY": 1})

    def dispatched_book(self, *entries):
        """(id, arm, dispatched) — outcome is set so completion() stays meaningful."""
        book = self.book()
        book.state["assignments"] = {}
        for ident, arm, ran in entries:
            book.state["assignments"][ident] = {
                "id": ident, "at": book.now(), "version": self.STUDY["control"], "arm": arm,
                "studyId": self.STUDY["id"], "phaseId": self.PHASE["id"], "modelRole": "PRIMARY",
                "dispatched": ran, "completed": ran,
                "outcome": "MODEL_DECISION" if ran else "SCREENED_NO_TRADE"}
        return book

    def test_per_cycle_figures_divide_by_dispatched_slots_not_enrolled_ones(self):
        """Dividing by every enrolled slot measured how often the host dispatches."""
        book = self.dispatched_book(("1", "CONTROL", True), ("2", "CONTROL", False),
                                    ("3", "CONTROL", False), ("4", "CANDIDATE", True))
        data = book.phase_data(self.STUDY, self.PHASE)
        self.assertEqual(data["arms"]["CONTROL"]["cycles"], 1)
        self.assertEqual(data["arms"]["CONTROL"]["assignedCycles"], 3)

    def test_a_screened_slot_never_counts_as_a_dispatched_one(self):
        book = self.dispatched_book(("1", "CONTROL", False), ("2", "CANDIDATE", False))
        data = book.phase_data(self.STUDY, self.PHASE)
        self.assertEqual(data["arms"]["CONTROL"]["cycles"], 0)
        self.assertEqual(data["arms"]["CANDIDATE"]["cycles"], 0)

    def test_a_crashed_job_stays_in_the_denominator(self):
        """Dispatched and lost is still a cycle the strategy was given."""
        book = self.dispatched_book(("1", "CONTROL", True))
        book.state["assignments"]["1"].update(outcome=None, completed=False)
        self.assertEqual(book.phase_data(self.STUDY, self.PHASE)["arms"]["CONTROL"]["cycles"], 1)

    def test_an_outcome_only_a_worker_can_record_counts_without_the_flag(self):
        """Slots enrolled before the flag existed must not silently leave the denominator."""
        book = self.dispatched_book(("1", "CONTROL", True))
        del book.state["assignments"]["1"]["dispatched"]
        self.assertEqual(book.phase_data(self.STUDY, self.PHASE)["arms"]["CONTROL"]["cycles"], 1)

    def test_unequal_dispatch_between_arms_is_reported_not_hidden(self):
        """The hazard of this denominator: the arm that dispatches less looks better."""
        book = self.dispatched_book(("1", "CONTROL", True), ("2", "CONTROL", True),
                                    ("3", "CANDIDATE", True), ("4", "CANDIDATE", False),
                                    ("5", "CANDIDATE", False), ("6", "CANDIDATE", False))
        data = book.phase_data(self.STUDY, self.PHASE)
        self.assertEqual(data["dispatchRateByArm"], {"CONTROL": 1.0, "CANDIDATE": 0.25})
        self.assertEqual(data["dispatchRateRatio"], 4.0)

    def test_a_day_both_arms_saw_the_same_policy_is_not_counted_as_skewed(self):
        """A lane-global switch lands on both arms, which is why pairing survives it."""
        book = self.book(("c", "FALLBACK", "CONTROL", 1), ("k", "FALLBACK", "CANDIDATE", 1))
        data = book.phase_data(self.STUDY, self.PHASE)
        self.assertEqual(len(data["pairedDays"]), 1)
        self.assertEqual(data["modelSkewedPairedDays"], 0)

    def test_a_day_whose_arms_saw_different_policies_is_counted_as_skewed(self):
        """The one case pairing cannot absorb: the delta is then partly a model delta."""
        book = self.book(("c", "PRIMARY", "CONTROL", 1), ("k", "FALLBACK", "CANDIDATE", 1))
        data = book.phase_data(self.STUDY, self.PHASE)
        self.assertEqual(len(data["pairedDays"]), 1)
        self.assertEqual(data["modelSkewedPairedDays"], 1)


class MergedCohortTests(unittest.TestCase):
    TAGS = {"cohort": "ASTRA_HERMES_FAST_LEARNING_V8", "fingerprint": "f",
            "executionPolicyVersion": "gw", "tradePolicyVersion": "v", "decisionVersion": "d"}

    def row(self, ident, role, net, **extra):
        return {**self.TAGS, "modelRole": role, "evidenceId": ident, "decisionId": "d" + ident,
                "kind": "TRADE", "eligible": True, "outcome": "SETTLED", "net": net,
                "executedQty": 1, "adverseDisplacementBps": 10, **extra}

    def test_one_cohort_still_reports_each_policy_separately(self):
        """The operator chose a single cohort; the merged number is what they asked
        for, and the split is what keeps it interpretable."""
        rows = [self.row("a", "PRIMARY", 1.0), self.row("b", "PRIMARY", -0.5),
                self.row("c", "FALLBACK", -2.0)]
        groups = cohort_metrics(rows)
        self.assertEqual(len(groups), 1, "operator chose one cohort for both policies")
        group = groups[0]
        self.assertAlmostEqual(group["netPnl"], -1.5)
        self.assertEqual(group["closedTradesN"], 3)
        self.assertAlmostEqual(group["byModel"]["PRIMARY"]["netPnl"], 0.5)
        self.assertEqual(group["byModel"]["PRIMARY"]["closedTradesN"], 2)
        self.assertAlmostEqual(group["byModel"]["FALLBACK"]["netPnl"], -2.0)
        self.assertEqual(group["byModel"]["FALLBACK"]["closedTradesN"], 1)

    def test_latency_is_attributed_to_the_policy_that_spent_it(self):
        rows = [self.row("a", "PRIMARY", 1.0)]
        stamps = [{**self.TAGS, "modelRole": "PRIMARY", "decisionId": "da", "modelDecisionLatency": 200000},
                  {**self.TAGS, "modelRole": "FALLBACK", "decisionId": "dc", "modelDecisionLatency": 60000}]
        group = cohort_metrics(rows, latency=stamps)[0]
        self.assertEqual(group["byModel"]["PRIMARY"]["modelDecisionLatencyMsMedian"], 200000)
        self.assertEqual(group["byModel"]["FALLBACK"]["modelDecisionLatencyMsMedian"], 60000)


class PolicyDeclarationTests(unittest.TestCase):
    def test_exactly_two_policies_exist_and_neither_can_be_invented(self):
        self.assertEqual(sorted(models.POLICIES), ["FALLBACK", "PRIMARY"])
        self.assertEqual(models.policy(models.PRIMARY),
                         {"role": "PRIMARY", "model": "gpt-6-astra", "provider": "openai-codex", "effort": "high"})
        self.assertEqual(models.policy(models.FALLBACK),
                         {"role": "FALLBACK", "model": "claude-opus-5", "provider": "anthropic", "effort": "max"})
        with self.assertRaises(ValueError):
            models.policy("SHADOW")
        self.assertEqual(models.identity(models.policy(models.FALLBACK))["reasoningEffort"], "max")

    def test_a_probe_that_cannot_run_is_an_answer_not_a_crash(self):
        result = models.probe(models.PRIMARY, root=Path(tempfile.gettempdir()), timeout=30)
        self.assertFalse(result["available"])
        self.assertIn("reason", result)


class MutationGuardTests(unittest.TestCase):
    """Removing a failover guard has to turn its own test red, not just look tidy."""

    MUTANTS = (
        ("fallback_must_answer", "                if available:\n", "                if True:\n",
         "FailoverTests", "test_primary_failure_alone_never_switches_policy"),
        ("no_switch_mid_session",
         "        if any(not j.get(\"finishedAt\") for j in self.state[\"jobs\"].values()):\n            return False\n",
         "        if False:\n            return False\n",
         "FailoverTests", "test_never_switches_while_a_worker_is_still_running"),
        ("primary_must_be_known_good", "                if self.primary_answers():\n",
         "                if True:\n",
         "FailoverTests", "test_it_does_not_bounce_to_a_primary_whose_own_probe_failed"),
        ("probe_ttl_is_enforced",
         "return bool(probe.get(\"available\")) and now() - probe.get(\"at\", 0) <= MODELS.PROBE_TTL_MS",
         "return bool(probe.get(\"available\"))",
         "FailoverTests", "test_a_primary_probe_older_than_its_ttl_is_not_evidence"),
        ("provider_outage_only",
         'PROVIDER_FAILURE_OUTCOMES = ("PROVIDER_UNAVAILABLE",)',
         'PROVIDER_FAILURE_OUTCOMES = ("PROVIDER_UNAVAILABLE", "TURN_BUDGET_EXHAUSTED", "MODEL_INCOMPLETE", "INVALID_MODEL_RESPONSE")',
         "FailoverTests", "test_model_behaviour_is_not_a_provider_outage"),
    )

    def test_removing_a_failover_guard_turns_its_test_red(self):
        source = Path(__file__).with_name("astra_v8_supervisor.py").read_text()
        for name, old, new, case_name, method in self.MUTANTS:
            with self.subTest(mutant=name):
                self.assertIn(old, source, name + " no longer matches the module source")
                mutated = types.ModuleType("supervisor_mutant_" + name)
                # The module resolves ROOT from __file__ at import time.
                mutated.__dict__["__file__"] = str(Path(__file__).with_name("astra_v8_supervisor.py"))
                exec(compile(source.replace(old, new, 1), "<in-memory-mutant>", "exec"), mutated.__dict__)
                result = unittest.TestResult()
                with patch.dict(globals(), {"sup": mutated}):
                    globals()[case_name](method).run(result)
                self.assertGreater(len(result.failures), 0, name + " escaped behavioral assertions")
                self.assertEqual(len(result.errors), 0, name + " only crashed instead of testing behavior")


if __name__ == "__main__":
    unittest.main()

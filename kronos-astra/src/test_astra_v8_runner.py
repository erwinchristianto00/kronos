"""Hermetic orchestration tests. Every gateway is mocked; no exchange orders."""
import copy
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import astra_runner as engine
import astra_fast_v8 as fast
import astra_v8_runner as runner
from astra_canonical_v8 import AXES, CanonicalBook


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.at = runner.now_ms()
        self.status = {"environment": "testnet", "laneId": "ASTRA_HERMES_TESTNET",
                       "executionVersion": engine.HOST_REVISION, "entryBlock": None, "lastError": None,
                       "active": [], "wallet": {"fresh": True, "snapshot": {"availableBalance": 1000}},
                       "capital": {"mode": "BINANCE_TESTNET_WALLET", "maxEntryNotionalUsd": 25,
                                   "maxOpenPositions": None, "totalLaneAllocationUsd": None},
                       "leverage": 1, "dailyLossCap": None}
        self.row = {"symbol": "DOGEUSDT", "observedAt": self.at, "filters": {"minNotional": 5},
                    "book": {"bid": 10, "ask": 10.001, "time": self.at},
                    "candles": [{"closeTime": self.at - 1000, "close": 10}],
                    "economics": {"commission": {"status": "AVAILABLE", "takerRate": .0005},
                                  "funding": {"status": "INDICATIVE", "nextFundingTime": self.at + 3600000,
                                              "nextSettlementCostBpsIfRateUnchanged": {"LONG": 1, "SHORT": -1}}}}
        self.raw = {"source": "BINANCE_USDM_TESTNET", "status": self.status, "rows": [self.row], "unavailableSymbols": []}
        self.plan = {"id": "frozen_plan_001", "symbol": "DOGEUSDT", "side": "LONG", "thesis": "Closed breakout remains accepted",
                     "triggerKind": "CLOSE_ABOVE", "triggerPrice": 10, "entryMin": 9.99, "entryMax": 10.02,
                     "stopPrice": 9.8, "targetPrice": 10.3, "notionalUsd": 6, "maxHoldMs": 600000,
                     "expiresAt": self.at + 1800000, "maxSpreadBps": 5, "maxCostBps": 30,
                     "entrySlippageBps": 5, "exitSlippageBps": 5, "fundingAllowanceBps": 2}
        p = patch.multiple(engine, ROOT=self.root, PLAN_BOOK=None, LEARNING_BOOK=None,
                           EXPERIMENT_BOOK=None, EXPERIMENT_REQUIRED=False)
        p.start()
        self.addCleanup(p.stop)
        p = patch.object(engine, "execution_config", return_value={})
        p.start()
        self.addCleanup(p.stop)
        p = patch.object(engine, "gateway", side_effect=self.gateway)
        self.gateway_mock = p.start()
        self.addCleanup(p.stop)
        p = patch.object(runner, "verify_manifest", return_value=None)
        self.manifest_mock = p.start()
        self.addCleanup(p.stop)
        p = patch.object(runner, "verify_v8_phase", return_value=True)
        self.phase_mock = p.start()
        self.addCleanup(p.stop)
        self.experiment = engine.ExperimentBook(self.root, engine.digest({"base": engine.SYSTEM, "common": engine.EXPERIMENT_RULES}))
        self.assignment = self.experiment.start_cycle()
        self.requests, self.observed, self.prompts, self.sessions = [], [], [], []
        self.gateway_response = {"status": "WAIT_RECORDED"}
        self.views = []

    def gateway(self, path, payload=None):
        if path == "/status":
            return copy.deepcopy(self.status)
        if path == "/context":
            return copy.deepcopy(self.raw)
        self.assertEqual(path, "/decision", "Worker may not fetch legacy journals")
        self.requests.append(copy.deepcopy(payload))
        records = runner.Journal(self.root, runner.FAST_TRADING).records
        self.assertTrue(any(r["kind"] == "DECISION_INTENT" and r["decisionId"] == payload["id"] for r in records))
        self.assertTrue(any(r["kind"] == "REQUEST" and r["request"] == payload for r in records))
        return copy.deepcopy(self.gateway_response)

    def job(self, **changes):
        context = fast.build_fast_context(self.views, self.status["active"], {"DOGEUSDT": self.row},
                    now_ms=self.at, policy_versions={"executionPolicyVersion": runner.COHORT,
                    "tradePolicyVersion": "unchanged-policy", "decisionVersion": "V8"})
        return {"id": "host-job-001", "mode": runner.FAST_TRADING, "cohortId": runner.COHORT,
                "fingerprint": "test-fingerprint", "eventDetectedAt": self.at - 50,
                "contextBuiltAt": self.at, "events": [{"id": "event-001"}],
                "context": context, "rawContext": copy.deepcopy(self.raw),
                "assignmentId": self.assignment["id"], **changes}

    def own(self, ident="owned-001"):
        self.status["active"].append({"id": ident, "symbol": "DOGEUSDT", "side": "LONG", "state": "OPEN",
                                     "qty": 1, "entryPrice": 10, "stopPrice": 9.8, "targetPrice": 10.3,
                                     "maxHoldMs": 600000, "createdAt": self.at - 10000, "stopId": "protected"})

    def freeze(self):
        book = engine.PlanBook(self.root)
        book.observe(self.raw)
        self.views = [book.create(self.plan)]
        self.experiment.bind_plan(book.get(self.plan["id"]))

    def action(self, action="NO_TRADE", **kwargs):
        return {"id": "decision-001", "action": action, "reason": "Explicit bounded evidence decision", **kwargs}

    def factory(self, actions=(), *, final=None, raises=None, callback=None):
        def create(**kwargs):
            self.prompts.append(kwargs["system_prompt"])
            self.sessions.append(kwargs["session"])
            self.assertEqual(kwargs["max_turns"], 12)
            self.assertEqual(kwargs["budget_seconds"], 240)
            def run(prompt):
                if callback:
                    callback(kwargs["session"])
                for name, args in actions:
                    self.observed.append(json.loads(kwargs["session"].call(name, args)))
                if raises:
                    raise raises
                return final or {"completed": True, "api_calls": 2, "final_response": "done"}
            return SimpleNamespace(run_conversation=run, close=lambda: None)
        return create

    def run_worker(self, actions=(), **kwargs):
        return runner.run_job(self.root, kwargs.pop("job", self.job()), engine=engine,
                              agent_factory=self.factory(actions, **kwargs))

    def test_context_is_host_bounded_and_does_not_fetch_again(self):
        result = self.run_worker([("astra_context", {"symbols": []}), ("astra_decide", self.action())])
        self.assertTrue(result["completed"])
        self.assertEqual([c.args[0] for c in self.gateway_mock.call_args_list], ["/decision"])
        self.assertNotIn("rawContext", self.prompts[0])
        self.assertNotIn("Scan the entire overview", self.prompts[0])
        self.assertNotIn("astra_learn REVIEW once", self.prompts[0])
        self.assertNotIn("use astra_experiment PROPOSE", self.prompts[0])

    def test_candidate_report_persisted_but_never_forwarded_to_gateway(self):
        from test_candidate_disposition import watch
        job=self.job()
        job['context']['marketCandidates']=[{'opportunityId':'candidate-a','symbol':'DOGEUSDT','book':self.row['book']}]
        row={**watch(self.at),'symbol':'DOGEUSDT'}
        args=self.action(assessedOpportunityIds=['candidate-a'],candidateAssessments=[row])
        result=self.run_worker([('astra_decide',args)],job=job)
        self.assertTrue(result['completed'])
        self.assertEqual(result['candidateReports'][0]['candidates'][0]['candidateDisposition'],'WATCH')
        self.assertEqual(result['candidateReports'][0]['decisionExecutionOutcome'],'NO_NEW_POSITION')
        self.assertEqual(self.observed[0]['candidateReport']['reportingStatus'],'COMPLETE')
        self.assertEqual(len(self.requests),1)
        self.assertNotIn('candidateAssessments',self.requests[0])
        self.assertEqual(self.requests[0]['action'],'WAIT')
        self.assertIn('CANDIDATE CLASSIFICATION',self.prompts[0])

    def test_missing_candidate_report_does_not_create_execution_blocker(self):
        job=self.job();job['context']['marketCandidates']=[{'opportunityId':'candidate-a','symbol':'DOGEUSDT','book':self.row['book']}]
        result=self.run_worker([('astra_decide',self.action(assessedOpportunityIds=['candidate-a']))],job=job)
        self.assertTrue(result['completed'])
        self.assertEqual(result['candidateReports'][0]['reportingStatus'],'INCOMPLETE')
        self.assertEqual(self.observed[0]['candidateReport']['reportingStatus'],'INCOMPLETE')
    def test_price_lte_feedback_and_idempotent_retry_do_not_duplicate_gateway_call(self):
        from test_candidate_disposition import watch
        job=self.job();job['context']['marketCandidates']=[{'opportunityId':'candidate-a','symbol':'DOGEUSDT','book':self.row['book']}]
        row={**watch(self.at),'symbol':'DOGEUSDT'}
        row['revisitCondition'].update(operator='LTE',value=0.005082)
        row['revisitCondition'].pop('upperValue')
        args=self.action(assessedOpportunityIds=['candidate-a'],candidateAssessments=[row])
        self.run_worker([('astra_decide',args),('astra_decide',args)],job=job)
        self.assertEqual(len(self.requests),1)
        self.assertEqual(self.observed[0]['candidateReport'],self.observed[1]['candidateReport'])
        self.assertEqual(self.observed[1]['candidateReport']['reportingStatus'],'COMPLETE')

    def test_full_journal_or_nested_memory_rejected_before_model(self):
        for key in ("fullJournal", "overview", "learningFeedback", "memory"):
            job = self.job()
            job["context"]["nested"] = {key: ["OLD_LESSON"]}
            with self.assertRaises(runner.IntegrationError):
                self.run_worker(job=job)
        self.assertEqual(self.prompts, [])
        self.gateway_mock.assert_not_called()

    def test_fast_review_publish_experiment_propose_memory_fetch_denied(self):
        operations = [("astra_learn", {"operation": op}) for op in ("REVIEW", "PUBLISH", "APPLY")]
        operations += [("memory", {"action": "add", "content": "obsolete rule"}),
                       ("astra_experiment", {"operation": "PROPOSE"}),
                       ("astra_context", {"symbols": ["DOGEUSDT"]})]
        self.run_worker(operations)
        self.assertTrue(all("error" in row for row in self.observed))
        self.gateway_mock.assert_not_called()
        self.assertFalse((self.root / "hermes-home/astra-learning.json").exists())

    def test_no_position_action_cannot_be_completed_model_decision(self):
        self.own()
        result = self.run_worker()
        self.assertFalse(result["completed"])
        self.assertEqual(result["missingPositionIds"], ["owned-001"])
        self.assertEqual(result["outcome"], "INVALID_MODEL_RESPONSE")

    def test_partial_coverage_refuses_entry_and_preserves_missing_position(self):
        self.own()
        self.own("owned-002")
        result = self.run_worker([("astra_decide", self.action("HOLD", positionId="owned-001")),
                                  ("astra_decide", self.action("NO_TRADE", id="decision-002"))])
        self.assertFalse(result["completed"])
        self.assertIn("error", self.observed[1])
        self.assertEqual(len(self.requests), 1)

    def test_hold_with_missing_data_is_explicit_hold(self):
        self.own()
        result = self.run_worker([("astra_decide", self.action("HOLD_WITH_REASON", positionId="owned-001",
                                                              missingDataReason="Current quote unavailable"))])
        self.assertTrue(result["completed"])
        self.assertEqual(result["actions"][0]["action"], "HOLD")
        self.assertIn("MISSING_DATA", self.requests[0]["reason"])
        self.assertEqual(self.requests[0]["tradeId"], "owned-001")

    def test_raw_gateway_actions_reduce_amend_and_wrong_side_are_denied(self):
        self.own()
        for action in ("OPEN", "CLOSE", "WAIT", "REDUCE", "AMEND_STOP"):
            self.run_worker([("astra_decide", self.action(action, positionId="owned-001"))],
                            job=self.job(id=action, events=[{"id": action}]))
            self.assertIn("error", self.observed[-1])
        self.assertEqual(self.requests, [])

    def test_changed_owned_quantity_rejects_management_before_gateway_request(self):
        self.own()
        job = self.job()
        self.status["active"][0]["qty"] = 2
        result = self.run_worker([("astra_decide", self.action("CUT_LOSS", positionId="owned-001"))], job=job)
        self.assertFalse(result["completed"])
        self.assertEqual(result["actions"][0]["outcome"], "REJECTED_BY_POLICY")
        self.assertIn("STALE_ACTION", result["actions"][0]["result"]["errorDetail"])
        self.assertEqual(self.requests, [])

    def test_missing_or_mutated_stop_rejects_stale_management(self):
        self.own()
        job = self.job()
        self.status["active"][0]["stopId"] = None
        self.run_worker([("astra_decide", self.action("HOLD", positionId="owned-001"))], job=job)
        self.assertEqual(self.requests, [])

    def test_provider_and_budget_failure_never_become_hold(self):
        result = self.run_worker(raises=TimeoutError("provider timeout"))
        self.assertEqual(result["outcome"], "PROVIDER_UNAVAILABLE")
        self.assertIsNone(result["apiCalls"])
        self.assertEqual(result["actions"], [])
        result = self.run_worker(job=self.job(id="job-two", events=[{"id": "event-two"}]),
                                 final={"completed": False, "api_calls": 12})
        self.assertEqual(result["outcome"], "TURN_BUDGET_EXHAUSTED")
        self.assertEqual(self.requests, [])

    def test_late_model_failure_does_not_erase_actual_hold(self):
        self.own()
        result = self.run_worker([("astra_decide", self.action("HOLD", positionId="owned-001"))],
                                 raises=TimeoutError("provider final timeout"))
        self.assertFalse(result["completed"])
        self.assertTrue(result["actions"][0]["validAction"])
        self.assertEqual(result["outcome"], "PROVIDER_UNAVAILABLE")
        self.assertIsNone(result["validationLatency"])
        self.assertEqual(result["missingPositionIds"], [])

    def test_duplicate_job_and_same_event_new_job_do_not_call_model(self):
        self.run_worker([("astra_decide", self.action())])
        duplicate = self.run_worker()
        renamed = self.run_worker(job=self.job(id="renamed-job"))
        self.assertEqual(duplicate["outcome"], "SKIPPED_UNCHANGED")
        self.assertFalse(renamed["modelCalled"])
        self.assertEqual(len(self.prompts), 1)
        self.assertEqual(len(self.requests), 1)

    def test_changed_job_payload_fails_before_replay(self):
        self.run_worker([("astra_decide", self.action())])
        changed = self.job()
        changed["context"]["extra"] = "mutated"
        with self.assertRaisesRegex(runner.IntegrationError, "reused"):
            self.run_worker(job=changed)
        self.assertEqual(len(self.requests), 1)

    def test_uncertain_request_retries_exact_original_on_restart(self):
        self.gateway_response = {"status": "REJECTED_OR_UNRESOLVED"}
        first = self.run_worker([("astra_decide", self.action())])
        self.assertEqual(first["actions"][0]["outcome"], "UNRESOLVED_RECONCILE")
        self.gateway_response = {"status": "WAIT_RECORDED"}
        self.run_worker()
        self.assertEqual(self.requests[0], self.requests[1])
        self.assertEqual(len(self.prompts), 1)

    def test_mutated_decision_id_cannot_replace_original_request(self):
        self.run_worker([("astra_decide", self.action()),
                         ("astra_decide", self.action(reason="Different retrospective reason"))])
        self.assertIn("error", self.observed[1])
        self.assertEqual(len(self.requests), 1)

    def test_fused_entry_uses_incumbent_fresh_contract_and_frozen_plan(self):
        self.gateway_response = {"id": "trade-1", "state": "OPEN", "qty": .6, "entryQty": .6,
                                  "entryPrice": 10.001, "error": None,
                                  "entry": {"attemptedAt": self.at + 1, "order": {"orderId": 42}},
                                  "fills": [{"orderId": 42, "time": self.at + 2, "qty": .6}]}
        result = self.run_worker([("astra_enter", self.action("ENTER_LONG", plan=self.plan))])
        self.assertTrue(result["completed"], self.observed)
        self.assertEqual(self.requests[0]["action"], "OPEN")
        self.assertEqual(self.requests[0]["entryContract"]["triggerPrice"], self.plan["triggerPrice"])
        self.assertEqual(self.requests[0]["entryContract"]["entryMax"], self.plan["entryMax"])
        self.assertEqual(result["orderSubmittedAt"], self.at + 1)
        self.assertEqual(result["orderFilledAt"], self.at + 2)
        self.assertTrue(self.manifest_mock.called)
        self.assertEqual([c.args[0] for c in self.gateway_mock.call_args_list], ["/context", "/decision"])

    def test_entry_action_side_disagreement_never_submits(self):
        self.run_worker([("astra_enter", self.action("ENTER_SHORT", plan=self.plan))])
        self.assertEqual(self.requests, [])

    def test_fused_entry_refreshes_aged_host_row_before_freeze(self):
        def age(session):
            engine.PLAN_BOOK.rows['DOGEUSDT']['observedAt']=runner.now_ms()-121000
        with patch.object(runner, 'now_ms', return_value=self.at):
            def refresh(gateway,symbols,**kwargs):
                self.assertTrue(kwargs.get('metadata_only'))
                return copy.deepcopy(self.raw)
            with patch('astra_v8_host.fetch_histories',side_effect=refresh) as read, \
                 patch('quant_candidate_refresh.refresh_candidates', side_effect=lambda x: {**x,'marketDataComplete':True}):
                result=self.run_worker([('astra_enter',self.action('ENTER_LONG',plan=self.plan))],callback=age)
        self.assertTrue(read.called)
        self.assertTrue(any(r['action']=='OPEN' for r in self.requests),self.observed)

    def test_abandon_metadata_accepted_after_snapshot_refresh(self):
        self.freeze()
        def abandon(session):
            snap=session.context['opportunities'][0]['reassessmentSnapshot']
            engine.PLAN_BOOK.rows['DOGEUSDT']['observedAt']-=1
            args=self.action('ABANDON_SETUP',setupId=self.plan['id'],snapshotId=snap['snapshotId'],
                             symbol='DOGEUSDT',assessedOpportunityIds=[self.plan['id']],checks=[])
            self.observed.append(json.loads(session.call('astra_decide',args)))
        result=self.run_worker(callback=abandon)
        self.assertTrue(result['completed'],self.observed)
        self.assertEqual(self.observed[-1]['status'],'ABANDONED')
        self.assertEqual(self.requests,[])

    def test_manifest_failure_blocks_entry_and_management(self):
        self.manifest_mock.side_effect = runner.IntegrationError("fingerprint mismatch")
        result = self.run_worker([("astra_enter", self.action("ENTER_LONG", plan=self.plan))])
        self.assertFalse(result["completed"])
        self.assertEqual(self.requests, [])

    def test_cached_observation_age_is_not_reset(self):
        self.row["observedAt"] = self.at - 130000
        seen = []
        self.run_worker(callback=lambda s: seen.append(s.engine.PLAN_BOOK.rows["DOGEUSDT"]["observedAt"]))
        self.assertEqual(seen, [self.at - 130000])

    def test_missing_host_observation_timestamp_fails_closed(self):
        del self.row["observedAt"]
        with self.assertRaisesRegex(runner.IntegrationError, "observedAt"):
            self.run_worker()

    def test_host_assignment_reloaded_not_redrawn(self):
        with patch.object(engine.ExperimentBook, "start_cycle", side_effect=AssertionError("must not assign")), \
             patch.object(engine.ExperimentBook, "advance", side_effect=AssertionError("must not advance")):
            self.run_worker([("astra_decide", self.action())])
        self.assertEqual(engine.EXPERIMENT_BOOK.current["id"], self.assignment["id"])
        self.assertEqual(engine.EXPERIMENT_BOOK.state["basePolicyHash"], self.experiment.state["basePolicyHash"])

    def test_truncated_journal_never_resets(self):
        path = self.root / "logs/astra-v8-fast_trading.jsonl"
        path.parent.mkdir(parents=True)
        path.write_text('{"kind":')
        with self.assertRaises(ValueError):
            self.run_worker()
        self.assertEqual(path.read_text(), '{"kind":')

    def test_coaching_blocks_every_trading_tool_without_gateway(self):
        operations = [(name, self.action()) for name in ("astra_decide", "astra_enter", "astra_plan", "astra_experiment", "memory")]
        job = self.job(mode=runner.COACHING, context={"canonicalEvidence": []})
        result = self.run_worker(operations, job=job)
        self.assertTrue(all("error" in value for value in self.observed))
        self.gateway_mock.assert_not_called()
        self.assertFalse(result["completed"])

    def test_coaching_review_uses_actual_evidence_and_does_not_write_old_journals(self):
        row = {"evidenceId": "settled-1", "eligible": True, "executedQty": .6, "actualFillPrice": 10.001,
               "fees": .012, "net": -.02, "entryBoundaryViolation": True,
               "reviewAxes": {axis: "UNKNOWN" for axis in AXES},
               "outcomeClassification": "BAD_PROCESS_BAD_OUTCOME"}
        body = {"axes": {axis: "Evaluate supplied actual evidence" for axis in AXES},
                "observedMechanism": "Entry boundary violation", "requiredAction": "Keep frozen entry boundary",
                "exceptions": "Unknown data", "outcomeClassification": "GOOD_PROCESS_BAD_OUTCOME"}
        result = self.run_worker([("astra_learn", {"operation": "REVIEW", "review": {"id": "review-1", "evidenceId": "settled-1", "body": body}})],
                                job=self.job(mode=runner.COACHING, context={"canonicalEvidence": [row]}))
        self.assertTrue(result["completed"], self.observed)
        self.assertEqual(self.observed[0]["canonicalEvidence"]["fees"], .012)
        self.assertEqual(self.observed[0]["status"], "CONTRADICTED")
        self.gateway_mock.assert_not_called()
        overlay = json.loads((self.root / "hermes-home/astra-canonical-v8.json").read_text())
        self.assertEqual(len([e for e in overlay if e["kind"] == "REVIEW"]), 1)
        self.assertFalse((self.root / "hermes-home/astra-learning.json").exists())
        self.assertFalse((self.root / "hermes-home/astra-procedures.json").exists())

    def test_coach_ingestion_persists_even_provider_unavailable(self):
        result = self.run_worker(job=self.job(mode=runner.COACHING, context={"canonicalEvidence": [{"evidenceId": "e1", "eligible": False}]}),
                                 raises=TimeoutError("provider timeout"))
        self.assertFalse(result["completed"])
        overlay = json.loads((self.root / "hermes-home/astra-canonical-v8.json").read_text())
        self.assertEqual(overlay[0]["payload"]["evidenceId"], "e1")

    def test_independent_modes_have_distinct_sessions_journals_and_budgets(self):
        self.run_worker()
        self.run_worker(job=self.job(mode=runner.COACHING, context={"canonicalEvidence": []}))
        self.assertNotEqual(self.sessions[0].session_id, self.sessions[1].session_id)
        self.assertTrue((self.root / "logs/astra-v8-fast_trading.jsonl").exists())
        self.assertTrue((self.root / "logs/astra-v8-coaching.jsonl").exists())
        self.assertEqual(set(runner.tool_schemas(engine)), runner.ALLOWLIST)

    def test_slow_model_does_not_hold_incumbent_tool_protection_lock(self):
        observed = []
        def callback(session):
            def monitor():
                with engine.TOOL_LOCK:
                    observed.append("protection free")
            thread = threading.Thread(target=monitor)
            thread.start()
            thread.join(timeout=1)
            self.assertFalse(thread.is_alive())
        self.run_worker(callback=callback)
        self.assertEqual(observed, ["protection free"])

    def test_nullable_timestamps_and_usage_are_not_fabricated(self):
        result = self.run_worker(final={"completed": False, "error": "unknown"})
        for key in ("apiCalls", "modelCalls", "turnsUsed", "tokenUsage", "decisionValidatedAt", "orderSubmittedAt", "orderFilledAt"):
            self.assertIsNone(result[key])

    def test_fill_time_uses_matched_order_not_unrelated_trade_or_update_time(self):
        result = {"entry": {"attemptedAt": 10, "order": {"orderId": 2, "updateTime": 11}},
                  "fills": [{"orderId": 3, "qty": 1, "time": 12}]}
        self.assertIsNone(runner.execution_times("ENTER_LONG", result, 1)["orderFilledAt"])
        result["fills"].append({"orderId": 2, "qty": 1, "time": 13})
        self.assertEqual(runner.execution_times("ENTER_LONG", result, 1)["orderFilledAt"], 13)
        self.assertIsNone(runner.execution_times("HOLD", result, 1)["orderSubmittedAt"])

    def canonical_book(self):
        book = CanonicalBook()
        tags = {"executionPolicyVersion": runner.COHORT, "tradePolicyVersion": "unchanged-policy",
                "decisionVersion": "V8", "cohort": runner.COHORT, "fingerprint": "test-fingerprint"}
        book.ingest([{**tags, "evidenceId": "e" + str(i), "eligible": True,
                      "entryBandViolation": False, "executionClass": "CURRENT_EXECUTION"} for i in range(3)], {})
        for number in range(4):
            book.publish("lesson-" + str(number),
                {"observedMechanism": "Executable quote moves outside frozen band",
                 "requiredAction": "Check original band", "exceptions": "Missing quote remains unknown"},
                ["e0", "e1", "e2"], {"action": "ENTER_LONG"},
                {"op": "eq", "field": "side", "value": "LONG"},
                {"predicate": {"op": "between", "field": "executableQuote", "min": {"field": "entryMin"}, "max": {"field": "entryMax"}},
                 "passActions": ["ENTER_LONG", "NO_TRADE"], "failActions": ["NO_TRADE"]},
                {"op": "eq", "field": "entryBandViolation", "value": False})
        path = self.root / "hermes-home/astra-canonical-v8.json"
        path.write_text(json.dumps(book.export()))
        return book

    def test_canonical_relevant_long_lesson_verified_on_no_trade_max_three(self):
        self.freeze()
        self.canonical_book()
        source = (self.root / "hermes-home/astra-canonical-v8.json").read_bytes()
        result = self.run_worker([("astra_decide", self.action("NO_TRADE", setupId=self.plan["id"],
                                  vetoReason="Explicit discretionary decline on current setup evidence",
                                  appliedLessonIds=["lesson-0", "invented"]))])
        self.assertTrue(result["completed"], self.observed)
        self.assertEqual(len(self.sessions[0].lessons), 3)
        usages = [r["usage"] for r in runner.Journal(self.root, runner.FAST_TRADING).records if r["kind"] == "LESSON_APPLICATION"]
        self.assertIn("lesson-0", usages[0]["applicableLessonIds"])
        self.assertIn("lesson-0", usages[0]["appliedLessonIds"])
        self.assertEqual(usages[0]["unverifiedClaims"], ["invented"])
        self.assertEqual((self.root / "hermes-home/astra-canonical-v8.json").read_bytes(), source)
        self.assertTrue(result["canonicalDelta"])

    def test_contradicted_and_retired_lessons_never_delivered(self):
        self.freeze()
        book = self.canonical_book()
        for i in range(4):
            book.retire("lesson-" + str(i), "New evidence contradicts historical procedure")
        (self.root / "hermes-home/astra-canonical-v8.json").write_text(json.dumps(book.export()))
        self.run_worker()
        self.assertEqual(self.sessions[0].lessons, [])

    def test_fast_application_delta_imported_by_coaching_from_original_base(self):
        self.freeze()
        self.canonical_book()
        fast_result = self.run_worker([("astra_decide", self.action("NO_TRADE", setupId=self.plan["id"],
                                      vetoReason="Decline with explicit present setup uncertainty"))])
        job = self.job(mode=runner.COACHING, context={"canonicalEvidence": []}, canonicalDeltas=[fast_result["canonicalDelta"]])
        self.run_worker(job=job)
        merged = json.loads((self.root / "hermes-home/astra-canonical-v8.json").read_text())
        self.assertEqual(len([r for r in merged if r["kind"] == "APPLICATION"]), 1)
        self.assertTrue(any(r["kind"] == "IMPORT_PROVENANCE" for r in merged))

    def test_already_imported_delta_is_not_replayed_by_later_coaching(self):
        self.freeze()
        self.canonical_book()
        fast_result = self.run_worker([("astra_decide", self.action("NO_TRADE", setupId=self.plan["id"],
                                      vetoReason="Decline with explicit present setup uncertainty"))])
        deltas = [fast_result["canonicalDelta"]]
        self.run_worker(job=self.job(id="coach-1", mode=runner.COACHING, context={"canonicalEvidence": []},
                                     canonicalDeltas=deltas))
        path = self.root / "hermes-home/astra-canonical-v8.json"
        first = path.read_text()
        with patch.object(runner.CanonicalBook, "ingest_applications",
                          side_effect=AssertionError("already-imported delta replayed")):
            self.run_worker(job=self.job(id="coach-2", mode=runner.COACHING, context={"canonicalEvidence": []},
                                         canonicalDeltas=deltas))
        self.assertEqual(path.read_text(), first)

    def test_coaching_canonical_input_never_exposes_raw_report(self):
        source = {"report": {"RAW_REPORT_SENTINEL": "not prompt"}, "status": self.status,
                  "legacyJournal": {"lessons": []}, "plans": [], "bindings": {}, "decisions": [],
                  "postFixExecutionVersions": [engine.HOST_REVISION]}
        with patch.object(runner, "canonical_evidence", return_value=[{"evidenceId": "e1", "eligible": False}]) as adapter:
            self.run_worker(job=self.job(mode=runner.COACHING, context={}, canonicalInput=source))
        self.assertEqual(adapter.call_args.kwargs["post_fix_execution_versions"], [engine.HOST_REVISION])
        self.assertNotIn("RAW_REPORT_SENTINEL", self.prompts[0])

    def test_no_trade_requires_enumeration_and_reports_only_assessed_symbols(self):
        job = self.job()
        job["context"]["marketCandidates"] = [{"opportunityId": "c1", "symbol": "DOGEUSDT"},
                                               {"opportunityId": "c2", "symbol": "BTCUSDT"}]
        result = self.run_worker([("astra_decide", self.action()),
                                 ("astra_decide", self.action(assessedOpportunityIds=["c1"]))], job=job)
        self.assertIn("error", self.observed[0])
        self.assertEqual(result["assessedSymbols"], ["DOGEUSDT"])
        self.assertEqual(len(self.requests), 1)

    def test_entry_no_fill_reaches_actual_engine_final_contract(self):
        self.gateway_response = {"state": "NO_FILL", "qty": 0, "entryQty": 0}
        result = self.run_worker([("astra_enter", self.action("ENTER_LONG", plan=self.plan))])
        self.assertTrue(result["completed"], self.observed)
        self.assertEqual(result["actions"][0]["outcome"], "NO_FILL_CONFIRMED")
        self.assertIn("entryContract", self.requests[0])
        self.assertIsNone(result["orderFilledAt"])

    def test_typed_entry_rejection_requires_no_order_and_gateway_proof(self):
        self.gateway_response = {"status": "ENTRY_REJECTED", "noOrderSubmitted": True,
                                  "entryGate": {"executionVersion": engine.HOST_REVISION}}
        result = self.run_worker([("astra_enter", self.action("ENTER_LONG", plan=self.plan))])
        self.assertEqual(result["actions"][0]["outcome"], "REJECTED_BY_POLICY")
        self.assertTrue(result["completed"])
        self.assertIsNone(result["orderSubmittedAt"])

    def test_unknown_entry_rejection_is_unresolved_without_proof(self):
        self.gateway_response = {"status": "ENTRY_REJECTED"}
        result = self.run_worker([("astra_enter", self.action("ENTER_LONG", plan=self.plan))])
        self.assertEqual(result["actions"][0]["outcome"], "UNRESOLVED_RECONCILE")
        self.assertFalse(result["completed"])

    def test_unresolved_close_cannot_be_replaced_by_new_decision_id(self):
        self.own()
        self.gateway_response = {"status": "REJECTED_OR_UNRESOLVED"}
        self.run_worker([("astra_decide", self.action("CUT_LOSS", positionId="owned-001")),
                         ("astra_decide", self.action("CUT_LOSS", positionId="owned-001", id="different-id"))])
        self.assertIn("exact original", self.observed[1]["error"])
        self.assertEqual(len(self.requests), 1)

    def test_close_timing_uses_only_this_action_exit_handles(self):
        value = {"exits": [{"attemptedAt": 5, "order": {"orderId": 1}},
                            {"attemptedAt": 20, "order": {"orderId": 2}}],
                 "fills": [{"orderId": 1, "qty": 1, "time": 6}, {"orderId": 2, "qty": 1, "time": 22}]}
        timing = runner.execution_times("CUT_LOSS", value, 15)
        self.assertEqual((timing["orderSubmittedAt"], timing["orderFilledAt"]), (20, 22))

    def test_host_event_id_envelopes_accept_ready_and_coverage_and_review(self):
        for reason in ("READY", "NEW_CANDIDATE_BATCH", "OWNED_POSITION_REVIEW_DUE"):
            self.assertEqual(runner.event_keys({"events": [{"eventId": reason + "-stable", "eventReason": reason}]}),
                             [reason + "-stable"])

    def test_retired_during_model_session_is_superseded_not_compliant(self):
        self.freeze()
        book = self.canonical_book()
        def retire(session):
            book.retire("lesson-0", "New contradictory evidence arrived")
            (self.root / "hermes-home/astra-canonical-v8.json").write_text(json.dumps(book.export()))
        self.run_worker([("astra_decide", self.action("NO_TRADE", setupId=self.plan["id"],
                           vetoReason="Explicit prospective discretionary decline", appliedLessonIds=["lesson-0"]))], callback=retire)
        records = runner.Journal(self.root, runner.FAST_TRADING).records
        usage = next(r for r in records if r["kind"] == "LESSON_APPLICATION")
        self.assertIn("lesson-0", usage["supersededLessonIds"])
        self.assertNotIn("lesson-0", usage["usage"]["appliedLessonIds"])

    def test_only_a_declared_model_policy_may_run_a_job(self):
        """A host that can name any model can change the decision policy silently."""
        import hermes_model_policy_v1 as models
        for bad in ({"task": "FAST_TRADING", "role": "PRIMARY", "model": "some-other-model", "provider": "openai-codex", "effort": "medium"},
                    # Right model and provider, wrong effort: still an undeclared policy.
                    {"task": "FAST_TRADING", "role": "FALLBACK", "model": "claude-opus-5", "provider": "anthropic", "effort": "max"},
                    {"task": "FAST_TRADING", "role": "SHADOW", "model": "x", "provider": "y", "effort": "high"}):
            with self.assertRaises((runner.IntegrationError, ValueError)):
                self.run_worker(job=self.job(modelPolicy=bad))
        self.assertEqual(self.prompts, [])
        self.gateway_mock.assert_not_called()
        # Only the declared Sonnet Medium trading policy is accepted.
        result = self.run_worker([("astra_decide", self.action())],
                                 job=self.job(modelPolicy=models.policy(models.FAST_TRADING), id="declared-primary"))
        self.assertTrue(result["completed"], self.observed)

    def test_every_record_names_the_policy_that_produced_it(self):
        import hermes_model_policy_v1 as models
        # Every new trading record identifies the Sonnet policy, not the legacy lane name.
        fallback = models.policy(models.FAST_TRADING)
        result = self.run_worker([("astra_decide", self.action())],
                                 job=self.job(modelPolicy=fallback, id="fallback-job"))
        self.assertTrue(result["completed"], self.observed)
        self.assertEqual((result["modelRole"], result["model"], result["reasoningEffort"]),
                         ("PRIMARY", "claude-sonnet-5", "medium"))
        records = runner.Journal(self.root, runner.FAST_TRADING).records
        self.assertTrue(records)
        self.assertTrue(all(r["modelRole"] == "PRIMARY" and r['model']=='claude-sonnet-5' and r['reasoningEffort']=='medium' for r in records))
        # Two policies must not share one agent session, or the second inherits the
        # first one's conversation state.
        primary = runner.JobSession(self.root, self.job(), runner.FAST_TRADING, engine, None,
                                    runner.Journal(self.root, runner.FAST_TRADING))
        second = runner.JobSession(self.root, self.job(modelPolicy=fallback,id='distinct-job'), runner.FAST_TRADING,
                                   engine, None, runner.Journal(self.root, runner.FAST_TRADING))
        self.assertNotEqual(primary.session_id, second.session_id)

    def test_substituted_model_or_tool_set_fails_the_job(self):
        import astra_models_v8 as models
        spec = models.policy(models.PRIMARY)
        self.assertTrue(runner.check_agent_identity(spec["model"], spec["provider"], set(runner.ALLOWLIST), spec))
        for model, provider, tools in ((spec["model"], "anthropic", set(runner.ALLOWLIST)),
                                       ("claude-opus-5", spec["provider"], set(runner.ALLOWLIST)),
                                       (spec["model"], spec["provider"], set(runner.ALLOWLIST) | {"shell"})):
            with self.assertRaises(runner.IntegrationError):
                runner.check_agent_identity(model, provider, tools, spec)

    def test_invalid_phase_blocks_entry_but_management_survives_missing_assignment(self):
        self.phase_mock.side_effect = runner.IntegrationError("V8 assignment mismatch")
        result = self.run_worker([("astra_enter", self.action("ENTER_LONG", plan=self.plan))])
        self.assertFalse(result["completed"])
        self.assertEqual(self.requests, [])
        self.own()
        result = self.run_worker([("astra_decide", self.action("HOLD", positionId="owned-001", id="hold-next-job"))],
                                 job=self.job(id="management-job", events=[{"eventId": "manage"}], assignmentId="missing"))
        self.assertTrue(result["completed"], self.observed)
        self.assertEqual(result["actions"][0]["positionId"], "owned-001")


if __name__ == "__main__":
    unittest.main()

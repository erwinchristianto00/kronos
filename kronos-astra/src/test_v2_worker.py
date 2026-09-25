import copy
import json
from unittest.mock import patch
import test_astra_v8_runner as fixtures
from astra_replan_v2 import EXPLANATIONS


class V2WorkerTests(fixtures.WorkerTests):
    def test_v2_wait_is_host_record_without_gateway_order(self):
        self.freeze()
        def act(session):
            snap = session.context["opportunities"][0]["reassessmentSnapshot"]
            r = json.loads(session.call("astra_decide", self.action("WAIT", setupId=self.plan["id"], snapshotId=snap["snapshotId"])))
            self.assertEqual(r["status"], "AWAITING_ENTRY", r)
            self.assertEqual(r["attemptsUsed"], 0)
        r = self.run_worker(callback=act)
        self.assertTrue(r["completed"], r)
        self.assertEqual(self.requests, [])
        self.assertEqual(r["actions"][0]["outcome"], "PLAN_UPDATED")

    def test_replan_child_requires_separate_enter_and_keeps_final_contract(self):
        self.freeze()
        self.at += 300000
        self.row["observedAt"] = self.at
        self.row["book"].update(bid=10.099, ask=10.1, time=self.at)
        self.row["candles"] = [{"closeTime": self.at-1000, "close": 10.1}]
        with patch.object(fixtures.runner, "now_ms", return_value=self.at), patch("time.time", return_value=self.at/1000):
            book = fixtures.engine.PlanBook(self.root)
            book.observe(self.raw)
            self.views = [book.view(book.get(self.plan["id"]))]
            def act(session):
                snap = session.context["opportunities"][0]["reassessmentSnapshot"]
                child = {**self.plan, "id": "v2_child_001", "triggerPrice": 10.1, "entryMin": 10.09,
                         "entryMax": 10.12, "stopPrice": 9.9, "targetPrice": 10.4, "notionalUsd": 5.5}
                a = self.action("REPLAN", setupId=self.plan["id"], snapshotId=snap["snapshotId"], plan=child,
                                evidenceCandleAt=self.at-1000, setupType="KNOWN", playbooks=["P1"],
                                **{k:"New closed evidence supports a different structure" for k in EXPLANATIONS})
                r = json.loads(session.call("astra_decide", a))
                self.assertEqual(r["status"], "REPLANNED", r)
                self.assertEqual(self.requests, [])
                self.gateway_response = {"status": "ENTRY_REJECTED", "noOrderSubmitted": True,
                    "entryGate": {"executionVersion": fixtures.engine.HOST_REVISION, "planId": child["id"],
                                  "failedPredicate": "entryBand"}}
                r = json.loads(session.call("astra_enter", self.action("ENTER_LONG", id="v2_enter_child_001", setupId=child["id"])))
                self.assertEqual(len(self.requests), 1, r)
                self.assertEqual(self.requests[0]["entryContract"]["planId"], child["id"])
                self.assertEqual(self.requests[0]["notionalUsd"], 5.5)
                rejected = session.engine.PLAN_BOOK.get(child["id"])
                self.assertEqual(rejected["v2"]["status"], "REASSESS_REQUIRED")
                self.assertTrue(session.engine.PLAN_BOOK.recoverable_no_order(rejected))
                self.assertIsNotNone(rejected["submissionId"])
            self.run_worker(callback=act)

    def test_v2_fresh_snapshot_race_does_not_mutate_or_send_order(self):
        self.freeze()
        def act(session):
            result = json.loads(session.call("astra_decide", self.action("WAIT", setupId=self.plan["id"], snapshotId="old-hash")))
            self.assertEqual(result["status"], "STALE_REASSESSMENT")
        self.run_worker(callback=act)
        self.assertEqual(self.requests, [])

    def test_v2_schema_no_reduce_or_new_tool(self):
        schemas = fixtures.runner.tool_schemas(fixtures.engine)
        self.assertEqual(set(schemas), fixtures.runner.ALLOWLIST)
        actions = schemas["astra_decide"]["parameters"]["properties"]["action"]["enum"]
        self.assertTrue({"WAIT", "REPLAN", "ABANDON_SETUP"} <= set(actions))
        self.assertNotIn("REDUCE", actions)

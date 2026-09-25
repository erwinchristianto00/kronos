import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from astra_replan_v2 import PlanBook, EXPLANATIONS
from test_astra_plans import FrozenPlanTests


class ReplanTests(unittest.TestCase):
    def setUp(self):
        FrozenPlanTests.setUp(self)
        self.book = PlanBook(self.root, now=lambda: self.now)
        self.book.observe(copy.deepcopy(self.context))
        self.book.create(copy.deepcopy(self.plan))

    def drift(self, price=10.10):
        self.now += 300000
        row = self.context["rows"][0]
        row["candles"] = [{"closeTime": self.now-1, "close": price, "high": price+.02, "low": price-.02}]
        row["book"].update(bid=price-.001, ask=price, time=self.now)
        self.book.observe(copy.deepcopy(self.context))

    def args(self, parent=None, action="REPLAN", ident="replan_decision_001"):
        parent = parent or self.plan["id"]
        snap = self.book.snapshot("DOGEUSDT")
        p = self.book.get(parent)["plan"]
        price = snap["book"]["ask"]
        child = {**p, "id": "child_"+ident, "triggerPrice": price,
                 "entryMin": price-.01, "entryMax": price+.02, "stopPrice": price-.2,
                 "targetPrice": price+.3, "notionalUsd": 5.5, "expiresAt": self.now+1800000}
        args = {"id": ident, "action": action, "setupId": parent,
                "snapshotId": snap["snapshotId"], "reason": "New closed structure supports reassessment"}
        if action == "REPLAN":
            args.update(plan=child, evidenceCandleAt=snap["candle"]["closeTime"], setupType="HYBRID",
                        playbooks=["P1", "P2"], **{k: "New observed structure with falsifiable invalidation" for k in EXPLANATIONS})
        return args

    def test_initial_ready_unchanged(self):
        self.assertTrue(self.book.view(self.book.get(self.plan["id"]))["assessment"]["ready"])

    def test_arrival_wait_does_not_retire_plan_or_spend_reassessment_budget(self):
        self.book.state['plans'] = []
        self.plan.update(triggerPrice=10.01, entryMin=10.01, entryMax=10.03)
        self.book.create(self.plan)
        for i in range(3):
            result = self.book.reassess(self.args(action='WAIT', ident='arrival_wait_%03d' % i))
            self.assertEqual(result['attemptsUsed'], 0)
            self.assertEqual(result['status'], 'AWAITING_ENTRY')
            self.assertNotIn('planLifecycle', result['hostValidation']['failed'])
        self.drift(10.015)
        view = self.book.view(self.book.get(self.plan['id']))
        self.assertTrue(view['assessment']['ready'])
        self.assertFalse(view['reassessment']['failedAt'])
        self.assertEqual(self.book.state['submissions'], {})  # readiness is not an order

    def test_short_approach_wait_is_symmetric(self):
        self.book.state['plans'] = []
        self.plan.update(side='SHORT', triggerKind='CLOSE_BELOW', triggerPrice=9.99,
                         entryMin=9.97, entryMax=9.99, stopPrice=10.2, targetPrice=9.7)
        self.book.create(self.plan)
        result = self.book.reassess(self.args(action='WAIT'))
        self.assertEqual(result['attemptsUsed'], 0)
        self.drift(9.98)
        self.assertTrue(self.book.view(self.book.get(self.plan['id']))['assessment']['ready'])

    def test_price_beyond_entry_band_remains_real_failure(self):
        self.book.state['plans'] = []
        self.plan['triggerPrice'] = 10.03
        self.context['rows'][0]['book'].update(bid=10.025, ask=10.026)
        self.book.observe(self.context)
        self.book.create(self.plan)
        p = self.book.get(self.plan['id'])
        self.assertTrue(p['v2'].get('failedAt'))
        self.assertIn('entryBand', p['v2']['failedPredicates'])

    def test_approach_with_cost_failure_still_requires_reassessment(self):
        self.book.state['plans'] = []
        self.plan.update(triggerPrice=10.01, entryMin=10.01, entryMax=10.03, maxCostBps=22)
        self.book.create(self.plan)
        result = self.book.reassess(self.args(action='WAIT'))
        self.assertEqual(result['attemptsUsed'], 1)
        self.assertEqual(result['status'], 'WAITING')

    def test_no_order_abandon_survives_quote_refresh(self):
        a=self.args(action='ABANDON_SETUP')
        self.drift()
        result=self.book.reassess(a)
        self.assertEqual(result['status'],'ABANDONED')
        self.assertEqual(result['decisionSnapshotId'],a['snapshotId'])
        self.assertNotEqual(result['snapshot']['snapshotId'],a['snapshotId'])
        self.assertTrue(result['noOrderSubmitted'])
        self.assertEqual(self.book.reassess(a),result)

    def test_snapshot_identity_ignores_only_observation_clock(self):
        before=self.book.snapshot('DOGEUSDT')
        row=self.book.rows['DOGEUSDT']
        row['observedAt']+=1;row['book']['time']+=1;self.now+=1
        after=self.book.snapshot('DOGEUSDT')
        self.assertEqual(before['snapshotId'],after['snapshotId'])
        self.assertNotEqual(before['snapshotDataHash'],after['snapshotDataHash'])
        row['book']['ask']+=.001
        self.assertNotEqual(after['snapshotId'],self.book.snapshot('DOGEUSDT')['snapshotId'])

    def test_expiry_retires_plan_not_thesis(self):
        self.now=self.plan['expiresAt']+1
        self.assertEqual(self.book.expire_unsubmitted(self.context['status']),[self.plan['id']])
        p=self.book.get(self.plan['id'])
        self.assertTrue(p['v2Retired'])
        self.assertEqual(p['v2']['status'],'EXPIRED')
        self.assertEqual(p['plan'],self.plan)
        self.assertEqual(self.book.expire_unsubmitted(self.context['status']),[])

    def test_expiry_preserves_submitted_or_owned(self):
        self.now=self.plan['expiresAt']+1
        p=self.book.get(self.plan['id']);p['submissionId']='unknown_order'
        self.assertEqual(self.book.expire_unsubmitted(self.context['status']),[])
        p.pop('submissionId')
        status={**self.context['status'],'active':[{'symbol':self.plan['symbol']}]}
        self.assertEqual(self.book.expire_unsubmitted(status),[])

    def test_old_plan_failure_not_thesis_failure(self):
        self.drift()
        v = self.book.view(self.book.get(self.plan["id"]))
        self.assertEqual(v["reassessment"]["status"], "REASSESS_REQUIRED")
        self.assertEqual(v["frozenPlan"] if "frozenPlan" in v else v["plan"], self.plan)
        self.assertFalse(v["assessment"]["ready"])

    def test_replan_immutable_parent_smaller_child_restart(self):
        self.drift()
        args = self.args()
        result = self.book.reassess(args)
        self.assertEqual(result["status"], "REPLANNED")
        restored = PlanBook(self.root, now=lambda: self.now)
        self.assertEqual(restored.get(self.plan["id"])["plan"], self.plan)
        self.assertEqual(restored.get(args["plan"]["id"])["plan"]["notionalUsd"], 5.5)
        self.assertTrue(result["child"]["assessment"]["ready"])
        self.assertFalse(restored.view(restored.get(self.plan["id"]))["assessment"]["ready"])

    def test_two_attempts_shared_across_descendants(self):
        self.drift()
        first = self.book.reassess(self.args())
        self.drift(10.2)
        second = self.book.reassess(self.args(first["childPlanId"], ident="replan_decision_002"))
        self.assertEqual(second["attemptsUsed"], 2)
        self.drift(10.3)
        with self.assertRaisesRegex(ValueError, "budget exhausted"):
            self.book.reassess(self.args(second["childPlanId"], ident="replan_decision_003"))

    def test_failed_attempts_consume_budget_without_altering_parent(self):
        self.drift()
        for i in range(2):
            a = self.args(ident="invalid_replan_00"+str(i))
            a["plan"]["notionalUsd"] = 26
            result = self.book.reassess(a)
            self.assertEqual(result["status"], "REASSESSMENT_REJECTED")
            self.assertEqual(result["attemptsUsed"], i+1)
            self.assertEqual(len(self.book.state["plans"]), 1)
        with self.assertRaisesRegex(ValueError, "budget exhausted"):
            self.book.reassess(self.args())

    def test_same_receipt_idempotent_changed_input_rejected(self):
        self.drift()
        a = self.args()
        original = self.book.reassess(a)
        self.assertEqual(self.book.reassess(a), original)
        with self.assertRaisesRegex(ValueError, "different input"):
            self.book.reassess({**a, "reason": "Different trading interpretation"})

    def test_wait_keeps_plan_non_executable_when_quote_recovers(self):
        self.drift()
        self.book.reassess(self.args(action="WAIT"))
        self.drift(10.001)
        self.assertFalse(self.book.view(self.book.get(self.plan["id"]))["assessment"]["ready"])

    def test_abandon_is_terminal_no_same_bar_budget_reset(self):
        self.drift()
        self.book.reassess(self.args(action="ABANDON_SETUP"))
        with self.assertRaisesRegex(ValueError, "reset"):
            self.book.create({**self.plan, "id": "reset_initial_001"})
        with self.assertRaisesRegex(ValueError, "Terminal"):
            self.book.reassess(self.args(ident="repeat_replan_001"))

    def test_stale_snapshot_refused(self):
        self.drift()
        a = self.args()
        self.drift(10.2)
        with self.assertRaisesRegex(ValueError, "STALE"):
            self.book.reassess(a)

    def test_new_quote_without_new_closed_evidence_not_replan(self):
        self.context["rows"][0]["book"]["ask"] = 10.1
        self.book.observe(copy.deepcopy(self.context))
        result = self.book.reassess(self.args())
        self.assertIn("newly closed", result["error"])

    def test_guard_mutations_fail_closed(self):
        for mutation in ({"maxSpreadBps": 100}, {"maxCostBps": 100}, {"entrySlippageBps": 1},
                         {"notionalUsd": 26}, {"notionalUsd": 1}, {"stopPrice": 999},
                         {"symbol": "BTCUSDT"}):
            with self.subTest(mutation=mutation):
                self.setUp()
                self.drift()
                a = self.args()
                a["plan"].update(mutation)
                r = self.book.reassess(a)
                self.assertEqual(r["status"], "REASSESSMENT_REJECTED")
                self.assertEqual(len(self.book.state["plans"]), 1)

    def test_hard_account_rejection_not_recoverable(self):
        self.drift()
        self.book.status["entryBlock"] = "UNRECONCILED_EXPOSURE"
        result = self.book.reassess(self.args())
        self.assertIn("recoverable", result["error"])

    def test_owned_or_submitted_cannot_change(self):
        self.drift()
        self.book.status["active"] = [{"symbol": "DOGEUSDT", "id": "owned"}]
        with self.assertRaisesRegex(ValueError, "exposure"):
            self.book.reassess(self.args())
        self.book.status["active"] = []
        self.book.get(self.plan["id"])["submissionId"] = "unknown_order"
        with self.assertRaisesRegex(ValueError, "exposure"):
            self.book.reassess(self.args())

    def test_reference_only_playbooks_not_execution(self):
        self.drift()
        a = self.args()
        a["playbooks"] = ["P4"]
        self.assertIn("reference only", self.book.reassess(a)["error"])

    def test_persistence_failure_restores_memory(self):
        self.drift()
        before = copy.deepcopy(self.book.state)
        with patch("astra_plans.PlanBook.save", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.book.reassess(self.args())
        self.assertEqual(self.book.state, before)

    def test_stale_and_future_quote_never_refresh_by_fiat(self):
        self.book.rows["DOGEUSDT"]["book"]["time"] = self.now+1000
        with self.assertRaisesRegex(ValueError, "Fresh"):
            self.book.snapshot("DOGEUSDT")


if __name__ == "__main__":
    unittest.main()

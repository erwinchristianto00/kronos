"""Regression for a displaced watch plan suppressing alternative formation."""
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import astra_runner
from astra_cadence import CadenceBook
import test_astra_cadence as fixtures


class ResponsiveCadenceTests(unittest.TestCase):
    setUp = fixtures.CadenceTest.setUp
    tearDown = fixtures.CadenceTest.tearDown
    make = fixtures.CadenceTest.make
    decide = fixtures.CadenceTest.decide
    spend_budget = fixtures.CadenceTest.spend_budget
    def displaced(self, live=1, displaced=1, ready=0, owned=0):
        return self.book.decide({'active': [{}] * owned}, ready, 0, live,
                                displaced_plan_n=displaced)

    def test_ake_reproduction_reforms_after_15_not_60_minutes(self):
        self.book = self.make({'formationIntervalMs': 3600000})
        self.book.record('PLAN_FORMATION')
        self.clock += 900000
        self.assertFalse(self.decide(live=1)['call'])
        d = self.displaced()
        self.assertEqual(d['reason'], 'PLAN_FORMATION')
        self.assertEqual(d['formationIntervalMs'], 900000)
        self.assertEqual(d['formationMode'], 'DISPLACED_PIPELINE')
        self.assertEqual((d['liveSetups'], d['viableSetups'], d['displacedSetups']), (1, 0, 1))

    def test_displaced_setups_do_not_fill_the_plan_floor(self):
        self.assertEqual(self.displaced(live=5, displaced=4)['reason'], 'PLAN_FORMATION')
        self.assertFalse(self.displaced(live=5, displaced=2)['call'])

    def test_no_per_tick_retry_or_budget_bypass(self):
        self.book.record('PLAN_FORMATION')
        self.assertFalse(self.displaced()['call'])
        self.clock += 899999
        self.assertFalse(self.displaced()['call'])
        self.clock += 1
        self.assertTrue(self.displaced()['call'])
        self.spend_budget()
        self.clock += 900000
        self.assertEqual(self.displaced()['outcome'], 'SCREENED_BUDGET')

    def test_ready_management_and_retry_protection_preserved(self):
        attempt = self.book.begin('PLAN_FORMATION')
        self.book.finish(attempt, 'PROVIDER_UNAVAILABLE')
        self.assertEqual(self.displaced()['outcome'], 'SCREENED_RETRY_BACKOFF')
        self.assertEqual(self.displaced(ready=1)['reason'], 'READY_SETUP')
        self.assertEqual(self.displaced(owned=1)['reason'], 'OWNED_POSITION')

    def test_return_to_band_restores_normal_wait_without_changing_journal(self):
        self.book.record('PLAN_FORMATION')
        self.clock += 900000
        before = json.dumps(self.book.state, sort_keys=True)
        self.assertTrue(self.displaced()['call'])
        self.assertFalse(self.displaced(displaced=0)['call'])
        self.assertEqual(json.dumps(self.book.state, sort_keys=True), before)

    def test_next_formation_time_explains_screened_wait(self):
        at = self.book.record('PLAN_FORMATION')
        d = self.displaced()
        self.assertEqual(d['nextFormationAt'], at + 900000)
        self.assertEqual(d['formationWaitMs'], 900000)


class ResponsiveScreenTests(unittest.TestCase):
    setUp = fixtures.ScreenCycleTests.setUp
    live_plan = fixtures.ScreenCycleTests.live_plan
    fake_gateway = fixtures.ScreenCycleTests.fake_gateway
    def run_screen(self, failures):
        self.plans.state['plans'] = [self.live_plan()]
        self.plans.state['plans'][0]['assessment'] = {'ready': False, 'failed': failures}
        book = CadenceBook(self.root, {'formationIntervalMs': 3600000})
        book.state['lastCallAt']['PLAN_FORMATION'] = int(__import__('time').time()*1000) - 900001
        book.save()
        (self.root / 'runner-config.json').write_text(json.dumps({
            'enabled': True, 'gatewayPort': 3112, 'cadence': {'formationIntervalMs': 3600000}}))
        before = json.dumps(self.plans.state, sort_keys=True)
        with patch.object(astra_runner, 'gateway', self.fake_gateway):
            d = astra_runner.screen_cycle({'active': []})
        self.assertEqual(json.dumps(self.plans.state, sort_keys=True), before)
        self.assertTrue(all(path == '/context' for path, _ in self.calls))
        return d

    def test_actual_ake_failed_predicates_reach_formation_not_order(self):
        d = self.run_screen(['entryBand', 'riskEnvelope'])
        self.assertEqual(d['reason'], 'PLAN_FORMATION')
        self.assertEqual(d['displacedSetupIds'], ['p1'])

    def test_risk_only_displacement_is_detected(self):
        self.assertEqual(self.run_screen(['riskEnvelope'])['reason'], 'PLAN_FORMATION')

    def test_trigger_only_wait_is_not_misclassified_as_displacement(self):
        d = self.run_screen(['trigger'])
        self.assertFalse(d['call'])
        self.assertEqual(d['displacedSetups'], 0)

    def test_stale_failed_band_never_used_as_verified_displacement(self):
        self.assertEqual(self.run_screen(['dataFresh', 'entryBand'])['reason'], 'SCREEN_UNAVAILABLE')

    def test_displacement_causes_real_cycle_call_and_persisted_reason_without_order(self):
        self.run_screen(['entryBand', 'riskEnvelope'])
        called, finished = [], []
        experiment = SimpleNamespace(current={'version': 'baseline'}, check_entry=lambda p: None,
            start_cycle=lambda: None, finish_cycle=finished.append, summary=lambda: {})
        learning = SimpleNamespace(observe_context=lambda c: None, delivered=set(),
            state={'lessons': []}, summary=lambda *a: {'unreviewedN': 0})
        def converse(prompt):
            called.append(prompt)
            return {'completed': True, 'final_response': 'WAIT', 'api_calls': 1, 'messages': []}
        agent = SimpleNamespace(model=astra_runner.MODEL, run_conversation=converse, close=lambda: None)
        def gateway(path, payload=None):
            if path == '/status':
                return {'active': []}
            return self.fake_gateway(path, payload)
        with patch.multiple(astra_runner, gateway=gateway, PlanBook=lambda *a, **k: self.plans,
            validate_capital_identity=lambda s: None, ExperimentBook=lambda *a: experiment,
            LearningBook=lambda *a: learning, refresh_learning_report=lambda: None,
            make_agent=lambda *a: agent, sync_dashboard=lambda: None), \
            patch.dict('sys.modules', {'hermes_state': SimpleNamespace(SessionDB=lambda: SimpleNamespace(close=lambda: None))}):
            astra_runner.run_cycle(True)
        receipt = json.loads((self.root / 'logs/cycles.jsonl').read_text())
        self.assertEqual(len(called), 1)
        self.assertEqual(finished, ['MODEL_DECISION'])
        self.assertTrue(receipt['modelCalled'])
        self.assertEqual(receipt['cadence']['reason'], 'PLAN_FORMATION')
        self.assertEqual(receipt['cadence']['formationMode'], 'DISPLACED_PIPELINE')
        self.assertEqual(receipt['cadence']['displacedSetupIds'], ['p1'])
        self.assertEqual(receipt['response'], 'WAIT')
        self.assertTrue(all(path == '/context' for path, _ in self.calls))


if __name__ == '__main__':
    unittest.main()

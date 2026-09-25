import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import astra_runner as runner
from astra_experiments import ExperimentBook, digest
from search_policy_migration import prepare
import test_astra_plans as fixtures


class SearchTests(unittest.TestCase):
    setUp = fixtures.FrozenPlanTests.setUp
    create = fixtures.FrozenPlanTests.create
    decision = fixtures.FrozenPlanTests.decision

    def view(self, failed=(), ready=False, eligible=True, **extras):
        return {'plan': {'id': 'test'}, 'assessment': {'failed': list(failed), 'ready': ready},
                'strategyEligibility': {'eligible': eligible}, **extras}

    def test_historical_price_displacement_is_watch_not_ready(self):
        for failed in [('entryBand',), ('entryBand', 'riskEnvelope', 'spread', 'cost'), ('riskEnvelope',)]:
            v = self.view(failed)
            before = copy.deepcopy(v)
            d = runner.search_disposition(v)
            self.assertEqual(d['status'], 'WATCH_PRICE')
            self.assertTrue(d['continueAlternativeSearch'])
            self.assertEqual(v, before)

    def test_trigger_wait_and_ready_are_distinct(self):
        self.assertEqual(runner.search_disposition(self.view(['trigger']))['status'], 'WATCH_TRIGGER')
        self.assertEqual(runner.search_disposition(self.view(ready=True))['status'], 'READY_NOW')

    def test_stale_foreign_and_terminal_never_labelled_executable(self):
        for v, expected in [(self.view(ready=True, eligible=False), 'INELIGIBLE_THIS_CYCLE'),
                             (self.view(ready=True, eligible=None), 'UNAVAILABLE'),
                             (self.view(['dataFresh', 'entryBand']), 'UNAVAILABLE'),
                             (self.view(ready=True, expired=True), 'TERMINAL_OR_SUBMITTED'),
                             (self.view(ready=True, submissionId='sent'), 'TERMINAL_OR_SUBMITTED')]:
            self.assertEqual(runner.search_disposition(v)['status'], expected)
        v = self.view(ready=True); v['assessment']['refreshRequired'] = True
        self.assertEqual(runner.search_disposition(v)['status'], 'UNAVAILABLE')

    def test_no_setup_wait_does_not_require_manufacturing_a_plan(self):
        d = self.decision(action='WAIT', reasonCode='NO_SETUP'); d.pop('setupId', None)
        with patch.object(runner, 'gateway', return_value={'status': 'WAIT_RECORDED'}) as g:
            self.assertEqual(json.loads(runner.decision_result(d))['status'], 'WAIT_RECORDED')
        self.assertEqual(g.call_args.args[0], '/decision')
        self.assertEqual(g.call_args.args[1]['action'], 'WAIT')
        self.assertEqual(self.book.state['plans'], [])

    def test_omitting_setup_id_does_not_bypass_explicit_ready_veto(self):
        self.create()
        d = self.decision(action='WAIT', reasonCode='NO_SETUP'); d.pop('setupId', None)
        with patch.object(runner, 'gateway') as g:
            result = json.loads(runner.decision_result(d))
        self.assertEqual(result['status'], 'READY_REQUIRES_EXPLICIT_DECISION')
        g.assert_not_called()

    def test_context_and_create_deliver_disposition_without_order(self):
        e = ExperimentBook(self.root, 'a'*64, now=lambda: self.now)
        e.start_cycle()
        with patch.object(runner, 'EXPERIMENT_BOOK', e), patch.object(runner, 'gateway') as g:
            result = json.loads(runner.plan_result({'operation': 'CREATE', 'plan': self.plan}))
            self.assertEqual(result['searchDisposition']['status'], 'READY_NOW')
            summary = runner.setup_summary()
            self.assertEqual(summary['searchPriority']['readyNowIds'], [self.plan['id']])
            self.assertEqual(summary['searchPriority']['scope'], 'RETURNED_PAGE_ONLY_NOT_THE_MARKET')
        g.assert_not_called()

    def test_search_policy_does_not_require_watch_creation_or_chasing(self):
        self.assertNotIn('Freeze the strongest inspected actionable hypothesis before NO_SETUP WAIT', runner.SYSTEM)
        self.assertIn('You need not CREATE a known-unexecutable plan', runner.SYSTEM)
        self.assertIn('No fixed symbol list, mandatory candidate count, trade quota', runner.SYSTEM)
        self.assertIn('Only the model\nchooses OPEN', runner.SYSTEM)
        self.assertIn('EXECUTABLE SEARCH V1', runner.SYSTEM)


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.clock = 1788889000000
        self.book = ExperimentBook(self.root, 'a'*64, now=lambda: self.clock)
        self.book.start_cycle()
        self.before = copy.deepcopy(self.book.state)

    def test_migration_preserves_history_and_requires_new_slot(self):
        b, event = prepare(self.root, 'b'*64, 'Prioritize executable candidates; keep all evidence and trading guards.', self.clock)
        self.assertEqual(ExperimentBook(self.root).state, self.before)  # prepare is read-only
        for key in ['assignments', 'planVersions', 'submissions', 'tradeDecisions', 'evidence', 'gates']:
            self.assertEqual(b.state[key], self.before[key])
        self.assertEqual(b.state['champion'], 'baseline_'+'b'*16)
        self.assertGreater(event['resumeAfterMs'], self.clock)
        self.assertNotEqual(event['resumeAfterMs']//300000, self.clock//300000)
        ExperimentBook.save(b)
        reopened = ExperimentBook(self.root, 'b'*64, now=lambda: event['resumeAfterMs'])
        self.assertEqual(reopened.start_cycle()['version'], b.state['champion'])
        with self.assertRaises(ValueError):
            prepare(self.root, 'b'*64, 'Never reset existing evidence to improve statistics.', self.clock)

    def test_active_trial_is_sealed_without_a_strategy_verdict(self):
        from test_astra_experiments import StrategyTrialTests
        # Build a real registered trial with the maintained trial fixture.
        fixture = StrategyTrialTests('test_assignment_balanced_persisted_and_idempotent_same_slot')
        fixture.setUp()
        try:
            self.assertIsNotNone(fixture.book.active())
            old = copy.deepcopy(fixture.book.state)
            b, _ = prepare(fixture.root, 'c'*64, 'Search policy changed; old comparison cannot span this cutover.', self.clock)
            self.assertEqual(b.state['studies'][-1]['status'], 'INVALIDATED_PROTOCOL')
            self.assertIn('NO STRATEGY CONCLUSION', b.state['studies'][-1]['phases'][-1]['result']['verdict'])
            self.assertEqual(b.state['assignments'], old['assignments'])
        finally:
            fixture.doCleanups()


if __name__ == '__main__':
    unittest.main()

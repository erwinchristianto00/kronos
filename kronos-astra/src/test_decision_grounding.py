"""Observed PEOPLE interpretation failures; hermetic, no model/order calls."""
import copy
import json
import unittest
import astra_v8_runner as runner
import test_entry_latency_fix as fixtures


class DecisionFactsTests(unittest.TestCase):
    def test_candidate_baseline_is_not_all_in_or_expected_return(self):
        c = {'economics': {'commission': {'status': 'AVAILABLE'}, 'feeAndSpreadBps': 48.1},
             'closedCandles': [{'high': .2273, 'low': .2233}] * 12,
             'formation': {'checks': {'costKnown': True, 'closedWindow': True}}}
        before = copy.deepcopy(c)
        f = runner.candidate_decision_facts(c)
        self.assertEqual(f['cost']['baselineFeeAndSpreadBps'], 48.1)
        self.assertIsNone(f['cost']['allInBps'])
        self.assertEqual(f['visibleWindow']['count'], 12)
        self.assertEqual(f['failedFormationChecks'], [])
        self.assertFalse(f['executionAuthority'])
        self.assertEqual(c, before)

    def test_candidate_missing_commission_stays_unknown(self):
        f = runner.candidate_decision_facts({'economics': {'feeAndSpreadBps': 0},
            'formation': {'checks': {'costKnown': False}}})
        self.assertIsNone(f['cost']['baselineFeeAndSpreadBps'])
        self.assertEqual(f['failedFormationChecks'], ['costKnown'])

    def test_incomplete_visible_window_cannot_invent_extreme(self):
        f = runner.candidate_decision_facts({'closedCandles': [{'low': 1, 'high': 2}, {}]})
        self.assertIsNone(f['visibleWindow']['low'])
        self.assertIsNone(f['visibleWindow']['high'])

    def opportunity(self):
        return {'frozenPlan': {'entryMin': .00885, 'entryMax': .00892, 'maxCostBps': 28},
                'executablePrice': .008869, 'adverseDisplacementBps': -34.83146,
                'assessment': {'at': 100, 'costBps': 28.2553},
                'invalidation': {'thesisPredicate': 'UNSUPPORTED'},
                'reassessment': {'status': 'WAITING', 'failedAt': 90, 'attemptsRemaining': 1,
                                 'createdSnapshot': {'candle': {'closeTime': 80}}},
                'reassessmentSnapshot': {'candle': {'closeTime': 95}}}

    def test_people_replay_separates_band_trigger_thesis_and_latch(self):
        o = self.opportunity(); before = copy.deepcopy(o)
        f = runner.host_decision_facts(o)
        self.assertEqual(f['thesisValidity'], 'NOT_MACHINE_EVALUATED')
        self.assertEqual(f['entryBandLocation'], 'WITHIN')
        self.assertEqual(f['triggerDisplacementLocation'], 'BEFORE_TRIGGER')
        self.assertEqual(f['waitMeaning'], 'NEW_STRUCTURE_FOR_REASSESSMENT_NOT_REACTIVATION')
        self.assertAlmostEqual(f['costHeadroomBps'], -.2553)
        self.assertTrue(f['newClosedEvidenceSinceCreation'])
        self.assertFalse(f['executionAuthority'])
        self.assertEqual(o, before)

    def test_unsupported_is_not_false_even_when_no_lifecycle(self):
        f = runner.host_decision_facts({'invalidation': {'thesisPredicate': 'UNSUPPORTED'}})
        self.assertEqual(f['thesisValidity'], 'NOT_MACHINE_EVALUATED')
        self.assertIsNone(f['costHeadroomBps'])
        self.assertIsNone(f['attemptsRemaining'])
        self.assertIsNone(f['newClosedEvidenceSinceCreation'])
        self.assertEqual(f['entryBandLocation'], 'UNKNOWN')

    def test_original_arrival_is_not_latched(self):
        o = self.opportunity(); o['reassessment'].pop('failedAt')
        self.assertEqual(runner.host_decision_facts(o)['waitMeaning'], 'ORIGINAL_ARRIVAL_OR_THESIS_REVIEW')

    def test_price_recovery_does_not_clear_latch(self):
        o = self.opportunity(); o['assessment']['costBps'] = 20
        f = runner.host_decision_facts(o)
        self.assertTrue(f['planFailureLatched'])
        self.assertFalse(f['priceRecoveryClearsLatch'])

    def test_terminal_is_not_replan_permission(self):
        o = self.opportunity(); o['reassessment']['status'] = 'ABANDONED'
        self.assertEqual(runner.host_decision_facts(o)['waitMeaning'], 'TERMINAL_PLAN')

    def test_bounds_and_signed_displacement_are_independent(self):
        for px, band in ((.0088, 'BELOW'), (.00885, 'WITHIN'), (.00892, 'WITHIN'), (.009, 'ABOVE')):
            o = self.opportunity(); o['executablePrice'] = px
            self.assertEqual(runner.host_decision_facts(o)['entryBandLocation'], band)
        o['adverseDisplacementBps'] = 10
        self.assertEqual(runner.host_decision_facts(o)['triggerDisplacementLocation'], 'BEYOND_TRIGGER')

    def test_same_closed_candle_does_not_become_new_evidence(self):
        o = self.opportunity(); o['reassessmentSnapshot']['candle']['closeTime'] = 80
        self.assertFalse(runner.host_decision_facts(o)['newClosedEvidenceSinceCreation'])

    def test_prompt_does_not_promote_momentum_or_unknowns_to_alpha(self):
        text = runner.fast_rules(None)
        for phrase in ('not expected future return', 'BASELINE ONLY',
                       'not a failed breakout', 'Never trade for a quota',
                       'ABANDON only with an observed thesis contradiction'):
            self.assertIn(phrase, text)


class DecisionContextTests(unittest.TestCase):
    setUp = fixtures.EntryLatencyTests.setUp
    gateway = fixtures.EntryLatencyTests.gateway
    job = fixtures.EntryLatencyTests.job
    freeze = fixtures.EntryLatencyTests.freeze
    action = fixtures.EntryLatencyTests.action
    factory = fixtures.EntryLatencyTests.factory
    run_worker = fixtures.EntryLatencyTests.run_worker

    def test_facts_are_delivered_to_real_worker_prompt_without_mutation(self):
        self.freeze()
        def decide(session):
            snap = session.context['opportunities'][0]['reassessmentSnapshot']
            result = json.loads(session.call('astra_decide', self.action('WAIT',
                setupId=self.plan['id'], snapshotId=snap['snapshotId'])))
            self.assertIn('hostDecisionFacts', result)
            self.assertFalse(result['hostDecisionFacts']['executionAuthority'])
        result = self.run_worker(callback=decide)
        self.assertTrue(result['completed'])
        self.assertIn('HOST_DECISION_FACTS_V1', self.prompts[0])
        f = self.sessions[0].context['opportunities'][0]['hostDecisionFacts']
        self.assertEqual(f['entryBandLocation'], 'WITHIN')
        self.assertFalse(f['executionAuthority'])


if __name__ == '__main__': unittest.main()

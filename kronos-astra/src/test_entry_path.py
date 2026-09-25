import copy
import json
import threading
import time
import unittest
from astra_v8_host import fetch_histories, FormationReader
import astra_v8_runner as runner
import astra_runner as engine
from test_astra_v8_runner import WorkerTests


class EntryContractTests(WorkerTests):
    def test_impossible_geometry_skips_refresh_and_order_with_structured_diagnostic(self):
        self.plan.update(triggerPrice=5.374, entryMin=5.4, entryMax=5.44,
                         stopPrice=5.32, targetPrice=5.55)
        self.run_worker([('astra_enter', self.action('ENTER_LONG', plan=self.plan))])
        self.assertEqual(self.gateway_mock.call_count, 0)
        self.assertEqual(self.requests, [])
        self.assertIn('geometryDiagnostic', json.dumps(self.observed))
        self.assertIn('INFEASIBLE_ENTRY_GEOMETRY', json.dumps(self.observed))

    def test_full_worker_failed_plan_skips_both_refresh_layers(self):
        self.freeze()
        def failed(session):
            p = session.engine.PLAN_BOOK.get(self.plan['id'])
            p['v2'].update(failedAt=self.at-1, status='WAITING', failedPredicates=['cost'])
            session.engine.PLAN_BOOK.save()
        self.run_worker([('astra_enter', self.action('ENTER_LONG', setupId=self.plan['id']))], callback=failed)
        self.assertEqual(self.gateway_mock.call_count, 0)
        self.assertEqual(self.requests, [])
        self.assertIn('LIFECYCLE_BLOCKED', json.dumps(self.observed))

    # Reuse the hermetic worker fixture, not production credentials.
    def test_metadata_and_decide_entry_share_gateway_contract(self):
        self.run_worker([('astra_decide', self.action('ENTER_LONG', plan=self.plan,
                         setupType='NOVEL', playbooks=['P1', 'P2']))])
        self.assertEqual(len(self.requests), 1, self.observed)
        self.assertEqual(self.requests[0]['action'], 'OPEN')
        self.assertNotIn('playbooks', self.requests[0])
        self.assertNotIn('setupType', self.requests[0])
        self.assertEqual(self.requests[0]['entryContract']['stopPrice'], self.plan['stopPrice'])

    def test_ambiguous_entry_fails_before_any_context_read(self):
        self.run_worker([('astra_enter', self.action('ENTER_LONG', plan=self.plan, setupId='ambiguous'))])
        self.assertEqual(self.requests, [])
        self.assertEqual(self.gateway_mock.call_count, 0)

    def test_invalid_metadata_still_fails(self):
        self.run_worker([('astra_enter', self.action('ENTER_LONG', plan=self.plan, playbooks=['BUY_NOW']))])
        self.assertEqual(self.requests, [])

    def test_entry_schema_does_not_advertise_replan_fields(self):
        s = runner.tool_schemas(engine)['astra_enter']['parameters']
        self.assertEqual(set(s['properties']['action']['enum']), {'ENTER_LONG','ENTER_SHORT'})
        self.assertNotIn('snapshotId', s['properties'])
        self.assertEqual(len(s['oneOf']), 2)


class PreparationTests(unittest.TestCase):
    def test_completed_reader_reports_ready_not_perpetually_preparing(self):
        r=FormationReader(lambda *args:None)
        r.startedAt=0
        r.worker=threading.Thread(target=lambda:None);r.worker.start();r.worker.join()
        self.assertEqual(r.summary(1)['status'],'READY_TO_DELIVER')

    def test_coaching_exhaustion_does_not_borrow_fast_budget(self):
        from unittest.mock import Mock, patch
        from types import SimpleNamespace
        from astra_v8_supervisor import Supervisor
        s=Supervisor.__new__(Supervisor)
        s.config={'dailyModelCallBudget':60,'dailyCoachingCallBudget':24,'reviewIntervalMs':1}
        s.state={'calls':[{'at':10000,'mode':'COACHING'}]*24,'lastCoachingAt':0}
        s.formation_reader=SimpleNamespace(worker=object())
        s.live_job=Mock(return_value=False);s.save=Mock();s.canonical_input=Mock()
        with patch('astra_v8_supervisor.now',return_value=10000):s.coach_if_due()
        s.canonical_input.assert_not_called()
        self.assertEqual(s.state['coachingDeferredReason'],'COACHING_DAILY_BUDGET_EXHAUSTED')

    def test_preparation_outcomes_are_real_host_accounting_not_model_failure(self):
        from astra_experiments import OUTCOMES, OUTCOME_EXCLUDED, OUTCOME_COMPLETED
        for value in ('SCREENED_CONTEXT_PREPARING','SCREENED_PREPARATION_SELECTION_CHANGED','SCREENED_CANDIDATE_DATA_UNAVAILABLE'):
            self.assertIn(value,OUTCOMES);self.assertIn(value,OUTCOME_EXCLUDED)
            self.assertNotIn(value,OUTCOME_COMPLETED)

    def test_pending_read_is_nonblocking_single_flight_and_exact_selection(self):
        gate=threading.Event(); calls=[]
        def gateway(path, payload=None):
            self.assertEqual(path,'/context')
            calls.append(payload);gate.wait(1)
            return {'contextMode':'FORMATION_METADATA_V1','marketDataComplete':False,'orderAuthority':False,
                    'source':'BINANCE_USDM_TESTNET','status':{'environment':'testnet'},'at':10,
                    'rows':[{'symbol':s} for s in payload['symbols']], 'unavailableSymbols':[],
                    'historyPage':{'offset':0,'returned':6,'nextOffset':None}}
        symbols=['AUSDT','BUSDT','CUSDT','DUSDT','EUSDT','FUSDT']
        selection={'selected':[{'symbol':s} for s in symbols]}
        reader=FormationReader(gateway)
        self.assertIsNone(reader.poll(selection,10))
        self.assertIsNone(reader.poll(selection,11))
        self.assertEqual(reader.summary(11)['status'],'PREPARING')
        gate.set();reader.worker.join(2)
        result=reader.poll(selection,12)
        self.assertEqual([r['symbol'] for r in result['raw']['rows']],symbols)
        self.assertEqual(result['selection'],selection);self.assertEqual(len(calls),1)
        self.assertEqual(calls[0]['contextMode'],'FORMATION_METADATA_V1')

    def test_metadata_mode_requires_explicit_gateway_ack(self):
        def old_gateway(*args):
            return {'source':'BINANCE_USDM_TESTNET','status':{'environment':'testnet'},
                    'rows':[{'symbol':'AUSDT'}],'historyPage':{'offset':0,'returned':1,'nextOffset':None}}
        with self.assertRaisesRegex(ValueError,'metadata gateway contract'):
            fetch_histories(old_gateway,['AUSDT'],metadata_only=True)
        self.assertEqual(fetch_histories(old_gateway,['AUSDT'])['rows'][0]['symbol'],'AUSDT')

    def test_wrong_venue_never_returns_partial_batch(self):
        def gateway(path,payload=None):
            return {'source':'LIVE','status':{'environment':'live'}}
        with self.assertRaises(ValueError):fetch_histories(gateway,['AUSDT','BUSDT'])

    def test_duplicate_symbols_rejected(self):
        with self.assertRaises(ValueError):fetch_histories(lambda *a:None,['AUSDT','AUSDT'])

    def test_failed_read_is_backed_off_without_model_or_order(self):
        calls=[]
        def fail(path,payload):
            calls.append(path);raise ValueError('unavailable')
        r=FormationReader(fail);s={'selected':[{'symbol':str(i)+'USDT'} for i in range(6)]}
        r.poll(s,10);r.worker.join(1)
        self.assertIsNone(r.poll(s,11));self.assertIsNone(r.poll(s,12))
        self.assertEqual(calls,['/context']);self.assertEqual(r.summary(12)['status'],'BACKOFF')

    def test_expired_preparation_not_delivered(self):
        r=FormationReader(lambda *a:None);r.worker=threading.Thread(target=lambda:None)
        r.worker.start();r.worker.join();r.messages.put((True,{'at':1}))
        self.assertIsNone(r.poll({},120002));self.assertEqual(r.error,'CONTEXT_READ_STALE')

    def test_context_preserves_risk_and_observed_narrative(self):
        c={'positions':[{'stop':2,'risk':5}], 'padding':'x'*60500,
           'candidateSelection':{'selected':[{'symbol':'BTCUSDT','slot':'NARRATIVE_EXPLORATION',
               'components':{'x':'a'*3000},'unknownComponents':['u'*1000]}]},
           'narrativeContext':{'rows':{'BTCUSDT':{'status':'OBSERVED_MEDIA_COVERAGE','uniqueHeadlineN':9}}}}
        out=runner.bounded_context(c)
        self.assertEqual(out['positions'],c['positions'])
        self.assertEqual(out['narrativeContext'],c['narrativeContext'])
        self.assertLess(len(json.dumps(out)),64000)


def load_tests(loader, tests, pattern):
    # Inherited fixture tests run in their original module; no inflated counts.
    suite=unittest.TestSuite()
    for cls in (EntryContractTests,PreparationTests):
        for name in cls.__dict__:
            if name.startswith('test_'):suite.addTest(cls(name))
    return suite

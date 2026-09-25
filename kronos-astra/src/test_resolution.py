import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import Mock
import astra_v8_runner as R
import ewma_shadow as E
from astra_canonical_v8 import learning_health


class ManagementTerminalTests(unittest.TestCase):
    def test_rejected_batch_watch_is_pending_until_explicit_new_confirmation(self):
        report={'reportingStatus':'COMPLETE','candidates':[{'opportunityId':'c','reportingStatus':'COMPLETE'}]}
        s=NS(job={'id':'j'},journal=NS(records=[{'kind':'DECISION_INTENT','jobId':'j',
             'decisionId':'rejected','candidateReport':report}]),
             actions=[{'decisionId':'rejected','outcome':'REJECTED_BY_POLICY'}])
        self.assertEqual(R.pending_candidate_assessments(s),['c'])
        s.journal.records.append({'kind':'DECISION_INTENT','jobId':'j','decisionId':'new','candidateReport':report})
        s.actions.append({'decisionId':'new','outcome':'VALID_NO_TRADE'})
        self.assertEqual(R.pending_candidate_assessments(s),[])

    def test_unconfirmed_watch_not_presented_as_complete(self):
        text=R.DISPOSITION.render_reports([{'decisionId':'d','decisionExecutionOutcome':'UNCONFIRMED',
                  'reportingStatus':'COMPLETE','candidates':[]}])
        self.assertIn('reporting INCOMPLETE',text)
        self.assertIn('WATCH proposals are NOT registered',text)

    def test_learning_health_exports_history_once_not_per_row(self):
        rows={str(i):{'evidenceId':str(i),'fingerprint':'f'} for i in range(24)}
        book=NS(_latest=lambda kind:rows if kind=='EVIDENCE' else {},export=Mock(return_value=[]))
        result=learning_health(book,'f')
        self.assertEqual(result['evidenceN'],24)
        self.assertEqual(result['reviewedCurrentContentN'],0)
        self.assertEqual(book.export.call_count,1)
        book.export.reset_mock();learning_health(book,'empty')
        book.export.assert_not_called()

    def test_omitted_id_is_bound_before_dispatch_explicit_id_is_untouched(self):
        s=NS(job={'id':'j'},mode=R.FAST_TRADING,decide=Mock(side_effect=lambda args,**kw:args))
        payload={'action':'NO_TRADE','reason':'No observed setup'}
        a=R.JobSession._call(s,'astra_decide',payload)
        b=R.JobSession._call(s,'astra_decide',payload)
        self.assertEqual(a['id'],b['id'])
        self.assertNotIn('id',payload)
        explicit=R.JobSession._call(s,'astra_decide',{**payload,'id':'original'})
        self.assertEqual(explicit['id'],'original')

    def test_automatic_id_stable_for_exact_payload_distinct_for_new_intent(self):
        a={'action':'NO_TRADE','reason':'measured structure absent'}
        before=copy.deepcopy(a)
        self.assertEqual(R.automatic_intent_id('j',a),R.automatic_intent_id('j',dict(reversed(list(a.items())))))
        self.assertNotEqual(R.automatic_intent_id('j',a),R.automatic_intent_id('j',{**a,'action':'ENTER_LONG'}))
        self.assertNotEqual(R.automatic_intent_id('j',a),R.automatic_intent_id('other',a))
        self.assertEqual(a,before)
        with self.assertRaisesRegex(ValueError,'never be remapped'):
            R.automatic_intent_id('j',{**a,'id':'explicit'})

    def session(self):
        return NS(mode=R.FAST_TRADING, positions={},
            context={'opportunities':[{'opportunityId':'p'}]},
            actions=[{'decisionId':'d','action':'WAIT','validAction':True,
                'outcome':'PLAN_UPDATED','opportunityId':'p',
                'result':{'status':'WAITING','noOrderSubmitted':True}}])

    def test_wait_and_abandon_terminal_no_second_narrative(self):
        s=self.session()
        self.assertIn('HOST-CONFIRMED',R.confirmed_management_completion(s))
        s.actions[0].update(action='ABANDON_SETUP',result={'status':'ABANDONED','noOrderSubmitted':True})
        self.assertIsNotNone(R.confirmed_management_completion(s))

    def test_incomplete_invalid_entry_replan_close_do_not_terminal(self):
        changes=[('action','ENTER_LONG'),('action','REPLAN'),('action','CUT_LOSS'),
                 ('validAction',False),('outcome','UNRESOLVED_RECONCILE'),
                 ('opportunityId','wrong'),('result',{'status':'WAITING'})]
        for k,v in changes:
            s=self.session();s.actions[0][k]=v
            self.assertIsNone(R.confirmed_management_completion(s),(k,v))
        s=self.session();s.context['marketCandidates']=[{'symbol':'BTCUSDT'}]
        self.assertIsNone(R.confirmed_management_completion(s))
        s=self.session();s.context['opportunities'].append({'opportunityId':'missing'})
        self.assertIsNone(R.confirmed_management_completion(s))
        s=self.session();s.positions={'owned':{}}
        self.assertIsNone(R.confirmed_management_completion(s))

    def test_hold_requires_all_owned_positions(self):
        s=self.session();s.context={'opportunities':[]};s.positions={'t':{}}
        s.actions=[{'decisionId':'h','action':'HOLD','positionId':'t',
                    'validAction':True,'outcome':'EXECUTED_MANAGEMENT'}]
        self.assertIsNotNone(R.confirmed_management_completion(s))
        s.positions['other']={}
        self.assertIsNone(R.confirmed_management_completion(s))

    def test_new_intent_id_does_not_mutate_existing_or_retry(self):
        s=NS(job={'id':'job'},journal=NS(records=[{'decisionId':'job-intent-1'},
            {'kind':'REQUEST','decisionId':'original-uncertain'}]))
        before=copy.deepcopy(s.journal.records)
        self.assertEqual(R.JobSession.next_decision_id(s),'job-intent-2')
        self.assertEqual(s.journal.records,before)


class EWMARecoveryTests(unittest.TestCase):
    def bars(self):
        return [[i*E.STEP, '100','102','99',str(100+(i%7)/10),'10',
                 (i+1)*E.STEP-1] for i in range(120)]

    def test_review_preserves_scores_quarantines_pending_and_keeps_cooldown(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);db=E.connect(folder/'shadow.sqlite3')
            self.addCleanup(db.close)
            bars=self.bars();at=120*E.STEP
            inputs={s:copy.deepcopy(bars) for s in E.SYMBOLS}
            with db:
                for s in E.SYMBOLS:E.apply_observation(db,s,bars,at)
                db.execute("UPDATE forecasts SET outcome='SCORED',realized=.01,loss_delta=.2 WHERE horizon=1")
                db.execute("INSERT INTO metadata VALUES('lastAutomaticRecoveryAt',?)",(str(at-1000),))
            original=[tuple(r) for r in db.execute("SELECT * FROM forecasts WHERE outcome='SCORED'")]
            inputs['ETHUSDT'][-1][4]='100.9'
            def fetch(route,params):return inputs[params['symbol']]
            with self.assertRaisesRegex(ValueError,'COOLDOWN'):
                E.revision_recovery(db,inputs,at,folder,fetch)
            plan=E.revision_recovery(db,inputs,at,folder,fetch,reviewed=True)
            with db:E.apply_recovery(db,plan)
            self.assertEqual(original,[tuple(r) for r in db.execute("SELECT * FROM forecasts WHERE outcome='SCORED'")])
            self.assertEqual(db.execute("SELECT count(*) FROM forecasts WHERE outcome='UNKNOWN_SOURCE_REVISION'").fetchone()[0],6)
            evidence=json.loads(next(folder.glob('source-epoch-*.json')).read_text())
            self.assertTrue(evidence['reviewed'])
            self.assertTrue((folder/'before-source-epoch-1.sqlite3').exists())

    def test_operator_review_never_bypasses_unstable_source(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);db=E.connect(folder/'shadow.sqlite3');self.addCleanup(db.close)
            bars=self.bars();at=120*E.STEP
            with db:
                for s in E.SYMBOLS:E.apply_observation(db,s,bars,at)
            inputs={s:copy.deepcopy(bars) for s in E.SYMBOLS};inputs['ETHUSDT'][-1][4]='100.9'
            with self.assertRaisesRegex(ValueError,'UNSTABLE'):
                E.revision_recovery(db,inputs,at,folder,lambda *args:bars,reviewed=True)
            self.assertFalse(list(folder.glob('source-epoch-*.json')))

if __name__=='__main__':unittest.main()

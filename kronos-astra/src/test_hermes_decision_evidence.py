import copy
import unittest
from hermes_decision_evidence import decision_context
from astra_canonical_v8 import CanonicalBook, SONNET_COHORT, needs_review, coaching_support, _hash, canonical_evidence, learning_health
from test_astra_canonical_v8 import fixture, adapt, TAGS, prepared_book, publish, context

class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.job={'id':'j','fingerprint':'f','contextBuiltAt':10,
                  'rawContext':{'source':'BINANCE_USDM_TESTNET','status':{'environment':'testnet'}},
                  'context':{'marketCandidates':[{'opportunityId':'a','symbol':'AAAUSDT'}]}}
        self.intent={'jobId':'j','fingerprint':'f','recordedAt':20,
                     'input':{'assessedOpportunityIds':['a'],'reason':'Displaced, wait'}}
        self.quant={'jobId':'j','fingerprint':'f','recordedAt':15,'snapshotHash':'q',
                    'snapshot':{'rows':[{'symbol':'AAAUSDT','marketContext':{'trend':'DOWN'},
                      'strategyEvidence':{'evidenceStatus':'MARKET_STATE_ONLY'}}],
                                'portfolioContext':{'grossExposure':0}}}
    def test_preserves_decision_context_without_inventing_side_or_edge(self):
        r=decision_context(self.intent,{'outcome':'VALID_NO_TRADE'},self.job,self.quant)
        self.assertEqual(r['reason'],'Displaced, wait')
        self.assertEqual(r['candidates'][0]['marketContext']['trend'],'DOWN')
        self.assertIsNone(r['candidates'][0]['side'])
        self.assertEqual(r['portfolioContext']['grossExposure'],0)
        self.assertNotIn('net',r)

    def test_symbol_report_reaches_canonical_context_with_provenance(self):
        self.intent['candidateReport']={'schemaVersion':'CANDIDATE_DISPOSITION_V1',
                                       'reportingStatus':'COMPLETE','assessmentN':1,
                                       'candidates':[{'symbol':'AAAUSDT','candidateDisposition':'WATCH'}]}
        r=decision_context(self.intent,{'outcome':'VALID_NO_TRADE'},self.job,self.quant)
        self.assertEqual(r['candidateReport'],self.intent['candidateReport'])
        self.assertTrue(r['sourceIntentHash'])
    def test_future_quant_rejected(self):
        self.quant['recordedAt']=21
        with self.assertRaises(ValueError):decision_context(self.intent,{},self.job,self.quant)
    def test_selection_receipt_preserved_and_bounded(self):
        self.job['context']['candidateSelection']={'rankingHash':'rank','sourceHash':'source',
            'meaning':'ATTENTION_ONLY','selected':[{'symbol':'AAAUSDT'}]}
        r=decision_context(self.intent,{},self.job,self.quant)
        self.assertEqual(r['candidateSelection'],self.job['context']['candidateSelection'])
        self.job['context']['candidateSelection']['huge']='x'*50000
        r=decision_context(self.intent,{},self.job,self.quant)
        self.assertEqual(r['candidateSelection']['rankingHash'],'rank')
        self.assertIn('omitted',r['candidateSelection'])
    def test_wrong_identity_or_environment_rejected(self):
        for field,value in [('fingerprint','other'),('id','other')]:
            j=copy.deepcopy(self.job);j[field]=value
            with self.assertRaises(ValueError):decision_context(self.intent,{},j)
        self.job['rawContext']['status']['environment']='live'
        with self.assertRaises(ValueError):decision_context(self.intent,{},self.job)
    def test_unknown_candidate_reported(self):
        self.intent['input']['assessedOpportunityIds']=['missing']
        r=decision_context(self.intent,{},self.job)
        self.assertEqual(r['candidateCoverage']['unresolvedIds'],['missing'])
    def test_replan_root_is_independent_episode(self):
        self.job['context']['marketCandidates'][0]['reassessment']={'rootPlanId':'root'}
        self.assertEqual(decision_context(self.intent,{},self.job)['episodeId'],'root')
    def test_oversized_candidates_explicitly_omitted(self):
        self.quant['snapshot']['rows'][0]['marketContext']['large']='x'*50000
        r=decision_context(self.intent,{},self.job,self.quant)
        self.assertEqual(r['omittedCandidateIds'],['a'])
        self.assertEqual(r['candidateCoverage']['includedN'],0)

    def test_large_context_dimension_reasons_not_sliced_as_list(self):
        for reasons in ({'market':['MISSING'], 'cost':['SLIPPAGE_UNKNOWN']},
                        ['MISSING'], None, 'LEGACY_UNKNOWN'):
            with self.subTest(reasons=reasons):
                row=self.quant['snapshot']['rows'][0]
                row['marketContext']['padding']='x'*22000
                row['dataQuality']={'status':'DEGRADED','reasons':reasons}
                before=copy.deepcopy(self.quant)
                result=decision_context(self.intent,{},self.job,self.quant)
                self.assertEqual(result['candidates'][0]['dataQuality']['reasons'],reasons)
                self.assertEqual(self.quant,before)

    def test_truncated_reasons_have_explicit_provenance(self):
        row=self.quant['snapshot']['rows'][0]
        row['marketContext']['padding']='x'*22000
        for reasons in (list(range(10)),{str(i):['UNKNOWN'] for i in range(10)}):
            row['dataQuality']={'reasons':reasons}
            result=decision_context(self.intent,{},self.job,self.quant)
            quality=result['candidates'][0]['dataQuality']
            self.assertEqual(len(quality['reasons']),8)
            self.assertEqual(quality['reasonsCompaction']['originalCount'],10)
            self.assertTrue(quality['reasonsCompaction']['originalHash'])

class LearningTests(unittest.TestCase):
    def test_confirmed_plan_update_is_not_profitable_trade(self):
        report,status,legacy,_=fixture()
        d={'id':'wait','at':100,'action':'WAIT','outcome':'PLAN_UPDATED',
           'validated':True,'noOrderConfirmed':True,'pending':False,**TAGS}
        rows=canonical_evidence(report,status,legacy,decisions=[d])
        row=next(r for r in rows if r['decisionId']=='wait')
        self.assertTrue(row['eligible']);self.assertEqual(row['net'],0)
        self.assertEqual(row['outcomeClassification'],'INSUFFICIENT_EVIDENCE')
    def test_health_does_not_infer_causal_improvement(self):
        b,rows=prepared_book();publish(b,rows)
        h=learning_health(b,TAGS['fingerprint'])
        self.assertEqual(h['liveSupportedLessonN'],1)
        self.assertEqual(h['linkedNetPnl'],'UNKNOWN')
        self.assertEqual(h['causalImprovement'],'UNPROVEN_REQUIRES_PROSPECTIVE_COMPARISON')
    def test_current_sonnet_cohort_recognized(self):
        self.assertEqual(adapt(fixture(),{**TAGS,'cohort':SONNET_COHORT})['executionClass'],'CURRENT_EXECUTION')
    def test_three_retries_not_three_support_cases(self):
        _,rows=prepared_book()
        for r in rows:r['independentEpisodeId']='one-root'
        b=CanonicalBook();b.ingest(rows,{})
        self.assertEqual(publish(b,rows)['status'],'PROVISIONAL')
    def test_evidence_changes_require_review_but_report_clock_does_not(self):
        row=adapt(fixture())
        events=[{'kind':'REVIEW','payload':{'evidenceId':row['evidenceId'],
                  'canonicalEvidence':copy.deepcopy(row),'evidenceHash':_hash(row)}}]
        self.assertFalse(needs_review(row,events))
        row['provenance']['reportAt']+=1000
        self.assertFalse(needs_review(row,events))
        row['decisionContext']={'reason':'new evidence'}
        self.assertTrue(needs_review(row,events))
    def test_supported_to_delivery_to_host_verified_application(self):
        b,rows=prepared_book()
        self.assertEqual(publish(b,rows)['status'],'SUPPORTED')
        self.assertEqual(len(coaching_support(rows,rows[:1])),3)
        d=b.deliver('next',context())
        self.assertEqual(len(d['procedures']),1)
        b.run_checks('next')
        a=b.verify('next','ENTER_LONG')
        self.assertEqual(a['appliedLessonIds'],['band-check'])
    def test_unselected_counterevidence_prevents_promotion(self):
        b,rows=prepared_book()
        bad=adapt(fixture('bad'));bad['entryBandViolation']=True
        b.ingest(rows+[bad],{})
        self.assertEqual(publish(b,rows)['status'],'CONTRADICTED')
    def test_other_partition_not_supplied_as_support(self):
        _,rows=prepared_book();rows[0]['fingerprint']='other'
        self.assertEqual(len(coaching_support(rows,rows[1:2])),2)

if __name__=='__main__':unittest.main()

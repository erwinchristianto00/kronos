import copy
import unittest
import candidate_disposition as c

def watch(at=100):
    return {'opportunityId':'candidate-a','symbol':'AAAUSDT','candidateDisposition':'WATCH',
        'reasonCode':'ENTRY_DISPLACEMENT','reason':'Current entry is displaced from the observed range.',
        'revisitCondition':{'metric':'executablePrice','operator':'BETWEEN','value':10,'upperValue':11,
                            'basis':'Revisit the observed closed-candle consolidation range.'},
        'expiresAt':at+1000,'invalidation':'Invalidated if the measured structure breaks down.'}

class DispositionTests(unittest.TestCase):
    def setUp(self):
        self.context={'marketCandidates':[{'opportunityId':'candidate-a','symbol':'AAAUSDT'},
                                         {'opportunityId':'candidate-b','symbol':'BBBUSDT'}]}
        self.args={'id':'decision-a','action':'NO_TRADE','assessedOpportunityIds':['candidate-a'],
                   'candidateAssessments':[watch()]}
    def report(self):return c.build_report(self.args,self.context,100)
    def test_watch_is_not_execution_or_scheduled(self):
        r=self.report();self.assertEqual(r['reportingStatus'],'COMPLETE')
        self.assertFalse(r['executionAuthority']);self.assertFalse(r['automaticallyScheduled'])
        self.assertEqual(r['candidates'][0]['estimatedNetEdge'],'UNKNOWN')
    def test_price_lte_regression_and_symmetric_gte(self):
        for op in ('LTE','GTE'):
            row=watch();row['revisitCondition'].update(operator=op,value=0.005082)
            row['revisitCondition'].pop('upperValue');self.args['candidateAssessments']=[row]
            self.assertEqual(self.report()['reportingStatus'],'COMPLETE')
    def test_every_advertised_pair_has_host_support(self):
        advertised={(b['properties']['metric']['const'],b['properties']['operator']['const']) for b in c.CONDITION['oneOf']}
        self.assertEqual(advertised,{(m,o) for m,ops in c.CONDITION_OPERATORS.items() for o in ops})
        for metric,op in advertised:
            row=watch();row['revisitCondition'].update(metric=metric,operator=op)
            if op!='BETWEEN':row['revisitCondition'].pop('upperValue')
            self.args['candidateAssessments']=[row]
            self.assertEqual(self.report()['reportingStatus'],'COMPLETE',(metric,op))
    def test_json_schema_and_host_agree_on_all_metric_operator_pairs(self):
        try:from jsonschema import Draft202012Validator
        except ImportError:self.skipTest('Independent JSON Schema library is test-only; parity validated on local host')
        Draft202012Validator.check_schema(c.CONDITION)
        validator=Draft202012Validator(c.CONDITION)
        for metric in (*c.CONDITION_OPERATORS,'UNKNOWN'):
            for op in ('LTE','GTE','GT','LT','BETWEEN'):
                for value in (-1,0,1):
                    row=watch();condition=row['revisitCondition']
                    condition.update(metric=metric,operator=op,value=value)
                    if op!='BETWEEN':condition.pop('upperValue')
                    self.args['candidateAssessments']=[row]
                    self.assertEqual(validator.is_valid(condition),self.report()['reportingStatus']=='COMPLETE',(metric,op,value))
    def test_invalid_pair_and_extraneous_upper_bound_rejected(self):
        for metric,op in [('closedCandleTime','LTE'),('executableSpreadBps','GTE'),('executablePrice','GT')]:
            row=watch();row['revisitCondition'].update(metric=metric,operator=op)
            self.args['candidateAssessments']=[row]
            self.assertEqual(self.report()['reportingStatus'],'INCOMPLETE')
    def test_nonpositive_or_nonfinite_price_rejected(self):
        for value in (0,-1,float('nan'),float('inf'),True):
            row=watch();row['revisitCondition'].update(operator='LTE',value=value)
            row['revisitCondition'].pop('upperValue');self.args['candidateAssessments']=[row]
            self.assertEqual(self.report()['reportingStatus'],'INCOMPLETE')
    def test_mixed_batch_keeps_symbol_nuance(self):
        self.args['assessedOpportunityIds'].append('candidate-b')
        self.args['candidateAssessments'].append({'opportunityId':'candidate-b','symbol':'BBBUSDT',
            'candidateDisposition':'NO_TRADE','reasonCode':'NO_STRUCTURE','reason':'No defensible structure in this snapshot.'})
        r=self.report();self.assertEqual([x['candidateDisposition'] for x in r['candidates']],['WATCH','NO_TRADE'])
    def test_missing_does_not_infer_from_batch_reason(self):
        self.args.pop('candidateAssessments');self.args['reason']='Everything is extended'
        self.assertEqual(self.report()['candidates'][0]['candidateDisposition'],'UNKNOWN')
    def test_missing_expired_or_wrong_watch_conditions_are_incomplete(self):
        for field,value in [('expiresAt',99),('expiresAt',True),('revisitCondition',{}),('invalidation','')]:
            with self.subTest(field=field,value=value):
                self.args['candidateAssessments']=[{**watch(),field:value}]
                self.assertEqual(self.report()['reportingStatus'],'INCOMPLETE')
    def test_wrong_symbol_or_duplicates_do_not_become_valid(self):
        self.args['candidateAssessments'][0]['symbol']='WRONGUSDT'
        self.assertEqual(self.report()['reportingStatus'],'INCOMPLETE')
        self.args['candidateAssessments']=[watch(),watch()]
        self.assertEqual(self.report()['candidates'][0]['candidateDisposition'],'UNKNOWN')
    def test_unknown_candidate_not_silently_accepted(self):
        self.args['candidateAssessments'].append({**watch(),'opportunityId':'unseen'})
        self.assertEqual(self.report()['issues'],['UNASSESSED_OR_INVALID_ROW'])
    def test_claimed_edge_cannot_enter_report(self):
        self.args['candidateAssessments'][0]['estimatedNetEdge']=99
        r=self.report()['candidates'][0]
        self.assertEqual(r['candidateDisposition'],'UNKNOWN');self.assertEqual(r['estimatedNetEdge'],'UNKNOWN')
    def test_plan_wait_is_not_candidate_watch(self):
        self.args['action']='WAIT';self.assertIsNone(self.report())
    def test_reporting_never_applies_to_entry(self):
        self.args['action']='ENTER_LONG';self.assertIsNone(self.report())
    def test_frozen_inputs_unmodified(self):
        before=copy.deepcopy(self.args);self.report();self.assertEqual(before,self.args)
    def test_unconfirmed_result_not_reported_as_no_position(self):
        records=[{'kind':'DECISION_INTENT','jobId':'job','decisionId':'decision-a','candidateReport':self.report()}]
        self.assertEqual(c.cycle_reports(records,'job',[])[0]['decisionExecutionOutcome'],'UNCONFIRMED')
        actions=[{'decisionId':'decision-a','outcome':'VALID_NO_TRADE'}]
        report=c.cycle_reports(records,'job',actions)
        self.assertIn('WATCH',c.render_reports(report));self.assertIn('NO_NEW_POSITION',c.render_reports(report))
    def test_malformed_array_is_report_error_not_execution_exception(self):
        for value in (None,42,'oops',{},[None]):
            self.args['candidateAssessments']=value
            self.assertEqual(self.report()['reportingStatus'],'INCOMPLETE')

if __name__=='__main__':unittest.main()

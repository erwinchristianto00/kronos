import copy,json,unittest
from astra_v8_runner import fast_trial_context,bounded_context,IntegrationError

class FastContextSizeTest(unittest.TestCase):
    def test_preserves_all_non_coaching_fields_exactly(self):
        t={'assignment':{'version':'v','arm':'CONTROL'},'assignedStrategy':{'risk':0.25,'text':'unchanged'},
           'gates':{'minN':75},'postPromotionWatch':{'rollback':True},'unknownFutureGate':{'v':1},
           'progress':{'huge':'x'*10000},'recentStudies':[{'data':'y'*10000}]}
        before=copy.deepcopy(t);p=fast_trial_context(t)
        for k,v in t.items():
            if k not in ('progress','recentStudies'):self.assertEqual(p[k],v)
        self.assertEqual(t,before)
        self.assertNotIn('progress',p);self.assertNotIn('recentStudies',p)
        self.assertEqual(p['coachingOnlyFields'],['progress','recentStudies'])
    def test_large_history_does_not_block_bounded_fast_payload(self):
        c={'market':{'data':'x'*51000},'strategyTrial':{'assignedStrategy':'y'*4200,'gates':{'risk':1},'recentStudies':['z'*12000]}}
        with self.assertRaises(IntegrationError):bounded_context(c)
        c['strategyTrial']=fast_trial_context(c['strategyTrial'])
        self.assertEqual(bounded_context(c),c)
    def test_large_required_payload_still_rejected_with_diagnostics(self):
        with self.assertRaisesRegex(IntegrationError,'serializedChars=.*fields='):
            bounded_context({'positions':['x'*65000]})
    def test_bound_not_raised(self):
        c={'x':''};overhead=len(json.dumps(c,separators=(',',':')));c['x']='x'*(64000-overhead)
        self.assertEqual(bounded_context(c),c)
        c['x']+='x'
        with self.assertRaises(IntegrationError):bounded_context(c)
    def test_invalid_numbers_rejected(self):
        with self.assertRaises(ValueError):bounded_context({'risk':float('nan')})
    def test_no_alias(self):
        t={'gates':{'a':1}};p=fast_trial_context(t);p['gates']['a']=2;self.assertEqual(t['gates']['a'],1)

if __name__=='__main__':unittest.main()

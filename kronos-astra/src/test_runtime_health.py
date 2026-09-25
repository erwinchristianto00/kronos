import sys,types,unittest
try:import shadow_projection
except ModuleNotFoundError:sys.modules.setdefault('shadow_projection',types.SimpleNamespace(collect_shadows=lambda _:{}))
from runtime_projection import projection

class HealthTests(unittest.TestCase):
    def result(self, extra=None, poll=950, **overrides):
        bad={'id':'bad','mode':'FAST_TRADING','at':100,'finishedAt':200,'result':{'outcome':'INTEGRATION_BLOCKED','error':'too large'}}
        jobs={'bad':bad}
        if extra:jobs['new']=extra
        return projection({'fingerprint':'x','armed':True}, {'fingerprint':'x','lastPollAt':poll,
            'router':{'modelPolicyVersion':'SONNET_MEDIUM_OPUS_REVIEW_V1'},'claudeAvailability':{'status':'READY'},'jobs':jobs,**overrides},True,'test',1000)
    def test_unresolved_error(self):self.assertEqual(self.result()['status'],'RUNNING_WITH_ERRORS')
    def good(self,mode='FAST_TRADING',completed=True):
        return {'id':'new','mode':mode,'at':300,'finishedAt':400,'result':{'outcome':'MODEL_DECISION','completed':completed}}
    def test_later_success_keeps_history(self):
        r=self.result(self.good());self.assertEqual(r['status'],'RUNNING');self.assertEqual(r['latestFailure']['id'],'bad');self.assertEqual(r['historicalFailureN'],1)
    def test_other_mode_does_not_mask(self):self.assertEqual(self.result(self.good('COACHING'))['status'],'RUNNING_WITH_ERRORS')
    def test_incomplete_not_success(self):self.assertEqual(self.result(self.good(completed=False))['status'],'RUNNING_WITH_ERRORS')
    def test_staleness_still_wins(self):self.assertEqual(self.result(self.good(),-400000)['status'],'STALE')
    def test_budget_exhaustion_visible_not_provider_failure(self):
        b={'version':'SPLIT_MODEL_BUDGET_V1','observedAt':900,'resetsAt':86400000,
           'FAST_TRADING':{'status':'EXHAUSTED'},'COACHING':{'status':'AVAILABLE'}}
        self.assertEqual(self.result(self.good(),modelCallBudgets=b)['status'],'RUNNING_TRADING_BUDGET_EXHAUSTED')
        b['FAST_TRADING']['status']='AVAILABLE';b['COACHING']['status']='EXHAUSTED'
        self.assertEqual(self.result(self.good(),modelCallBudgets=b)['status'],'RUNNING')
        b['observedAt']=-400000
        self.assertIsNone(self.result(self.good(),modelCallBudgets=b)['modelCallBudgets'])
    def test_loop_error_not_hidden_by_completed_job(self):
        self.assertEqual(self.result(self.good(),lastLoopError={'at':900,'error':'blocked'},lastHealthyTickAt=800)['status'],'RUNNING_WITH_ERRORS')
        self.assertEqual(self.result(self.good(),lastLoopError={'at':900,'error':'blocked'},lastHealthyTickAt=950)['status'],'RUNNING')

if __name__=='__main__':unittest.main()

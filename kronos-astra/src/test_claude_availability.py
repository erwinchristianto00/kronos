import tempfile,unittest,json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from claude_availability import Availability,valid,MODELS,LEASE_MS
from astra_v8_host import atomic_json
from astra_v8_supervisor import Supervisor

def success(at):return {'checkedAt':at,'passed':True,'checks':[{'model':m,'effort':e,'passed':True} for m,e in MODELS]}
class WaitArmTests(unittest.TestCase):
    def test_no_evidence_is_not_ready(self):self.assertFalse(valid({},100))
    def test_exact_both_models_required(self):
        s=success(100);self.assertTrue(valid(s,101));s['checks'][0]['model']='gpt-6-astra';self.assertFalse(valid(s,101))
    def test_stale_future_rejected(self):
        self.assertFalse(valid(success(100),99));self.assertFalse(valid(success(100),100+LEASE_MS))
    def test_one_failed_model_blocks(self):
        s=success(100);s['checks'][1]['passed']=False;self.assertFalse(valid(s,101))
    def test_backoff_no_spawn(self):
        with tempfile.TemporaryDirectory() as root,patch('claude_availability.subprocess.Popen') as popen:
            a=Availability(root,lambda:100);a.failed();self.assertFalse(a.tick([],60));popen.assert_not_called()
    def test_daily_budget_preserved(self):
        with tempfile.TemporaryDirectory() as root,patch('claude_availability.subprocess.Popen') as popen:
            a=Availability(root,lambda:100);calls=[{'at':100}]*59;self.assertFalse(a.tick(calls,60));popen.assert_not_called();self.assertEqual(len(calls),59)
    def test_probe_reserves_two_calls(self):
        with tempfile.TemporaryDirectory() as root,patch('claude_availability.subprocess.Popen') as popen:
            a=Availability(root,lambda:100);calls=[];self.assertFalse(a.tick(calls,60));self.assertEqual(len(calls),2);popen.assert_called_once()
    def test_success_automatically_unlocks(self):
        with tempfile.TemporaryDirectory() as root:
            a=Availability(root,lambda:101);a.started=100;a.proc=SimpleNamespace(poll=lambda:0)
            atomic_json(a.result_path,{**success(100),'probeStartedAt':100})
            self.assertTrue(a.tick([],60));self.assertEqual(a.state['status'],'READY')
    def test_stale_probe_result_does_not_unlock(self):
        with tempfile.TemporaryDirectory() as root:
            a=Availability(root,lambda:101);a.started=100;a.proc=SimpleNamespace(poll=lambda:0)
            atomic_json(a.result_path,{**success(100),'probeStartedAt':99})
            self.assertFalse(a.tick([],60));self.assertFalse(a.ready())
    def test_dispatch_cannot_bypass_wait(self):
        s=Supervisor.__new__(Supervisor);s.manifest={'claudeWaitArm':True};s.claude_availability=SimpleNamespace(ready=lambda:False)
        with self.assertRaisesRegex(ValueError,'WAITING_FOR_CLAUDE'):s.dispatch({})
    def test_provider_failure_revokes_readiness(self):
        with tempfile.TemporaryDirectory() as root:
            a=Availability(root,lambda:101);a.state.update(status='READY',result=success(100));self.assertTrue(a.ready());a.failed();self.assertFalse(a.ready())

if __name__=='__main__':unittest.main()

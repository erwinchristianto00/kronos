import copy,tempfile,unittest
from unittest.mock import Mock,patch
from astra_cadence import split_model_budgets,DAY_MS,merged_config
from astra_v8_supervisor import Supervisor
from claude_availability import Availability

class SplitBudgetTests(unittest.TestCase):
    def ledger(self):
        return [{'at':100,'mode':'FAST_TRADING'} for _ in range(79)]+[{'at':100,'mode':'COACHING'} for _ in range(11)]
    def test_actual_legacy_day_migrates_without_reset(self):
        calls=self.ledger();before=copy.deepcopy(calls)
        b=split_model_budgets(calls,{'dailyModelCallBudget':90,'dailyCoachingCallBudget':24},200)
        self.assertEqual(b['FAST_TRADING']['remaining'],11)
        self.assertEqual(b['COACHING']['remaining'],13)
        self.assertEqual(calls,before)
    def test_isolation_both_directions(self):
        for mode,other in [('FAST_TRADING','COACHING'),('COACHING','FAST_TRADING')]:
            b=split_model_budgets([{'at':100,'mode':mode}]*90,{'dailyModelCallBudget':90,'dailyCoachingCallBudget':24},200)
            self.assertEqual(b[mode]['status'],'EXHAUSTED');self.assertEqual(b[other]['used'],0)
    def test_reset_utc_and_future_day_excluded(self):
        b=split_model_budgets(self.ledger()+[{'at':DAY_MS*2,'mode':'COACHING'}],{},DAY_MS)
        self.assertEqual(b['FAST_TRADING']['used'],0);self.assertEqual(b['COACHING']['used'],0)
        self.assertEqual(b['resetsAt'],DAY_MS*2)
    def test_probes_and_unknown_are_not_free(self):
        b=split_model_budgets([{'at':1},{'at':1,'mode':'CLAUDE_HEALTH_PROBE'}],{},2)
        self.assertEqual(b['FAST_TRADING']['used'],2);self.assertEqual(b['unknownModeN'],1)
    def test_coaching_allowed_after_trading_exhausted(self):
        s=Supervisor.__new__(Supervisor);s.config={'dailyModelCallBudget':1,'reviewIntervalMs':1}
        s.state={'calls':[{'at':100,'mode':'FAST_TRADING'}]};s.live_job=Mock(return_value=False)
        s.canonical_input=Mock(side_effect=RuntimeError('REACHED_EVIDENCE_SELECTION'))
        with patch('astra_v8_supervisor.now',return_value=100):
            with self.assertRaisesRegex(RuntimeError,'REACHED_EVIDENCE_SELECTION'):s.coach_if_due()
    def test_provider_probe_does_not_count_coaching(self):
        with tempfile.TemporaryDirectory() as root,patch('claude_availability.subprocess.Popen') as popen:
            a=Availability(root,lambda:200);a.state.update(reason='EXISTING_DAILY_MODEL_BUDGET',nextProbeAt=DAY_MS)
            calls=self.ledger();a.tick(calls,90,exclude_modes=('COACHING',))
            popen.assert_called_once();self.assertEqual(len(calls),92)
            b=split_model_budgets(calls,{'dailyModelCallBudget':90},200)
            self.assertEqual(b['FAST_TRADING']['used'],81);self.assertEqual(b['COACHING']['used'],11)
    def test_config_validation(self):
        self.assertEqual(merged_config({'dailyCoachingCallBudget':24})['dailyCoachingCallBudget'],24)
        for bad in (-1,True,'24'):
            with self.assertRaises(ValueError):split_model_budgets([],{'dailyCoachingCallBudget':bad},100)
    def test_provider_failure_keeps_backoff_after_budget_split(self):
        with tempfile.TemporaryDirectory() as root,patch('claude_availability.subprocess.Popen') as popen:
            a=Availability(root,lambda:200);a.state['reason']='EXISTING_DAILY_MODEL_BUDGET'
            a.failed();a.tick(self.ledger(),90,exclude_modes=('COACHING',))
            popen.assert_not_called()

if __name__=='__main__':unittest.main()

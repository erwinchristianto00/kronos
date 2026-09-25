import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
import hermes_model_policy_v1 as R
import astra_v8_runner as worker
import astra_v8_supervisor as supervisor
from astra_canonical_v8 import CanonicalBook


class FixedPolicyTests(unittest.TestCase):
    def test_exact_mapping(self):
        for task,model,effort in ((R.FAST_TRADING,'claude-sonnet-5','medium'),
                                  (R.COACHING,'claude-opus-5','high'),(R.DEEP_REVIEW,'claude-opus-5','max')):
            self.assertEqual(R.policy(task),dict(task=task,role=R.PRIMARY,model=model,provider='anthropic',effort=effort))

    def test_no_fallback_or_escalation_policy(self):
        for task in R.TASKS:
            for role in (R.FALLBACK,R.ESCALATION):
                with self.assertRaises(ValueError): R.policy(task,role)
        for model,effort in (('gpt-6-astra','medium'),('claude-sonnet-5','high'),('claude-opus-5','high'),('claude-opus-5','max')):
            self.assertFalse(R.is_declared({**R.policy(R.FAST_TRADING),'model':model,'effort':effort}))

    def test_old_state_rejected_without_mutation(self):
        state={'routerState':'CLAUDE_FALLBACK','primaryModel':'gpt-6-astra'}
        before=copy.deepcopy(state)
        with self.assertRaises(ValueError): R.Router(state,lambda:100)
        self.assertEqual(before,state)

    def test_failure_recorded_without_routing_change(self):
        s=supervisor.Supervisor.__new__(supervisor.Supervisor)
        s.state={'jobs':{}}
        s.save=lambda:None
        job={'mode':R.FAST_TRADING,'modelPolicy':R.policy(R.FAST_TRADING)}
        for error in ('429 quota exhausted','503 unavailable','401 unauthorized','unknown model','timeout',None,'HOLD','NO_TRADE'):
            s.route_result(job,{'error':error})
            self.assertEqual(s.model_policy(R.FAST_TRADING),R.policy(R.FAST_TRADING))
            self.assertEqual(s.state['router']['primaryFailureReason'],R.classify_provider_error(error))
        with patch.object(s,'start_probe') as probe:
            s.model_health_tick()
        probe.assert_not_called()
        with self.assertRaises(ValueError): s.switch_model('FALLBACK','failure')
        with self.assertRaises(ValueError): s.start_probe('PRIMARY')

    def test_wrong_task_policy_and_legacy_job_fail_before_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            for spec in (R.policy(R.COACHING),R.policy(R.DEEP_REVIEW),
                         {**R.policy(R.FAST_TRADING),'model':'gpt-6-astra'}):
                job={'id':'bad','cohortId':R.COHORT,'fingerprint':'f','mode':R.FAST_TRADING,
                     'context':{},'modelPolicy':spec}
                with self.assertRaises(worker.IntegrationError):
                    worker.JobSession(tmp,job,R.FAST_TRADING,None,CanonicalBook(),worker.Journal(tmp,R.FAST_TRADING))
            with self.assertRaises(worker.IntegrationError):
                worker.run_job(tmp,{'id':'legacy','cohortId':'ASTRA_QUANT_TRADE_MANAGER_V4','fingerprint':'f','mode':R.FAST_TRADING})

    def test_deep_review_is_separate_nontrading_job(self):
        with tempfile.TemporaryDirectory() as tmp:
            job={'id':'audit-1','cohortId':R.COHORT,'fingerprint':'new-fingerprint','mode':R.DEEP_REVIEW,
                 'context':{'canonicalEvidence':[]},'events':[], 'modelPolicy':R.policy(R.DEEP_REVIEW),
                 'auditReason':'CONFLICTING_LESSONS'}
            def factory(**kwargs):
                session=kwargs['session']
                self.assertEqual(session.model_policy['effort'],'max')
                self.assertEqual(session.context['mode'],R.DEEP_REVIEW)
                for name in ('astra_enter','astra_plan','astra_decide','astra_experiment'):
                    self.assertIn('error',session.call(name,{}))
                self.assertIn('canonicalEvidence',session.call('astra_context',{}))
                return SimpleNamespace(run_conversation=lambda p:{'completed':True,'api_calls':0},close=lambda:None)
            worker.run_job(tmp,job,agent_factory=factory)
            self.assertTrue((Path(tmp)/'logs/astra-v8-deep_review.jsonl').exists())

    def test_routine_coaching_stays_high_even_after_failures(self):
        r=R.Router({},lambda:100)
        r.record_result(R.policy(R.FAST_TRADING),'429 quota')
        self.assertEqual(r.policy_for(R.COACHING)['effort'],'high')
        self.assertEqual(r.policy_for(R.DEEP_REVIEW)['effort'],'max')

    def test_deep_review_requires_explicit_audit_reason(self):
        with tempfile.TemporaryDirectory() as tmp:
            job={'id':'routine','cohortId':R.COHORT,'fingerprint':'f','context':{},'modelPolicy':R.policy(R.DEEP_REVIEW)}
            with self.assertRaises(worker.IntegrationError):
                worker.JobSession(tmp,job,R.DEEP_REVIEW,None,CanonicalBook(),worker.Journal(tmp,R.DEEP_REVIEW))

    def test_provider_constructor_gets_exact_model_effort_and_no_fallback(self):
        import sys
        from unittest.mock import Mock
        calls=[]
        def create(**kw):
            calls.append(kw)
            return SimpleNamespace(model=kw['model'],provider=kw['provider'],tools=[{'name':n} for n in worker.ALLOWLIST],close=lambda:None)
        provider=SimpleNamespace(resolve_runtime_provider=lambda **kw:dict(provider='anthropic',api_key='FAKE_TEST_ONLY',base_url='https://not-used.invalid',api_mode='anthropic_messages'))
        init=SimpleNamespace(_init_memory=lambda *a:None)
        modules={'hermes_cli':SimpleNamespace(), 'hermes_cli.runtime_provider':provider,
                 'hermes_state':SimpleNamespace(SessionDB=lambda **kw:SimpleNamespace(close=lambda:None)),
                 'run_agent':SimpleNamespace(AIAgent=create),'agent':SimpleNamespace(agent_init=init),
                 'tools':SimpleNamespace(),'tools.registry':SimpleNamespace(registry=SimpleNamespace(register=Mock()))}
        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules,modules), patch.object(worker,'tool_schemas',return_value={}):
            for task in R.TASKS:
                session=SimpleNamespace(model_policy=R.policy(task),root=Path(tmp),mode=task,engine=SimpleNamespace(),session_id=task)
                worker.make_agent(session=session,system_prompt='test',max_turns=12,budget_seconds=240)
        self.assertEqual([(c['model'],c['reasoning_config']['effort']) for c in calls],
                         [('claude-sonnet-5','medium'),('claude-opus-5','high'),('claude-opus-5','max')])
        self.assertTrue(all(c['fallback_model'] is None for c in calls))

if __name__=='__main__': unittest.main()

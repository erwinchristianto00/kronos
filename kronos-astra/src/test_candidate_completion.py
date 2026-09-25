import copy
import sys
import unittest
from types import SimpleNamespace as NS, ModuleType
from unittest.mock import patch
import astra_v8_runner as R


class CompletionTests(unittest.TestCase):
    def setUp(self):
        row={'opportunityId':'c1','symbol':'AAAUSDT','reportingStatus':'COMPLETE',
             'candidateDisposition':'NO_TRADE','issues':[], 'reason':'Unverified model rationale'}
        report={'reportingStatus':'COMPLETE','candidates':[row]}
        self.action={'action':'NO_TRADE','outcome':'VALID_NO_TRADE','validAction':True,'decisionId':'d1'}
        self.intent={'kind':'DECISION_INTENT','jobId':'j','decisionId':'d1','candidateReport':report}
        self.s=NS(mode=R.FAST_TRADING,positions={},job={'id':'j'},
            context={'marketCandidates':[{'opportunityId':'c1','symbol':'AAAUSDT'}]},
            actions=[self.action],journal=NS(records=[self.intent]))

    def test_complete_factual_receipt_not_rewritten_model_prose(self):
        result=R.confirmed_candidate_completion(self.s)
        self.assertIn('HOST-CONFIRMED',result)
        self.assertNotIn('Unverified model rationale',result)
        self.assertIn('not factual accuracy',result)
        self.assertIn('UNKNOWN',result)

    def test_rejects_incomplete_or_unknown_reports(self):
        for field,value in [('reportingStatus','INCOMPLETE'),('candidateDisposition','UNKNOWN'),
                            ('issues',['WRONG']),('symbol','OTHER'),('opportunityId','other')]:
            with self.subTest(field=field):
                s=copy.deepcopy(self.s);s.journal.records[0]['candidateReport']['candidates'][0][field]=value
                self.assertIsNone(R.confirmed_candidate_completion(s))

    def test_no_terminal_for_entries_plans_positions_coaching_or_partial_coverage(self):
        variants=[]
        for outcome in ('REJECTED_BY_POLICY','UNRESOLVED_RECONCILE','OPEN','PLAN_UPDATED'):
            s=copy.deepcopy(self.s);s.actions[0]['outcome']=outcome;variants.append(s)
        s=copy.deepcopy(self.s);s.context['opportunities']=[{'opportunityId':'p'}];variants.append(s)
        s=copy.deepcopy(self.s);s.positions={'owned':{}};variants.append(s)
        s=copy.deepcopy(self.s);s.mode='COACHING';variants.append(s)
        s=copy.deepcopy(self.s);s.context['marketCandidates'].append({'opportunityId':'c2','symbol':'B'});variants.append(s)
        s=copy.deepcopy(self.s);s.actions=[];variants.append(s)
        s=copy.deepcopy(self.s);s.journal.records=[];variants.append(s)
        s=copy.deepcopy(self.s);s.journal.records*=2;variants.append(s)
        for s in variants:self.assertIsNone(R.confirmed_candidate_completion(s))

    def run_adapter(self, *, halt=False, persistence=False, interrupted=False, tool_error=False, other_tool=False):
        self.s.actions=[];self.s.journal.records=[]
        agent=NS(_astra_candidate_terminal=True,max_iterations=12,is_interrupted=interrupted,
                 _incremental_persistence_failed=persistence,_tool_guardrail_halt_decision=None)
        verdict=NS(action='break' if halt else 'continue',failed=False,final_response=None,_turn_exit_reason=None)
        def original(current_agent, **kwargs):
            self.s.actions.append(self.action);self.s.journal.records.append(self.intent)
            if tool_error:self.s.journal.records.append({'kind':'TOOL_REJECTED'})
            return verdict
        loop=ModuleType('agent.conversation_loop');loop.run_tool_round=original
        package=ModuleType('agent');package.conversation_loop=loop
        with patch.dict(sys.modules,{'agent':package,'agent.conversation_loop':loop}):
            with R.candidate_terminal_scope(agent,self.s):
                result=loop.run_tool_round(agent,api_call_count=1,
                    assistant_message=NS(tool_calls=[NS(function=NS(name='astra_enter' if other_tool else 'astra_decide'))]))
            self.assertIs(loop.run_tool_round,original)
        return agent,result

    def test_complete_original_round_before_clean_terminal(self):
        agent,result=self.run_adapter()
        self.assertEqual(result.action,'break')
        self.assertEqual(result._turn_exit_reason,'host_confirmed_candidate_completion')
        self.assertTrue(agent._astra_host_terminal)

    def test_never_masks_errors_or_interrupts(self):
        for key in ('halt','persistence','interrupted','tool_error','other_tool'):
            with self.subTest(key=key):
                agent,result=self.run_adapter(**{key:True})
                self.assertFalse(getattr(agent,'_astra_host_terminal',False))


if __name__=='__main__':unittest.main()

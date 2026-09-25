import copy
import json
import unittest
import tempfile
import types
from pathlib import Path
from unittest.mock import patch
import astra_watch_queue as w
import candidate_disposition as c

AT = 1800000

def report(symbol='AAAUSDT', at=AT, disposition='WATCH'):
    row = {'opportunityId': 'candidate-'+symbol, 'symbol': symbol, 'candidateDisposition': disposition,
           'reasonCode': 'ENTRY_DISPLACEMENT', 'reason': 'Wait for the observed entry structure.'}
    if disposition == 'WATCH':
        row.update(revisitCondition={'metric': 'executablePrice', 'operator': 'LTE', 'value': 10,
                    'basis': 'Previously observed consolidation price.'}, expiresAt=at+3600000,
                   invalidation='Abandon if the observed structure is invalidated.')
    r = c.build_report({'id': 'decision-'+str(at), 'action': 'NO_TRADE',
                       'assessedOpportunityIds': [row['opportunityId']], 'candidateAssessments': [row]},
                      {'marketCandidates': [row]}, at)
    return {**r, 'hostOutcome': 'VALID_NO_TRADE'}

def observation(at=AT, bid=9.8, ask=9.9):
    return {'book': {'bid': bid, 'ask': ask, 'time': at}, 'closedCandleTime': at-1}

class WatchTests(unittest.TestCase):
    def setUp(self):
        self.q = w.init({})
        w.ingest(self.q, [report()], AT)

    def test_persistence_idempotency_and_no_execution(self):
        w.ingest(self.q, [report()], AT+1)
        q = json.loads(json.dumps(self.q))
        self.assertEqual(len(q['items']), 1)
        self.assertEqual(len(q['events']), 1)
        self.assertFalse(q['items']['AAAUSDT']['executionAuthority'])
        self.assertNotIn('plan', q['items']['AAAUSDT'])

    def test_unconfirmed_or_unknown_not_registered(self):
        for r in [{**report('BBBUSDT'), 'hostOutcome': 'REJECTED_BY_POLICY'},
                  {**report('BBBUSDT'), 'assessedAt': AT+1}]:
            w.ingest(self.q, [r], AT)
        r=report('BBBUSDT');r['candidates'][0]['reportingStatus']='INCOMPLETE'
        w.ingest(self.q,[r],AT)
        self.assertNotIn('BBBUSDT',self.q['items'])

    def test_trigger_ready_and_missing_stale_future_rejected(self):
        for obs in [{}, observation(AT-60001), observation(AT+1), observation(AT,10,9)]:
            w.observe(self.q, {'AAAUSDT':obs}, AT)
            self.assertEqual(w.due(self.q), [])
        w.observe(self.q, {'AAAUSDT':observation()}, AT)
        self.assertEqual(len(w.due(self.q)),1)

    def test_all_condition_operators_and_no_side_inference(self):
        row=self.q['items']['AAAUSDT']
        self.assertFalse(w.condition(row, observation(AT,9.9,10.1),AT))
        row['revisitCondition'].update(operator='GTE',value=9.8)
        self.assertTrue(w.condition(row,observation(),AT))
        row['revisitCondition'].update(operator='BETWEEN',value=9.8,upperValue=10)
        self.assertTrue(w.condition(row,observation(),AT))
        row['revisitCondition']={'metric':'executableSpreadBps','operator':'LTE','value':102}
        self.assertTrue(w.condition(row,observation(),AT))
        row['revisitCondition']={'metric':'closedCandleTime','operator':'GT','value':AT-300000}
        self.assertTrue(w.condition(row,observation(),AT))
        self.assertFalse(w.condition(row,{'closedCandleTime':AT+1},AT))

    def test_expiry_and_owned_plan_suppression(self):
        w.observe(self.q, {'AAAUSDT':observation()}, AT, {'AAAUSDT'})
        self.assertEqual(w.due(self.q),[])
        w.observe(self.q, {}, AT+3600000)
        self.assertEqual(self.q['items']['AAAUSDT']['status'],'EXPIRED')

    def test_dispatch_restart_cooldown_and_new_candle(self):
        row=self.q['items']['AAAUSDT']
        w.mark_dispatched(self.q,[row['id']],'job',AT)
        self.q=json.loads(json.dumps(self.q))
        w.observe(self.q,{'AAAUSDT':observation()},AT+1)
        self.assertEqual(w.due(self.q),[])
        w.finish(self.q,'job',AT+2)
        w.observe(self.q,{'AAAUSDT':observation(AT+3)},AT+3)
        self.assertEqual(w.due(self.q),[])
        w.observe(self.q,{'AAAUSDT':observation(AT+300001)},AT+300001)
        self.assertEqual(len(w.due(self.q)),1)

    def test_renewed_watch_carries_cooldown_no_trade_closes(self):
        row=self.q['items']['AAAUSDT'];w.mark_dispatched(self.q,[row['id']],'job',AT)
        w.finish(self.q,'job',AT+1)
        w.ingest(self.q,[report(at=AT+2)],AT+2)
        self.assertEqual(self.q['items']['AAAUSDT']['lastDeliveredAt'],AT)
        w.ingest(self.q,[report(at=AT+3,disposition='NO_TRADE')],AT+3)
        self.assertEqual(self.q['items']['AAAUSDT']['status'],'CLOSED_NO_TRADE')

    def test_overflow_retained_and_fair_order(self):
        for i in range(30):w.ingest(self.q,[report(str(i)+'USDT')],AT)
        w.observe(self.q,{s:observation() for s in self.q['items']},AT)
        first=w.due(self.q)[:w.MAX_EXTRA]
        w.mark_dispatched(self.q,[r['id'] for r in first],'job',AT)
        self.assertEqual(len(w.due(self.q)),13)
        self.assertEqual(len(self.q['items']),31)

    def test_context_overflow_never_removes_six_fresh(self):
        fresh=[str(i)+'USDT' for i in range(6)]
        candidates=[{'symbol':s} for s in fresh]+[
            {'symbol':'W'+str(i)+'USDT','watchReassessment':{'id':str(i)},'payload':'x'*500} for i in range(3)]
        context={'marketCandidates':candidates,'opportunities':[]}
        raw={'status':{'active':[]},'rows':[{'symbol':r['symbol']} for r in candidates]}
        with patch('astra_quant_v4.contract',return_value={}):
            deferred=w.fit_context(context,raw,fresh,AT,limit=800)
        self.assertEqual([r['symbol'] for r in context['marketCandidates'][:6]],fresh)
        self.assertEqual(len(context['marketCandidates']),7)
        self.assertEqual(deferred,['2','1'])

    def test_public_poll_no_order_routes(self):
        routes=[]
        def read(path,params):
            routes.append(path)
            return {'symbol':params['symbol'],'bidPrice':'9','askPrice':'9.1','time':AT}
        poll=w.WatchPoll(read)
        poll._read(list(self.q['items'].values()))
        self.assertEqual(routes,['/fapi/v1/ticker/bookTicker'])
        self.assertIn('AAAUSDT',poll.messages.get_nowait())


class SupervisorWatchIntegration(unittest.TestCase):
    def run_batch(self, watch_n=3, budget=60, ready=True, preparation=None):
        import astra_v8_supervisor as s
        from test_astra_v8_supervisor import EnrolledSlotOutcomeTests
        t=tempfile.TemporaryDirectory();self.addCleanup(t.cleanup)
        sup=EnrolledSlotOutcomeTests().supervisor(t.name,lastFormationAt=0)
        sup.config['dailyModelCallBudget']=budget
        sup.coverage=s.CoverageBook(Path(t.name)/'coverage.json')
        q=w.init(sup.state)
        for i in range(watch_n):w.ingest(q,[report('W'+str(i)+'USDT')],AT)
        observations={key:observation(AT,9,9.1) if ready else observation(AT,11,12) for key in q['items']}
        sup.watch_poll=types.SimpleNamespace(poll=lambda q,at:observations,observations=observations)
        fresh=[str(i)+'USDT' for i in range(6)]
        exclusions=[]
        def selection(coverage,at,exclude_symbols=()):
            exclusions.extend(exclude_symbols)
            return {'selected':[{'symbol':symbol} for symbol in fresh]}
        sup.dynamic_scan=types.SimpleNamespace(poll=lambda at:{},selection=selection,state={'universe':fresh+list(q['items'])})
        sup.quant_reference_cache=types.SimpleNamespace(context=lambda:{})
        sent=[];sup.dispatch=lambda job:sent.append(copy.deepcopy(job))
        status={'environment':'testnet','source':'BINANCE_USDM_TESTNET','active':[],'executionVersion':'expected'}
        def raw(symbols):
            return {'source':'BINANCE_USDM_TESTNET','status':status,'unavailableSymbols':[],
                    'rows':[{'symbol':symbol,'observedAt':AT,'book':observation(AT,9,9.1)['book'],
                             'candles':[{'closeTime':AT-1,'close':9.1}],'economics':{}} for symbol in symbols]}
        if preparation:
            sup.formation_reader=types.SimpleNamespace(
                poll=lambda selected,at:None if preparation=='PENDING' else
                    {'raw':raw(fresh),'selection':selected,'startedAt':AT-1000},
                summary=lambda at:{'status':'PREPARING'})
        plans=types.SimpleNamespace(state={'plans':[]},observe=lambda r:None,view=lambda p:p,expire_unsubmitted=lambda s:[])
        with patch.object(s,'now',return_value=AT), patch.object(s.engine,'gateway',return_value=status), \
             patch.object(s.engine,'validate_capital_identity'), patch.object(s.engine,'execution_config',return_value={}), \
             patch.object(s,'validate_assignment'),patch.object(s,'PlanBook',return_value=plans), \
             patch.object(s,'fetch_formation',side_effect=lambda c,r:raw(r['symbols'])), \
             patch.object(s,'fetch_histories',side_effect=lambda g,symbols,**kwargs:raw(symbols)), \
             patch.object(s,'refresh_candidates',side_effect=lambda r:r):
            sup._tick()
        return sup,sent,fresh,exclusions

    def test_six_fresh_plus_three_watch_nine_delivered_separate_accounting(self):
        sup,sent,fresh,excluded=self.run_batch()
        self.assertEqual(len(sent),1)
        candidates=sent[0]['context']['marketCandidates']
        self.assertEqual(len(candidates),9)
        self.assertEqual([r['symbol'] for r in candidates[:6]],fresh)
        self.assertEqual(set(excluded),{'W0USDT','W1USDT','W2USDT'})
        reservation=next(iter(sup.coverage.state['jobs'].values()))
        self.assertEqual(reservation['symbols'],fresh)
        self.assertEqual(sum(r['status']=='IN_FLIGHT' for r in sup.state['watchQueue']['items'].values()),3)
        self.assertNotIn('/decision',json.dumps(sent))

    def test_pending_background_read_does_not_starve_triggered_watches(self):
        sup,sent,fresh,excluded=self.run_batch(preparation='PENDING')
        self.assertEqual(len(sent),1)
        self.assertEqual(len(sent[0]['context']['marketCandidates']),3)
        self.assertFalse(sup.coverage.state['jobs'])
        self.assertEqual(sup.state['lastFormationAt'],0)

    def test_prepared_batch_still_delivers_six_plus_three(self):
        sup,sent,fresh,excluded=self.run_batch(preparation='READY')
        self.assertEqual(len(sent[0]['context']['marketCandidates']),9)
        self.assertEqual(sup.state['formationPreparation']['status'],'DELIVERED')
        self.assertEqual(sent[0]['eventDetectedAt'],AT-1000)

    def test_untriggered_watches_do_not_spend_model_context(self):
        _,sent,_,_=self.run_batch(ready=False)
        self.assertEqual(len(sent[0]['context']['marketCandidates']),6)

    def test_watch_does_not_bypass_budget(self):
        sup,sent,_,_=self.run_batch(budget=0)
        self.assertEqual(sent,[])
        self.assertEqual(len(w.due(sup.state['watchQueue'])),3)

    def test_more_than_eighteen_remain_queued_not_dropped(self):
        sup,sent,_,_=self.run_batch(watch_n=21)
        n=sum(r['status']=='IN_FLIGHT' for r in sup.state['watchQueue']['items'].values())
        self.assertGreater(n,0)
        self.assertLessEqual(n,18)
        self.assertEqual(len(w.due(sup.state['watchQueue'])),21-n)
        self.assertEqual(len(sent[0]['context']['marketCandidates']),6+n)

if __name__=='__main__':unittest.main()

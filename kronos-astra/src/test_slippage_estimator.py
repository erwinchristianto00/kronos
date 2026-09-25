import copy
import unittest
from slippage_estimator import inspect_order, audit, estimate, PROTOCOL, METHOD
from audit_slippage_history import normalize

BASE=1788000000000
ASOF=BASE+10*86400000


def observation(i=0,side='BUY',price=101,**extra):
    t=BASE+(i%6)*86400000+(i//6)*10000
    return {'environment':'testnet','laneId':'ASTRA_HERMES_TESTNET','symbol':'BTCUSDT','orderId':str(i),
            'side':side,'orderType':'MARKET','timeInForce':'NOT_APPLICABLE','executionPath':'ENTRY','executionVersion':'v1',
            'submittedAt':t,'terminalAt':t+300,'accountingAsOf':t+400,'finalState':'FILLED',
            'requestedQty':'2','executedQty':'2','fillAccountingComplete':True,
            'preSubmitQuote':{'bid':99,'ask':100,'time':t-50},
            'preSubmitContext':{'time':t-10,'volatilityBpsPerBar':10,'liquidityBucket':'L1','liquidityMethodVersion':'qv-v1'},
            'fills':[{'orderId':str(i),'tradeId':'f'+str(i),'symbol':'BTCUSDT','qty':2,'price':price,'time':t+100}],**extra}


def query(o=None):
    return inspect_order(o or observation(),ASOF)['conditioning']


def legacy_source():
    o=observation()
    order={'orderId':'0','side':'BUY','type':'MARKET','timeInForce':'NOT_APPLICABLE',
           'origQty':2,'executedQty':2,'status':'FILLED','updateTime':o['terminalAt']}
    trade={'id':'t','symbol':o['symbol'],'settlementComplete':True,'book':o['preSubmitQuote'],
           'executionVersion':'v1','entry':{'order':order,'attemptedAt':o['submittedAt']},
           'exits':[],'fills':o['fills']}
    return {'environment':'testnet','laneId':'ASTRA_HERMES_TESTNET','capturedAt':ASOF,'closed':[trade],'active':[]}


class SlippageTests(unittest.TestCase):
    def test_truly_unversioned_legacy_still_works(self):
        self.assertTrue(inspect_order(normalize(legacy_source())[0],ASOF)['eligible'])

    def test_unknown_versions_never_fall_back_and_remain_in_coverage(self):
        for version in ('ASTRA_EXECUTION_PROVENANCE_V2','',None,1,True,{},[]):
            with self.subTest(version=version):
                source=legacy_source(); source['closed'][0]['entry']['execution']={'schemaVersion':version}
                before=copy.deepcopy(source); rows=normalize(source)
                result=estimate(rows,query(),ASOF)
                self.assertEqual(rows[0]['slippageStatus'],'UNKNOWN_UNSUPPORTED_SCHEMA')
                self.assertEqual(result['dataCoverage']['totalObservations'],1)
                self.assertEqual(result['dataCoverage']['eligible'],0)
                self.assertEqual(result['dataCoverage']['exclusionReasons'],{'UNKNOWN_UNSUPPORTED_SCHEMA':1})
                self.assertIsNone(result['expectedBps'])
                self.assertEqual(source,before)

    def test_malformed_envelopes_are_quarantined_not_crashes_or_legacy(self):
        for record in (None,False,[], 'bad',{'schemaVersion':'ASTRA_EXECUTION_PROVENANCE_V1'}):
            source=legacy_source(); source['closed'][0]['entry']['execution']=record
            result=audit(normalize(source),ASOF)
            self.assertEqual(result['dataCoverage']['eligible'],0)
            self.assertEqual(result['observations'][0]['reasons'],['UNKNOWN_MALFORMED_SCHEMA'])

    def test_version_metadata_without_envelope_cannot_masquerade_as_legacy(self):
        for key in ('schemaVersion','executionSchemaVersion','provenanceVersion'):
            source=legacy_source(); source['closed'][0]['entry'][key]='V2'
            self.assertEqual(audit(normalize(source),ASOF)['observations'][0]['reasons'],['UNKNOWN_UNSUPPORTED_SCHEMA'])

    def test_estimator_rejects_unknown_schema_even_with_valid_numbers(self):
        rows=[observation(i,schemaVersion='V2') for i in range(36)]
        result=estimate(rows,query(),ASOF)
        self.assertEqual(result['dataCoverage']['excluded'],36)
        self.assertEqual(result['sampleN'],0)
        self.assertIsNone(result['expectedBps'])

    def test_new_provenance_adapter_requires_dispatch_and_preserves_scope(self):
        o=observation()
        record={'schemaVersion':'ASTRA_EXECUTION_PROVENANCE_V1','environment':'testnet','laneId':'ASTRA_HERMES_TESTNET',
            'orderIntentId':'intent','decisionId':'decision','symbol':o['symbol'],'side':'BUY','orderType':'MARKET',
            'timeInForce':'NOT_APPLICABLE','executionVersion':'v1','executionPath':'NORMAL_EXIT','requestedQty':2,
            'preSubmit':{'quoteTimestamp':o['preSubmitQuote']['time'],'bestBid':99,'bestAsk':100},
            'submit':{'exchangeOrderId':'0','wireTimestamp':o['submittedAt']},
            'execution':{'accountingComplete':True,'accountingAsOf':ASOF,'slippageStatus':'CALCULABLE_NOT_CALIBRATED'},
            'fills':{'raw':o['fills']}}
        t={'id':'t','symbol':o['symbol'],'entry':{},'exits':[{'execution':record,
            'order':{'orderId':'0','status':'FILLED','executedQty':2,'updateTime':o['terminalAt']}}],'fills':o['fills']}
        source={'environment':'testnet','laneId':'ASTRA_HERMES_TESTNET','capturedAt':ASOF,'closed':[t],'active':[]}
        r=normalize(source)[1]
        self.assertTrue(inspect_order(r,ASOF)['eligible'])
        self.assertEqual(r['executionPath'],'NORMAL_EXIT')
        self.assertEqual(r['schemaVersion'],'ASTRA_EXECUTION_PROVENANCE_V1')
        record['provenanceVersion']='V2'
        self.assertEqual(audit(normalize(source),ASOF)['observations'][1]['reasons'],['UNKNOWN_UNSUPPORTED_SCHEMA'])
        del record['provenanceVersion']
        record['executionPath']={}
        self.assertEqual(audit(normalize(source),ASOF)['observations'][1]['reasons'],['UNKNOWN_MALFORMED_SCHEMA'])
        record['executionPath']='NORMAL_EXIT'
        record['submit']['wireTimestamp']=None
        self.assertFalse(inspect_order(normalize(source)[1],ASOF)['eligible'])

    def test_malformed_quote_and_context_fail_safely(self):
        self.assertFalse(inspect_order(observation(preSubmitQuote='bad'),ASOF)['eligible'])
        r=inspect_order(observation(preSubmitContext=['bad']),ASOF)
        self.assertTrue(r['eligible'])
        self.assertIsNone(r['conditioning']['volatilityBucket'])

    def test_invalid_protocol_and_clock_rejected(self):
        for value in (True, float('nan'), -1):
            with self.assertRaises(ValueError): estimate([],query(),value)
        for value in (True, float('nan'), 30.5):
            with self.assertRaises(ValueError): estimate([],query(),ASOF,{**PROTOCOL,'minOrders':value})

    def test_buy_vwap_all_fills_and_sell_preserved_denominator(self):
        o=observation(); f=o['fills'][0]; o['fills']=[{**f,'qty':1,'price':100},{**f,'tradeId':'second','qty':1,'price':102,'time':o['submittedAt']+200}]
        r=inspect_order(o,ASOF)
        self.assertTrue(r['eligible']); self.assertAlmostEqual(r['slippageBps'],100)
        self.assertEqual((r['fillCount'],r['filledNotional'],r['fillVWAP']),(2,202,101))
        self.assertEqual((r['timeToFirstFillMs'],r['timeToFinalFillMs']),(100,200))
        s=inspect_order(observation(side='SELL',price=98),ASOF)
        self.assertAlmostEqual(s['slippageBps'],(99/98-1)*10000)
        self.assertEqual(s['methodVersion'],METHOD)

    def test_price_improvements_are_negative_not_clipped(self):
        self.assertLess(inspect_order(observation(price=99),ASOF)['slippageBps'],0)
        self.assertLess(inspect_order(observation(side='SELL',price=100),ASOF)['slippageBps'],0)

    def test_partial_terminal_accounting(self):
        o=observation(finalState='CANCELED',requestedQty=4)
        self.assertTrue(inspect_order(o,ASOF)['eligible'])
        o['fillAccountingComplete']=False
        self.assertIn('INCOMPLETE_FILL_ACCOUNTING',inspect_order(o,ASOF)['reasons'])

    def test_explicit_exclusions(self):
        mutations=[({'preSubmitQuote':None},'MISSING_OR_INVALID_PRE_SUBMIT_QUOTE'),
                   ({'preSubmitQuote':{'bid':99,'ask':100,'time':BASE+1}},'QUOTE_AFTER_SUBMIT'),
                   ({'preSubmitQuote':{'bid':99,'ask':100,'time':BASE-5001}},'STALE_QUOTE'),
                   ({'finalState':'PARTIALLY_FILLED'},'UNKNOWN_OR_NONTERMINAL_ORDER_STATE'),
                   ({'executionPath':'SAFETY_UNWIND'},'NONREPRESENTATIVE_OR_UNKNOWN_EXECUTION_PATH'),
                   ({'executionPath':'MANUAL'},'NONREPRESENTATIVE_OR_UNKNOWN_EXECUTION_PATH'),
                   ({'executedQty':3},'EXECUTED_QUANTITY_MISMATCH'),
                   ({'environment':'live'},'WRONG_ENVIRONMENT_OR_OWNERSHIP'),
                   ({'accountingAsOf':ASOF+1},'INVALID_OR_FUTURE_LIFECYCLE_TIMESTAMPS')]
        for delta,reason in mutations:
            with self.subTest(reason=reason): self.assertIn(reason,inspect_order(observation(**delta),ASOF)['reasons'])

    def test_duplicate_fills_and_unknown_numeric_rejected(self):
        o=observation(); o['fills']*=2
        self.assertFalse(inspect_order(o,ASOF)['eligible'])
        for n in (True,float('nan'),'Infinity','1e9999',-1):
            o=observation(); o['fills'][0]['price']=n
            self.assertFalse(inspect_order(o,ASOF)['eligible'])

    def test_order_sample_unit_dedup_and_conflict(self):
        o=observation(); r=audit([o,copy.deepcopy(o)],ASOF)
        self.assertEqual(r['dataCoverage']['eligible'],1)
        self.assertEqual(r['dataCoverage']['duplicateRecords'],1)
        other=observation(price=102)
        r=audit([o,other],ASOF)
        self.assertEqual(r['dataCoverage']['eligible'],0)
        self.assertEqual(r['dataCoverage']['excluded'],1)

    def test_unknown_if_small_or_one_day(self):
        rows=[observation(i) for i in range(29)]
        self.assertEqual(estimate(rows,query(),ASOF)['status'],'UNKNOWN_INSUFFICIENT_SAMPLE')
        rows=[observation(i) for i in range(35)]
        for o in rows:
            offset=(int(o['orderId'])%6)*86400000
            for k in ('submittedAt','terminalAt','accountingAsOf'): o[k]-=offset
            o['preSubmitQuote']['time']-=offset; o['fills'][0]['time']-=offset
        self.assertEqual(estimate(rows,query(),ASOF)['status'],'UNKNOWN_INSUFFICIENT_SAMPLE')

    def test_estimate_tail_uncertainty_is_deterministic(self):
        rows=[observation(i,price=99+i/100) for i in range(36)]
        a=estimate(rows,query(),ASOF)
        self.assertEqual(a,estimate(rows,query(),ASOF))
        self.assertEqual(a['status'],'ESTIMATED')
        self.assertEqual(a['sampleN'],36)
        self.assertEqual(a['upperBoundType'],'EMPIRICAL_P90')
        self.assertLess(a['upperBoundBps'],0)
        self.assertEqual(a['uncertainty']['method'],'UTC_DAY_CLUSTER_BOOTSTRAP_PERCENTILE_95')

    def test_fallback_is_explicit_never_global(self):
        rows=[observation(i) for i in range(36)]
        q={**query(),'volatilityBucket':'different'}
        a=estimate(rows,q,ASOF)
        self.assertEqual(a['conditioning']['level'],'SYMBOL_SIDE_ORDER')
        self.assertIn('volatilityBucket',a['conditioning']['droppedDimensions'])
        q.update(symbol='OTHERUSDT',liquidityBucket='qv-v1:L1')
        a=estimate(rows,q,ASOF)
        self.assertEqual(a['conditioning']['level'],'LIQUIDITY_SIDE_ORDER')
        q['liquidityBucket']='different'
        self.assertEqual(estimate(rows,q,ASOF)['status'],'UNKNOWN_INSUFFICIENT_SAMPLE')

    def test_fixed_scope_not_pooled(self):
        rows=[observation(i) for i in range(36)]
        for k,v in (('environment','live'),('side','SELL'),('executionPath','NORMAL_EXIT'),('executionVersion','v2'),('timeInForce','IOC')):
            self.assertNotEqual(estimate(rows,{**query(),k:v},ASOF)['status'],'ESTIMATED')

    def test_notional_bucket_uses_requested_not_filled_size(self):
        o=observation(finalState='CANCELED',requestedQty=4)
        self.assertEqual(inspect_order(o,ASOF)['conditioning']['notionalBucket'],'5')
        self.assertEqual(inspect_order(o,ASOF)['requestedReferenceNotional'],400)

    def test_coverage_and_immutability(self):
        rows=[observation(),observation(1,preSubmitQuote=None)]
        before=copy.deepcopy(rows); a=estimate(rows,query(),ASOF)
        self.assertEqual(a['dataCoverage']['totalObservations'],2)
        self.assertEqual(a['dataCoverage']['eligible']+a['dataCoverage']['excluded'],2)
        self.assertEqual(rows,before)

    def test_missing_execution_version_is_not_calibratable(self):
        o=observation(executionVersion=None)
        a=audit([o],ASOF)
        self.assertEqual(a['dataCoverage']['executionScopeIncomplete'],1)
        self.assertIsNone(estimate([o],query(o),ASOF)['expectedBps'])

    def test_adapter_never_reuses_entry_book_for_exit(self):
        o=observation(); order={'orderId':'0','side':'BUY','type':'MARKET','origQty':2,'executedQty':2,'status':'FILLED','updateTime':o['terminalAt']}
        trade={'id':'t','symbol':'BTCUSDT','settlementComplete':True,'book':o['preSubmitQuote'],
               'entry':{'order':order,'attemptedAt':o['submittedAt']},'fills':o['fills'],
               'exits':[{'order':{**order,'orderId':'x','side':'SELL'},'attemptedAt':o['submittedAt']+1000}]}
        source={'environment':'testnet','laneId':'ASTRA_HERMES_TESTNET','capturedAt':ASOF,'closed':[trade],'active':[]}
        rows=normalize(source)
        self.assertEqual(rows[0]['preSubmitQuote'],o['preSubmitQuote'])
        self.assertIsNone(rows[1]['preSubmitQuote'])
        self.assertIsNone(rows[0]['executionVersion'])


if __name__=='__main__': unittest.main()

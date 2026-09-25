import copy
import unittest
from quant_candidate_refresh import refresh_candidates, read_public
from quant_measurements import measure
from astra_v8_runner import V4_HOST_CONTRACT

class RefreshTests(unittest.TestCase):
    at = 30_000_100
    def raw(self):
        return {'source':'BINANCE_USDM_TESTNET','status':{'environment':'testnet'},
                'rows':[{'symbol':s,'features':{'old':True},'candles':[],
                         'economics':{'commission':{'taker':.0005},'roundTripTakerFeeBps':10,
                                      'feeAndSpreadBps':999,'bookFresh':True}}
                        for s in ('AAAUSDT','BBBUSDT')]}
    def read(self, path, params):
        if path.endswith('klines'):
            return [[i*300000,'10','12','9','11','5',(i+1)*300000-1,'55'] for i in range(39,101)]
        return {'symbol':params['symbol'],'bidPrice':'10','askPrice':'11','time':self.at-10}
    def test_fresh_closed_window_no_old_features_no_input_mutation(self):
        raw=self.raw(); original=copy.deepcopy(raw)
        result=refresh_candidates(raw,self.read,lambda:self.at)
        self.assertEqual(raw,original)
        for row in result['rows']:
            self.assertEqual(measure(row,self.at)['status'],'MEASURED')
            self.assertLess(row['candles'][-1]['closeTime'],self.at)
            self.assertEqual(row['features'],{})
            self.assertEqual(row['economics']['commission'],{'taker':.0005})
            self.assertNotEqual(row['economics']['feeAndSpreadBps'],999)
    def test_metadata_becomes_complete_only_after_real_market_refresh(self):
        raw={**self.raw(),'contextMode':'FORMATION_METADATA_V1','marketDataComplete':False,'orderAuthority':False}
        calls=[]
        def read(path,params):
            calls.append((path,params['symbol']))
            return self.read(path,params)
        out=refresh_candidates(raw,read,lambda:self.at)
        self.assertTrue(out['marketDataComplete'])
        self.assertEqual(out['contextMode'],'FORMATION_REFRESH_V2')
        self.assertFalse(out['orderAuthority'])
        self.assertFalse(raw['marketDataComplete'])
        self.assertEqual(len(calls),4)  # One candle and one BBO read per symbol.
    def test_metadata_with_failed_refresh_remains_incomplete(self):
        raw={**self.raw(),'contextMode':'FORMATION_METADATA_V1','marketDataComplete':False,'orderAuthority':False}
        def fail(*args):raise RuntimeError('unavailable')
        out=refresh_candidates(raw,fail,lambda:self.at)
        self.assertFalse(out['marketDataComplete'])
        self.assertTrue(all(not r['candles'] and r['book'] is None for r in out['rows']))
    def test_book_phase_after_all_candles(self):
        done=set()
        def read(path,params):
            if path.endswith('klines'):done.add(params['symbol'])
            else:self.assertEqual(len(done),2)
            return self.read(path,params)
        refresh_candidates(self.raw(),read,lambda:self.at)
    def test_failure_cannot_reuse_old_data(self):
        def fail(*args):raise RuntimeError('secret must not escape')
        result=refresh_candidates(self.raw(),fail,lambda:self.at)
        for row in result['rows']:
            self.assertIsNone(row['book']);self.assertEqual(row['candles'],[])
            self.assertFalse(row['economics']['bookFresh'])
            self.assertNotIn('feeAndSpreadBps',row['economics'])
            self.assertNotIn('secret',str(row))
    def test_stale_future_mismatched_book_rejected(self):
        for change in ({'time':self.at-5001},{'time':self.at+1},{'symbol':'OTHERUSDT'},{'bidPrice':'nan'}):
            def read(path,params):
                value=self.read(path,params)
                return {**value,**change} if isinstance(value,dict) else value
            self.assertIsNone(refresh_candidates(self.raw(),read,lambda:self.at)['rows'][0]['book'])
    def test_identity_and_size_fail_closed(self):
        for edit in ({'source':'LIVE'},{'status':{'environment':'live'}},{'rows':self.raw()['rows']*4}):
            with self.assertRaises(ValueError):refresh_candidates({**self.raw(),**edit},self.read,lambda:self.at)
    def test_no_order_route(self):
        with self.assertRaises(ValueError):read_public('/fapi/v1/order',{})
    def test_unicode_and_single_character_contracts(self):
        raw=self.raw()
        for symbol in ('币安人生USDT','测试测试USDT','XUSDT'):
            raw['rows'][0]['symbol']=symbol
            result=refresh_candidates(raw,self.read,lambda:self.at)
            self.assertEqual(result['rows'][0]['symbol'],symbol)
            self.assertIsNotNone(result['rows'][0]['book'])
    def test_invalid_names_never_reach_network(self):
        from unittest.mock import Mock
        for symbol in ('USDT','../USDT','A?USDT','A\nUSDT','A\u200bUSDT',None,[]):
            raw=self.raw();raw['rows'][0]['symbol']=symbol;read=Mock()
            with self.assertRaises(ValueError):refresh_candidates(raw,read,lambda:self.at)
            read.assert_not_called()
    def test_hypothesis_permission_and_guards(self):
        self.assertIn('NOT by itself an entry veto',V4_HOST_CONTRACT)
        self.assertIn('All freshness, cost and hard risk guards remain',V4_HOST_CONTRACT)
        self.assertIn('FORMATION CONTEXT:',V4_HOST_CONTRACT)
        self.assertIn('Never force entry',V4_HOST_CONTRACT)

if __name__=='__main__':unittest.main()

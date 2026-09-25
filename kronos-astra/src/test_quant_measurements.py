import copy
import math
import unittest
from unittest.mock import patch
from quant_measurements import measure, closed_window, pair_measurement, portfolio_exposure
from astra_quant_v4 import contract
from collect_quant_readonly import public_get, collect


def series(symbol='BTCUSDT',power=1,n=61):
    price=100
    bars=[]
    for i in range(n):
        price*=math.exp(power*(.001+.002*math.sin(i)))
        bars.append({'open':price,'high':price*1.001,'low':price*.999,'close':price,
                     'volume':10,'quoteVolume':10*price,'closeTime':(i+1)*300000-1})
    return {'symbol':symbol,'intervalMs':300000,'observedAt':n*300000,
            'candles':bars,'features':{}}


class MeasurementTests(unittest.TestCase):
    def setUp(self):
        self.row=series()
        self.at=61*300000

    def test_measures_closed_windows(self):
        r=measure(self.row,self.at)
        self.assertEqual(r['status'],'MEASURED')
        self.assertEqual(r['closedBarsN'],61)
        f=r['features']
        expected=sum(max(b['high']-b['low'],abs(b['high']-a['close']),abs(b['low']-a['close']))
                     for a,b in zip(self.row['candles'][-15:],self.row['candles'][-14:]))/14/self.row['candles'][-1]['close']*10000
        self.assertAlmostEqual(f['atrSma14Bps'],expected)
        self.assertAlmostEqual(f['vwap20'],sum(c['close'] for c in self.row['candles'][-20:])/20)
        self.assertIsNotNone(f['regime'])

    def test_beta_2_correlation_1_from_aligned_log_returns(self):
        r=measure(series('ALTUSDT',2),self.at,[self.row])['benchmarks']['BTCUSDT']
        self.assertAlmostEqual(r['beta'],2,places=10)
        self.assertAlmostEqual(r['correlation'],1,places=10)
        self.assertEqual(r['n'],60)

    def test_future_price_cannot_change_current_features(self):
        before=measure(self.row,self.at)
        self.row['candles'].append({**self.row['candles'][-1],'closeTime':self.at+300000,'close':1e9})
        self.assertEqual(measure(self.row,self.at),before)

    def test_gaps_duplicates_unordered_fail_closed(self):
        for kind in ('gap','duplicate','unordered'):
            r=copy.deepcopy(self.row)
            if kind=='gap': r['candles'].pop(-10)
            if kind=='duplicate': r['candles'].insert(5,r['candles'][5])
            if kind=='unordered': r['candles'][2:4]=reversed(r['candles'][2:4])
            self.assertEqual(measure(r,self.at)['status'],'UNAVAILABLE')

    def test_stale_and_invalid_ohlcv_rejected(self):
        self.assertEqual(measure(self.row,self.at+400000)['reason'],'STALE_CANDLES')
        for value in (float('nan'),-1,True):
            r=copy.deepcopy(self.row); r['candles'][-1]['close']=value
            self.assertEqual(measure(r,self.at)['reason'],'INVALID_OHLCV')

    def test_constant_benchmark_not_zero_beta(self):
        r=series(power=0)
        p=measure(self.row,self.at,[r])['benchmarks']['BTCUSDT']
        self.assertIsNone(p['beta']); self.assertEqual(p['reason'],'ZERO_RETURN_VARIANCE')

    def test_different_intervals_not_paired(self):
        r=copy.deepcopy(self.row); r['intervalMs']=60000
        p=measure(self.row,self.at,[r])['benchmarks']['BTCUSDT']
        self.assertIsNone(p['beta'])

    def test_short_sample_remains_partial(self):
        r=series(n=20)
        self.assertEqual(measure(r,20*300000)['status'],'PARTIAL')

    def test_input_immutable_and_deterministic(self):
        old=copy.deepcopy(self.row)
        self.assertEqual(measure(self.row,self.at),measure(self.row,self.at))
        self.assertEqual(self.row,old)

    def test_contract_fills_measurements_not_profit_statistics(self):
        q=contract({'source':'BINANCE_USDM_TESTNET','status':{'environment':'testnet'},
                    'rows':[self.row,series('ALTUSDT',2)]},self.at)
        r=q['rows'][1]
        self.assertAlmostEqual(r['beta'],2)
        self.assertIsNone(r['historicalProfitFactor'])
        self.assertIsNone(r['estimatedEdgeBps'])
        self.assertEqual(q['portfolio']['status'],'UNKNOWN')

    def test_missing_account_not_assumed_flat(self):
        self.assertEqual(portfolio_exposure({'environment':'testnet'},[],self.at)['status'],'UNKNOWN')
        self.assertEqual(portfolio_exposure({'environment':'testnet','active':[]},[],self.at)['status'],'UNKNOWN')
        r=portfolio_exposure({'environment':'testnet','active':[],'observedAt':self.at},[],self.at)
        self.assertEqual(r['grossNotionalUsd'],0)

    def test_portfolio_uses_actual_qty_current_book(self):
        self.row['book']={'bid':99,'ask':101,'time':self.at}
        r=portfolio_exposure({'environment':'testnet','observedAt':self.at,
            'active':[{'symbol':'BTCUSDT','qty':2,'side':'SHORT'}]},[self.row],self.at)
        self.assertEqual(r['grossNotionalUsd'],200)
        self.assertEqual(r['netNotionalUsd'],-200)

    def test_order_endpoints_blocked_without_network(self):
        for path in ('/fapi/v1/order','/fapi/v1/order/test','https://fapi.binance.com/fapi/v1/klines'):
            with self.assertRaises(ValueError): public_get(path)

    def test_execution_quote_and_funding_are_timestamped(self):
        self.row['book']={'bid':99,'ask':101,'time':self.at}
        self.row['economics']={'funding':{'rate':.0001,'status':'INDICATIVE','observedAt':self.at}}
        result=measure(self.row,self.at)['execution']
        self.assertEqual(result['spreadBps'],200)
        self.assertEqual(result['indicativeFundingRate'],.0001)
        self.assertIsNone(result['allInModeledCostBps'])
        result=measure(self.row,self.at+5001)['execution']
        self.assertIsNone(result['spreadBps'])

    def test_invalid_sample_never_calls_network(self):
        with patch('collect_quant_readonly.public_get') as get:
            for symbols in ([],['BTCUSDT','BTCUSDT'],['../order']):
                with self.assertRaises(ValueError): collect(symbols)
            get.assert_not_called()


if __name__=='__main__':
    unittest.main()

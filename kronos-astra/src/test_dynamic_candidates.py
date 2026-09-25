import copy
import json
import tempfile
import threading
import unittest
from pathlib import Path
from dynamic_candidates import observe,select,INTERVAL_MS,MAX_SCAN_AGE_MS
from dynamic_scan import DynamicScan
from astra_v8_host import CoverageBook

AT=1800000000000
def overview(at=AT):
    symbols=['BTCUSDT']+[f'X{i}USDT' for i in range(9)]
    return {'at':at,'source':'BINANCE_USDM_TESTNET','status':{'environment':'testnet'},
            'universe':symbols,'overview':[{'symbol':s,'book':{'bid':100+i,'ask':100.01+i,
            'time':at,'bidQty':10+i,'askQty':10+i},'quoteVolume24h':100000*(i+1),
            'statsFresh':True,'unavailableForNewEntry':False} for i,s in enumerate(symbols)]}

class ScorerTests(unittest.TestCase):
    def test_deterministic(self):
        a=observe(overview(),{},AT);b=observe(overview(),{},AT)
        self.assertEqual(a,b);self.assertEqual(select(a,{},AT),select(b,{},AT))

    def test_cold_slots_explicit_and_unique(self):
        state=observe(overview(),{},AT);selection=select(state,{},AT)
        rows=selection['selected']
        self.assertEqual(len({r['symbol'] for r in rows}),6)
        self.assertEqual([r['slot'] for r in rows],['TOP_SCORE']*4+['EXPLORATION_NO_MEASURED_STATE_CHANGE','EXPLORATION'])
        self.assertTrue(all(r['components']['volumeExpansion'] is None for r in rows))
        self.assertTrue(all(r['status']=='WARMING_UP' for r in rows))

    def test_measured_change_and_oldest_exploration(self):
        state=observe(overview(),{},AT)
        state['ranked'][7]['stateChange']=1
        selection=select(state,{},AT)
        self.assertEqual(selection['selected'][4]['symbol'],state['ranked'][7]['symbol'])
        self.assertEqual(selection['selected'][4]['slot'],'BIGGEST_STATE_CHANGE')
        explored=selection['selected'][5]['symbol']
        again=select(state,{'jobs':{'x':{'symbols':[explored],'outcome':'DONE','at':AT}}},AT)
        self.assertNotEqual(again['selected'][5]['symbol'],explored)

    def test_reprioritizes_not_queue_head(self):
        state=observe(overview(),{},AT)
        chosen=state['ranked'][-1];state['ranked'].remove(chosen);state['ranked'].insert(0,chosen)
        self.assertEqual(select(state,{'queue':['NEVERUSDT']},AT)['selected'][0]['symbol'],chosen['symbol'])

    def test_stale_scan_rejected(self):
        state=observe(overview(),{},AT)
        for at in (AT-1,AT+MAX_SCAN_AGE_MS+1):
            with self.assertRaises(ValueError):select(state,{},at)

    def test_invalid_quotes_excluded(self):
        o=overview();o['overview'][0]['book']['time']=AT-180001
        o['overview'][1]['book']['time']=AT+1
        o['overview'][2]['book']['ask']=1
        state=observe(o,{},AT)
        self.assertEqual(len(state['excluded']),3)
        self.assertEqual(len(state['ranked']),7)

    def test_live_source_rejected(self):
        o=overview();o['source']='BINANCE_USDM_LIVE'
        with self.assertRaises(ValueError):observe(o,{},AT)

    def test_no_duplicate_cached_samples(self):
        o=overview();state=observe(o,{},AT)
        again=observe(o,state,AT+1)
        self.assertTrue(all(len(h)==1 for h in again['history'].values()))

    def test_warmup_and_benchmark_not_entry_eligible(self):
        state={}
        for step in range(12):
            at=AT+step*INTERVAL_MS;o=overview(at)
            for i,r in enumerate(o['overview']):
                move=(i+1)*step*.01
                r['book']['bid']+=move;r['book']['ask']+=move
            o['overview'][0]['unavailableForNewEntry']=True
            state=observe(o,state,at)
        self.assertEqual(len(state['history']['BTCUSDT']),12)
        self.assertNotIn('BTCUSDT',[r['symbol'] for r in state['ranked']])
        for r in state['ranked']:
            self.assertEqual(r['components']['trendAlignment'],1)
            self.assertIsNotNone(r['components']['relativeStrengthImprovement'])
            self.assertIsNone(r['components']['volumeExpansion'])

    def test_missing_liquidity_not_imputed(self):
        o=overview();o['overview'][0]['statsFresh']=False
        row=next(r for r in observe(o,{},AT)['ranked'] if r['symbol']=='BTCUSDT')
        self.assertIsNone(row['components']['liquidityQuality'])

    def test_wider_spread_reduces_score(self):
        o=overview();a=observe(o,{},AT)
        o['overview'][-1]['book']['ask']=120
        b=observe(o,{},AT)
        get=lambda state:next(r['score'] for r in state['ranked'] if r['symbol']=='X8USDT')
        self.assertLess(get(b),get(a))

    def test_coverage_reserves_selected_not_queue(self):
        with tempfile.TemporaryDirectory() as root:
            book=CoverageBook(Path(root)/'coverage.json');state=observe(overview(),{},AT)
            book.observe(state['universe'],{},AT)
            selection=select(state,book.state,AT)
            job=book.reserve('dynamic',6,AT,selection=selection)
            self.assertEqual(job['symbols'],[r['symbol'] for r in selection['selected']])
            self.assertEqual(book.reserve('dynamic',6,AT+1,selection=selection),job)
            self.assertEqual(job['selection'],selection)

class ScanTests(unittest.TestCase):
    def test_nonblocking_single_inflight_and_persist(self):
        with tempfile.TemporaryDirectory() as root:
            release=threading.Event();calls=[]
            def gateway(path,args):
                calls.append((path,args));release.wait(2);return overview()
            scan=DynamicScan(root,gateway)
            try:
                self.assertTrue(scan.poll(AT)['inFlight'])
                scan.poll(AT+1);self.assertEqual(len(calls),1)
            finally:release.set();scan.worker.join(2)
            self.assertEqual(scan.poll(AT+2)['status'],'FRESH')
            restored=DynamicScan(root,gateway)
            self.assertEqual(restored.state,scan.state)
            self.assertEqual(calls,[('/context',{'symbols':[]})])

    def test_failure_backoff(self):
        with tempfile.TemporaryDirectory() as root:
            scan=DynamicScan(root,lambda *a: {'error':'offline'})
            scan.poll(AT);scan.worker.join(2);health=scan.poll(AT+1)
            self.assertFalse(health['inFlight']);self.assertIsNotNone(health['error'])
            with self.assertRaises(ValueError):scan.selection({},AT+1)

    def test_corrupt_persistence_blocks_only_scanner(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'hermes-home/v8/dynamic-candidates.json';path.parent.mkdir(parents=True)
            path.write_text('broken')
            scan=DynamicScan(root,lambda *a:self.fail('must not silently replace corrupt evidence'))
            self.assertIsNotNone(scan.poll(AT)['error']);self.assertEqual(path.read_text(),'broken')
            with self.assertRaises(ValueError):scan.selection({},AT)

if __name__=='__main__':unittest.main()

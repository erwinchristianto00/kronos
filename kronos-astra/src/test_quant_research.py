import copy
import unittest
from quant_research import replay, metrics, report
from test_quant_measurements import series


class ResearchTests(unittest.TestCase):
    def setUp(self):
        self.row=series(n=500)
        for c in self.row['candles']: c['openTime']=c['closeTime']-299999
        self.cutoff=500*300000

    def test_next_open_nonoverlap_and_purged_splits(self):
        r=replay(self.row,self.cutoff)
        self.assertTrue(r['episodes'])
        previous={}
        for e in r['episodes']:
            self.assertGreater(e['entryAt'],e['signalAt'])
            self.assertGreater(e['exitAt'],e['entryAt'])
            self.assertGreater(e['entryAt'],previous.get(e['probe'],0))
            previous[e['probe']]=e['exitAt']
            self.assertTrue(e['exitAt']<r['holdoutStart'] if e['split']=='CALIBRATION' else e['signalAt']>=r['holdoutStart'])
            self.assertAlmostEqual(e['modelNetBps']['15'],e['grossReferenceBps']-15)
            self.assertIsNone(e['realizedPnl'])

    def test_future_candle_is_excluded(self):
        before=replay(self.row,self.cutoff)
        self.row['candles'].append({**self.row['candles'][-1],'closeTime':self.cutoff+300000,'open':1e12})
        self.assertEqual(replay(self.row,self.cutoff),before)

    def test_holdout_prices_cannot_change_calibration(self):
        before=replay(self.row,self.cutoff)
        for c in self.row['candles'][300:]:
            for key in ('open','high','low','close'): c[key]*=1.5
        after=replay(self.row,self.cutoff)
        self.assertEqual([e for e in before['episodes'] if e['split']=='CALIBRATION'],
                         [e for e in after['episodes'] if e['split']=='CALIBRATION'])

    def test_history_gap_and_wrong_interval_rejected(self):
        self.row['candles'].pop(100)
        with self.assertRaises(ValueError): replay(self.row,self.cutoff)
        self.row['intervalMs']=3600000
        with self.assertRaises(ValueError): replay(self.row,self.cutoff)

    def test_zero_samples_not_zero_expectancy(self):
        m=metrics([],15)
        self.assertIsNone(m['modelExpectancyBps'])
        self.assertIsNone(m['modelProfitFactor'])
        self.assertIsNone(m['estimatedCurrentEdgeBps'])


if __name__=='__main__': unittest.main()

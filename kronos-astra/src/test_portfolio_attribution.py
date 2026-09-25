import copy
import unittest
from portfolio_attribution import completeness
from quant_snapshot import portfolio_context

AT=1800000000000


def fixture():
    status={'laneId':'ASTRA_HERMES_TESTNET','environment':'testnet','observedAt':AT,'active':[
        {'id':'a','symbol':'AAAUSDT','side':'LONG','qty':2},
        {'id':'b','symbol':'BBBUSDT','side':'SHORT','qty':1}]}
    rows=[{'symbol':s,'book':{'bid':99,'ask':101,'time':AT}} for s in ('AAAUSDT','BBBUSDT')]
    markets={'AAAUSDT':{'btcBeta':1.2},'BBBUSDT':{'btcBeta':-.5}}
    return status,rows,markets


class PortfolioAttributionTests(unittest.TestCase):
    def test_gross_and_net_survive_unknown_strategy_sector(self):
        s,r,m=fixture(); p=portfolio_context(s,r,m,AT)
        self.assertEqual((p['grossExposure'],p['netExposure']),(300,100))
        self.assertEqual(p['attributionStatus'],'UNKNOWN_INCOMPLETE_ATTRIBUTION')
        self.assertEqual((p['attributedExposurePct'],p['unattributedExposurePct']),(0,100))
        self.assertIsNone(p['strategyConcentration']); self.assertIsNone(p['sectorConcentration'])
        self.assertEqual(p['unknownPositions']['count'],2)
        self.assertEqual(p['unknownPositions']['notional'],300)

    def test_known_dimensions_use_total_gross_not_net_or_subset(self):
        s,r,m=fixture(); p=completeness(s,r,AT,m)
        self.assertEqual(p['bySymbol']['status'],'COMPLETE')
        self.assertAlmostEqual(p['bySide']['concentration']['LONG'],2/3)
        self.assertEqual(p['byBetaBucket']['status'],'COMPLETE')
        self.assertEqual(p['bySymbol']['attributedExposurePct'],100)
        self.assertEqual(p['bySymbol']['unattributedExposurePct'],0)

    def test_partial_beta_does_not_publish_concentration(self):
        s,r,m=fixture(); del m['BBBUSDT']
        p=portfolio_context(s,r,m,AT)
        self.assertEqual(p['byBetaBucket']['status'],'PARTIAL')
        self.assertAlmostEqual(p['byBetaBucket']['unattributedExposurePct'],100/3)
        self.assertIsNone(p['betaBucketConcentration'])
        self.assertEqual(p['grossExposure'],300)

    def test_missing_price_never_zero_unknown_notional(self):
        s,r,m=fixture(); r.pop()
        p=portfolio_context(s,r,m,AT)
        self.assertIsNone(p['grossExposure'])
        self.assertEqual(p['knownGrossNotionalUsd'],200)
        self.assertIsNone(p['unknownPositions']['notional'])
        self.assertIsNone(p['unattributedExposurePct'])
        self.assertIsNone(p['symbolConcentration'])
        self.assertEqual(p['unvaluedPositionsN'],1)

    def test_empty_is_not_missing_or_100_percent_coverage(self):
        s,r,m=fixture(); s['active']=[]
        p=portfolio_context(s,r,m,AT)
        self.assertEqual(p['attributionStatus'],'COMPLETE')
        self.assertEqual(p['unknownPositions']['count'],0)
        self.assertEqual(p['grossExposure'],0)
        self.assertIsNone(p['attributedExposurePct'])
        del s['active']; p=portfolio_context(s,r,m,AT)
        self.assertIsNone(p['positionsN']); self.assertIsNone(p['grossExposure'])
        self.assertEqual(p['attributionStatus'],'UNKNOWN_INCOMPLETE_ATTRIBUTION')

    def test_untrusted_labels_ignored_and_input_immutable(self):
        s,r,m=fixture()
        for p in s['active']:
            p.update(strategyId='WINNER',strategyVersion='99',sector='MEME',attribution={'status':'COMPLETE'})
        before=copy.deepcopy(s); p=completeness(s,r,AT,m)
        self.assertEqual(s,before)
        self.assertEqual(p['byStrategy']['attributedPositionsN'],0)
        self.assertEqual(p['bySector']['attributedPositionsN'],0)

    def test_bad_id_foreign_stale_and_malformed_not_trusted(self):
        for bad in ('duplicate','foreign','stale','badid','malformed'):
            s,r,m=fixture()
            if bad=='duplicate': s['active'][1]['id']='a'
            if bad=='foreign': s['laneId']='OTHER'
            if bad=='stale': s['observedAt']=AT-120001
            if bad=='badid': s['active'][0]['id']={}
            if bad=='malformed': s['active'][0]=None
            p=portfolio_context(s,r,m,AT)
            self.assertIsNone(p['grossExposure'],bad)
            self.assertIsNone(p['symbolConcentration'],bad)

if __name__=='__main__': unittest.main()

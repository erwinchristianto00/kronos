import copy
import threading
import unittest
from unittest.mock import patch
from quant_snapshot import snapshot, LANE
from quant_snapshot_host import ReferenceCache, attach_references
from test_quant_measurements import series
import test_astra_v8_runner as worker_fixtures
import astra_v8_runner as runner


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.at = 61*300000
        self.row = series('DOGEUSDT', 2)
        self.row['book'] = {'bid': 99, 'ask': 101, 'time': self.at}
        self.row['economics'] = {
            'commission': {'status': 'AVAILABLE', 'source': 'TESTNET_ACCOUNT_SYMBOL_COMMISSION_RATE',
                           'observedAt': self.at, 'makerRate': .0002, 'takerRate': .0004},
            'funding': {'status': 'INDICATIVE', 'observedAt': self.at, 'exchangeTime': self.at,
                        'lastFundingRate': .0001, 'nextFundingTime': self.at+3600000}}
        self.raw = {'source': 'BINANCE_USDM_TESTNET', 'at': self.at,
                    'status': {'environment': 'testnet', 'laneId': LANE, 'active': []},
                    'rows': [self.row], 'quantReferences': [series(), series('ETHUSDT')]}

    def test_contract_fields_actual_rates_and_unknown_slippage(self):
        s = snapshot(self.raw, self.at)
        r = s['rows'][0]
        self.assertEqual(r['dataQuality']['status'], 'DEGRADED')
        self.assertEqual(r['costContext']['makerFee'], .0002)
        self.assertEqual(r['costContext']['takerFee'], .0004)
        self.assertEqual(r['costContext']['fundingEstimate']['longCostBps'], 1)
        self.assertIsNone(r['costContext']['slippageEstimate'])
        self.assertIsNone(r['costContext']['allInCostBps'])
        self.assertAlmostEqual(r['marketContext']['btcBeta'], 2)
        self.assertEqual(s['portfolioContext']['grossExposure'], 0)
        self.assertEqual(len(s['rows']), 1)

    def test_stale_or_forged_fee_is_unknown_not_zero(self):
        for change in ({'observedAt': self.at-900001}, {'source': 'MODEL_GUESS'}, {'takerRate': True}):
            raw = copy.deepcopy(self.raw)
            raw['rows'][0]['economics']['commission'].update(change)
            self.assertIsNone(snapshot(raw, self.at)['rows'][0]['costContext']['takerFee'])

    def test_funding_requires_fresh_exchange_time_and_future_settlement(self):
        for change in ({'exchangeTime': self.at-120001}, {'nextFundingTime': self.at}, {'observedAt': self.at+1}):
            raw = copy.deepcopy(self.raw)
            raw['rows'][0]['economics']['funding'].update(change)
            self.assertIsNone(snapshot(raw, self.at)['rows'][0]['costContext']['fundingEstimate'])

    def test_future_or_stale_context_invalid_not_entry_signal(self):
        for at in (self.at-1, self.at+120001):
            r = snapshot(self.raw, at)['rows'][0]
            self.assertEqual(r['dataQuality']['status'], 'INVALID')
            self.assertIsNone(r['marketContext']['btcBeta'])
            self.assertIsNone(r['strategyEvidence']['netExpectancy'])

    def test_missing_benchmark_does_not_remove_candidate(self):
        self.raw['quantReferences'] = []
        r = snapshot(self.raw, self.at)['rows'][0]
        self.assertIsNone(r['marketContext']['btcBeta'])
        self.assertEqual(r['symbol'], 'DOGEUSDT')

    def test_supplied_alpha_never_promoted(self):
        self.row['strategyEvidence'] = {'evidenceStatus': 'FORWARD_VALIDATED', 'profitFactor': 999}
        self.raw['strategyEvidence'] = self.row['strategyEvidence']
        e = snapshot(self.raw, self.at)['rows'][0]['strategyEvidence']
        self.assertEqual(e['evidenceStatus'], 'MARKET_STATE_ONLY')
        self.assertIsNone(e['profitFactor'])
        self.assertTrue({'evidenceAsOf','methodVersion','dataWindow','strategyId','version','scope'} <= e.keys())

    def test_portfolio_signed_beta_actual_quantities_and_no_taxonomy_guess(self):
        self.raw['status']['active'] = [{'id':'one','symbol':'DOGEUSDT','side':'SHORT','qty':2}]
        p = snapshot(self.raw, self.at)['portfolioContext']
        self.assertEqual(p['grossExposure'], 200)
        self.assertEqual(p['netExposure'], -200)
        self.assertAlmostEqual(p['directionalBeta']['btcEquivalentNotionalUsd'], -400)
        self.assertEqual(p['symbolConcentration'], {'DOGEUSDT':1})
        self.assertIsNone(p['sectorConcentration'])
        self.assertIsNone(p['strategyConcentration'])

    def test_stale_account_duplicate_or_foreign_ownership_unknown(self):
        for mutation in ('stale','missing','foreign','duplicate'):
            raw = copy.deepcopy(self.raw)
            if mutation == 'stale': raw['at'] = self.at-120001
            if mutation == 'missing': raw['status'].pop('active')
            if mutation == 'foreign': raw['status']['laneId'] = 'KRONOS_LIVE'
            if mutation == 'duplicate': raw['status']['active'] = [{'id':'x','symbol':'DOGEUSDT','qty':1,'side':'LONG'}]*2
            self.assertIsNone(snapshot(raw, self.at)['portfolioContext']['grossExposure'])

    def test_pure_and_market_measurement_window_not_strategy_window(self):
        before = copy.deepcopy(self.raw)
        r = snapshot(self.raw, self.at)['rows'][0]
        self.assertEqual(before, self.raw)
        self.assertIsNotNone(r['marketContext']['dataWindow']['start'])
        self.assertIsNone(r['strategyEvidence']['dataWindow'])

    def test_cache_nonblocking_single_flight_and_scope_separation(self):
        started, release, done = threading.Event(), threading.Event(), threading.Event()
        calls = []
        def gateway(path, payload):
            calls.append((path,payload)); started.set(); release.wait(2)
            return {**self.raw, 'rows': [series(),series('ETHUSDT')],
                    'historyPage': {'offset':0,'returned':2,'nextOffset':None}}
        cache = ReferenceCache(gateway, clock=lambda:self.at)
        original_collect = cache._collect
        def run():
            try: original_collect()
            finally: done.set()
        cache._collect = run
        raw = attach_references(self.raw, cache)
        self.assertTrue(started.wait(1))
        for _ in range(5): cache.context()
        self.assertEqual(len(calls),1)
        self.assertEqual(raw['rows'], self.raw['rows'])
        self.assertEqual(raw['status'], self.raw['status'])
        release.set(); self.assertTrue(done.wait(2))
        self.assertEqual(len(cache.context()['quantReferences']),2)
        self.at += 120001
        with patch('quant_snapshot_host.threading.Thread'):
            self.assertEqual(cache.context()['quantReferences'],[])

    def test_reference_failure_is_not_fatal(self):
        def bad(*args): raise OSError('sensitive details')
        cache = ReferenceCache(bad, clock=lambda:self.at)
        cache._collect()
        with patch('quant_snapshot_host.threading.Thread'):
            result = cache.context()
        self.assertEqual(result['quantReferenceStatus']['reason'],'REFERENCE_FETCH_FAILED')
        self.assertEqual(result['quantReferences'],[])

    def test_context_size_for_six_candidates_stays_bounded(self):
        import json
        from astra_quant_v4 import contract
        from astra_v8_supervisor import compact_candidate
        rows = [{**copy.deepcopy(self.row),'symbol':'S'+str(i)+'USDT'} for i in range(6)]
        raw = {**self.raw,'rows':rows}
        quant = {k:v for k,v in contract(raw,self.at).items() if k not in ('rows','portfolio')}
        ctx = {'marketCandidates':[compact_candidate(r,self.at) for r in rows],'quantEvidence':quant}
        runner.bounded_context(ctx)
        self.assertLess(len(json.dumps(ctx)), 64000)

    def test_reference_warmup_runs_while_model_busy(self):
        import astra_v8_supervisor as s
        supervisor = s.Supervisor.__new__(s.Supervisor)
        from types import SimpleNamespace
        supervisor.dynamic_scan=SimpleNamespace(poll=lambda at:{})
        supervisor.state = {'events':s.new_event_state(),'pendingEvents':[],'jobs':{},'lastManagedAt':{}}
        supervisor.market_rows = {}
        supervisor.config = {}
        supervisor.manifest = {'gatewayExecutionVersion':'expected'}
        supervisor.reap = lambda: None
        supervisor.model_health_tick = lambda: None
        supervisor.owned_context = lambda status: []
        supervisor.save = lambda: None
        supervisor.live_job = lambda mode: {'model':'busy'}
        supervisor.coach_if_due = lambda: None
        with patch.object(s.engine,'gateway',return_value={'executionVersion':'expected'}), patch.object(s.engine,'validate_capital_identity'), patch.object(s,'ReferenceCache') as cache:
            supervisor.tick()
        cache.return_value.context.assert_called_once()


class QuantWorkerTests(worker_fixtures.WorkerTests):
    def test_final_model_context_has_contract_without_reference_trade_permissions(self):
        self.raw['at'] = self.at
        self.raw['quantReferences'] = [series(), series('ETHUSDT')]
        seen = []
        def inspect(session):
            seen.append(session.context['quantEvidence']['snapshot'])
            portfolio=seen[-1]['portfolioContext']
            self.assertEqual(portfolio['schemaVersion'],'PORTFOLIO_ATTRIBUTION_COMPLETENESS_V1')
            self.assertEqual(portfolio['concentrationGuard']['maxUnattributedExposurePct'],0)
            self.assertTrue({'attributionStatus','attributedExposurePct','unattributedExposurePct',
                'byStrategy','bySymbol','bySide','bySector','byBetaBucket','unknownPositions'}<=portfolio.keys())
            self.assertEqual(set(session.engine.PLAN_BOOK.rows), {'DOGEUSDT'})
        result = self.run_worker([('astra_decide',self.action())], callback=inspect)
        self.assertTrue(result['completed'])
        self.assertEqual(seen[0]['rows'][0]['strategyEvidence']['evidenceStatus'], 'MARKET_STATE_ONLY')
        records = runner.Journal(self.root, runner.FAST_TRADING).records
        self.assertTrue(any(r['kind']=='DECISION_INTENT' for r in records))
        prepared = [r for r in records if r['kind']=='QUANT_CONTEXT_PREPARED']
        self.assertEqual(len(prepared), 1)
        self.assertEqual(prepared[0]['snapshot'], seen[0])
        self.assertEqual(prepared[0]['snapshotHash'], runner.digest(seen[0]))


if __name__ == '__main__': unittest.main()

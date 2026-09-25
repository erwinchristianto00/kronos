"""Regression coverage for observed BARD delay and incorrect latch attribution. No network/order."""
import json
import unittest
from unittest.mock import patch
import test_astra_v8_runner as fixtures
from test_row_refresh import Session, row
import astra_v8_runner as runner
from hermes_dashboard import host_entry_report


class EntryLatencyTests(unittest.TestCase):
    setUp = fixtures.WorkerTests.setUp
    gateway = fixtures.WorkerTests.gateway
    job = fixtures.WorkerTests.job
    freeze = fixtures.WorkerTests.freeze
    action = fixtures.WorkerTests.action
    factory = fixtures.WorkerTests.factory
    run_worker = fixtures.WorkerTests.run_worker
    def test_empty_delivered_lessons_skip_archive_replay_but_keep_canonical_receipts(self):
        def check(session):
            session.canonical_path.write_text('invalid would fail if replayed')
        result = self.run_worker([('astra_decide', self.action())], callback=check)
        self.assertTrue(result['completed'])
        kinds = [r['kind'] for r in result['canonicalDelta']]
        self.assertIn('DELIVERY', kinds)
        self.assertIn('CHECKS', kinds)
        self.assertIn('APPLICATION', kinds)

    def test_new_plan_initial_cost_failure_is_not_reported_as_old_latch(self):
        self.row['book']['bid'] = 9.98  # spread raises cost above cap, fixed fee floor still below it
        self.row['candles'][0]['close'] = 9.99  # trigger also unmet
        result = self.run_worker([('astra_enter', self.action('ENTER_LONG', plan=self.plan))])
        d = result['hostEntryDiagnostics'][0]
        self.assertEqual(d['failureOrigin'], 'NEW_PLAN_FAILED_INITIAL_CHECK')
        self.assertTrue(d['planPersisted'])
        self.assertIn('cost', d['failedPredicates'])
        self.assertIn('trigger', d['failedPredicates'])
        self.assertGreater(d['costBps'], d['maxCostBps'])
        self.assertFalse(d['orderSubmitted'])
        self.assertEqual(self.requests, [])
        text = host_entry_report(result)
        self.assertIn('Rencana BARU', text)
        self.assertIn('not verified', text)

    def test_existing_failed_plan_keeps_latch_no_order_and_no_refresh(self):
        self.row['book']['bid'] = 9.98
        self.freeze()
        with patch.object(runner.JobSession, 'refresh_selected_row', side_effect=AssertionError('unexpected refresh')):
            result = self.run_worker([('astra_enter', self.action('ENTER_LONG', setupId=self.plan['id']))])
        self.assertEqual(result['hostEntryDiagnostics'][0]['failureOrigin'], 'EXISTING_PLAN_LIFECYCLE')
        self.assertEqual(self.requests, [])


class RefreshContractTests(unittest.TestCase):
    def test_uses_acknowledged_metadata_then_public_market_then_account(self):
        at = 1800000000000
        s = Session({'AUSDT': row('AUSDT', at-230000)})
        raw = {'rows': [row('AUSDT', at)], 'unavailableSymbols': []}
        with patch.object(runner, 'now_ms', return_value=at), \
             patch('astra_v8_host.fetch_histories', return_value=raw) as metadata, \
             patch('quant_candidate_refresh.refresh_candidates', return_value={**raw, 'marketDataComplete': True}) as market:
            s.refresh_selected_row('AUSDT')
        self.assertEqual(metadata.call_args.kwargs, {'metadata_only': True})
        market.assert_called_once_with(raw)
        self.assertEqual(s.appended[-1][1]['refreshMethod'], 'METADATA_PUBLIC_TESTNET_V1')

    def test_partial_public_read_fails_closed_without_replacing_stale_row(self):
        at = 1800000000000
        s = Session({'AUSDT': row('AUSDT', at-230000)})
        with patch.object(runner, 'now_ms', return_value=at), \
             patch('astra_v8_host.fetch_histories', return_value={}), \
             patch('quant_candidate_refresh.refresh_candidates', return_value={'marketDataComplete': False}):
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                s.refresh_selected_row('AUSDT')
        self.assertEqual(s.engine.PLAN_BOOK.rows['AUSDT']['observedAt'], at-230000)

    def test_unknown_diagnostic_source_not_claimed_host_verified(self):
        self.assertEqual(host_entry_report({'hostEntryDiagnostics': [{'source': 'MODEL'}]}), '')


if __name__ == '__main__': unittest.main()

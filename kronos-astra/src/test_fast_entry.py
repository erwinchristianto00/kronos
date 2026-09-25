"""Synthetic fixtures only: no network, provider calls or actual trade orders."""
import copy
import json
import types
import unittest
from pathlib import Path
from unittest.mock import patch, Mock

import astra_runner as runner
from astra_learning import LearningBook
from astra_plans import ENTER_SCHEMA
import test_astra_plans as plan_tests


class FastEntryTests(unittest.TestCase):
    def setUp(self):
        plan_tests.FrozenPlanTests.setUp(self)
        patcher = patch.multiple(runner, ROOT=self.root, EXPERIMENT_BOOK=None,
                                 EXPERIMENT_REQUIRED=False, LEARNING_BOOK=None)
        patcher.start(); self.addCleanup(patcher.stop)
        row = self.context['rows'][0]
        row['economics']['commission']['observedAt'] = self.now
        row['economics']['funding'].update(observedAt=self.now, exchangeTime=self.now)
        self.book.observe(self.context)
        # Existing tests exercise the older cache path, not the new <=5s path.
        self.now += 6000
        self.requests = []
        self.orders = {}
        self.input = {'id': 'fast_entry_001', 'reason': 'Explicit immediate test entry with frozen risk and costs',
                      'plan': copy.deepcopy(self.plan)}

    def snapshot(self):
        return {k: copy.deepcopy(v) for k, v in self.context.items() if k != 'rows'} | {
            'overview': [{'symbol': r['symbol'], 'book': copy.deepcopy(r['book'])} for r in self.context['rows']]}

    def gateway(self, path, payload):
        self.requests.append((path, copy.deepcopy(payload)))
        if path == '/context':
            return self.snapshot() if not payload['symbols'] else copy.deepcopy(self.context)
        self.assertEqual(path, '/decision')
        return self.orders.setdefault(payload['id'], {'id': 'synthetic-trade', 'state': 'OPEN'})

    def enter(self, args=None):
        with patch.object(runner, 'gateway', self.gateway):
            return json.loads(runner.serialized_tool(runner.enter_result, self.input if args is None else args))

    def test_fused_entry_uses_one_fresh_overview_and_original_order_gateway(self):
        result = self.enter()
        self.assertEqual(result['state'], 'OPEN')
        self.assertEqual(self.requests[0], ('/context', {'symbols': []}))
        self.assertEqual(len(self.requests), 2)
        sent = self.requests[1][1]
        for dst, src in [('symbol', 'symbol'), ('side', 'side'), ('notionalUsd', 'notionalUsd'),
                         ('stopPrice', 'stopPrice'), ('targetPrice', 'targetPrice'), ('maxHoldMs', 'maxHoldMs'),
                         ('slippageBps', 'entrySlippageBps')]:
            self.assertEqual(sent[dst], self.plan[src])
        self.assertEqual(result['entryLatency']['executionMode'], 'FUSED_ENTRY')
        self.assertEqual(result['entryLatency']['contextPath'], 'CURRENT_BAR_COST_CACHE_FRESH_BBO')
        self.assertIn('checkToGatewayMs', result['entryLatency'])

    def test_failed_lifecycle_rejected_without_market_reads_or_order(self):
        from astra_replan_v2 import PlanBook
        self.book = PlanBook(self.root, now=lambda:self.now)
        self.book.observe(self.context)
        self.book.create(self.plan)
        p = self.book.get(self.plan['id'])
        p['v2'].update(failedAt=self.now-1, status='WAITING', failedPredicates=['cost'])
        self.book.save()
        args = {k:v for k,v in self.input.items() if k != 'plan'}
        args['setupId'] = self.plan['id']
        with patch.object(runner, 'PLAN_BOOK', self.book):
            result = self.enter(args)
        self.assertEqual(self.requests, [])
        self.assertEqual(result['assessment']['planStatus'], 'LIFECYCLE_BLOCKED')
        self.assertFalse(result['assessment']['marketChecksPerformed'])
        self.assertEqual(result['entryLatency']['dataReadMs'], 0)
        self.assertTrue(result['noOrderSubmitted'])
        self.assertEqual(p['v2']['failedAt'], self.now-1)

    def test_geometry_ready_does_not_mislabel_failed_lifecycle_ready(self):
        from astra_replan_v2 import PlanBook
        self.book = PlanBook(self.root, now=lambda:self.now)
        self.book.observe(self.context)
        self.book.create(self.plan)
        p = self.book.get(self.plan['id'])
        p['v2'].update(failedAt=self.now-1, status='WAITING', failedPredicates=['cost'])
        assessment = self.book.evaluate(p)
        self.assertFalse(assessment['ready'])
        self.assertEqual(assessment['planStatus'], 'LIFECYCLE_BLOCKED')
        self.assertEqual(assessment['priorFailedPredicates'], ['cost'])

    def test_just_refreshed_context_skips_duplicate_read_but_not_gateway(self):
        self.now -= 6000
        result = self.enter()
        self.assertEqual(result['state'], 'OPEN')
        self.assertEqual([p for p, _ in self.requests], ['/decision'])
        self.assertEqual(result['entryLatency']['contextPath'],
                         'RECENT_HOST_SNAPSHOT_FINAL_GATEWAY_REVALIDATION')
        self.assertIn('entryContract', self.requests[0][1])

    def test_recent_book_does_not_make_old_status_fresh(self):
        self.now -= 6000
        self.book.status_observed_at = self.now-5001
        self.enter()
        self.assertEqual(self.requests[0], ('/context', {'symbols': []}))

    def test_future_recent_clock_does_not_skip_read(self):
        self.now -= 6000
        self.book.status_observed_at = self.now+1
        self.enter()
        self.assertEqual(self.requests[0], ('/context', {'symbols': []}))

    def test_v2_normal_watch_can_reach_explicit_gateway_entry(self):
        from astra_replan_v2 import PlanBook
        self.now -= 6000
        self.book = PlanBook(self.root, now=lambda:self.now)
        self.book.observe(self.context)
        self.plan.update(triggerPrice=10.01, entryMin=10.01, entryMax=10.03)
        self.book.create(self.plan)
        with patch.object(runner, 'PLAN_BOOK', self.book):
            for i in range(3):
                self.book.reassess({'id':'waiting_observation_%d'%i, 'action':'WAIT',
                    'setupId':self.plan['id'], 'reason':'Waiting for the original closed candle trigger',
                    'snapshotId':self.book.snapshot('DOGEUSDT')['snapshotId']})
            self.assertEqual(self.requests, [])
            self.now += 300000
            row = self.context['rows'][0]
            row['candles'] = [{'closeTime':self.now-1,'close':10.015}]
            row['book'].update(bid=10.014,ask=10.015,time=self.now)
            row['economics']['funding'].update(observedAt=self.now,exchangeTime=self.now)
            self.book.observe(self.context)
            self.assertTrue(self.book.get(self.plan['id'])['assessment']['ready'])
            self.assertEqual(self.requests, [])
            result = self.enter({'id':'explicit_entry_after_wait','reason':'Explicit model entry after original trigger',
                                 'setupId':self.plan['id']})
            self.assertEqual(result['state'],'OPEN')
            self.assertEqual([path for path,_ in self.requests],['/decision'])
        self.assertEqual(self.book.get(self.plan['id'])['plan'], self.plan)
        self.assertTrue((self.root/'logs/entry-latency.jsonl').exists())

    def test_contract_is_host_derived_and_retry_reuses_exact_persisted_terms(self):
        self.enter()
        first = copy.deepcopy(self.requests[-1][1])
        contract = first['entryContract']
        for k in ('entryMin','entryMax','triggerPrice','maxSpreadBps','maxCostBps','expiresAt'):
            self.assertEqual(contract[k],self.plan[k])
        self.assertEqual(contract['takerRate'],.0005)
        self.assertEqual(contract['planId'],self.plan['id'])
        self.assertEqual(self.book.state['submissions'][first['id']]['request'],first)
        self.context['rows'][0]['book'].update(bid=20,ask=21)
        self.enter()
        self.assertEqual(self.requests[-1],('/decision',first))

    def test_gateway_downgrade_blocks_new_entry_without_touching_existing_positions(self):
        self.context['status'].pop('executionVersion')
        result=self.enter()
        self.assertEqual(result['status'],'SETUP_DATA_UNAVAILABLE')
        self.assertFalse(self.orders)

    def test_optional_lesson_is_durable_before_submission_without_a_model_round_trip(self):
        learning = LearningBook(self.root, now=lambda: self.now)
        learning.state['lessons'] = [{'id': 'synthetic_lesson'}]
        args = {**self.input, 'lesson': {'lessonId': 'synthetic_lesson', 'rationale': 'Prospective relevance, never a retrospective performance claim'}}
        original_gateway = self.gateway
        def checked(path, payload):
            if path == '/decision':
                data = json.loads(learning.path.read_text())
                binding = data['bindings'][self.plan['id']]
                self.assertLessEqual(binding['at'], self.book.state['submissions'][args['id']]['at'])
            return original_gateway(path, payload)
        with patch.object(runner, 'LEARNING_BOOK', learning), patch.object(runner, 'gateway', checked):
            result = json.loads(runner.enter_result(args))
        self.assertEqual(result['state'], 'OPEN')
        self.assertEqual(len(self.requests), 2)

    def test_existing_setup_uses_same_fast_path_without_recreating_plan(self):
        self.book.create(self.plan)
        result = self.enter({'id': self.input['id'], 'reason': self.input['reason'], 'setupId': self.plan['id']})
        self.assertEqual(result['state'], 'OPEN')
        self.assertEqual(len(self.book.state['plans']), 1)

    def test_watch_only_create_never_sends_an_order(self):
        with patch.object(runner, 'gateway', self.gateway):
            result = json.loads(runner.plan_result({'operation': 'CREATE', 'plan': self.plan}))
        self.assertTrue(result['assessment']['ready'])
        self.assertEqual(self.requests, [])

    def test_current_price_rejection_does_not_schedule_a_later_automatic_entry(self):
        self.context['rows'][0]['book'].update(bid=10.2, ask=10.201)
        result = self.enter()
        self.assertEqual(result['status'], 'SETUP_NOT_READY')
        self.assertFalse(result['entryLatency']['gatewaySent'])
        self.assertFalse(self.orders)
        self.context['rows'][0]['book'].update(bid=10, ask=10.001)
        self.book.observe(self.context)
        self.assertTrue(self.book.get(self.plan['id'])['assessment']['ready'])
        self.assertFalse(self.orders)  # Readiness alone is not an OPEN authorization.

    def test_wallet_and_ownership_are_refreshed_not_reused_from_cache(self):
        self.context['status']['wallet']['fresh'] = False
        result = self.enter()
        self.assertEqual(result['status'], 'SETUP_NOT_READY')
        self.assertIn('walletFresh', result['assessment']['failed'])
        self.assertFalse(self.orders)
        self.context['status']['wallet']['fresh'] = True
        self.context['unavailableSymbols'] = ['DOGEUSDT']
        result = self.enter()
        self.assertIn('symbolFree', result['assessment']['failed'])
        self.assertFalse(self.orders)

    def test_stale_missing_or_wrong_venue_quotes_fail_without_submitting(self):
        for variant in ('stale', 'missing', 'wrongVenue'):
            snapshot = self.snapshot()
            if variant == 'stale': snapshot['overview'][0]['book']['time'] = self.now-30001
            if variant == 'missing': snapshot['overview'] = []
            if variant == 'wrongVenue': snapshot['source'] = 'MAINNET'
            with patch.object(runner, 'gateway', return_value=snapshot) as g:
                result = json.loads(runner.enter_result(self.input))
            self.assertEqual(result['status'], 'SETUP_DATA_UNAVAILABLE')
            self.assertEqual(g.call_count, 1)

    def test_same_bar_missing_fee_or_expired_funding_cache_falls_back(self):
        row = copy.deepcopy(self.book.rows['DOGEUSDT'])
        self.assertTrue(runner.entry_cache_current(row, self.now))
        variants = []
        for kind in ('bar', 'fee', 'funding', 'exchangeTime', 'observation'):
            r = copy.deepcopy(row)
            if kind == 'bar': r['candles'][0]['closeTime'] -= 300000
            if kind == 'fee': r['economics']['commission'].pop('observedAt')
            if kind == 'funding': r['economics']['funding']['observedAt'] -= 60000
            if kind == 'exchangeTime': r['economics']['funding']['exchangeTime'] -= 120000
            if kind == 'observation': r['observedAt'] -= 120000
            variants.append(r)
        for r in variants:
            self.assertFalse(runner.entry_cache_current(r, self.now))
        self.book.rows['DOGEUSDT'] = variants[2]
        result = self.enter()
        self.assertEqual(result['entryLatency']['contextPath'], 'FULL_CONTEXT')
        self.assertEqual(self.requests[0], ('/context', {'symbols': ['DOGEUSDT']}))

    def test_bar_rollover_during_bbo_refresh_forces_full_candle_check(self):
        def boundary(path, payload):
            self.requests.append((path, payload))
            self.assertEqual(path, '/context')
            if not payload['symbols']:
                self.now += 300000
                return self.snapshot()
            c = copy.deepcopy(self.context)
            c['rows'][0]['candles'] = [{'closeTime': self.now-1, 'close': 9.5}]
            c['rows'][0]['book']['time'] = self.now
            return c
        with patch.object(runner, 'gateway', boundary):
            result = json.loads(runner.enter_result(self.input))
        self.assertEqual(result['status'], 'SETUP_NOT_READY')
        self.assertIn('trigger', result['assessment']['failed'])
        self.assertEqual(result['entryLatency']['contextPath'], 'CACHE_EXPIRED_DURING_REFRESH_FULL_CONTEXT')
        self.assertEqual(self.requests, [('/context', {'symbols': []}), ('/context', {'symbols': ['DOGEUSDT']})])

    def test_provenance_gate_is_not_bypassed(self):
        exp = types.SimpleNamespace(bind_plan=lambda _: None,
                                    check_entry=Mock(side_effect=ValueError('Wrong assigned version')))
        with patch.object(runner, 'EXPERIMENT_BOOK', exp):
            result = self.enter()
        self.assertIn('Wrong assigned version', result['entry_error'])
        self.assertEqual(self.requests, [])

    def test_missing_strategy_or_unknown_lesson_never_creates_an_order(self):
        with patch.object(runner, 'EXPERIMENT_REQUIRED', True):
            result = self.enter()
        self.assertIn('journal unavailable', result['entry_error'])
        self.assertEqual(self.book.state['plans'], [])
        result = self.enter({**self.input, 'lesson': {'lessonId': 'unknown', 'rationale': 'A purported relevance not backed by a known lesson'}})
        self.assertIn('must already exist', result['entry_error'])
        self.assertEqual(self.book.state['plans'], [])

    def test_uncertain_transport_reuses_exact_decision_and_does_not_duplicate(self):
        first = True
        original = self.gateway
        def uncertain(path, payload):
            nonlocal first
            result = original(path, payload)
            if path == '/decision' and first:
                first = False
                raise TimeoutError('Synthetic reply loss after gateway accepted order')
            return result
        with patch.object(runner, 'gateway', uncertain):
            result = json.loads(runner.enter_result(self.input))
            self.assertEqual(result['entryLatency']['outcome'], 'ERROR_AFTER_SEND_UNCERTAIN')
            retry = json.loads(runner.enter_result(self.input))
        self.assertEqual(retry['state'], 'OPEN')
        self.assertEqual(retry['entryLatency']['contextPath'], 'IDEMPOTENT_RECONCILIATION')
        self.assertEqual(len(self.orders), 1)
        submits = [p for path, p in self.requests if path == '/decision']
        self.assertEqual(submits[0], submits[1])

    def test_duplicate_id_with_different_intent_is_rejected(self):
        self.enter()
        count = len(self.requests)
        result = self.enter({**self.input, 'reason': 'Changed decision text after the original entry intent'})
        self.assertIn('different intent', result['entry_error'])
        self.assertEqual(len(self.requests), count)

    def test_telemetry_write_failure_after_order_preserves_actual_order_result(self):
        original = Path.open
        def failed(path, *args, **kwargs):
            if path.name == 'entry-latency.jsonl': raise PermissionError('Synthetic telemetry failure')
            return original(path, *args, **kwargs)
        with patch.object(Path, 'open', failed): result = self.enter()
        self.assertEqual(result['state'], 'OPEN')
        self.assertFalse(result['entryLatency']['telemetryPersisted'])
        self.assertEqual(len(self.orders), 1)

    def test_fast_entry_tool_is_only_registered_for_trading_mode(self):
        registry = Mock()
        with patch.dict('sys.modules', {'tools.registry': types.SimpleNamespace(registry=registry)}):
            runner.register_tools(False)
            self.assertNotIn('astra_enter', [c.kwargs['name'] for c in registry.register.call_args_list])
            registry.reset_mock()
            runner.register_tools(True)
            registered = next(c for c in registry.register.call_args_list if c.kwargs['name'] == 'astra_enter')
            self.assertEqual(registered.kwargs['schema'], ENTER_SCHEMA)

    def test_agent_must_actually_receive_fast_entry_and_no_unapproved_tools(self):
        provider = types.SimpleNamespace(resolve_runtime_provider=lambda **k: {
            'provider': 'openai-codex', 'api_key': 'synthetic', 'base_url': 'https://example.invalid', 'api_mode': 'responses'})
        names = ['astra_context', 'astra_enter']
        agent = types.SimpleNamespace(AIAgent=lambda **k: types.SimpleNamespace(
            model=k['model'], provider=k['provider'], tools=[{'name': n} for n in names]))
        modules = {'hermes_cli.runtime_provider': provider, 'run_agent': agent,
                   'hermes_state': types.SimpleNamespace(SessionDB=lambda: object())}
        with patch.dict('sys.modules', modules), patch.object(runner, 'register_tools', lambda _: None):
            self.assertEqual(runner.make_agent(True, object()).model, 'gpt-6-astra')
            names.remove('astra_enter')
            with self.assertRaisesRegex(RuntimeError, 'isolation failed'):
                runner.make_agent(True, object())
            names.extend(['astra_enter', 'shell'])
            with self.assertRaisesRegex(RuntimeError, 'isolation failed'):
                runner.make_agent(True, object())


if __name__ == '__main__': unittest.main()

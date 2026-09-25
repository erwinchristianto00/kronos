import copy
import unittest
from pathlib import Path

import astra_quant_v4 as quant
import astra_v4_spec as spec
import astra_v8_runner as worker
import hermes_model_policy_v1 as router
from make_v8_manifest import build, RUNTIME_FILES


class QuantV4Tests(unittest.TestCase):
    def setUp(self):
        self.raw = {"source": "BINANCE_USDM_TESTNET", "status": {"environment": "testnet"},
                    "rows": [{"symbol": "DOGEUSDT", "observedAt": 1000,
                              "features": {"returnBps": 12.5, "unknown": None, "bad": float('nan')}}]}

    def test_features_are_not_estimated_edge(self):
        q = quant.contract(self.raw, 1000)
        self.assertFalse(q['validatedEdgeEngineAvailable'])
        r = q['rows'][0]
        self.assertEqual(r['measuredFeatures'], {'returnBps':12.5})
        self.assertTrue(all(r[k] is None for k in quant.UNAVAILABLE))

    def test_old_or_future_features_do_not_become_fresh(self):
        for at in (999, 122000):
            r = quant.contract(self.raw, at)['rows'][0]
            self.assertEqual(r['status'], 'STALE_FEATURE_CONTEXT')
            self.assertIsNone(r['measuredFeatures']['returnBps'])

    def test_false_statistics_not_promoted(self):
        self.raw['rows'][0]['quant'] = {'historicalProfitFactor':999,'estimatedEdgeBps':999}
        q = quant.contract(self.raw, 1000)['rows'][0]
        self.assertIsNone(q['historicalProfitFactor'])
        self.assertIsNone(q['estimatedEdgeBps'])

    def test_no_live_context(self):
        self.raw['status']['environment'] = 'live'
        with self.assertRaises(ValueError):
            quant.contract(self.raw, 1000)

    def test_no_input_mutation(self):
        self.raw['rows'][0]['features'].pop('bad')
        original = copy.deepcopy(self.raw)
        quant.contract(self.raw, 1000)
        self.assertEqual(self.raw, original)

    def test_v4_is_only_strategy_prompt(self):
        prompt = worker.fast_rules(None)
        self.assertTrue(prompt.startswith(spec.PROMPT.replace('Model: GPT-6 Astra · MEDIUM','Model: Claude Sonnet 5 · MEDIUM',1)))
        self.assertNotIn('V2 supersedes', prompt)
        self.assertIn('QUANT_EDGE:', prompt)
        self.assertIn('PORTFOLIO_FIT:', prompt)
        self.assertIn('No essay.', prompt)
        self.assertIn('Max two attempts', prompt)

    def test_primary_is_sonnet_medium(self):
        p = router.POLICIES[(router.FAST_TRADING, router.PRIMARY)]
        self.assertEqual((p['model'],p['effort']),('claude-sonnet-5','medium'))

    def test_spec_and_contract_are_fingerprinted_unarmed(self):
        m = build(Path(__file__).parent, armed=False, tests_passed=False,
                  integration_verified=False, gateway_version='astra-final-book-contract-v1-20260909')
        self.assertEqual(m['cohortId'],router.COHORT)
        self.assertFalse(m['armed'])
        self.assertTrue({'astra_v4_spec.py','astra_quant_v4.py'} <= set(m['runtimeFiles']))


if __name__ == '__main__':
    unittest.main()

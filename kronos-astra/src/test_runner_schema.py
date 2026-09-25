"""Tool-schema and forwarding regression tests; no provider/network calls."""
import json
import copy
import sys
import types
import unittest
from unittest.mock import Mock, patch
import astra_runner


class ContextSchemaTests(unittest.TestCase):
    def test_wallet_capital_identity_rejects_legacy_virtual_wallet_and_wrong_environment(self):
        valid = {"environment": "testnet", "laneId": "ASTRA_HERMES_TESTNET", "leverage": 1,
                 "capital": {"mode": "BINANCE_TESTNET_WALLET", "maxEntryNotionalUsd": 25,
                             "maxOpenPositions": None, "totalLaneAllocationUsd": None}}
        astra_runner.validate_capital_identity(valid)
        for invalid in [{"environment": "testnet", "initialEquity": 25},
                        {**valid, "environment": "mainnet"}, {**valid, "leverage": 10},
                        {**valid, "capital": {**valid["capital"], "maxOpenPositions": 1}}]:
            with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
                astra_runner.validate_capital_identity(invalid)

    def test_enriched_full_universe_and_old_reasons_fit_without_loss_of_statistics(self):
        symbols = [f"COIN{i}USDT" for i in range(528)]
        result = {"universe": symbols, "overview": [{"symbol": s, "book": {"bid": 123.12345678, "ask": 123.22345678, "bidQty": 123456.12345, "askQty": 923456.12345, "time": 1800000000000}, "minNotional": 5, "unavailableForNewEntry": False,
            "change24hPct": 12.1234, "quoteVolume24h": 123456789.1234, "range24hPct": 13.1234, "statsFresh": True} for s in symbols], "rows": [],
            "status": {"decisions": [{"decision": {"id": str(i), "reason": "x" * 4000}, "result": {"status": "WAIT_RECORDED"}} for i in range(10)]}}
        trade = {"id": "closed-trade", "state": "CLOSED", "exitReason": "MAX_HOLD", "decision": {"id": "old-decision", "reason": "x" * 4000}, "fills": [{"price": 1, "qty": 5, "commission": 0.01}]}
        result["status"]["closed"] = [copy.deepcopy(trade), copy.deepcopy(trade)]
        for previous in result["status"]["decisions"]:
            previous["result"] = copy.deepcopy(trade)
        with patch.object(astra_runner, "gateway", return_value=result):
            encoded = astra_runner.context_result({"symbols": []})
        decoded = json.loads(encoded)
        self.assertLess(len(encoded), 90000)
        self.assertEqual(len(decoded["overview"]["rows"]), 528)
        row = dict(zip(decoded["overview"]["columns"], decoded["overview"]["rows"][0]))
        self.assertEqual(row["quoteVolume24h"], 123456789.1234)
        self.assertTrue(row["statsFresh"])
        self.assertTrue(decoded["status"]["decisions"][0]["decision"]["reasonTruncatedInContext"])
        self.assertEqual(decoded["status"]["closed"][0]["fills"][0]["commission"], 0.01)
        self.assertEqual(decoded["status"]["closed"][0]["exitReason"], "MAX_HOLD")

    def test_oversized_overview_has_lossless_continuation_not_a_symbol_cap(self):
        symbols = [f"COIN{i}USDT" for i in range(1200)]
        snapshot = {"universe": symbols, "overview": [{"symbol": s, "book": {"bid": 123.12345678, "ask": 123.22345678, "bidQty": 123456.12345, "askQty": 923456.12345, "time": 1800000000000}, "minNotional": 5, "unavailableForNewEntry": False} for s in symbols], "rows": []}
        seen = []
        offset = 0
        while offset is not None:
            with patch.object(astra_runner, "gateway", return_value=copy.deepcopy(snapshot)):
                response = astra_runner.context_result({"symbols": [], "overviewOffset": offset})
            self.assertLess(len(response), 90000)
            d = json.loads(response)
            seen.extend(r[0] for r in d["overview"]["rows"])
            offset = d["overviewPage"]["nextOffset"]
        self.assertEqual(seen, symbols)

    def test_oversized_response_is_explicitly_unavailable_not_silently_spilled(self):
        with patch.object(astra_runner, "gateway", return_value={"unexpected": "x" * 100001}):
            with self.assertRaisesRegex(RuntimeError, "DATA_UNAVAILABLE"):
                astra_runner.context_result({"symbols": []})

    def test_trade_tool_requires_explicit_decision_reason_classification(self):
        registry = Mock()
        with patch.dict(sys.modules, {"tools.registry": types.SimpleNamespace(registry=registry)}):
            astra_runner.register_tools(True)
        decision = registry.register.call_args_list[1].kwargs["schema"]
        self.assertIn("reasonCode", decision["parameters"]["required"])
        self.assertIn("COST_UNAVAILABLE", decision["parameters"]["properties"]["reasonCode"]["enum"])
        self.assertIn("TAKE_PROFIT", decision["parameters"]["properties"]["reasonCode"]["enum"])
        self.assertIn("CUT_LOSS", decision["parameters"]["properties"]["reasonCode"]["enum"])
        self.assertEqual(decision["parameters"]["properties"]["notionalUsd"]["maximum"], 25)

    def test_entire_universe_survives_hermes_output_budget(self):
        symbols = [f"COIN{i}USDT" for i in range(528)]
        result = {"universe": symbols, "overview": [{"symbol": s, "book": {"bid": 1, "ask": 2, "time": 1800000000000}, "minNotional": 5, "unavailableForNewEntry": False} for s in symbols], "rows": []}
        with patch.object(astra_runner, "gateway", return_value=result):
            encoded = astra_runner.context_result({"symbols": []})
        self.assertLess(len(encoded), 90000)
        decoded = json.loads(encoded)
        self.assertEqual(decoded["universe"], symbols)
        self.assertEqual([r[0] for r in decoded["overview"]["rows"]], symbols)
        self.assertEqual(decoded["overview"]["rows"][0][1:6], [1, 2, None, None, 1800000000000])

    def test_large_history_page_has_lossless_continuation_not_spillover(self):
        candle = {"openTime": 1800000000000, "closeTime": 1800000299999,
                  "open": 12345.123456789, "high": 12345.123456789, "low": 12345.123456789,
                  "close": 12345.123456789, "volume": 12345.123456789}
        result = {"rows": [{"symbol": f"COIN{i}USDT", "candles": [copy.deepcopy(candle) for _ in range(100)]} for i in range(20)],
                  "historyPage": {"offset": 20, "requested": 40, "returned": 20, "nextOffset": None}}
        with patch.object(astra_runner, "gateway", return_value=result):
            encoded = astra_runner.context_result({"symbols": [], "offset": 20})
        decoded = json.loads(encoded)
        self.assertLess(len(encoded), 90000)
        count = len(decoded["rows"])
        self.assertGreater(count, 0)
        self.assertLess(count, 20)
        self.assertEqual(decoded["historyPage"]["nextOffset"], 20 + count)
        self.assertEqual(dict(zip(decoded["rows"][0]["candleColumns"], decoded["rows"][0]["candles"][0])), candle)

    def test_unrestricted_symbols_and_exact_pagination_forwarding(self):
        registry = Mock()
        with patch.dict(sys.modules, {"tools.registry": types.SimpleNamespace(registry=registry)}):
            astra_runner.register_tools(False)
        registry.register.assert_called_once()
        context = registry.register.call_args.kwargs
        properties = context["schema"]["parameters"]["properties"]
        self.assertNotIn("maxItems", properties["symbols"])
        self.assertEqual(properties["offset"], {"type": "integer", "minimum": 0})
        request = {"symbols": [f"COIN{i}USDT" for i in range(47)], "offset": 20}
        with patch.object(astra_runner, "gateway", return_value={"ok": True}) as gateway:
            self.assertEqual(json.loads(context["handler"](request)), {"ok": True})
            gateway.assert_called_once_with("/context", request)


if __name__ == "__main__":
    unittest.main()

import { describe, expect, it } from "vitest";

import { parseDailyRangeContractAggTrade } from "../src/lib/daily-range-contract-path.js";

describe("Daily Range contract-price path parser", () => {
  it("accepts a Binance combined aggTrade envelope with contract event time", () => {
    expect(parseDailyRangeContractAggTrade({
      stream: "btcusdt@aggTrade",
      data: { s: "BTCUSDT", p: "100000.25", T: 1_000 },
    }, 1_005, 900)).toEqual({
      symbol: "BTCUSDT",
      price: 100000.25,
      eventTimeMs: 1_000,
      receivedAtMs: 1_005,
      source: "CONTRACT_AGG_TRADE",
      streamStartedAtMs: 900,
    });
  });

  it("rejects a malformed or non-causal path event instead of inventing an extrema point", () => {
    expect(parseDailyRangeContractAggTrade({ data: { s: "BTCUSDT", p: "NaN", T: 1_000 } }, 1_005, 900)).toBeNull();
    expect(parseDailyRangeContractAggTrade({ data: { s: "", p: "100", T: 1_000 } }, 1_005, 900)).toBeNull();
    expect(parseDailyRangeContractAggTrade({ data: { s: "BTCUSDT", p: "100", T: 1_000 } }, 0, 900)).toBeNull();
  });
});

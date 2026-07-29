import { describe, expect, it } from "vitest";
import type { Candle } from "@dtc/shared";
import { challengerAgree, type ForecastChallengerPrediction } from "../src/lib/forecast-challenger.js";
import {
  ForecastChallengerBtcAnchorCache,
  refreshForecastChallengerBtcAnchor,
} from "../src/lib/forecast-challenger-btc-anchor.js";

const candle = { openTime: 1, closeTime: 2, open: 1, high: 1, low: 1, close: 1, volume: 1 } as Candle;
const prediction = (overrides: Partial<ForecastChallengerPrediction> = {}): ForecastChallengerPrediction => ({
  available: true,
  model: "chronos2",
  bias: "LONG",
  confidence: 70,
  expectedReturn: 0.01,
  volatility: 0.002,
  probabilityUp: 70,
  probabilityDown: 30,
  generatedAtMs: 5_000,
  reason: null,
  ...overrides,
});

describe("forecast challenger advisory contract", () => {
  it("maps only a directional, confidence-bearing prediction into a signed vote", () => {
    expect(challengerAgree(prediction())).toBeCloseTo(0.7, 8);
    expect(challengerAgree(prediction({ bias: "SHORT", confidence: 35 }))).toBeCloseTo(-0.35, 8);
    expect(challengerAgree(prediction({ bias: "NEUTRAL" }))).toBeNull();
    expect(challengerAgree(prediction({ available: false }))).toBeNull();
    expect(challengerAgree(prediction({ confidence: 0 }))).toBeNull();
  });

  it("withdraws a prior opinion immediately when the refresh fails", async () => {
    const cache = new ForecastChallengerBtcAnchorCache();
    const fetchCandles = async () => Array.from({ length: 32 }, () => candle);
    await refreshForecastChallengerBtcAnchor(cache, fetchCandles, async () => prediction());
    await refreshForecastChallengerBtcAnchor(cache, async () => { throw new Error("network down"); }, async () => prediction());
    expect(cache.get().agree).toBeNull();
    expect(cache.get().atMs).toBeNull();
    expect(cache.get().lastSuccessAtMs).not.toBeNull();
    expect(cache.get().lastFailureAtMs).not.toBeNull();
    expect(cache.get().lastSkipReason).toContain("network down");
  });

  it("recovers health and a fresh opinion after a later successful refresh", async () => {
    const cache = new ForecastChallengerBtcAnchorCache();
    const fetchCandles = async () => Array.from({ length: 32 }, () => candle);
    await refreshForecastChallengerBtcAnchor(cache, async () => { throw new Error("offline"); }, async () => prediction());
    await refreshForecastChallengerBtcAnchor(cache, fetchCandles, async () => prediction({ generatedAtMs: 10_000 }));
    expect(cache.get().agree).toBeCloseTo(0.7, 8);
    expect(cache.get().atMs).toBe(10_000);
    expect(cache.get().lastFailureAtMs).toBeNull();
    expect(cache.get().stalenessReason).toBeNull();
  });
});

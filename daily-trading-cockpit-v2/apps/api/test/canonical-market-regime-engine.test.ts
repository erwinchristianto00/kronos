import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Candle } from "@dtc/shared";
import {
  fetchCanonicalMarketRegimeEngineRawSymbolObservation,
  ingestCanonicalMarketRegimeRawObservations,
  diffCanonicalMarketRegimeEngineObservationIds,
  buildCanonicalMarketRegimeEngineSourceObservationId,
  buildCanonicalMarketRegimeEngineFuturesKlinesUrl,
  CANONICAL_MARKET_REGIME_ENGINE_CANDLES_REQUIRED,
  computeCanonicalMarketRegimeEngineReturnPct,
  buildCanonicalMarketRegimeEngineSymbolStats,
  computeCanonicalMarketRegimeEngineLiquidityWeights,
  computeCanonicalMarketRegimeEngineDirection,
  computeCanonicalMarketRegimeEngineBreadth,
  computeCanonicalMarketRegimeEngineCohesionDispersion,
  computeCanonicalMarketRegimeEngineRiskStress,
  CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT,
  classifyCanonicalMarketRegimeEngineCoverage,
  computeCanonicalMarketRegimeEngineCandidateDirection,
  computeCanonicalMarketRegimeEngineOverlays,
  canonicalMarketRegimeEnginePanicConditionMet,
  advanceCanonicalMarketRegimeEnginePanicState,
  initialCanonicalMarketRegimeEngineProjectionState,
  advanceCanonicalMarketRegimeEngineProjection,
  computeCanonicalMarketRegimeSnapshot,
  computeCanonicalMarketRegimeEngineConfidence,
  degradedLowCoverageSnapshot,
  validCanonicalMarketRegimeSnapshotShape,
  readCanonicalMarketRegimeSnapshotStoreStrict,
  CanonicalMarketRegimeSnapshotStore,
  getCanonicalMarketRegimeSnapshotStore,
  _resetCanonicalMarketRegimeSnapshotStoreForTests,
  recordCanonicalMarketRegimeSnapshot,
  getCanonicalMarketRegimeSnapshot,
  CANONICAL_MARKET_REGIME_ENGINE_DISABLED_ENV_KEY,
  CANONICAL_MARKET_REGIME_ENGINE_MIN_UNIVERSE_SIZE,
  CANONICAL_MARKET_REGIME_SNAPSHOT_SCHEMA_VERSION,
  CANONICAL_MARKET_REGIME_SNAPSHOT_MAX_HISTORY,
  CANONICAL_MARKET_REGIME_DEFAULT_CALIBRATION_VERSION,
  CANONICAL_MARKET_REGIME_ENGINE_VERSION,
  CANONICAL_MARKET_REGIME_ENGINE_ENTER_CONFIRM_CYCLES,
  CANONICAL_MARKET_REGIME_ENGINE_PANIC_RISK_STRESS_THRESHOLD,
  CANONICAL_MARKET_REGIME_ENGINE_PANIC_DIRECTION_FAST_THRESHOLD,
  CANONICAL_MARKET_REGIME_ENGINE_PANIC_BREADTH_THRESHOLD,
  CANONICAL_MARKET_REGIME_ENGINE_PANIC_EXIT_CONFIRM_CYCLES,
  type CanonicalMarketRegimeEngineFetchJson,
  type CanonicalMarketRegimeEngineRawSymbolResult,
  type CanonicalMarketRegimeEngineSymbolStat,
  type CanonicalMarketRegimeEngineRawIngestionCycle,
  type CanonicalMarketRegimeEngineCoverageResult,
  type CanonicalMarketRegimeEnginePanicState,
  type CanonicalMarketRegimeSnapshot,
  type CanonicalMarketRegimeRawFeatures,
  type CanonicalMarketRegimeRawSymbolFeature,
} from "../src/lib/canonical-market-regime-engine.js";

const HOUR_MS = 3_600_000;
const NOW = Date.UTC(2026, 7, 4, 12, 0, 0);

/** `count` contiguous COMPLETED 1h candles, ascending, the last one closing exactly at `endMs`. */
function buildContiguousCandles(count: number, endMs: number): Candle[] {
  const out: Candle[] = [];
  for (let i = count; i >= 1; i -= 1) {
    const openTime = endMs - i * HOUR_MS;
    out.push({ openTime, open: 100, high: 101, low: 99, close: 100 + (count - i), volume: 1000 });
  }
  return out;
}

function klineRow(c: Candle): unknown[] {
  return [c.openTime, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume), c.openTime + HOUR_MS - 1, "0", 0, "0", "0", "0"];
}

function fetchJsonForCandles(candles: Candle[]): CanonicalMarketRegimeEngineFetchJson {
  return async (url: string) => {
    if (!url.includes("/fapi/v1/klines")) throw new Error(`unexpected url ${url}`);
    return candles.map(klineRow);
  };
}

function isOk(result: CanonicalMarketRegimeEngineRawSymbolResult): result is Extract<CanonicalMarketRegimeEngineRawSymbolResult, { dataQuality: "OK" }> {
  return result.dataQuality === "OK";
}

describe("canonical-market-regime-engine — raw ingestion (stage 1)", () => {
  describe("buildCanonicalMarketRegimeEngineSourceObservationId", () => {
    it("is a stable, human-readable composite key", () => {
      expect(buildCanonicalMarketRegimeEngineSourceObservationId("BTCUSDT", "1h", 123)).toBe("BTCUSDT|1h|123");
    });
  });

  describe("buildCanonicalMarketRegimeEngineFuturesKlinesUrl", () => {
    it("targets the futures klines endpoint with symbol/interval/limit", () => {
      const url = buildCanonicalMarketRegimeEngineFuturesKlinesUrl("ETHUSDT", "1h", 30);
      expect(url).toContain("fapi.binance.com/fapi/v1/klines");
      expect(url).toContain("symbol=ETHUSDT");
      expect(url).toContain("interval=1h");
      expect(url).toContain("limit=30");
    });
  });

  describe("fetchCanonicalMarketRegimeEngineRawSymbolObservation", () => {
    it("returns OK with exactly the required window of completed candles on a clean fetch", async () => {
      const candles = buildContiguousCandles(CANONICAL_MARKET_REGIME_ENGINE_CANDLES_REQUIRED, NOW);
      const result = await fetchCanonicalMarketRegimeEngineRawSymbolObservation("BTCUSDT", NOW, { fetchJson: fetchJsonForCandles(candles) });
      expect(result.dataQuality).toBe("OK");
      if (!isOk(result)) throw new Error("expected OK");
      expect(result.candles).toHaveLength(CANONICAL_MARKET_REGIME_ENGINE_CANDLES_REQUIRED);
      expect(result.lastClosedCandleOpenTimeMs).toBe(NOW - HOUR_MS);
      expect(result.sourceObservationId).toBe(buildCanonicalMarketRegimeEngineSourceObservationId("BTCUSDT", "1h", NOW - HOUR_MS));
    });

    it("NEVER includes the in-progress candle, even when the fetch returns it", async () => {
      const completed = buildContiguousCandles(CANONICAL_MARKET_REGIME_ENGINE_CANDLES_REQUIRED, NOW);
      const forming: Candle = { openTime: NOW, open: 999, high: 999, low: 999, close: 999, volume: 1 };
      const result = await fetchCanonicalMarketRegimeEngineRawSymbolObservation("BTCUSDT", NOW, {
        fetchJson: fetchJsonForCandles([...completed, forming]),
      });
      expect(result.dataQuality).toBe("OK");
      if (!isOk(result)) throw new Error("expected OK");
      expect(result.candles.some((c) => c.openTime === NOW)).toBe(false);
      expect(result.candles.some((c) => c.close === 999)).toBe(false);
      expect(Math.max(...result.candles.map((c) => c.openTime))).toBe(NOW - HOUR_MS);
    });

    it("returns MISSING/INSUFFICIENT_COMPLETED_CANDLES when fewer than required candles are available", async () => {
      const candles = buildContiguousCandles(CANONICAL_MARKET_REGIME_ENGINE_CANDLES_REQUIRED - 1, NOW);
      const result = await fetchCanonicalMarketRegimeEngineRawSymbolObservation("BTCUSDT", NOW, { fetchJson: fetchJsonForCandles(candles) });
      expect(result.dataQuality).toBe("MISSING");
      if (result.dataQuality !== "MISSING") throw new Error("expected MISSING");
      expect(result.reason).toBe("INSUFFICIENT_COMPLETED_CANDLES");
      expect("candles" in result).toBe(false);
    });

    it("returns MISSING/NON_CONTIGUOUS_CANDLES when the required window has an internal gap", async () => {
      const contiguous26 = buildContiguousCandles(CANONICAL_MARKET_REGIME_ENGINE_CANDLES_REQUIRED + 1, NOW);
      const withGap = contiguous26.filter((_, i) => i !== 10); // count stays at CANDLES_REQUIRED, one hour dropped
      expect(withGap).toHaveLength(CANONICAL_MARKET_REGIME_ENGINE_CANDLES_REQUIRED);
      const result = await fetchCanonicalMarketRegimeEngineRawSymbolObservation("BTCUSDT", NOW, { fetchJson: fetchJsonForCandles(withGap) });
      expect(result.dataQuality).toBe("MISSING");
      if (result.dataQuality !== "MISSING") throw new Error("expected MISSING");
      expect(result.reason).toBe("NON_CONTIGUOUS_CANDLES");
    });

    it("returns MISSING/FETCH_ERROR when the network call rejects, and never throws", async () => {
      const fetchJson: CanonicalMarketRegimeEngineFetchJson = async () => {
        throw new Error("boom");
      };
      const result = await fetchCanonicalMarketRegimeEngineRawSymbolObservation("BTCUSDT", NOW, { fetchJson });
      expect(result.dataQuality).toBe("MISSING");
      if (result.dataQuality !== "MISSING") throw new Error("expected MISSING");
      expect(result.reason).toBe("FETCH_ERROR");
      expect(result.detail).toContain("boom");
    });

    it("returns MISSING/MALFORMED_RESPONSE for a non-array payload", async () => {
      const fetchJson: CanonicalMarketRegimeEngineFetchJson = async () => ({ not: "an array" });
      const result = await fetchCanonicalMarketRegimeEngineRawSymbolObservation("BTCUSDT", NOW, { fetchJson });
      expect(result.dataQuality).toBe("MISSING");
      if (result.dataQuality !== "MISSING") throw new Error("expected MISSING");
      expect(result.reason).toBe("MALFORMED_RESPONSE");
    });

    it("returns MISSING/MALFORMED_RESPONSE when a row has a non-finite OHLCV field", async () => {
      const candles = buildContiguousCandles(CANONICAL_MARKET_REGIME_ENGINE_CANDLES_REQUIRED, NOW);
      const rows = candles.map(klineRow);
      (rows[5] as unknown[])[4] = "not-a-number"; // corrupt one row's close
      const fetchJson: CanonicalMarketRegimeEngineFetchJson = async () => rows;
      const result = await fetchCanonicalMarketRegimeEngineRawSymbolObservation("BTCUSDT", NOW, { fetchJson });
      expect(result.dataQuality).toBe("MISSING");
      if (result.dataQuality !== "MISSING") throw new Error("expected MISSING");
      expect(result.reason).toBe("MALFORMED_RESPONSE");
    });

    it("returns MISSING/UNSUPPORTED_INTERVAL for an interval outside the known map, without ever fetching", async () => {
      let called = false;
      const fetchJson: CanonicalMarketRegimeEngineFetchJson = async () => {
        called = true;
        return [];
      };
      const result = await fetchCanonicalMarketRegimeEngineRawSymbolObservation("BTCUSDT", NOW, { fetchJson, interval: "7h" });
      expect(result.dataQuality).toBe("MISSING");
      if (result.dataQuality !== "MISSING") throw new Error("expected MISSING");
      expect(result.reason).toBe("UNSUPPORTED_INTERVAL");
      expect(called).toBe(false);
    });
  });

  describe("ingestCanonicalMarketRegimeRawObservations", () => {
    it("keeps honest coverage counts and NEVER lets a missing symbol contribute a value", async () => {
      const good = buildContiguousCandles(CANONICAL_MARKET_REGIME_ENGINE_CANDLES_REQUIRED, NOW);
      const fetchJson: CanonicalMarketRegimeEngineFetchJson = async (url) => {
        if (url.includes("symbol=GOODUSDT")) return good.map(klineRow);
        throw new Error("simulated outage");
      };
      const cycle = await ingestCanonicalMarketRegimeRawObservations(["GOODUSDT", "BADUSDT"], NOW, { fetchJson });

      expect(cycle.requiredSymbolCount).toBe(2);
      expect(cycle.validSymbolCount).toBe(1);
      expect(cycle.coveragePct).toBeCloseTo(0.5);

      expect(Object.keys(cycle.sourceObservationIds)).toEqual(["GOODUSDT"]);
      expect(cycle.sourceObservationIds.BADUSDT).toBeUndefined();

      expect(cycle.perSymbol.BADUSDT?.dataQuality).toBe("MISSING");
      expect("candles" in (cycle.perSymbol.BADUSDT as object)).toBe(false); // structural: no numeric leak

      expect(cycle.missingSymbols).toHaveLength(1);
      expect(cycle.missingSymbols[0]).toMatchObject({ symbol: "BADUSDT", reason: "FETCH_ERROR" });
      expect(cycle.missingReasonCounts.FETCH_ERROR).toBe(1);
      expect(cycle.missingReasonCounts.MALFORMED_RESPONSE).toBe(0);
    });

    it("never divides by zero: an empty universe yields coveragePct 0, not NaN", async () => {
      const cycle = await ingestCanonicalMarketRegimeRawObservations([], NOW, { fetchJson: async () => [] });
      expect(cycle.requiredSymbolCount).toBe(0);
      expect(cycle.validSymbolCount).toBe(0);
      expect(cycle.coveragePct).toBe(0);
      expect(Number.isNaN(cycle.coveragePct)).toBe(false);
    });
  });

  describe("diffCanonicalMarketRegimeEngineObservationIds (structural dedup guarantee, requirement #4)", () => {
    it("is never a duplicate on cold start, even against an empty current map", () => {
      const delta = diffCanonicalMarketRegimeEngineObservationIds({}, null);
      expect(delta.isDuplicateCycle).toBe(false);
    });

    it("is a duplicate when the identity map is byte-for-byte unchanged", () => {
      const ids = { BTCUSDT: "BTCUSDT|1h|100", ETHUSDT: "ETHUSDT|1h|100" };
      const delta = diffCanonicalMarketRegimeEngineObservationIds({ ...ids }, { ...ids });
      expect(delta).toEqual({ isDuplicateCycle: true, changedSymbols: [], droppedSymbols: [] });
    });

    it("is a duplicate when both prior and current are empty (but prior is not null)", () => {
      const delta = diffCanonicalMarketRegimeEngineObservationIds({}, {});
      expect(delta.isDuplicateCycle).toBe(true);
    });

    it("flags a symbol whose id changed (a genuinely new completed candle)", () => {
      const prior = { BTCUSDT: "BTCUSDT|1h|100" };
      const current = { BTCUSDT: "BTCUSDT|1h|200" };
      const delta = diffCanonicalMarketRegimeEngineObservationIds(current, prior);
      expect(delta.isDuplicateCycle).toBe(false);
      expect(delta.changedSymbols).toEqual(["BTCUSDT"]);
      expect(delta.droppedSymbols).toEqual([]);
    });

    it("flags a symbol that dropped out (was OK, now MISSING)", () => {
      const prior = { BTCUSDT: "BTCUSDT|1h|100", ETHUSDT: "ETHUSDT|1h|100" };
      const current = { BTCUSDT: "BTCUSDT|1h|100" };
      const delta = diffCanonicalMarketRegimeEngineObservationIds(current, prior);
      expect(delta.isDuplicateCycle).toBe(false);
      expect(delta.changedSymbols).toEqual([]);
      expect(delta.droppedSymbols).toEqual(["ETHUSDT"]);
    });

    it("flags a symbol that newly appeared (was MISSING, now OK)", () => {
      const prior = { BTCUSDT: "BTCUSDT|1h|100" };
      const current = { BTCUSDT: "BTCUSDT|1h|100", ETHUSDT: "ETHUSDT|1h|100" };
      const delta = diffCanonicalMarketRegimeEngineObservationIds(current, prior);
      expect(delta.isDuplicateCycle).toBe(false);
      expect(delta.changedSymbols).toEqual(["ETHUSDT"]);
      expect(delta.droppedSymbols).toEqual([]);
    });

    it("is not a duplicate when a symbol changed AND another dropped in the same cycle", () => {
      // Combined-signal case: both changedSymbols and droppedSymbols are simultaneously non-empty
      // here, so this alone cannot distinguish the `&&` in isDuplicateCycle's definition from a
      // weakened `||` (both formulas agree when both terms are false) — the three single-signal
      // cases above ("changed" alone, "dropped" alone, "appeared" alone) are what actually pin that
      // boundary, since each has exactly one of the two terms true. This test instead guards the
      // simpler property that a cycle with two simultaneous real changes is never miscounted as one
      // that cancels itself out back to "duplicate".
      const prior = { BTCUSDT: "BTCUSDT|1h|100", ETHUSDT: "ETHUSDT|1h|100" };
      const current = { BTCUSDT: "BTCUSDT|1h|200" }; // BTC changed AND ETH dropped
      const delta = diffCanonicalMarketRegimeEngineObservationIds(current, prior);
      expect(delta.isDuplicateCycle).toBe(false);
      expect(delta.changedSymbols).toEqual(["BTCUSDT"]);
      expect(delta.droppedSymbols).toEqual(["ETHUSDT"]);
    });
  });
});

// ─── stage 2: pure statistics (direction/breadth/cohesion/dispersion/riskStress) ───────────────────

function c(close: number, openTime = 0): Candle {
  return { openTime, open: close, high: close, low: close, close, volume: 1 };
}

function stat(
  overrides: Partial<CanonicalMarketRegimeEngineSymbolStat> & { symbol: string },
): CanonicalMarketRegimeEngineSymbolStat {
  return { dataQuality: "OK", returnFastPct: null, returnSlowPct: null, quoteVolume24hUsd: null, ...overrides };
}

function okSymbolResult(symbol: string, candles: Candle[]) {
  const lastClosedCandleOpenTimeMs = candles[candles.length - 1]!.openTime;
  return {
    symbol,
    dataQuality: "OK" as const,
    candles,
    lastClosedCandleOpenTimeMs,
    sourceObservationId: buildCanonicalMarketRegimeEngineSourceObservationId(symbol, "1h", lastClosedCandleOpenTimeMs),
  };
}

function missingSymbolResult(symbol: string) {
  return { symbol, dataQuality: "MISSING" as const, reason: "FETCH_ERROR" as const, detail: "test-missing" };
}

/** Hand-builds a stage-1 ingestion cycle without going through the async fetch pipeline, so stage-2
 *  tests can stay synchronous and focused on the statistics themselves. */
function buildCycle(entries: Array<{ symbol: string; candles?: Candle[] }>): CanonicalMarketRegimeEngineRawIngestionCycle {
  const perSymbol: CanonicalMarketRegimeEngineRawIngestionCycle["perSymbol"] = {};
  const sourceObservationIds: Record<string, string> = {};
  const missingSymbols: CanonicalMarketRegimeEngineRawIngestionCycle["missingSymbols"] = [];
  let validSymbolCount = 0;
  for (const e of entries) {
    if (e.candles) {
      const r = okSymbolResult(e.symbol, e.candles);
      perSymbol[e.symbol] = r;
      sourceObservationIds[e.symbol] = r.sourceObservationId;
      validSymbolCount += 1;
    } else {
      const r = missingSymbolResult(e.symbol);
      perSymbol[e.symbol] = r;
      missingSymbols.push({ symbol: e.symbol, reason: r.reason, detail: r.detail });
    }
  }
  return {
    atMs: NOW,
    interval: "1h",
    requiredSymbolCount: entries.length,
    validSymbolCount,
    coveragePct: entries.length > 0 ? validSymbolCount / entries.length : 0,
    perSymbol,
    sourceObservationIds,
    missingSymbols,
    missingReasonCounts: {
      FETCH_ERROR: missingSymbols.length,
      MALFORMED_RESPONSE: 0,
      INSUFFICIENT_COMPLETED_CANDLES: 0,
      NON_CONTIGUOUS_CANDLES: 0,
      UNSUPPORTED_INTERVAL: 0,
    },
  };
}

describe("canonical-market-regime-engine — stage 2 pure statistics", () => {
  describe("computeCanonicalMarketRegimeEngineReturnPct", () => {
    it("computes a simple (non-log) fractional return over the lookback window", () => {
      const candles = [c(100), c(101), c(102), c(103), c(104), c(105), c(110)];
      expect(computeCanonicalMarketRegimeEngineReturnPct(candles, 6)).toBeCloseTo(0.1);
    });

    it("returns null (never 0) when there are not enough candles for the lookback", () => {
      expect(computeCanonicalMarketRegimeEngineReturnPct([c(100), c(101), c(102)], 6)).toBeNull();
    });

    it("returns null for a non-positive lookback", () => {
      expect(computeCanonicalMarketRegimeEngineReturnPct([c(100), c(101)], 0)).toBeNull();
    });

    it("returns null when the reference close is non-finite/non-positive, never a fabricated 0", () => {
      const candles = [c(0), c(101), c(102), c(103), c(104), c(105), c(110)];
      expect(computeCanonicalMarketRegimeEngineReturnPct(candles, 6)).toBeNull();
    });
  });

  describe("buildCanonicalMarketRegimeEngineSymbolStats", () => {
    it("computes both returns and passes through liquidity for an OK symbol", () => {
      const candles = Array.from({ length: 25 }, (_, i) => c(100 + i, i * HOUR_MS));
      const cycle = buildCycle([{ symbol: "BTCUSDT", candles }]);
      const stats = buildCanonicalMarketRegimeEngineSymbolStats(cycle, { BTCUSDT: 5_000_000 });
      expect(stats).toHaveLength(1);
      expect(stats[0]!.dataQuality).toBe("OK");
      expect(stats[0]!.quoteVolume24hUsd).toBe(5_000_000);
      expect(stats[0]!.returnSlowPct).toBeCloseTo(24 / 100); // closes 100 -> 124 over 24 bars
      expect(stats[0]!.returnFastPct).toBeCloseTo(6 / 118); // closes 118 -> 124 over 6 bars
    });

    it("gives a MISSING symbol every field null, discarding any liquidity value present for it", () => {
      const cycle = buildCycle([{ symbol: "DEADUSDT" }]);
      const stats = buildCanonicalMarketRegimeEngineSymbolStats(cycle, { DEADUSDT: 99_000_000 });
      expect(stats).toEqual([
        { symbol: "DEADUSDT", dataQuality: "MISSING", returnFastPct: null, returnSlowPct: null, quoteVolume24hUsd: null },
      ]);
    });

    it("excludes (never zero-fills) an OK symbol absent from the liquidity map", () => {
      const candles = Array.from({ length: 25 }, (_, i) => c(100, i * HOUR_MS));
      const cycle = buildCycle([{ symbol: "NOVOLUSDT", candles }]);
      const stats = buildCanonicalMarketRegimeEngineSymbolStats(cycle, {});
      expect(stats[0]!.quoteVolume24hUsd).toBeNull();
    });

    it("orders output deterministically by symbol, independent of input order", () => {
      const candles = Array.from({ length: 25 }, (_, i) => c(100, i * HOUR_MS));
      const cycle = buildCycle([
        { symbol: "ZZZUSDT", candles },
        { symbol: "AAAUSDT", candles },
      ]);
      const stats = buildCanonicalMarketRegimeEngineSymbolStats(cycle, {});
      expect(stats.map((s) => s.symbol)).toEqual(["AAAUSDT", "ZZZUSDT"]);
    });
  });

  describe("computeCanonicalMarketRegimeEngineLiquidityWeights", () => {
    it("normalizes an uncapped set to sum to 1, preserving relative liquidity ordering", () => {
      const entries = Array.from({ length: 10 }, (_, i) => ({ symbol: `S${i}`, quoteVolume24hUsd: (i + 1) * 1_000_000 }));
      const weights = computeCanonicalMarketRegimeEngineLiquidityWeights(entries);
      const sum = Object.values(weights).reduce((a, v) => a + v, 0);
      expect(sum).toBeCloseTo(1);
      expect(weights.S9).toBeGreaterThan(weights.S0!); // most liquid gets the largest uncapped share
      for (const w of Object.values(weights)) {
        expect(w).toBeLessThanOrEqual(CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT + 1e-6);
      }
    });

    it("excludes (never zero-weights) a symbol with null or non-positive volume, and the lone survivor is still capped, never inflated to the full 100% (FINDING 1 fix)", () => {
      const weights = computeCanonicalMarketRegimeEngineLiquidityWeights([
        { symbol: "A", quoteVolume24hUsd: 1_000_000 },
        { symbol: "B", quoteVolume24hUsd: null },
        { symbol: "C", quoteVolume24hUsd: 0 },
      ]);
      expect(Object.keys(weights)).toEqual(["A"]);
      expect(weights.A).toBeCloseTo(CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT);
    });

    it("caps a dominant symbol at MAX_SINGLE_SYMBOL_WEIGHT_PCT and redistributes the rest, summing to 1 (adversarial test B analogue)", () => {
      const entries = [{ symbol: "BTC", quoteVolume24hUsd: 900_000_000_000 }];
      for (let i = 0; i < 59; i += 1) entries.push({ symbol: `ALT${i}`, quoteVolume24hUsd: 5_000_000 });
      const weights = computeCanonicalMarketRegimeEngineLiquidityWeights(entries);
      expect(weights.BTC).toBeCloseTo(CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT, 6);
      const sum = Object.values(weights).reduce((a, v) => a + v, 0);
      expect(sum).toBeCloseTo(1);
    });

    it("caps even a lone symbol at the ceiling and leaves the rest of the budget unallocated, rather than ever handing it the full 100% (FINDING 1 fix — never throws, and the cap invariant holds unconditionally)", () => {
      const weights = computeCanonicalMarketRegimeEngineLiquidityWeights([{ symbol: "SOLO", quoteVolume24hUsd: 1_000_000 }]);
      expect(weights.SOLO).toBeCloseTo(CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT);
    });

    it("for a 2-symbol universe below the mathematically-required feasibility floor (ceil(1/cap)=7), BOTH symbols are capped at exactly 0.15 and the sum falls short of 1 — the cap is never sacrificed just to make two voters' shares add up (FINDING 1 fix)", () => {
      const weights = computeCanonicalMarketRegimeEngineLiquidityWeights([
        { symbol: "A", quoteVolume24hUsd: 10_000_000_000 },
        { symbol: "B", quoteVolume24hUsd: 1_000_000 },
      ]);
      const sum = Object.values(weights).reduce((a, v) => a + v, 0);
      expect(weights.A).toBeCloseTo(CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT, 6);
      expect(weights.B).toBeCloseTo(CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT, 6);
      expect(sum).toBeCloseTo(2 * CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT, 6);
      expect(sum).toBeLessThan(1);
    });

    it("never lets any symbol's final weight exceed the cap, even with multiple simultaneously-overflowing tiers", () => {
      const entries = [
        { symbol: "DOM", quoteVolume24hUsd: 100_000_000_000 },
        { symbol: "MID", quoteVolume24hUsd: 50_000_000 },
      ];
      for (let i = 0; i < 40; i += 1) entries.push({ symbol: `TINY${i}`, quoteVolume24hUsd: 1_000 });
      const weights = computeCanonicalMarketRegimeEngineLiquidityWeights(entries);
      const sum = Object.values(weights).reduce((a, v) => a + v, 0);
      expect(sum).toBeCloseTo(1);
      for (const w of Object.values(weights)) {
        expect(w).toBeLessThanOrEqual(CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT + 1e-6);
      }
      expect(weights.DOM).toBeCloseTo(CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT, 6);
    });

    it("returns {} for an empty input", () => {
      expect(computeCanonicalMarketRegimeEngineLiquidityWeights([])).toEqual({});
    });

    it("[FINDING 1 repro] a volume-pipeline-only partial outage (57/60 attempted symbols with quoteVolume24hUsd: null, candles unaffected) never lets the 3 survivors' weights exceed the cap, no matter how few of the attempted universe remain active", () => {
      const entries = Array.from({ length: 60 }, (_, i) => ({
        symbol: `SYM${i}USDT`,
        quoteVolume24hUsd: i < 3 ? 50_000_000 + i * 1_000_000 : null, // only 3/60 have a working volume pipeline
      }));
      const weights = computeCanonicalMarketRegimeEngineLiquidityWeights(entries);
      expect(Object.keys(weights).sort()).toEqual(["SYM0USDT", "SYM1USDT", "SYM2USDT"]);
      for (const w of Object.values(weights)) {
        expect(w).toBeLessThanOrEqual(CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT + 1e-6);
      }
      // Pre-fix this summed to 1 with each survivor around 0.33 (double the cap) — post-fix the cap
      // holds and the shortfall is left unallocated instead.
      const sum = Object.values(weights).reduce((a, v) => a + v, 0);
      expect(sum).toBeLessThanOrEqual(3 * CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT + 1e-6);
    });
  });

  describe("computeCanonicalMarketRegimeEngineDirection", () => {
    it("weights symbols by liquidity in the uncapped regime: a higher-volume bullish symbol outweighs a lower-volume bearish one", () => {
      const stats = [
        stat({ symbol: "BIG", returnFastPct: 0.05, quoteVolume24hUsd: 9_000_000 }),
        stat({ symbol: "MID", returnFastPct: -0.05, quoteVolume24hUsd: 1_000_000 }),
        ...Array.from({ length: 20 }, (_, i) => stat({ symbol: `PAD${i}`, returnFastPct: 0, quoteVolume24hUsd: 1_000_000 })),
      ];
      const result = computeCanonicalMarketRegimeEngineDirection(stats);
      expect(result.directionFast).toBeGreaterThan(0);
      expect(result.consideredSymbolCountFast).toBe(22);
      for (const w of Object.values(result.weightsBySymbolFast)) {
        expect(w).toBeLessThanOrEqual(CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT + 1e-6);
      }
    });

    it("caps a dominant symbol's influence so it cannot single-handedly flip direction to its own magnitude (adversarial test B analogue)", () => {
      const entries = [stat({ symbol: "BTC", returnFastPct: 0.2, quoteVolume24hUsd: 900_000_000_000 })];
      for (let i = 0; i < 59; i += 1) entries.push(stat({ symbol: `ALT${i}`, returnFastPct: -0.01, quoteVolume24hUsd: 5_000_000 }));
      const result = computeCanonicalMarketRegimeEngineDirection(entries);
      // BTC capped at 15% contributes <= 0.15*0.20=0.03; the other 85% of weight sees -0.01 uniformly.
      expect(result.directionFast).toBeLessThan(0.05);
      expect(result.weightsBySymbolFast.BTC).toBeCloseTo(CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT, 6);
    });

    it("excludes a MISSING symbol entirely — never zero-fills its return into the weighted sum (test D analogue)", () => {
      const withMissing = computeCanonicalMarketRegimeEngineDirection([
        stat({ symbol: "A", returnFastPct: 0.02, quoteVolume24hUsd: 10_000_000 }),
        stat({ symbol: "B", dataQuality: "MISSING", returnFastPct: null, quoteVolume24hUsd: null }),
      ]);
      const withoutMissing = computeCanonicalMarketRegimeEngineDirection([
        stat({ symbol: "A", returnFastPct: 0.02, quoteVolume24hUsd: 10_000_000 }),
      ]);
      expect(withMissing.directionFast).toBeCloseTo(withoutMissing.directionFast);
      expect(withMissing.consideredSymbolCountFast).toBe(1);
    });

    it("returns an honest 0 with consideredSymbolCount 0 on empty input, never NaN", () => {
      const result = computeCanonicalMarketRegimeEngineDirection([]);
      expect(result.directionFast).toBe(0);
      expect(result.directionSlow).toBe(0);
      expect(result.consideredSymbolCountFast).toBe(0);
      expect(Number.isNaN(result.directionFast)).toBe(false);
    });

    it("computes directionFast and directionSlow as fully independent passes over the same stats", () => {
      // A lone symbol is below the feasibility floor, so its weight is capped at MAX_SINGLE_SYMBOL_WEIGHT_PCT
      // (FINDING 1 fix), not 1 — direction is that capped weight times the raw return either way.
      const cap = CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT;
      const stats = [stat({ symbol: "A", returnFastPct: 0.05, returnSlowPct: -0.05, quoteVolume24hUsd: 10_000_000 })];
      const result = computeCanonicalMarketRegimeEngineDirection(stats);
      expect(result.directionFast).toBeCloseTo(cap * 0.05, 6);
      expect(result.directionSlow).toBeCloseTo(cap * -0.05, 6);
    });
  });

  describe("computeCanonicalMarketRegimeEngineBreadth", () => {
    it("is a pure equal-weight vote — one huge-liquidity-implied symbol counts exactly the same as any other (adversarial test C analogue: direction and breadth deliberately disagree here)", () => {
      const stats: Array<{ symbol: string; dataQuality: "OK" | "MISSING"; returnFastPct: number | null }> = [
        { symbol: "BTC", dataQuality: "OK", returnFastPct: 0.5 },
        { symbol: "ALT1", dataQuality: "OK", returnFastPct: -0.01 },
        { symbol: "ALT2", dataQuality: "OK", returnFastPct: -0.01 },
        { symbol: "ALT3", dataQuality: "OK", returnFastPct: -0.01 },
      ];
      const breadth = computeCanonicalMarketRegimeEngineBreadth(stats);
      expect(breadth.advancers).toBe(1);
      expect(breadth.decliners).toBe(3);
      expect(breadth.breadth).toBeCloseTo(-0.5); // (1-3)/4, regardless of BTC's return magnitude
    });

    it("excludes MISSING and null-return symbols from its own denominator, never zero-filling them into 'unchanged'", () => {
      const breadth = computeCanonicalMarketRegimeEngineBreadth([
        { symbol: "A", dataQuality: "OK", returnFastPct: 0.01 },
        { symbol: "B", dataQuality: "MISSING", returnFastPct: null },
      ]);
      expect(breadth.consideredSymbolCount).toBe(1);
      expect(breadth.unchanged).toBe(0);
      expect(breadth.advancers).toBe(1);
    });

    it("buckets an exact-zero return as 'unchanged', not an advancer or decliner", () => {
      const breadth = computeCanonicalMarketRegimeEngineBreadth([{ symbol: "A", dataQuality: "OK", returnFastPct: 0 }]);
      expect(breadth.unchanged).toBe(1);
      expect(breadth.breadth).toBe(0);
    });

    it("returns an honest 0 with consideredSymbolCount 0 on empty input, never NaN", () => {
      const breadth = computeCanonicalMarketRegimeEngineBreadth([]);
      expect(breadth.breadth).toBe(0);
      expect(breadth.consideredSymbolCount).toBe(0);
    });
  });

  describe("computeCanonicalMarketRegimeEngineCohesionDispersion", () => {
    it("is 1.0 when every symbol agrees in sign with the median", () => {
      const result = computeCanonicalMarketRegimeEngineCohesionDispersion([
        { symbol: "A", dataQuality: "OK", returnFastPct: 0.01 },
        { symbol: "B", dataQuality: "OK", returnFastPct: 0.02 },
        { symbol: "C", dataQuality: "OK", returnFastPct: 0.03 },
      ]);
      expect(result.cohesion).toBe(1);
      expect(result.medianReturnFastPct).toBeCloseTo(0.02);
    });

    it("drops below 1.0 when the universe is split", () => {
      const result = computeCanonicalMarketRegimeEngineCohesionDispersion([
        { symbol: "A", dataQuality: "OK", returnFastPct: 0.05 },
        { symbol: "B", dataQuality: "OK", returnFastPct: 0.04 },
        { symbol: "C", dataQuality: "OK", returnFastPct: -0.01 },
      ]);
      expect(result.cohesion).toBeCloseTo(2 / 3);
    });

    it("computes dispersion as median(|x - median|) * 1.4826, matching a hand-computed example", () => {
      // values -0.02,0,0.02,0.04,0.10 -> median 0.02; deviations 0.04,0.02,0,0.02,0.08 -> median(dev)=0.02
      const result = computeCanonicalMarketRegimeEngineCohesionDispersion([
        { symbol: "A", dataQuality: "OK", returnFastPct: -0.02 },
        { symbol: "B", dataQuality: "OK", returnFastPct: 0.0 },
        { symbol: "C", dataQuality: "OK", returnFastPct: 0.02 },
        { symbol: "D", dataQuality: "OK", returnFastPct: 0.04 },
        { symbol: "E", dataQuality: "OK", returnFastPct: 0.1 },
      ]);
      expect(result.dispersion).toBeCloseTo(0.02 * 1.4826, 6);
    });

    it("is not blown up by a single outlier the way a variance-based statistic would be (robustness)", () => {
      const calm = computeCanonicalMarketRegimeEngineCohesionDispersion(
        Array.from({ length: 10 }, (_, i) => ({ symbol: `S${i}`, dataQuality: "OK" as const, returnFastPct: 0.01 })),
      );
      const withOutlier = computeCanonicalMarketRegimeEngineCohesionDispersion([
        ...Array.from({ length: 9 }, (_, i) => ({ symbol: `S${i}`, dataQuality: "OK" as const, returnFastPct: 0.01 })),
        { symbol: "OUTLIER", dataQuality: "OK" as const, returnFastPct: 5.0 }, // a +500% freak print
      ]);
      expect(withOutlier.dispersion).toBeLessThan(0.05);
      expect(withOutlier.dispersion).toBeGreaterThanOrEqual(calm.dispersion);
      expect(withOutlier.cohesion).toBe(1); // sign-agreement is untouched by the outlier's magnitude
    });

    it("returns an honest 0/null on empty input, never NaN", () => {
      const result = computeCanonicalMarketRegimeEngineCohesionDispersion([]);
      expect(result.cohesion).toBe(0);
      expect(result.dispersion).toBe(0);
      expect(result.medianReturnFastPct).toBeNull();
      expect(result.consideredSymbolCount).toBe(0);
    });
  });

  describe("computeCanonicalMarketRegimeEngineRiskStress", () => {
    it("matches the approved 0.4/0.3/0.3 weighted formula on a full happy-path input", () => {
      const btcCandles = Array.from({ length: 200 }, (_, i) => c(100 + Math.sin(i / 5) * 3, i * HOUR_MS));
      const result = computeCanonicalMarketRegimeEngineRiskStress({
        btcCandles,
        fundingRateBySymbol: { A: 0.0008, B: 0.0001, C: 0.0001 }, // A: 8bps -> EXTREME; B/C: 1bp -> NEUTRAL
        openInterestChangePercentBySymbol: { A: 3, B: 0.2, C: -0.5 }, // only |A|=3 >= OI_TREND_PCT(1)
      });
      expect(result.fundingStressShare).toBeCloseTo(1 / 3);
      expect(result.oiAccelerationShare).toBeCloseTo(1 / 3);
      expect(result.btcAtrPercentile).not.toBeNull();
      const btcTerm = (result.btcAtrPercentile as number) / 100;
      expect(result.riskStress).toBeCloseTo(0.4 * btcTerm + 0.3 * (1 / 3) + 0.3 * (1 / 3), 6);
    });

    it("never zero-fills a missing BTC term — renormalizes over funding+OI instead, and surfaces btcAtrPercentile: null", () => {
      const result = computeCanonicalMarketRegimeEngineRiskStress({
        btcCandles: [c(100)], // far short of the 182-candle requirement
        fundingRateBySymbol: { A: 0.0008 }, // EXTREME -> fundingStressShare 1
        openInterestChangePercentBySymbol: { A: 3 }, // accelerating -> oiAccelerationShare 1
      });
      expect(result.btcAtrPercentile).toBeNull();
      // Renormalized over 0.3+0.3=0.6: (0.3*1 + 0.3*1)/0.6 = 1, NOT 0.4*0 + 0.3*1 + 0.3*1 = 0.6.
      expect(result.riskStress).toBeCloseTo(1);
    });

    it("excludes (never zero-fills) a null funding entry from its own share denominator", () => {
      const withNull = computeCanonicalMarketRegimeEngineRiskStress({
        btcCandles: [],
        fundingRateBySymbol: { A: 0.0008, B: null },
        openInterestChangePercentBySymbol: {},
      });
      const withoutEntry = computeCanonicalMarketRegimeEngineRiskStress({
        btcCandles: [],
        fundingRateBySymbol: { A: 0.0008 },
        openInterestChangePercentBySymbol: {},
      });
      expect(withNull.fundingStressShare).toBeCloseTo(withoutEntry.fundingStressShare);
      expect(withNull.fundingConsideredSymbolCount).toBe(1);
      expect(withoutEntry.fundingConsideredSymbolCount).toBe(1);
    });

    it("returns an honest 0 (never NaN/throw) when every input is empty", () => {
      const result = computeCanonicalMarketRegimeEngineRiskStress({
        btcCandles: [],
        fundingRateBySymbol: {},
        openInterestChangePercentBySymbol: {},
      });
      expect(result.riskStress).toBe(0);
      expect(Number.isNaN(result.riskStress)).toBe(false);
      expect(result.fundingConsideredSymbolCount).toBe(0);
      expect(result.oiAccelerationConsideredSymbolCount).toBe(0);
    });
  });
});

// ─── stage 3: projection state machine (hysteresis, overlays, panic) ───────────────────────────────

describe("canonical-market-regime-engine — stage 3 projection state machine", () => {
  describe("classifyCanonicalMarketRegimeEngineCoverage", () => {
    it("classifies VALID at/above the 85% floor, with no reasons", () => {
      const result = classifyCanonicalMarketRegimeEngineCoverage({ coveragePct: 0.85, validSymbolCount: 51, requiredSymbolCount: 60 });
      expect(result.status).toBe("VALID");
      expect(result.reasons).toEqual([]);
    });

    it("classifies DEGRADED strictly between the DEGRADED and VALID floors", () => {
      const result = classifyCanonicalMarketRegimeEngineCoverage({ coveragePct: 0.7, validSymbolCount: 42, requiredSymbolCount: 60 });
      expect(result.status).toBe("DEGRADED");
      expect(result.reasons.length).toBeGreaterThan(0);
    });

    it("classifies INVALID below the DEGRADED floor", () => {
      const result = classifyCanonicalMarketRegimeEngineCoverage({ coveragePct: 0.5, validSymbolCount: 30, requiredSymbolCount: 60 });
      expect(result.status).toBe("INVALID");
    });

    it("classifies INVALID (never a vacuous VALID) for a zero-universe cycle", () => {
      const result = classifyCanonicalMarketRegimeEngineCoverage({ coveragePct: 0, validSymbolCount: 0, requiredSymbolCount: 0 });
      expect(result.status).toBe("INVALID");
    });

    it("classifies INVALID for a non-finite coveragePct, never a safe default", () => {
      const result = classifyCanonicalMarketRegimeEngineCoverage({ coveragePct: NaN, validSymbolCount: 10, requiredSymbolCount: 60 });
      expect(result.status).toBe("INVALID");
    });
  });

  describe("computeCanonicalMarketRegimeEngineCandidateDirection", () => {
    const bullish = { directionFast: 0.02, directionSlow: 0.04, breadth: 0.3, cohesion: 0.6 };
    const bearish = { directionFast: -0.02, directionSlow: -0.04, breadth: -0.3, cohesion: 0.6 };

    it("is BULLISH when all four conditions clear their bar", () => {
      expect(computeCanonicalMarketRegimeEngineCandidateDirection(bullish)).toBe("BULLISH");
    });

    it("is BEARISH when all four conditions clear their mirrored bar", () => {
      expect(computeCanonicalMarketRegimeEngineCandidateDirection(bearish)).toBe("BEARISH");
    });

    it("is MIXED when only directionFast falls short — a real AND, not a scored vote", () => {
      expect(computeCanonicalMarketRegimeEngineCandidateDirection({ ...bullish, directionFast: 0.01 })).toBe("MIXED");
    });

    it("is MIXED when only directionSlow falls short", () => {
      expect(computeCanonicalMarketRegimeEngineCandidateDirection({ ...bullish, directionSlow: 0.01 })).toBe("MIXED");
    });

    it("is MIXED when only breadth falls short", () => {
      expect(computeCanonicalMarketRegimeEngineCandidateDirection({ ...bullish, breadth: 0.1 })).toBe("MIXED");
    });

    it("is MIXED when only cohesion falls short", () => {
      expect(computeCanonicalMarketRegimeEngineCandidateDirection({ ...bullish, cohesion: 0.5 })).toBe("MIXED");
    });

    it("is MIXED just below the strict >= boundary", () => {
      expect(
        computeCanonicalMarketRegimeEngineCandidateDirection({ directionFast: 0.0149, directionSlow: 0.04, breadth: 0.3, cohesion: 0.6 }),
      ).toBe("MIXED");
    });

    it("is MIXED (never a crash/NaN) on non-finite input — missing data never becomes a confident signal (test D analogue)", () => {
      expect(
        computeCanonicalMarketRegimeEngineCandidateDirection({ directionFast: NaN, directionSlow: 0.04, breadth: 0.3, cohesion: 0.6 }),
      ).toBe("MIXED");
    });
  });

  describe("computeCanonicalMarketRegimeEngineOverlays", () => {
    const base = {
      directionFast: 0,
      breadth: 0,
      cohesion: 0.9,
      riskStress: 0,
      coverageStatus: "VALID" as const,
      panicActive: false,
      cyclesInProjection: 5,
      enterCandidateCycles: 0,
    };

    it("transition is true while accumulating (0 < enterCandidateCycles < ENTER_CONFIRM_CYCLES)", () => {
      expect(computeCanonicalMarketRegimeEngineOverlays({ ...base, enterCandidateCycles: 1 }).transition).toBe(true);
    });

    it("transition is true the cycle a flip just landed, even with no active accumulation", () => {
      expect(computeCanonicalMarketRegimeEngineOverlays({ ...base, cyclesInProjection: 1, enterCandidateCycles: 0 }).transition).toBe(true);
    });

    it("transition is false once settled (no accumulation, cyclesInProjection>1)", () => {
      expect(computeCanonicalMarketRegimeEngineOverlays({ ...base, cyclesInProjection: 5, enterCandidateCycles: 0 }).transition).toBe(false);
    });

    it("highStress flips at exactly the 0.70 threshold", () => {
      expect(computeCanonicalMarketRegimeEngineOverlays({ ...base, riskStress: 0.7 }).highStress).toBe(true);
      expect(computeCanonicalMarketRegimeEngineOverlays({ ...base, riskStress: 0.6999 }).highStress).toBe(false);
    });

    it("panic is a straight passthrough of panicActive", () => {
      expect(computeCanonicalMarketRegimeEngineOverlays({ ...base, panicActive: true }).panic).toBe(true);
      expect(computeCanonicalMarketRegimeEngineOverlays({ ...base, panicActive: false }).panic).toBe(false);
    });

    it("lowCoverage is true for both DEGRADED and INVALID, false only for VALID", () => {
      expect(computeCanonicalMarketRegimeEngineOverlays({ ...base, coverageStatus: "DEGRADED" }).lowCoverage).toBe(true);
      expect(computeCanonicalMarketRegimeEngineOverlays({ ...base, coverageStatus: "INVALID" }).lowCoverage).toBe(true);
      expect(computeCanonicalMarketRegimeEngineOverlays({ ...base, coverageStatus: "VALID" }).lowCoverage).toBe(false);
    });

    it("rotational fires only when directionFast and breadth disagree in sign AND both clear the magnitude floor", () => {
      expect(computeCanonicalMarketRegimeEngineOverlays({ ...base, directionFast: 0.15, breadth: -0.15 }).rotational).toBe(true);
      expect(computeCanonicalMarketRegimeEngineOverlays({ ...base, directionFast: 0.05, breadth: -0.15 }).rotational).toBe(false); // fast too small
      expect(computeCanonicalMarketRegimeEngineOverlays({ ...base, directionFast: 0.15, breadth: 0.15 }).rotational).toBe(false); // same sign
    });

    it("fragmented fires below the 0.35 cohesion floor", () => {
      expect(computeCanonicalMarketRegimeEngineOverlays({ ...base, cohesion: 0.34 }).fragmented).toBe(true);
      expect(computeCanonicalMarketRegimeEngineOverlays({ ...base, cohesion: 0.35 }).fragmented).toBe(false);
    });
  });

  describe("canonicalMarketRegimeEnginePanicConditionMet", () => {
    const severe = { riskStress: 0.9, directionFast: 0.05, breadth: 0.4, coverageStatus: "VALID" as const };

    it("is true when all four conditions hold simultaneously", () => {
      expect(canonicalMarketRegimeEnginePanicConditionMet(severe)).toBe(true);
    });

    it("is false when riskStress alone falls short", () => {
      expect(canonicalMarketRegimeEnginePanicConditionMet({ ...severe, riskStress: 0.8 })).toBe(false);
    });

    it("is false when |directionFast| alone falls short", () => {
      expect(canonicalMarketRegimeEnginePanicConditionMet({ ...severe, directionFast: 0.03 })).toBe(false);
    });

    it("is false when breadth disagrees in sign with directionFast, even with both severe in magnitude", () => {
      expect(canonicalMarketRegimeEnginePanicConditionMet({ ...severe, breadth: -0.4 })).toBe(false);
    });

    it("is false when |breadth| alone falls short", () => {
      expect(canonicalMarketRegimeEnginePanicConditionMet({ ...severe, breadth: 0.2 })).toBe(false);
    });

    it("is false when coverage is not VALID, even with every other condition severe — never declares panic off degraded data", () => {
      expect(canonicalMarketRegimeEnginePanicConditionMet({ ...severe, coverageStatus: "DEGRADED" })).toBe(false);
      expect(canonicalMarketRegimeEnginePanicConditionMet({ ...severe, coverageStatus: "INVALID" })).toBe(false);
    });

    it("is false (never throws) on non-finite input", () => {
      expect(canonicalMarketRegimeEnginePanicConditionMet({ ...severe, riskStress: NaN })).toBe(false);
    });
  });

  describe("advanceCanonicalMarketRegimeEnginePanicState", () => {
    const cold: CanonicalMarketRegimeEnginePanicState = { panicActive: false, panicSinceMs: null, panicCyclesSinceExitCandidate: 0 };

    it("activates immediately (zero confirmation delay) on the first cycle the condition is met (adversarial test G)", () => {
      const result = advanceCanonicalMarketRegimeEnginePanicState(cold, true, 1000);
      expect(result.panicActive).toBe(true);
      expect(result.panicSinceMs).toBe(1000);
    });

    it("does NOT clear on the 1st, 2nd, or 3rd consecutive non-met cycle", () => {
      let state = advanceCanonicalMarketRegimeEnginePanicState(cold, true, 0);
      for (let i = 1; i <= 3; i += 1) {
        state = advanceCanonicalMarketRegimeEnginePanicState(state, false, i * 1000);
        expect(state.panicActive).toBe(true);
      }
    });

    it("clears on exactly the 4th consecutive non-met cycle", () => {
      let state = advanceCanonicalMarketRegimeEnginePanicState(cold, true, 0);
      for (let i = 1; i <= 4; i += 1) {
        state = advanceCanonicalMarketRegimeEnginePanicState(state, false, i * 1000);
      }
      expect(state.panicActive).toBe(false);
      expect(state.panicSinceMs).toBeNull();
    });

    it("a recurrence resets the exit counter rather than pausing it", () => {
      let state = advanceCanonicalMarketRegimeEnginePanicState(cold, true, 0);
      state = advanceCanonicalMarketRegimeEnginePanicState(state, false, 1000);
      state = advanceCanonicalMarketRegimeEnginePanicState(state, false, 2000);
      state = advanceCanonicalMarketRegimeEnginePanicState(state, true, 3000); // recurs after 2 non-met cycles
      expect(state.panicCyclesSinceExitCandidate).toBe(0);
      state = advanceCanonicalMarketRegimeEnginePanicState(state, false, 4000);
      state = advanceCanonicalMarketRegimeEnginePanicState(state, false, 5000);
      expect(state.panicActive).toBe(true); // only 2 non-met since the recurrence — not enough
      state = advanceCanonicalMarketRegimeEnginePanicState(state, false, 6000);
      state = advanceCanonicalMarketRegimeEnginePanicState(state, false, 7000);
      expect(state.panicActive).toBe(false); // now 4 consecutive since the recurrence
    });

    it("stays inactive across non-met cycles when never triggered", () => {
      const state = advanceCanonicalMarketRegimeEnginePanicState(cold, false, 1000);
      expect(state.panicActive).toBe(false);
      expect(state.panicCyclesSinceExitCandidate).toBe(0);
    });
  });

  describe("advanceCanonicalMarketRegimeEngineProjection", () => {
    const VALID_COVERAGE: CanonicalMarketRegimeEngineCoverageResult = {
      status: "VALID",
      coveragePct: 0.95,
      validSymbolCount: 57,
      requiredSymbolCount: 60,
      reasons: [],
    };
    const INVALID_COVERAGE: CanonicalMarketRegimeEngineCoverageResult = {
      status: "INVALID",
      coveragePct: 0.4,
      validSymbolCount: 24,
      requiredSymbolCount: 60,
      reasons: ["too low"],
    };
    const CALM = { directionFast: 0, directionSlow: 0, breadth: 0, cohesion: 0.9, riskStress: 0.1 };
    const BULLISH_SIGNAL = { directionFast: 0.02, directionSlow: 0.04, breadth: 0.3, cohesion: 0.6, riskStress: 0.1 };
    const BEARISH_SIGNAL = { directionFast: -0.02, directionSlow: -0.04, breadth: -0.3, cohesion: 0.6, riskStress: 0.1 };

    function ids(tag: string): Record<string, string> {
      return { BTCUSDT: `BTCUSDT|1h|${tag}` };
    }

    it("cold start begins at MIXED with cyclesInProjection 1, never directionally confident on the first cycle even with a strong signal", () => {
      const result = advanceCanonicalMarketRegimeEngineProjection(null, {
        nowMs: 1000,
        ...BULLISH_SIGNAL,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("A"),
      });
      expect(result.isDuplicateCycle).toBe(false);
      expect(result.projection).toBe("MIXED");
      expect(result.state.stateHistory.cyclesInProjection).toBe(1);
    });

    it("matches initialCanonicalMarketRegimeEngineProjectionState's own seed shape on cold start", () => {
      const seed = initialCanonicalMarketRegimeEngineProjectionState(1000);
      expect(seed.projection).toBe("MIXED");
      expect(seed.panicActive).toBe(false);
      expect(seed.stateHistory.cyclesInProjection).toBe(0); // seeds at 0 so cycle 1's "+1" lands on 1
    });

    it("confirms BULLISH only on the 3rd consecutive genuinely-new cycle with a persistent bullish signal, not sooner (ENTER_CONFIRM_CYCLES=3)", () => {
      let result = advanceCanonicalMarketRegimeEngineProjection(null, {
        nowMs: 0,
        ...BULLISH_SIGNAL,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("0"),
      });
      expect(result.projection).toBe("MIXED");
      result = advanceCanonicalMarketRegimeEngineProjection(result.state, {
        nowMs: 1000,
        ...BULLISH_SIGNAL,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("1"),
      });
      expect(result.projection).toBe("MIXED");
      result = advanceCanonicalMarketRegimeEngineProjection(result.state, {
        nowMs: 2000,
        ...BULLISH_SIGNAL,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("2"),
      });
      expect(result.projection).toBe("BULLISH");
      expect(result.state.stateHistory.cyclesInProjection).toBe(1);
      expect(result.state.stateHistory.lastFlipAtMs).toBe(2000);
      expect(result.state.enterCandidate).toBeNull();
      expect(result.state.enterCandidateCycles).toBe(0);
    });

    it("reverts to MIXED immediately (1 cycle, no accumulation) the instant a confirmed direction stops matching", () => {
      let result = advanceCanonicalMarketRegimeEngineProjection(null, {
        nowMs: 1000,
        ...BULLISH_SIGNAL,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("A"),
      });
      result = advanceCanonicalMarketRegimeEngineProjection(result.state, {
        nowMs: 2000,
        ...BULLISH_SIGNAL,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("B"),
      });
      result = advanceCanonicalMarketRegimeEngineProjection(result.state, {
        nowMs: 3000,
        ...BULLISH_SIGNAL,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("C"),
      });
      expect(result.projection).toBe("BULLISH");
      result = advanceCanonicalMarketRegimeEngineProjection(result.state, {
        nowMs: 4000,
        ...CALM,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("D"),
      });
      expect(result.projection).toBe("MIXED");
      expect(result.state.stateHistory.cyclesInProjection).toBe(1);
      expect(result.state.stateHistory.lastFlipAtMs).toBe(4000);
    });

    it("an ordinary BULLISH<->BEARISH flip passes through MIXED for the full confirmation window, never direct (adversarial test F)", () => {
      let result = advanceCanonicalMarketRegimeEngineProjection(null, {
        nowMs: 0,
        ...BULLISH_SIGNAL,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("0"),
      });
      result = advanceCanonicalMarketRegimeEngineProjection(result.state, {
        nowMs: 1000,
        ...BULLISH_SIGNAL,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("1"),
      });
      result = advanceCanonicalMarketRegimeEngineProjection(result.state, {
        nowMs: 2000,
        ...BULLISH_SIGNAL,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("2"),
      });
      expect(result.projection).toBe("BULLISH");

      const projections: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        result = advanceCanonicalMarketRegimeEngineProjection(result.state, {
          nowMs: 3000 + i * 1000,
          ...BEARISH_SIGNAL,
          coverage: VALID_COVERAGE,
          sourceObservationIds: ids(`b${i}`),
        });
        projections.push(result.projection);
      }
      // Cycles 1-2 of the reversal: MIXED (revert, then accumulating toward BEARISH). Cycle 3: BEARISH
      // confirmed. `projection` is NEVER "BEARISH" before it is first genuinely "MIXED" — no direct jump.
      expect(projections).toEqual(["MIXED", "MIXED", "BEARISH"]);
    });

    it("switching the accumulation target mid-MIXED restarts the confirmation count at 1, not a partial carry-over", () => {
      let result = advanceCanonicalMarketRegimeEngineProjection(null, {
        nowMs: 0,
        ...BULLISH_SIGNAL,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("0"),
      });
      result = advanceCanonicalMarketRegimeEngineProjection(result.state, {
        nowMs: 1000,
        ...BULLISH_SIGNAL,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("1"),
      });
      expect(result.state.enterCandidate).toBe("BULLISH");
      expect(result.state.enterCandidateCycles).toBe(2);
      result = advanceCanonicalMarketRegimeEngineProjection(result.state, {
        nowMs: 2000,
        ...BEARISH_SIGNAL,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("2"),
      });
      expect(result.projection).toBe("MIXED");
      expect(result.state.enterCandidate).toBe("BEARISH");
      expect(result.state.enterCandidateCycles).toBe(1); // restarted, not 3
    });

    it("LOW_COVERAGE forces candidateDirection/projection to MIXED even with an otherwise-strong bullish signal, and blocks accumulation while it persists (requirement #5)", () => {
      const result = advanceCanonicalMarketRegimeEngineProjection(null, {
        nowMs: 1000,
        ...BULLISH_SIGNAL,
        coverage: INVALID_COVERAGE,
        sourceObservationIds: ids("A"),
      });
      expect(result.candidateDirection).toBe("MIXED");
      expect(result.projection).toBe("MIXED");
      expect(result.overlays.lowCoverage).toBe(true);
      expect(result.state.enterCandidate).toBeNull();
      expect(result.state.enterCandidateCycles).toBe(0);
    });

    it("LOW_COVERAGE immediately reverts an already-confirmed BULLISH projection to MIXED", () => {
      let result = advanceCanonicalMarketRegimeEngineProjection(null, {
        nowMs: 0,
        ...BULLISH_SIGNAL,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("0"),
      });
      result = advanceCanonicalMarketRegimeEngineProjection(result.state, {
        nowMs: 1000,
        ...BULLISH_SIGNAL,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("1"),
      });
      result = advanceCanonicalMarketRegimeEngineProjection(result.state, {
        nowMs: 2000,
        ...BULLISH_SIGNAL,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("2"),
      });
      expect(result.projection).toBe("BULLISH");
      result = advanceCanonicalMarketRegimeEngineProjection(result.state, {
        nowMs: 3000,
        ...BULLISH_SIGNAL,
        coverage: INVALID_COVERAGE,
        sourceObservationIds: ids("3"),
      });
      expect(result.projection).toBe("MIXED");
    });

    it("a duplicate cycle (identical sourceObservationIds) returns the prior state completely unchanged — no counter advances (requirement #4 / test E)", () => {
      const result1 = advanceCanonicalMarketRegimeEngineProjection(null, {
        nowMs: 0,
        ...BULLISH_SIGNAL,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("A"),
      });
      const result2 = advanceCanonicalMarketRegimeEngineProjection(result1.state, {
        nowMs: 1000,
        ...BULLISH_SIGNAL,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("A"), // SAME id — no new completed candle arrived
      });
      expect(result2.isDuplicateCycle).toBe(true);
      expect(result2.state).toBe(result1.state); // literally the same object, not just deep-equal
      expect(result2.projection).toBe(result1.projection);
    });

    it("a cold start is never treated as a duplicate, even against an empty sourceObservationIds map", () => {
      const result = advanceCanonicalMarketRegimeEngineProjection(null, {
        nowMs: 0,
        ...CALM,
        coverage: INVALID_COVERAGE,
        sourceObservationIds: {},
      });
      expect(result.isDuplicateCycle).toBe(false);
    });

    it("panic activates immediately within the step function, independent of whatever candidateDirection/projection compute this same cycle", () => {
      // directionSlow (0.02) falls short of its own 0.03 bar, so candidateDirection is MIXED this
      // cycle regardless of the panic combination — the two computations share raw inputs but are
      // otherwise independent.
      const severeButNotDirectional = { directionFast: 0.05, directionSlow: 0.02, breadth: 0.4, cohesion: 0.9, riskStress: 0.9 };
      const result = advanceCanonicalMarketRegimeEngineProjection(null, {
        nowMs: 1000,
        ...severeButNotDirectional,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("A"),
      });
      expect(result.candidateDirection).toBe("MIXED");
      expect(result.overlays.panic).toBe(true);
    });

    it("panic does not clear on the cycle right after the severe combination stops, only after its own 4-cycle hysteresis", () => {
      const severe = { directionFast: 0.05, directionSlow: 0.05, breadth: 0.4, cohesion: 0.9, riskStress: 0.9 };
      let result = advanceCanonicalMarketRegimeEngineProjection(null, {
        nowMs: 0,
        ...severe,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("0"),
      });
      expect(result.overlays.panic).toBe(true);
      result = advanceCanonicalMarketRegimeEngineProjection(result.state, {
        nowMs: 1000,
        ...CALM,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("1"),
      });
      expect(result.overlays.panic).toBe(true); // still active — only 1 non-met cycle so far
    });

    it("a duplicate cycle does not advance the panic exit counter either", () => {
      const severe = { directionFast: 0.05, directionSlow: 0.05, breadth: 0.4, cohesion: 0.9, riskStress: 0.9 };
      const started = advanceCanonicalMarketRegimeEngineProjection(null, {
        nowMs: 0,
        ...severe,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("0"),
      });
      const offCondition = advanceCanonicalMarketRegimeEngineProjection(started.state, {
        nowMs: 1000,
        ...CALM,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("1"),
      });
      const duplicate = advanceCanonicalMarketRegimeEngineProjection(offCondition.state, {
        nowMs: 2000,
        ...CALM,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("1"), // same id as the previous cycle
      });
      expect(duplicate.isDuplicateCycle).toBe(true);
      expect(duplicate.state.stateHistory.panicCyclesSinceExitCandidate).toBe(
        offCondition.state.stateHistory.panicCyclesSinceExitCandidate,
      );
    });

    it("[FINDING 2] a candle-duplicate cycle whose riskStress escalates still activates PANIC — riskStress is never memoized against a stale prior result", () => {
      const calmSevereShape = { directionFast: 0.05, directionSlow: 0.05, breadth: 0.4, cohesion: 0.9, riskStress: 0.1 };
      const started = advanceCanonicalMarketRegimeEngineProjection(null, {
        nowMs: 0,
        ...calmSevereShape,
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("0"),
      });
      expect(started.overlays.panic).toBe(false); // riskStress 0.1 — nowhere near the 0.85 panic floor

      // SAME sourceObservationId as the previous call (candle-duplicate) — only riskStress escalates.
      const escalated = advanceCanonicalMarketRegimeEngineProjection(started.state, {
        nowMs: 1000,
        ...calmSevereShape,
        riskStress: 0.9, // now clears the panic floor; directionFast/breadth/cohesion unchanged
        coverage: VALID_COVERAGE,
        sourceObservationIds: ids("0"), // same id — no new completed candle arrived
      });

      // NOT a full duplicate (riskStress moved), so PANIC re-evaluates and activates THIS cycle.
      expect(escalated.isDuplicateCycle).toBe(false);
      expect(escalated.overlays.panic).toBe(true);
      expect(escalated.state.panicActive).toBe(true);
      expect(escalated.state).not.toBe(started.state); // a new state object — not memoized

      // The DIRECTIONAL hysteresis stays frozen — candle identity didn't change, so there is nothing
      // new for it to confirm, even though this cycle was not a full duplicate overall.
      expect(escalated.projection).toBe(started.projection);
      expect(escalated.state.stateHistory.cyclesInProjection).toBe(started.state.stateHistory.cyclesInProjection);
      expect(escalated.state.enterCandidateCycles).toBe(started.state.enterCandidateCycles);
    });
  });
});

describe("canonical-market-regime-engine — stage 4 durability + public API", () => {
  const HOUR = 3_600_000;
  const NO_ENV = {} as NodeJS.ProcessEnv;
  const KILL_ENV = { [CANONICAL_MARKET_REGIME_ENGINE_DISABLED_ENV_KEY]: "1" } as unknown as NodeJS.ProcessEnv;

  function freshDataDir(): string {
    return mkdtempSync(join(tmpdir(), "canonical-regime-engine-"));
  }

  /** N symbols, all identical returns/volume so direction/breadth/cohesion are trivially predictable:
   *  direction == returnFastPct/returnSlowPct exactly (equal liquidity weights), breadth == +-1
   *  (unanimous), cohesion == 1 (unanimous). Explicit per-symbol sourceObservationId (tagged by
   *  `idTag`) so duplicate-cycle behavior across separate computeCanonicalMarketRegimeSnapshot calls
   *  is exercised deliberately, not accidentally, by the synthetic-id fallback's own atMs-embedding. */
  function uniformRawFeatures(
    atMs: number,
    n: number,
    returnFastPct: number,
    returnSlowPct: number,
    idTag: string,
    extra: Partial<CanonicalMarketRegimeRawFeatures> = {},
  ): CanonicalMarketRegimeRawFeatures {
    return {
      atMs,
      perSymbol: Array.from({ length: n }, (_, i) => ({
        symbol: `SYM${i}USDT`,
        returnFastPct,
        returnSlowPct,
        quoteVolume24hUsd: 10_000_000,
        sourceObservationId: `SYM${i}USDT|1h|${idTag}`,
      })),
      ...extra,
    };
  }

  beforeEach(() => {
    _resetCanonicalMarketRegimeSnapshotStoreForTests();
  });

  describe("computeCanonicalMarketRegimeSnapshot", () => {
    it("assembles a VALID snapshot on cold start with the default version stamps", () => {
      const snap = computeCanonicalMarketRegimeSnapshot(uniformRawFeatures(0, 12, 0, 0, "A"), null, {}, 0);
      expect(snap.status).toBe("VALID");
      expect(snap.schemaVersion).toBe(CANONICAL_MARKET_REGIME_SNAPSHOT_SCHEMA_VERSION);
      expect(snap.engineVersion).toBe(CANONICAL_MARKET_REGIME_ENGINE_VERSION);
      expect(snap.calibrationVersion).toBe(CANONICAL_MARKET_REGIME_DEFAULT_CALIBRATION_VERSION);
      expect(snap.projection).toBe("MIXED"); // cold start never directionally confident on cycle 1
      expect(validCanonicalMarketRegimeSnapshotShape(snap)).toBe(true);
    });

    it("honors an explicit calibrationVersion 5th argument", () => {
      const snap = computeCanonicalMarketRegimeSnapshot(uniformRawFeatures(0, 12, 0, 0, "A"), null, {}, 0, "v7-frozen");
      expect(snap.calibrationVersion).toBe("v7-frozen");
    });

    it("carries enterCandidate/enterCandidateCycles across snapshot cycles so a BULLISH flip confirms on the 3rd genuinely-new cycle — regression test for the required enterCandidate/enterCandidateCycles fields", () => {
      let snap = computeCanonicalMarketRegimeSnapshot(uniformRawFeatures(0, 12, 0.02, 0.05, "A"), null, {}, 0);
      expect(snap.projection).toBe("MIXED");
      expect(snap.enterCandidateCycles).toBe(1);
      snap = computeCanonicalMarketRegimeSnapshot(uniformRawFeatures(HOUR, 12, 0.02, 0.05, "B"), snap, {}, HOUR);
      expect(snap.projection).toBe("MIXED");
      expect(snap.enterCandidateCycles).toBe(2);
      snap = computeCanonicalMarketRegimeSnapshot(uniformRawFeatures(2 * HOUR, 12, 0.02, 0.05, "C"), snap, {}, 2 * HOUR);
      expect(snap.projection).toBe("BULLISH");
      expect(snap.regimeFamily).toBe("BULLISH");
      expect(snap.enterCandidateCycles).toBe(0);
      expect(snap.enterCandidate).toBeNull();
    });

    it("confirms BEARISH the same way on the mirrored signal", () => {
      let snap = computeCanonicalMarketRegimeSnapshot(uniformRawFeatures(0, 12, -0.02, -0.05, "A"), null, {}, 0);
      snap = computeCanonicalMarketRegimeSnapshot(uniformRawFeatures(HOUR, 12, -0.02, -0.05, "B"), snap, {}, HOUR);
      snap = computeCanonicalMarketRegimeSnapshot(uniformRawFeatures(2 * HOUR, 12, -0.02, -0.05, "C"), snap, {}, 2 * HOUR);
      expect(snap.projection).toBe("BEARISH");
      expect(snap.regimeFamily).toBe("BEARISH");
    });

    it("a genuine duplicate cycle (unchanged sourceObservationIds) returns the prior snapshot object completely unchanged, even though nowMs advanced", () => {
      const first = computeCanonicalMarketRegimeSnapshot(uniformRawFeatures(0, 12, 0.02, 0.05, "A"), null, {}, 0);
      const second = computeCanonicalMarketRegimeSnapshot(uniformRawFeatures(HOUR, 12, 0.02, 0.05, "A"), first, {}, HOUR);
      expect(second).toBe(first); // same reference — not just deep-equal
      expect(second.atMs).toBe(0); // did NOT advance to HOUR
    });

    it("a cold start is never a duplicate even with an empty perSymbol input", () => {
      const snap = computeCanonicalMarketRegimeSnapshot({ atMs: 0, perSymbol: [] }, null, {}, 0);
      expect(snap.status).toBe("DEGRADED_INSUFFICIENT_SYMBOLS");
    });

    it("forces DEGRADED_INSUFFICIENT_SYMBOLS + MIXED + lowCoverage below CANONICAL_MARKET_REGIME_ENGINE_MIN_UNIVERSE_SIZE, even at 100% coverage of the (too-small) attempted universe", () => {
      const n = CANONICAL_MARKET_REGIME_ENGINE_MIN_UNIVERSE_SIZE - 1;
      const snap = computeCanonicalMarketRegimeSnapshot(uniformRawFeatures(0, n, 0.02, 0.05, "A"), null, {}, 0);
      expect(snap.status).toBe("DEGRADED_INSUFFICIENT_SYMBOLS");
      expect(snap.coverage.status).toBe("INVALID");
      expect(snap.coverage.validSymbolCount).toBe(n); // honestly reports full coverage of the small set
      expect(snap.projection).toBe("MIXED");
      expect(snap.overlays.lowCoverage).toBe(true);
      expect(snap.confidence).toBe(0);
    });

    it("does NOT force DEGRADED_INSUFFICIENT_SYMBOLS at/above the minimum universe size", () => {
      const snap = computeCanonicalMarketRegimeSnapshot(
        uniformRawFeatures(0, CANONICAL_MARKET_REGIME_ENGINE_MIN_UNIVERSE_SIZE, 0, 0, "A"),
        null,
        {},
        0,
      );
      expect(snap.status).toBe("VALID");
    });

    it("forces DEGRADED_STALE_UNIVERSE + MIXED + lowCoverage when rawFeatures.universeStale is true, independent of universe size", () => {
      const snap = computeCanonicalMarketRegimeSnapshot(
        uniformRawFeatures(0, 12, 0.02, 0.05, "A", { universeStale: true }),
        null,
        {},
        0,
      );
      expect(snap.status).toBe("DEGRADED_STALE_UNIVERSE");
      expect(snap.coverage.status).toBe("INVALID");
      expect(snap.projection).toBe("MIXED");
      expect(snap.overlays.lowCoverage).toBe(true);
    });

    it("a universeStale transition (false -> true) with otherwise-unchanged ids is NOT treated as a duplicate", () => {
      const first = computeCanonicalMarketRegimeSnapshot(uniformRawFeatures(0, 12, 0.02, 0.05, "A"), null, {}, 0);
      const second = computeCanonicalMarketRegimeSnapshot(
        uniformRawFeatures(HOUR, 12, 0.02, 0.05, "A", { universeStale: true }),
        first,
        {},
        HOUR,
      );
      expect(second).not.toBe(first);
      expect(second.status).toBe("DEGRADED_STALE_UNIVERSE");
    });

    it("never fabricates a 0 for a MISSING symbol's returns — null passes straight through to the assembled perSymbol row", () => {
      const raw: CanonicalMarketRegimeRawFeatures = {
        atMs: 0,
        perSymbol: [
          ...Array.from({ length: 11 }, (_, i) => ({
            symbol: `SYM${i}USDT`,
            returnFastPct: 0.02,
            returnSlowPct: 0.05,
            quoteVolume24hUsd: 10_000_000,
          })),
          { symbol: "MISSINGUSDT", returnFastPct: null, returnSlowPct: null, quoteVolume24hUsd: null },
        ],
      };
      const snap = computeCanonicalMarketRegimeSnapshot(raw, null, {}, 0);
      const missingRow = snap.perSymbol.find((s) => s.symbol === "MISSINGUSDT");
      expect(missingRow?.dataQuality).toBe("MISSING");
      expect(missingRow?.returnFastPct).toBeNull();
      expect(snap.sourceObservationIds.MISSINGUSDT).toBeUndefined(); // excluded, never a fabricated id either
      expect(snap.coverage.validSymbolCount).toBe(11);
      expect(snap.coverage.requiredSymbolCount).toBe(12);
    });

    it("riskStress reads an honest 0 (not a fabricated calm reading with a false sense of precision) when every risk-stress ingredient is omitted, as a calibration replay bar would omit them", () => {
      const snap = computeCanonicalMarketRegimeSnapshot(uniformRawFeatures(0, 12, 0, 0, "A"), null, {}, 0);
      expect(snap.riskStress).toBe(0);
      expect(snap.overlays.highStress).toBe(false);
    });

    it("[FINDING 1] a volume-pipeline-only partial outage (60 symbols, ALL with healthy candles, only 3 with a non-null quoteVolume24hUsd) degrades coverage to LOW_COVERAGE — candle-fetch success alone no longer reads as a healthy cycle", () => {
      const perSymbol: CanonicalMarketRegimeRawSymbolFeature[] = Array.from({ length: 60 }, (_, i) => ({
        symbol: `SYM${i}USDT`,
        returnFastPct: 0.02, // healthy candle data for ALL 60 (no MISSING rows at all)
        returnSlowPct: 0.04,
        quoteVolume24hUsd: i < 3 ? 50_000_000 + i * 1_000_000 : null, // only 3/60 have a working volume pipeline
      }));
      const snap = computeCanonicalMarketRegimeSnapshot({ atMs: 0, perSymbol }, null, {}, 0);

      // Candle coverage alone is 60/60 — the honest per-symbol bookkeeping is untouched by this fix.
      expect(snap.coverage.validSymbolCount).toBe(60);
      expect(snap.coverage.requiredSymbolCount).toBe(60);

      // BEFORE the fix this cycle reported coverage.status "VALID" / overlays.lowCoverage false —
      // exactly the silent-blind-spot this finding is about. After the fix, thin volume data alone
      // is enough to degrade coverage, exactly like a candle-fetch failure already does.
      expect(snap.coverage.status).not.toBe("VALID");
      expect(snap.overlays.lowCoverage).toBe(true);
      expect(snap.coverage.reasons.join(" ")).toMatch(/quoteVolume24hUsd|volume/i);

      // candidateDirection is coverage-forced to MIXED (requirement #5's existing machinery), so a
      // cold-start snapshot stays MIXED — this fix rides the SAME forcing path a candle-based
      // LOW_COVERAGE cycle already used, no new special case.
      expect(snap.projection).toBe("MIXED");

      // Independently of coverage, the liquidity cap itself must hold on this exact snapshot's own
      // direction computation — the review must never be satisfied by coverage alone (see file-header
      // FIX GOAL). None of the 3 active symbols' post-cap weight may exceed the cap.
      const cap = CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT;
      expect(Math.abs(snap.directionFast)).toBeLessThanOrEqual(3 * cap * 0.02 + 1e-9);
    });

    it("[FINDING 2] a candle-duplicate cycle (identical sourceObservationIds) whose funding/OI escalate to extreme still recomputes riskStress and PANIC — never returns the prior snapshot unchanged", () => {
      const n = 12;
      const calmFunding = Object.fromEntries(Array.from({ length: n }, (_, i) => [`SYM${i}USDT`, 0.0001])); // 1bp — NEUTRAL
      const calmOi = Object.fromEntries(Array.from({ length: n }, (_, i) => [`SYM${i}USDT`, 0.5])); // below OI_TREND_PCT
      const extremeFunding = Object.fromEntries(Array.from({ length: n }, (_, i) => [`SYM${i}USDT`, 0.02])); // 200bps — EXTREME
      const extremeOi = Object.fromEntries(Array.from({ length: n }, (_, i) => [`SYM${i}USDT`, 50])); // +50% — far above OI_TREND_PCT

      const first = computeCanonicalMarketRegimeSnapshot(
        uniformRawFeatures(0, n, 0.05, 0.05, "A", { fundingRateBySymbol: calmFunding, openInterestChangePercentBySymbol: calmOi }),
        null,
        {},
        0,
      );
      expect(first.riskStress).toBe(0);
      expect(first.overlays.panic).toBe(false);
      expect(first.projection).toBe("MIXED"); // cold start — 1st of 3 confirmations toward BULLISH
      expect(first.enterCandidateCycles).toBe(1);

      // SAME idTag "A" -> identical sourceObservationIds (candle-duplicate) — only funding/OI escalate,
      // 5 minutes later (this engine's own faster tick cadence than its 1h candle interval).
      const second = computeCanonicalMarketRegimeSnapshot(
        uniformRawFeatures(300_000, n, 0.05, 0.05, "A", {
          fundingRateBySymbol: extremeFunding,
          openInterestChangePercentBySymbol: extremeOi,
        }),
        first,
        {},
        300_000,
      );

      // THE FIX: riskStress/panic/highStress react to the fresh funding/OI — never memoized against the
      // stale first-call reading, and this is NOT the same object as `first`.
      expect(second).not.toBe(first);
      expect(second.atMs).toBe(300_000);
      expect(second.riskStress).toBeGreaterThanOrEqual(CANONICAL_MARKET_REGIME_ENGINE_PANIC_RISK_STRESS_THRESHOLD);
      expect(second.overlays.highStress).toBe(true);
      expect(second.overlays.panic).toBe(true);
      expect(second.sourceObservationIds).toEqual(first.sourceObservationIds); // candle identity genuinely unchanged

      // THE GUARDRAIL (requirement #4, unchanged for its original purpose): the DIRECTIONAL hysteresis
      // must NOT see a second confirmation from this candle-duplicate cycle, and confidence must not
      // inflate — candle-derived evidence (direction/breadth/cohesion) genuinely did not change.
      expect(second.projection).toBe("MIXED");
      expect(second.enterCandidateCycles).toBe(1); // still 1, NOT 2 — no double confirmation
      expect(second.stateHistory.cyclesInProjection).toBe(first.stateHistory.cyclesInProjection);
      expect(second.confidence).toBe(first.confidence);
    });
  });

  describe("computeCanonicalMarketRegimeEngineConfidence", () => {
    it("is 0 whenever coverageStatus is not VALID, regardless of cyclesInProjection", () => {
      expect(
        computeCanonicalMarketRegimeEngineConfidence({ coveragePct: 1, coverageStatus: "DEGRADED", cyclesInProjection: 100 }),
      ).toBe(0);
      expect(
        computeCanonicalMarketRegimeEngineConfidence({ coveragePct: 1, coverageStatus: "INVALID", cyclesInProjection: 100 }),
      ).toBe(0);
    });

    it("scales with coveragePct x stability, capped at 1", () => {
      expect(
        computeCanonicalMarketRegimeEngineConfidence({ coveragePct: 1, coverageStatus: "VALID", cyclesInProjection: 3 }),
      ).toBeCloseTo(1, 10);
      expect(
        computeCanonicalMarketRegimeEngineConfidence({ coveragePct: 1, coverageStatus: "VALID", cyclesInProjection: 1 }),
      ).toBeCloseTo(1 / 3, 10);
      expect(
        computeCanonicalMarketRegimeEngineConfidence({ coveragePct: 0.5, coverageStatus: "VALID", cyclesInProjection: 30 }),
      ).toBeCloseTo(0.5, 10); // stability caps at 1, never exceeds it past ENTER_CONFIRM_CYCLES
    });

    it("is 0 on non-finite input, never NaN", () => {
      expect(computeCanonicalMarketRegimeEngineConfidence({ coveragePct: NaN, coverageStatus: "VALID", cyclesInProjection: 3 })).toBe(0);
    });
  });

  describe("degradedLowCoverageSnapshot", () => {
    it("is always MIXED/lowCoverage/zero-confidence, with the given reason and default status", () => {
      const snap = degradedLowCoverageSnapshot(1000, "some reason");
      expect(snap.status).toBe("DEGRADED_INSUFFICIENT_SYMBOLS");
      expect(snap.projection).toBe("MIXED");
      expect(snap.regimeFamily).toBe("MIXED");
      expect(snap.overlays.lowCoverage).toBe(true);
      expect(snap.overlays.panic).toBe(false);
      expect(snap.confidence).toBe(0);
      expect(snap.coverage.status).toBe("INVALID");
      expect(snap.coverage.reasons).toEqual(["some reason"]);
      expect(snap.perSymbol).toEqual([]);
      expect(snap.sourceObservationIds).toEqual({});
    });

    it("honors a custom status (e.g. ENGINE_DISABLED)", () => {
      expect(degradedLowCoverageSnapshot(1000, "disabled", "ENGINE_DISABLED").status).toBe("ENGINE_DISABLED");
    });

    it("is itself always a well-formed snapshot per validCanonicalMarketRegimeSnapshotShape — the ONE safe default must pass its own strict validator", () => {
      expect(validCanonicalMarketRegimeSnapshotShape(degradedLowCoverageSnapshot(1000, "x"))).toBe(true);
    });
  });

  describe("readCanonicalMarketRegimeSnapshotStoreStrict", () => {
    it("FILE_MISSING for a nonexistent file", () => {
      const dataDir = freshDataDir();
      const result = readCanonicalMarketRegimeSnapshotStoreStrict(join(dataDir, "nope.json"));
      expect(result.status).toBe("FILE_MISSING");
      expect(result.state).toBeNull();
    });

    it("JSON_CORRUPTED for unparseable content", () => {
      const dataDir = freshDataDir();
      const file = join(dataDir, "bad.json");
      writeFileSync(file, "{ not json", "utf-8");
      expect(readCanonicalMarketRegimeSnapshotStoreStrict(file).status).toBe("JSON_CORRUPTED");
    });

    it("SCHEMA_MISMATCH for a wrong schemaVersion", () => {
      const dataDir = freshDataDir();
      const file = join(dataDir, "wrong-schema.json");
      writeFileSync(file, JSON.stringify({ schemaVersion: 2, latest: null, history: [], updatedAtIso: null }), "utf-8");
      expect(readCanonicalMarketRegimeSnapshotStoreStrict(file).status).toBe("SCHEMA_MISMATCH");
    });

    it("PARTIAL_INVALID when history is missing/malformed", () => {
      const dataDir = freshDataDir();
      const file = join(dataDir, "no-history.json");
      writeFileSync(file, JSON.stringify({ schemaVersion: 1, latest: null, updatedAtIso: null }), "utf-8");
      expect(readCanonicalMarketRegimeSnapshotStoreStrict(file).status).toBe("PARTIAL_INVALID");
    });

    it("HISTORY_INCONSISTENT when latest is not the last element of history", () => {
      const dataDir = freshDataDir();
      const file = join(dataDir, "inconsistent.json");
      const a = degradedLowCoverageSnapshot(1000, "a");
      const b = degradedLowCoverageSnapshot(2000, "b");
      writeFileSync(file, JSON.stringify({ schemaVersion: 1, latest: b, history: [a], updatedAtIso: null }), "utf-8");
      expect(readCanonicalMarketRegimeSnapshotStoreStrict(file).status).toBe("HISTORY_INCONSISTENT");
    });

    it("VALID for a well-formed store file, round-tripping the exact state", () => {
      const dataDir = freshDataDir();
      const file = join(dataDir, "ok.json");
      const snap = degradedLowCoverageSnapshot(1000, "seed");
      writeFileSync(file, JSON.stringify({ schemaVersion: 1, latest: snap, history: [snap], updatedAtIso: "2026-08-04T00:00:00.000Z" }), "utf-8");
      const result = readCanonicalMarketRegimeSnapshotStoreStrict(file);
      expect(result.status).toBe("VALID");
      expect(result.state?.latest?.atMs).toBe(1000);
      expect(result.state?.history).toHaveLength(1);
    });
  });

  describe("CanonicalMarketRegimeSnapshotStore", () => {
    it("a fresh store (no file yet) starts with get() null and empty history", () => {
      const dataDir = freshDataDir();
      const store = new CanonicalMarketRegimeSnapshotStore(join(dataDir, "history.json"));
      expect(store.get()).toBeNull();
      expect(store.getHistory()).toEqual([]);
    });

    it("record()+save() persists, and a NEW store instance reading the same file recovers the exact latest", () => {
      const dataDir = freshDataDir();
      const file = join(dataDir, "history.json");
      const snap = degradedLowCoverageSnapshot(1000, "seed");
      const store = new CanonicalMarketRegimeSnapshotStore(file);
      expect(store.record(snap)).toBe(true);
      store.save();
      expect(existsSync(file)).toBe(true);

      const reloaded = new CanonicalMarketRegimeSnapshotStore(file);
      expect(reloaded.get()?.atMs).toBe(1000);
      expect(reloaded.getHistory()).toHaveLength(1);
    });

    it("record() is a no-op (returns false, does not grow history) on a duplicate (unchanged sourceObservationIds + status)", () => {
      const dataDir = freshDataDir();
      const store = new CanonicalMarketRegimeSnapshotStore(join(dataDir, "history.json"));
      const snap = { ...degradedLowCoverageSnapshot(1000, "seed"), sourceObservationIds: { SYM: "id-A" } };
      expect(store.record(snap)).toBe(true);
      const duplicateResubmit = { ...degradedLowCoverageSnapshot(2000, "seed"), sourceObservationIds: { SYM: "id-A" } };
      expect(store.record(duplicateResubmit)).toBe(false);
      expect(store.getHistory()).toHaveLength(1);
      expect(store.get()?.atMs).toBe(1000); // did not get overwritten by the duplicate's atMs
    });

    it("record() DOES append when sourceObservationIds genuinely changed", () => {
      const dataDir = freshDataDir();
      const store = new CanonicalMarketRegimeSnapshotStore(join(dataDir, "history.json"));
      store.record({ ...degradedLowCoverageSnapshot(1000, "seed"), sourceObservationIds: { SYM: "id-A" } });
      const changed = store.record({ ...degradedLowCoverageSnapshot(2000, "seed"), sourceObservationIds: { SYM: "id-B" } });
      expect(changed).toBe(true);
      expect(store.getHistory()).toHaveLength(2);
    });

    it("[FINDING 2 / persisted store] record() must NOT treat a candle-duplicate snapshot as a no-op when riskStress escalated — mirrors computeCanonicalMarketRegimeSnapshot's own riskStress-aware duplicate check, extended to the persisted layer", () => {
      const dataDir = freshDataDir();
      const store = new CanonicalMarketRegimeSnapshotStore(join(dataDir, "history.json"));
      const n = 12;
      const calmFunding = Object.fromEntries(Array.from({ length: n }, (_, i) => [`SYM${i}USDT`, 0.0001])); // 1bp — NEUTRAL
      const calmOi = Object.fromEntries(Array.from({ length: n }, (_, i) => [`SYM${i}USDT`, 0.5])); // below OI_TREND_PCT
      const extremeFunding = Object.fromEntries(Array.from({ length: n }, (_, i) => [`SYM${i}USDT`, 0.02])); // 200bps — EXTREME
      const extremeOi = Object.fromEntries(Array.from({ length: n }, (_, i) => [`SYM${i}USDT`, 50])); // +50% — far above OI_TREND_PCT

      const calm = computeCanonicalMarketRegimeSnapshot(
        uniformRawFeatures(0, n, 0.05, 0.05, "A", { fundingRateBySymbol: calmFunding, openInterestChangePercentBySymbol: calmOi }),
        null,
        {},
        0,
      );
      expect(calm.riskStress).toBe(0);
      expect(calm.overlays.panic).toBe(false);
      expect(store.record(calm)).toBe(true);

      // SAME idTag "A" -> identical sourceObservationIds (candle-duplicate), status stays VALID —
      // only funding/OI escalate, 5 minutes later. This reuses the exact setup of the
      // computeCanonicalMarketRegimeSnapshot "[FINDING 2]" test above, so `escalated` is a genuine,
      // separately-computed snapshot object (not a hand-built fixture) exercising the real
      // compute -> store.record() pipeline.
      const escalated = computeCanonicalMarketRegimeSnapshot(
        uniformRawFeatures(300_000, n, 0.05, 0.05, "A", {
          fundingRateBySymbol: extremeFunding,
          openInterestChangePercentBySymbol: extremeOi,
        }),
        calm,
        {},
        300_000,
      );
      expect(escalated.sourceObservationIds).toEqual(calm.sourceObservationIds); // candle identity unchanged
      expect(escalated.status).toBe(calm.status); // status unchanged too — both VALID
      expect(escalated.riskStress).toBeGreaterThanOrEqual(CANONICAL_MARKET_REGIME_ENGINE_PANIC_RISK_STRESS_THRESHOLD);
      expect(escalated.overlays.panic).toBe(true);

      // THE FIX: a candle-identity+status duplicate whose riskStress genuinely escalated must still be
      // recorded as the new `latest` — never silently dropped as a no-op. Before this fix, record()'s
      // own duplicate check was candle-identity+status only (no riskStress term), so this call
      // returned false and the persisted store — and therefore every getCanonicalMarketRegimeSnapshot()
      // caller — kept serving the stale pre-escalation snapshot, defeating FINDING 2's fix one layer up.
      expect(store.record(escalated)).toBe(true);
      expect(store.get()).toBe(escalated); // latest actually advanced to the risk-escalated snapshot
      expect(store.get()?.overlays.panic).toBe(true);
      expect(store.getHistory()).toHaveLength(2);
    });

    it("bounds history at CANONICAL_MARKET_REGIME_SNAPSHOT_MAX_HISTORY, dropping the oldest rows", () => {
      const dataDir = freshDataDir();
      const store = new CanonicalMarketRegimeSnapshotStore(join(dataDir, "history.json"));
      const total = CANONICAL_MARKET_REGIME_SNAPSHOT_MAX_HISTORY + 5;
      for (let i = 0; i < total; i += 1) {
        store.record({ ...degradedLowCoverageSnapshot(i, "seed"), sourceObservationIds: { SYM: `id-${i}` } });
      }
      expect(store.getHistory()).toHaveLength(CANONICAL_MARKET_REGIME_SNAPSHOT_MAX_HISTORY);
      expect(store.getHistory()[0]?.sourceObservationIds.SYM).toBe("id-5"); // the first 5 were dropped
      expect(store.get()?.sourceObservationIds.SYM).toBe(`id-${total - 1}`);
    });

    it("a corrupt JSON file is discarded and reseeded (never throws, never partially repaired)", () => {
      const dataDir = freshDataDir();
      const file = join(dataDir, "history.json");
      writeFileSync(file, "{ not json", "utf-8");
      const store = new CanonicalMarketRegimeSnapshotStore(file);
      expect(store.get()).toBeNull();
      expect(store.getHistory()).toEqual([]);
    });

    it("a schema-version-mismatched file is discarded and reseeded", () => {
      const dataDir = freshDataDir();
      const file = join(dataDir, "history.json");
      writeFileSync(file, JSON.stringify({ schemaVersion: 99, latest: null, history: [], updatedAtIso: null }), "utf-8");
      const store = new CanonicalMarketRegimeSnapshotStore(file);
      expect(store.get()).toBeNull();
    });

    it("a file whose history contains a malformed entry is discarded and reseeded wholesale, not partially loaded", () => {
      const dataDir = freshDataDir();
      const file = join(dataDir, "history.json");
      const good = degradedLowCoverageSnapshot(1000, "ok");
      writeFileSync(
        file,
        JSON.stringify({ schemaVersion: 1, latest: good, history: [good, { bogus: true }], updatedAtIso: null }),
        "utf-8",
      );
      const store = new CanonicalMarketRegimeSnapshotStore(file);
      expect(store.get()).toBeNull(); // NOT `good` — a partial repair would be silently trusting corrupt data
      expect(store.getHistory()).toEqual([]);
    });
  });

  describe("recordCanonicalMarketRegimeSnapshot", () => {
    it("writes the store file to disk and returns true on the first record", () => {
      const dataDir = freshDataDir();
      const file = join(dataDir, "canonical-market-regime-history.json");
      expect(existsSync(file)).toBe(false);
      const changed = recordCanonicalMarketRegimeSnapshot(degradedLowCoverageSnapshot(1000, "seed"), dataDir);
      expect(changed).toBe(true);
      expect(existsSync(file)).toBe(true);
    });

    it("does not rewrite the file (returns false) on an exact duplicate resubmission", () => {
      const dataDir = freshDataDir();
      const first = { ...degradedLowCoverageSnapshot(1000, "seed"), sourceObservationIds: { SYM: "id-A" } };
      recordCanonicalMarketRegimeSnapshot(first, dataDir);
      const before = readFileSync(join(dataDir, "canonical-market-regime-history.json"), "utf-8");
      const duplicate = { ...degradedLowCoverageSnapshot(2000, "seed"), sourceObservationIds: { SYM: "id-A" } };
      const changed = recordCanonicalMarketRegimeSnapshot(duplicate, dataDir);
      expect(changed).toBe(false);
      const after = readFileSync(join(dataDir, "canonical-market-regime-history.json"), "utf-8");
      expect(after).toBe(before); // byte-identical — no disk write happened
    });
  });

  describe("getCanonicalMarketRegimeSnapshot", () => {
    it("kill switch active -> ENGINE_DISABLED, MIXED/lowCoverage, zero confidence, and touches the store not at all (no file created)", () => {
      const dataDir = freshDataDir();
      const snap = getCanonicalMarketRegimeSnapshot(dataDir, 1000, KILL_ENV);
      expect(snap.status).toBe("ENGINE_DISABLED");
      expect(snap.projection).toBe("MIXED");
      expect(snap.overlays.lowCoverage).toBe(true);
      expect(snap.confidence).toBe(0);
      expect(existsSync(join(dataDir, "canonical-market-regime-history.json"))).toBe(false);
    });

    it("cold start (kill switch unset, no store file yet) -> a degraded but non-null snapshot, never null/undefined", () => {
      const dataDir = freshDataDir();
      const snap = getCanonicalMarketRegimeSnapshot(dataDir, 1000, NO_ENV);
      expect(snap).toBeTruthy();
      expect(snap.status).toBe("DEGRADED_INSUFFICIENT_SYMBOLS");
      expect(snap.overlays.lowCoverage).toBe(true);
    });

    it("returns the recorded latest once one has been recorded", () => {
      const dataDir = freshDataDir();
      const recorded = { ...degradedLowCoverageSnapshot(5000, "recorded", "VALID"), sourceObservationIds: { SYM: "id-A" } };
      recordCanonicalMarketRegimeSnapshot(recorded, dataDir);
      const snap = getCanonicalMarketRegimeSnapshot(dataDir, 6000, NO_ENV);
      expect(snap.atMs).toBe(5000);
    });
  });

  describe("getCanonicalMarketRegimeSnapshotStore", () => {
    it("returns the same singleton instance across calls until reset", () => {
      const dataDir = freshDataDir();
      const a = getCanonicalMarketRegimeSnapshotStore(dataDir);
      const b = getCanonicalMarketRegimeSnapshotStore(dataDir);
      expect(a).toBe(b);
      _resetCanonicalMarketRegimeSnapshotStoreForTests();
      const c = getCanonicalMarketRegimeSnapshotStore(dataDir);
      expect(c).not.toBe(a);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADVERSARIAL REQUIREMENT TESTS A-G — exercised exclusively against the REAL exported
// computeCanonicalMarketRegimeSnapshot / computeCanonicalMarketRegimeEngineDirection functions above;
// nothing in this section reimplements any engine logic. canonical-market-regime-universe.ts (the
// sibling "which symbols are even eligible" module) has no direction/candidate-vote/panic/hysteresis
// surface at all — it only filters/ranks the symbol LIST the engine subsequently reads raw returns
// from — so it has no role in A-G specifically, which are all properties of the regime COMPUTATION
// itself once raw per-symbol data is in hand. Requirements H-K (LOW_COVERAGE blocks every entry path,
// all executors receive identical policy, exact-context keys survive the wiring layer, candidate-
// derived regime cannot influence AUTHORIZATION end-to-end) are execution-policy/wiring-level concerns
// that belong to canonical-market-regime-execution-policy.ts's and
// canonical-market-regime-adversarial-execution-paths.test.ts's own already-existing suites — out of
// scope here by design; this file tests the engine in isolation from the wiring around it.
// ═══════════════════════════════════════════════════════════════════════════════

describe("canonical-market-regime-engine — adversarial requirement tests (A-G)", () => {
  const T0 = Date.UTC(2026, 7, 1, 0, 0, 0);
  const HOUR = 3_600_000;

  /** One CanonicalMarketRegimeRawFeatures.perSymbol row, individually controllable — a more general
   *  builder than stage 4's own locally-scoped `uniformRawFeatures` (which forces every symbol
   *  identical), needed here because every adversarial test below deliberately constructs a
   *  NON-uniform cohort (a dominant whale plus many small alts, a mix of OK and MISSING, etc). */
  function regimeRow(
    symbol: string,
    overrides: Partial<CanonicalMarketRegimeRawSymbolFeature> = {},
  ): CanonicalMarketRegimeRawSymbolFeature {
    return { symbol, returnFastPct: 0, returnSlowPct: 0, quoteVolume24hUsd: 10_000_000, ...overrides };
  }

  function regimeRawFeatures(
    atMs: number,
    perSymbol: CanonicalMarketRegimeRawSymbolFeature[],
    extra: Partial<CanonicalMarketRegimeRawFeatures> = {},
  ): CanonicalMarketRegimeRawFeatures {
    return { atMs, perSymbol, ...extra };
  }

  describe("[CANON-REGIME-A] candidate direction cannot affect canonical regime", () => {
    /** A deliberately non-uniform, realistic-looking 20-symbol cohort (mixed signs, mixed liquidity —
     *  echoing the old fixed-20 UNIVERSE's own size) so this isn't a degenerate all-equal case that
     *  could hide a broken injection accidentally cancelling out. */
    function realisticCohort(): CanonicalMarketRegimeRawSymbolFeature[] {
      return [
        regimeRow("BTCUSDT", { returnFastPct: 0.018, returnSlowPct: 0.035, quoteVolume24hUsd: 900_000_000 }),
        regimeRow("ETHUSDT", { returnFastPct: 0.012, returnSlowPct: 0.02, quoteVolume24hUsd: 400_000_000 }),
        ...Array.from({ length: 10 }, (_, i) =>
          regimeRow(`BULL${i}USDT`, { returnFastPct: 0.02 + i * 0.001, returnSlowPct: 0.04, quoteVolume24hUsd: 5_000_000 }),
        ),
        ...Array.from({ length: 8 }, (_, i) =>
          regimeRow(`BEAR${i}USDT`, { returnFastPct: -0.01 - i * 0.001, returnSlowPct: -0.005, quoteVolume24hUsd: 3_000_000 }),
        ),
      ];
    }

    /** The shape scan-service.ts's deriveMarketRegime actually counts per candidate
     *  (finalDirection: LONG/SHORT/NEUTRAL) — constructed here even though NOTHING in
     *  computeCanonicalMarketRegimeSnapshot's real signature has a parameter shaped to accept it. */
    function fakeLegacyVotes(direction: "LONG" | "SHORT"): Array<{ symbol: string; finalDirection: "LONG" | "SHORT" }> {
      return realisticCohort().map((s) => ({ symbol: s.symbol, finalDirection: direction }));
    }

    it("is byte-identical across runs on the SAME raw market data even when a fake legacy candidate-vote bundle is smuggled through every channel the real signature actually exposes (generic calibrationParams bag, extra top-level properties, extra per-symbol properties)", () => {
      const baseline = computeCanonicalMarketRegimeSnapshot(regimeRawFeatures(T0, realisticCohort()), null, {}, T0);

      // Channel 1: calibrationParams is the one generic, untyped numeric bag in the real signature —
      // encode the fake vote counts into it under suggestive names. Reading the source confirms only
      // `calibrationParams.maxSingleSymbolWeightPct` is ever actually read; everything else must be inert.
      const allLongParams = { candidateBullishVotes: 20, candidateBearishVotes: 0, legacyMarketRegimeMargin: 20 };
      const allShortParams = { candidateBullishVotes: 0, candidateBearishVotes: 20, legacyMarketRegimeMargin: -20 };

      // Channel 2 + 3: attach extra, unofficial properties directly onto the rawFeatures object AND
      // onto every perSymbol row — mirroring scan-service.ts's own ScanResult/candidate shape
      // (`finalDirection`, a free-text `marketRegime`) — via a deliberate `as unknown as` cast so this
      // compiles despite not being part of CanonicalMarketRegimeRawFeatures's real type. If anything
      // downstream ever accidentally read `.candidateDirection`/`.finalDirection`, this would catch it.
      function withSmuggledVotes(direction: "LONG" | "SHORT"): CanonicalMarketRegimeRawFeatures {
        const raw = {
          atMs: T0,
          candidateDirection: direction, // top-level smuggle attempt
          legacyMarketRegime: direction === "LONG" ? "Bullish expansion" : "Bearish pressure",
          fakeCandidateVotes: fakeLegacyVotes(direction),
          perSymbol: realisticCohort().map((s) => ({ ...s, finalDirection: direction })), // per-row smuggle attempt
        };
        return raw as unknown as CanonicalMarketRegimeRawFeatures;
      }

      const injectedAllLong = computeCanonicalMarketRegimeSnapshot(withSmuggledVotes("LONG"), null, allLongParams, T0);
      const injectedAllShort = computeCanonicalMarketRegimeSnapshot(withSmuggledVotes("SHORT"), null, allShortParams, T0);

      expect(injectedAllLong).toEqual(baseline);
      expect(injectedAllShort).toEqual(baseline);
      expect(injectedAllLong).toEqual(injectedAllShort); // transitively implied, asserted directly too for clarity
    });
  });

  describe("[CANON-REGIME-B] BTC/microcap cannot dominate beyond the capped-liquidity-weighted cap", () => {
    const WHALE_RETURN_FAST = 0.5; // +50%, an extreme single-symbol print
    const WHALE_RETURN_SLOW = 0.8; // +80%
    const ALT_RETURN_FAST = -0.01; // -1%, uniformly OPPOSITE in sign to the whale
    const ALT_RETURN_SLOW = -0.02;
    const ALT_COUNT = 59;

    function whaleCohort(): CanonicalMarketRegimeRawSymbolFeature[] {
      return [
        regimeRow("BTCUSDT", { returnFastPct: WHALE_RETURN_FAST, returnSlowPct: WHALE_RETURN_SLOW, quoteVolume24hUsd: 900_000_000_000 }),
        ...Array.from({ length: ALT_COUNT }, (_, i) =>
          regimeRow(`ALT${i}USDT`, { returnFastPct: ALT_RETURN_FAST, returnSlowPct: ALT_RETURN_SLOW, quoteVolume24hUsd: 5_000_000 }),
        ),
      ];
    }

    it("directionFast/directionSlow land at exactly the cap-implied analytic bound, never anywhere near the whale's own extreme return, no matter how dominant its liquidity", () => {
      const snap = computeCanonicalMarketRegimeSnapshot(regimeRawFeatures(T0, whaleCohort()), null, {}, T0);

      // The 59 alts are liquidity-IDENTICAL to each other, so once the whale is capped at exactly
      // MAX_SINGLE_SYMBOL_WEIGHT_PCT, the remaining budget splits evenly across them — this is the
      // EXACT bound the design promises, asserted as an equality, not just a loose "< some small number":
      const cap = CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT;
      const expectedFast = cap * WHALE_RETURN_FAST + (1 - cap) * ALT_RETURN_FAST;
      const expectedSlow = cap * WHALE_RETURN_SLOW + (1 - cap) * ALT_RETURN_SLOW;
      expect(snap.directionFast).toBeCloseTo(expectedFast, 6);
      expect(snap.directionSlow).toBeCloseTo(expectedSlow, 6);

      // Sanity anchor pinning the magnitude gap explicitly, not just an inequality: if the cap were not
      // actually applied, directionFast/Slow would sit near the whale's own +50%/+80% raw return.
      expect(Math.abs(snap.directionFast)).toBeLessThan(WHALE_RETURN_FAST / 3);
      expect(Math.abs(snap.directionSlow)).toBeLessThan(WHALE_RETURN_SLOW / 3);
    });

    it("the whale's own post-cap weight is exactly the designed cap, verified directly against the real weighting function (not merely inferred from the composite above)", () => {
      const stats: CanonicalMarketRegimeEngineSymbolStat[] = whaleCohort().map((s) => ({
        symbol: s.symbol,
        dataQuality: "OK",
        returnFastPct: s.returnFastPct,
        returnSlowPct: s.returnSlowPct,
        quoteVolume24hUsd: s.quoteVolume24hUsd,
      }));
      const direction = computeCanonicalMarketRegimeEngineDirection(stats);
      expect(direction.weightsBySymbolFast.BTCUSDT).toBeCloseTo(CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT, 6);
      const altWeightSum = Object.entries(direction.weightsBySymbolFast)
        .filter(([symbol]) => symbol !== "BTCUSDT")
        .reduce((sum, [, w]) => sum + w, 0);
      expect(altWeightSum).toBeCloseTo(1 - CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT, 6);
    });
  });

  describe("[CANON-REGIME-C] breadth remains equal-weight, completely blind to liquidity distribution", () => {
    const ALT_COUNT = 11;

    function wideLiquidityCohort(): CanonicalMarketRegimeRawSymbolFeature[] {
      return [
        regimeRow("WHALEUSDT", { returnFastPct: -0.8, returnSlowPct: -0.8, quoteVolume24hUsd: 900_000_000_000 }), // extreme bearish print
        ...Array.from({ length: ALT_COUNT }, (_, i) =>
          regimeRow(`ALT${i}USDT`, { returnFastPct: 0.02, returnSlowPct: 0.02, quoteVolume24hUsd: 1_000_000 }),
        ),
      ];
    }
    function equalLiquidityCohort(): CanonicalMarketRegimeRawSymbolFeature[] {
      return [
        regimeRow("WHALEUSDT", { returnFastPct: -0.8, returnSlowPct: -0.8, quoteVolume24hUsd: 1_000_000 }), // same return, whale's OWN liquidity now equal to the alts
        ...Array.from({ length: ALT_COUNT }, (_, i) =>
          regimeRow(`ALT${i}USDT`, { returnFastPct: 0.02, returnSlowPct: 0.02, quoteVolume24hUsd: 1_000_000 }),
        ),
      ];
    }

    it("reflects the count-based majority (11 bullish alts outvote 1 extreme-bearish whale) regardless of the whale's return magnitude", () => {
      const snap = computeCanonicalMarketRegimeSnapshot(regimeRawFeatures(T0, wideLiquidityCohort()), null, {}, T0);
      expect(snap.breadth).toBeCloseTo((ALT_COUNT - 1) / (ALT_COUNT + 1), 6); // 11 advancers, 1 decliner — count only
    });

    it("is IDENTICAL (exact equality) whether the dominant symbol's liquidity is $900B or reduced to exactly equal every alt's, while directionFast (deliberately) is NOT — isolating precisely which statistic is liquidity-blind and which is not", () => {
      const whaleDominant = computeCanonicalMarketRegimeSnapshot(regimeRawFeatures(T0, wideLiquidityCohort()), null, {}, T0);
      const equalLiquidity = computeCanonicalMarketRegimeSnapshot(regimeRawFeatures(T0, equalLiquidityCohort()), null, {}, T0);
      expect(equalLiquidity.breadth).toBe(whaleDominant.breadth); // exact equality — breadth never even looks at volume
      expect(equalLiquidity.cohesion).toBe(whaleDominant.cohesion); // cohesion is the other liquidity-blind statistic
      expect(equalLiquidity.directionFast).not.toBeCloseTo(whaleDominant.directionFast, 2); // contrast: direction DOES move
    });
  });

  describe("[CANON-REGIME-D] missing data never becomes a safe zero", () => {
    const OK_COUNT = 15;
    const OK_RETURN_FAST = 0.02;

    function okRows(): CanonicalMarketRegimeRawSymbolFeature[] {
      return Array.from({ length: OK_COUNT }, (_, i) =>
        regimeRow(`SYM${i}USDT`, { returnFastPct: OK_RETURN_FAST, returnSlowPct: 0.04, quoteVolume24hUsd: 10_000_000 }),
      );
    }

    it("a MISSING symbol is EXCLUDED from every aggregate's denominator — numerically indistinguishable from that symbol never having been attempted at all, never a fabricated flat 0", () => {
      const withGhost = computeCanonicalMarketRegimeSnapshot(
        regimeRawFeatures(T0, [...okRows(), regimeRow("GHOSTUSDT", { returnFastPct: null, returnSlowPct: null, quoteVolume24hUsd: null })]),
        null,
        {},
        T0,
      );
      const withoutGhostAtAll = computeCanonicalMarketRegimeSnapshot(regimeRawFeatures(T0, okRows()), null, {}, T0);

      // The headline claim: every numeric aggregate is IDENTICAL whether the missing symbol is present
      // (marked MISSING) or entirely absent from the input — proving it contributes exactly nothing, not
      // a fabricated 0 diluting the average or padding breadth's "unchanged" bucket.
      expect(withGhost.directionFast).toBeCloseTo(withoutGhostAtAll.directionFast, 9);
      expect(withGhost.directionSlow).toBeCloseTo(withoutGhostAtAll.directionSlow, 9);
      expect(withGhost.breadth).toBe(withoutGhostAtAll.breadth);
      expect(withGhost.cohesion).toBe(withoutGhostAtAll.cohesion);
      expect(withGhost.dispersion).toBe(withoutGhostAtAll.dispersion);

      // Rule out the specific anti-pattern by name: if GHOSTUSDT had been silently zero-filled, breadth
      // would show 16 considered / 1 "unchanged", and directionFast would be diluted to
      // OK_RETURN_FAST*15/16 — neither matches what was just asserted above.
      expect(withGhost.directionFast).toBeCloseTo(OK_RETURN_FAST, 9);
      expect(withGhost.directionFast).not.toBeCloseTo((OK_RETURN_FAST * OK_COUNT) / (OK_COUNT + 1), 5);

      // And the honest bookkeeping this exclusion is supposed to produce (requirements #4/#5's own
      // "coverage tracks the exclusion honestly" framing):
      const ghostRow = withGhost.perSymbol.find((s) => s.symbol === "GHOSTUSDT");
      expect(ghostRow?.dataQuality).toBe("MISSING");
      expect(ghostRow?.returnFastPct).toBeNull();
      expect(withGhost.sourceObservationIds.GHOSTUSDT).toBeUndefined();
      expect(withGhost.coverage.validSymbolCount).toBe(OK_COUNT);
      expect(withGhost.coverage.requiredSymbolCount).toBe(OK_COUNT + 1);
      expect(withGhost.coverage.status).toBe("VALID"); // 15/16 = 93.75% still clears the 85% floor
    });
  });

  describe("[CANON-REGIME-E] duplicate observation does not add confirmation", () => {
    const FIVE_MIN = 300_000;

    function bullishRows(idTag: string): CanonicalMarketRegimeRawSymbolFeature[] {
      return Array.from({ length: 12 }, (_, i) =>
        regimeRow(`SYM${i}USDT`, {
          returnFastPct: 0.02,
          returnSlowPct: 0.05,
          quoteVolume24hUsd: 10_000_000,
          sourceObservationId: `SYM${i}USDT|1h|${idTag}`,
        }),
      );
    }

    it("an interleaved duplicate tick (same completed observation polled again, e.g. this engine's own faster tick cadence than its 1h candle interval) does not advance the confirmation counter — BULLISH still confirms on exactly the 3rd genuinely-new cycle, never earlier", () => {
      const cycle1 = computeCanonicalMarketRegimeSnapshot(regimeRawFeatures(0, bullishRows("A")), null, {}, 0);
      expect(cycle1.projection).toBe("MIXED");
      expect(cycle1.enterCandidateCycles).toBe(1);

      const cycle2 = computeCanonicalMarketRegimeSnapshot(regimeRawFeatures(HOUR, bullishRows("B")), cycle1, {}, HOUR);
      expect(cycle2.projection).toBe("MIXED");
      expect(cycle2.enterCandidateCycles).toBe(2);

      // A duplicate tick: same underlying candle observation ("B" again), wall-clock time advanced by
      // only 5 minutes — no new candle has actually closed yet.
      const duplicateTick = computeCanonicalMarketRegimeSnapshot(
        regimeRawFeatures(HOUR + FIVE_MIN, bullishRows("B")),
        cycle2,
        {},
        HOUR + FIVE_MIN,
      );
      expect(duplicateTick).toBe(cycle2); // literally the same object — not merely deep-equal
      expect(duplicateTick.enterCandidateCycles).toBe(2); // UNCHANGED — the duplicate added no confirmation
      expect(duplicateTick.atMs).toBe(HOUR); // did not even advance to HOUR+FIVE_MIN

      // The genuinely-new 3rd observation still has to arrive before BULLISH confirms — if the
      // duplicate above had wrongly counted, this would already have been BULLISH beforehand.
      const cycle3 = computeCanonicalMarketRegimeSnapshot(regimeRawFeatures(2 * HOUR, bullishRows("C")), duplicateTick, {}, 2 * HOUR);
      expect(cycle3.projection).toBe("BULLISH");
      expect(cycle3.enterCandidateCycles).toBe(0);
    });
  });

  describe("[CANON-REGIME-F] ordinary BULLISH<->BEARISH flips pass through MIXED, never direct — proven through the full public snapshot API, across computeCanonicalMarketRegimeSnapshot calls, not just the internal state-machine step", () => {
    function rows(idTag: string, returnFastPct: number, returnSlowPct: number): CanonicalMarketRegimeRawSymbolFeature[] {
      return Array.from({ length: 12 }, (_, i) =>
        regimeRow(`SYM${i}USDT`, { returnFastPct, returnSlowPct, quoteVolume24hUsd: 10_000_000, sourceObservationId: `SYM${i}USDT|1h|${idTag}` }),
      );
    }

    it("a persistent bullish run flipping to a persistent bearish run visits MIXED for the full confirmation window on the way down; projection and regimeFamily agree at every step and neither ever reverts to the old direction mid-flip", () => {
      let snap = computeCanonicalMarketRegimeSnapshot(regimeRawFeatures(0, rows("0", 0.02, 0.05)), null, {}, 0);
      snap = computeCanonicalMarketRegimeSnapshot(regimeRawFeatures(HOUR, rows("1", 0.02, 0.05)), snap, {}, HOUR);
      snap = computeCanonicalMarketRegimeSnapshot(regimeRawFeatures(2 * HOUR, rows("2", 0.02, 0.05)), snap, {}, 2 * HOUR);
      expect(snap.projection).toBe("BULLISH");
      expect(snap.regimeFamily).toBe("BULLISH");

      const sequence: string[] = [];
      for (let i = 0; i < CANONICAL_MARKET_REGIME_ENGINE_ENTER_CONFIRM_CYCLES; i += 1) {
        snap = computeCanonicalMarketRegimeSnapshot(regimeRawFeatures((3 + i) * HOUR, rows(`b${i}`, -0.02, -0.05)), snap, {}, (3 + i) * HOUR);
        expect(snap.regimeFamily).toBe(snap.projection); // the two fields never disagree, on any cycle
        sequence.push(snap.projection);
      }
      // Cycles 1-2 of the reversal: MIXED (immediate revert, then accumulating toward BEARISH). Cycle 3:
      // BEARISH confirmed. `projection` is never "BEARISH" before it is first genuinely "MIXED".
      expect(sequence).toEqual(["MIXED", "MIXED", "BEARISH"]);
      expect(sequence).not.toContain("BULLISH"); // never reverts back to the OLD direction mid-flip either
    });
  });

  describe("[CANON-REGIME-G] panic activates immediately and does not clear immediately — driven by REAL riskStress inputs (funding+OI aggregated market-wide) through the full computeCanonicalMarketRegimeSnapshot pipeline, not a hand-injected riskStress number", () => {
    const N = 12;

    /** riskStress driven genuinely through computeCanonicalMarketRegimeEngineRiskStress: btcCandles
     *  omitted (< 182 bars -> null btcAtrPercentile, per the engine's own documented renormalization),
     *  so riskStress = the funding+OI terms renormalized over their own combined 0.6 weight — exactly
     *  1.0 when every symbol is simultaneously funding-EXTREME (>= 7bps, DEFAULT_CROWDING_EXTREME_BPS)
     *  and OI-accelerating (>= 1%, OI_TREND_PCT) — comfortably clearing the 0.85 panic floor without
     *  needing a hand-tuned candle series to hit a precise ATR percentile. */
    function severeRows(idTag: string): CanonicalMarketRegimeRawSymbolFeature[] {
      return Array.from({ length: N }, (_, i) =>
        regimeRow(`SYM${i}USDT`, { returnFastPct: 0.05, returnSlowPct: 0.05, quoteVolume24hUsd: 10_000_000, sourceObservationId: `SYM${i}USDT|1h|${idTag}` }),
      );
    }
    function severeExtra(): Partial<CanonicalMarketRegimeRawFeatures> {
      const fundingRateBySymbol: Record<string, number> = {};
      const openInterestChangePercentBySymbol: Record<string, number> = {};
      for (let i = 0; i < N; i += 1) {
        fundingRateBySymbol[`SYM${i}USDT`] = 0.001; // 10bps, above the 7bps EXTREME bar
        openInterestChangePercentBySymbol[`SYM${i}USDT`] = 5; // well above the 1% OI_TREND_PCT bar
      }
      return { fundingRateBySymbol, openInterestChangePercentBySymbol };
    }
    function calmRows(idTag: string): CanonicalMarketRegimeRawSymbolFeature[] {
      return Array.from({ length: N }, (_, i) =>
        regimeRow(`SYM${i}USDT`, { returnFastPct: 0, returnSlowPct: 0, quoteVolume24hUsd: 10_000_000, sourceObservationId: `SYM${i}USDT|1h|${idTag}` }),
      );
    }

    it("PANIC flips true on the SAME cycle the severe combination first appears — even on a cold start, zero entry hysteresis — while the ordinary directional projection on that very same cycle is still MIXED (its own, separate, 3-cycle hysteresis); all four AND-terms of the panic condition are independently confirmed genuinely satisfied, not just the boolean outcome", () => {
      const snap = computeCanonicalMarketRegimeSnapshot(regimeRawFeatures(0, severeRows("A"), severeExtra()), null, {}, 0);
      expect(snap.riskStress).toBeGreaterThanOrEqual(CANONICAL_MARKET_REGIME_ENGINE_PANIC_RISK_STRESS_THRESHOLD);
      expect(Math.abs(snap.directionFast)).toBeGreaterThanOrEqual(CANONICAL_MARKET_REGIME_ENGINE_PANIC_DIRECTION_FAST_THRESHOLD);
      expect(Math.abs(snap.breadth)).toBeGreaterThanOrEqual(CANONICAL_MARKET_REGIME_ENGINE_PANIC_BREADTH_THRESHOLD);
      expect(Math.sign(snap.directionFast)).toBe(Math.sign(snap.breadth));
      expect(snap.coverage.status).toBe("VALID");
      expect(snap.overlays.panic).toBe(true);
      expect(snap.projection).toBe("MIXED"); // the DIRECTIONAL projection still needs its own 3-cycle confirmation
    });

    it("PANIC does not clear on cycles 1..(EXIT_CONFIRM_CYCLES-1) after the severe combination stops, only on the EXIT_CONFIRM_CYCLES-th consecutive genuinely-new non-recurring cycle", () => {
      let snap = computeCanonicalMarketRegimeSnapshot(regimeRawFeatures(0, severeRows("A"), severeExtra()), null, {}, 0);
      expect(snap.overlays.panic).toBe(true);

      for (let i = 1; i <= CANONICAL_MARKET_REGIME_ENGINE_PANIC_EXIT_CONFIRM_CYCLES - 1; i += 1) {
        snap = computeCanonicalMarketRegimeSnapshot(regimeRawFeatures(i * HOUR, calmRows(`c${i}`)), snap, {}, i * HOUR);
        expect(snap.overlays.panic).toBe(true); // still active — not enough consecutive non-met cycles yet
      }
      snap = computeCanonicalMarketRegimeSnapshot(
        regimeRawFeatures(CANONICAL_MARKET_REGIME_ENGINE_PANIC_EXIT_CONFIRM_CYCLES * HOUR, calmRows("cFinal")),
        snap,
        {},
        CANONICAL_MARKET_REGIME_ENGINE_PANIC_EXIT_CONFIRM_CYCLES * HOUR,
      );
      expect(snap.overlays.panic).toBe(false);
    });

    it("a recurrence of the severe combination while exit-counting resets the exit hysteresis rather than pausing it", () => {
      let snap = computeCanonicalMarketRegimeSnapshot(regimeRawFeatures(0, severeRows("A"), severeExtra()), null, {}, 0);
      snap = computeCanonicalMarketRegimeSnapshot(regimeRawFeatures(HOUR, calmRows("c1")), snap, {}, HOUR);
      snap = computeCanonicalMarketRegimeSnapshot(regimeRawFeatures(2 * HOUR, calmRows("c2")), snap, {}, 2 * HOUR);
      expect(snap.overlays.panic).toBe(true); // still active, 2 non-met so far
      snap = computeCanonicalMarketRegimeSnapshot(regimeRawFeatures(3 * HOUR, severeRows("B"), severeExtra()), snap, {}, 3 * HOUR); // recurs
      expect(snap.stateHistory.panicCyclesSinceExitCandidate).toBe(0);
      snap = computeCanonicalMarketRegimeSnapshot(regimeRawFeatures(4 * HOUR, calmRows("c4")), snap, {}, 4 * HOUR);
      snap = computeCanonicalMarketRegimeSnapshot(regimeRawFeatures(5 * HOUR, calmRows("c5")), snap, {}, 5 * HOUR);
      expect(snap.overlays.panic).toBe(true); // only 2 non-met since the recurrence — not enough yet
    });
  });
});

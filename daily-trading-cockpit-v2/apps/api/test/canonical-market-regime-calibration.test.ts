import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runCanonicalMarketRegimeCalibration,
  replayCanonicalMarketRegimeHistory,
  groupIntoEpisodes,
  liquidityCappedWeights,
  buildCalibrationBarsFromCandles,
  buildCalibrationVersionId,
  CanonicalMarketRegimeCalibrationStore,
  getCanonicalMarketRegimeCalibrationStore,
  _resetCanonicalMarketRegimeCalibrationStoreForTests,
  ACTIVE_CALIBRATION_VERSION_DEFAULT,
  MIN_CALIBRATION_STATE_EPISODES,
  MIN_PANIC_EPISODES,
  DEFAULT_MAX_SINGLE_SYMBOL_WEIGHT_PCT,
  type CalibrationHistoricalBar,
  type ComputeCanonicalMarketRegimeSnapshotFn,
  type CanonicalMarketRegimeCalibrationReport,
} from "../src/lib/canonical-market-regime-calibration.js";

const HOUR_MS = 3_600_000;
const SYMBOLS = ["WHALE", "S1", "S2", "S3", "S4", "S5", "S6", "S7"];
const START_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), "canonical-calibration-"));
}

/** Deterministic, smoothly-oscillating synthetic price/volume history. One symbol ("WHALE") carries
 *  a volume 100000x any other so the concentration metric's cap genuinely engages. */
function buildFixtureBars(nBars: number): CalibrationHistoricalBar[] {
  const bars: CalibrationHistoricalBar[] = [];
  for (let i = 0; i < nBars; i += 1) {
    const tMs = START_MS + i * HOUR_MS;
    const closesBySymbol = new Map<string, number>();
    const volBySymbol = new Map<string, number>();
    SYMBOLS.forEach((sym, si) => {
      const base = 100 * (si + 1);
      const price = base * (1 + 0.02 * Math.sin(i / 12 + si));
      closesBySymbol.set(sym, price);
      volBySymbol.set(sym, si === 0 ? 500_000_000_000 : 5_000_000);
    });
    bars.push({ tMs, closesBySymbol, quoteVolume24hUsdBySymbol: volBySymbol });
  }
  return bars;
}

/** A test-double standing in for the (not-yet-built) engine's computeCanonicalMarketRegimeSnapshot:
 *  cycles BULLISH -> BEARISH -> MIXED every call (by call order, not by the actual price data), so
 *  the harness's OWN episode-counting/BLOCKED/metrics-assembly logic can be exercised deterministically
 *  without depending on the real engine's classification logic. */
function makeCyclingFakeComputeSnapshot(forcePanicAtMs: Set<number> = new Set()): ComputeCanonicalMarketRegimeSnapshotFn {
  let counter = 0;
  return (rawFeatures, _prior, _params, nowMs) => {
    const cyclePos = counter % 3;
    counter += 1;
    const projection: "BULLISH" | "BEARISH" | "MIXED" = cyclePos === 0 ? "BULLISH" : cyclePos === 1 ? "BEARISH" : "MIXED";
    const panic = forcePanicAtMs.has(nowMs);
    const validSymbolCount = rawFeatures.perSymbol.filter((s) => s.returnFastPct !== null).length;
    return {
      schemaVersion: 1,
      engineVersion: "test-fake-v1",
      calibrationVersion: "test-fake-v1",
      atMs: nowMs,
      universeVersion: "test-universe-v1",
      universeSize: rawFeatures.perSymbol.length,
      perSymbol: rawFeatures.perSymbol.map((s) => ({
        symbol: s.symbol,
        returnFastPct: s.returnFastPct,
        returnSlowPct: s.returnSlowPct,
        quoteVolume24hUsd: s.quoteVolume24hUsd,
        spreadBps: null,
        openInterestUsd: null,
        dataQuality: s.returnFastPct === null ? "MISSING" : "OK",
      })),
      directionFast: 0,
      directionSlow: 0,
      breadth: 0,
      cohesion: cyclePos === 2 ? 0.2 : 0.8,
      dispersion: 0,
      riskStress: panic ? 0.9 : 0.1,
      coverage: {
        validSymbolCount,
        requiredSymbolCount: rawFeatures.perSymbol.length,
        coveragePct: rawFeatures.perSymbol.length > 0 ? (validSymbolCount / rawFeatures.perSymbol.length) * 100 : 0,
        status: "VALID",
        reasons: [],
      },
      projection,
      regimeFamily: projection,
      overlays: { transition: false, highStress: panic, panic, lowCoverage: false, rotational: false, fragmented: cyclePos === 2 },
      confidence: 0.5,
      stateHistory: { projectionSinceMs: nowMs, cyclesInProjection: 1, lastFlipAtMs: null, panicSinceMs: null, panicCyclesSinceExitCandidate: 0 },
      status: "VALID",
    };
  };
}

function buildOkReport(forcePanicAtMs: Set<number> = new Set()): CanonicalMarketRegimeCalibrationReport {
  const bars = buildFixtureBars(400);
  return runCanonicalMarketRegimeCalibration({
    bars,
    computeSnapshot: makeCyclingFakeComputeSnapshot(forcePanicAtMs),
    calibrationParams: {},
    nowMs: START_MS + 400 * HOUR_MS,
  });
}

describe("groupIntoEpisodes", () => {
  it("groups consecutive identical states into one episode and splits on change", () => {
    const rows = [
      { tMs: 1, state: "A" },
      { tMs: 2, state: "A" },
      { tMs: 3, state: "B" },
      { tMs: 4, state: "B" },
      { tMs: 5, state: "B" },
      { tMs: 6, state: "A" },
    ];
    const episodes = groupIntoEpisodes(rows);
    expect(episodes).toHaveLength(3);
    expect(episodes[0]).toMatchObject({ state: "A", startIdx: 0, endIdx: 1, lengthBars: 2 });
    expect(episodes[1]).toMatchObject({ state: "B", startIdx: 2, endIdx: 4, lengthBars: 3 });
    expect(episodes[2]).toMatchObject({ state: "A", startIdx: 5, endIdx: 5, lengthBars: 1 });
  });

  it("handles a single row as one episode", () => {
    const episodes = groupIntoEpisodes([{ tMs: 1, state: "X" }]);
    expect(episodes).toEqual([{ state: "X", startIdx: 0, endIdx: 0, startMs: 1, endMs: 1, lengthBars: 1 }]);
  });

  it("returns an empty array for an empty input", () => {
    expect(groupIntoEpisodes([])).toEqual([]);
  });
});

describe("liquidityCappedWeights", () => {
  it("caps a dominant symbol at maxWeightPct and redistributes the excess, preserving sum=1", () => {
    const volumes: Record<string, number> = { WHALE: 500_000_000_000 };
    for (let i = 1; i <= 7; i += 1) volumes[`S${i}`] = 5_000_000;
    const weights = liquidityCappedWeights(volumes, DEFAULT_MAX_SINGLE_SYMBOL_WEIGHT_PCT);
    const sum = Object.values(weights).reduce((a, v) => a + v, 0);
    expect(sum).toBeCloseTo(1, 9);
    expect(weights.WHALE!).toBeCloseTo(DEFAULT_MAX_SINGLE_SYMBOL_WEIGHT_PCT, 6);
    for (let i = 1; i <= 7; i += 1) {
      expect(weights[`S${i}`]!).toBeLessThanOrEqual(DEFAULT_MAX_SINGLE_SYMBOL_WEIGHT_PCT + 1e-9);
      expect(weights[`S${i}`]!).toBeGreaterThan(0);
    }
  });

  it("still sums to 1 in a degenerate small universe where the cap is mathematically unsatisfiable", () => {
    // 3 symbols at a 15% cap: even equal weighting (33% each) exceeds the cap — no valid assignment
    // exists where every weight <= 15% AND weights sum to 1. Sum=1 must still hold.
    const volumes = { A: 1_000_000, B: 500_000, C: 100_000 };
    const weights = liquidityCappedWeights(volumes, 0.15);
    const sum = Object.values(weights).reduce((a, v) => a + v, 0);
    expect(sum).toBeCloseTo(1, 9);
  });

  it("gives a single symbol the full weight (cap is meaningless with nobody to redistribute to)", () => {
    const weights = liquidityCappedWeights({ ONLY: 12_345 }, 0.15);
    expect(weights).toEqual({ ONLY: 1 });
  });

  it("falls back to equal weight when no symbol has usable volume", () => {
    const weights = liquidityCappedWeights({ A: 0, B: 0, C: 0 }, 0.15);
    expect(weights.A).toBeCloseTo(1 / 3, 9);
    expect(weights.B).toBeCloseTo(1 / 3, 9);
    expect(weights.C).toBeCloseTo(1 / 3, 9);
  });

  it("converges within its bounded iteration budget for a large, heavily-skewed universe", () => {
    const volumes: Record<string, number> = {};
    for (let i = 0; i < 60; i += 1) volumes[`SYM${i}`] = i === 0 ? 1_000_000_000_000 : 1_000_000 + i * 1000;
    const weights = liquidityCappedWeights(volumes, 0.15);
    const sum = Object.values(weights).reduce((a, v) => a + v, 0);
    expect(sum).toBeCloseTo(1, 6);
    for (const w of Object.values(weights)) expect(w).toBeLessThanOrEqual(0.15 + 1e-6);
  });
});

describe("buildCalibrationBarsFromCandles", () => {
  it("aligns per-symbol candles by openTime and leaves a missing symbol absent (never fabricated)", () => {
    const bars = buildCalibrationBarsFromCandles({
      BTCUSDT: [
        { openTime: 1000, close: 100 },
        { openTime: 2000, close: 101 },
      ],
      ETHUSDT: [
        { openTime: 1000, close: 10 },
        // no candle at 2000 — ETH is simply absent from that bar
      ],
    });
    expect(bars).toHaveLength(2);
    expect(bars[0]!.tMs).toBe(1000);
    expect(bars[0]!.closesBySymbol.get("BTCUSDT")).toBe(100);
    expect(bars[0]!.closesBySymbol.get("ETHUSDT")).toBe(10);
    expect(bars[1]!.tMs).toBe(2000);
    expect(bars[1]!.closesBySymbol.get("BTCUSDT")).toBe(101);
    expect(bars[1]!.closesBySymbol.has("ETHUSDT")).toBe(false);
  });

  it("drops non-finite or non-positive candles rather than fabricating a value", () => {
    const bars = buildCalibrationBarsFromCandles({
      X: [
        { openTime: 1000, close: Number.NaN },
        { openTime: 2000, close: -5 },
        { openTime: 3000, close: 42 },
      ],
    });
    expect(bars).toHaveLength(1);
    expect(bars[0]!.tMs).toBe(3000);
  });
});

describe("replayCanonicalMarketRegimeHistory", () => {
  it("feeds a null prior snapshot on the first bar and the previous row's own snapshot thereafter", () => {
    const bars = buildFixtureBars(10);
    const priorsSeen: Array<unknown> = [];
    const computeSnapshot: ComputeCanonicalMarketRegimeSnapshotFn = (rawFeatures, prior, _params, nowMs) => {
      priorsSeen.push(prior);
      return makeCyclingFakeComputeSnapshot()(rawFeatures, prior, {}, nowMs);
    };
    const result = replayCanonicalMarketRegimeHistory({ bars, computeSnapshot, calibrationParams: {} });
    expect(result.rows).toHaveLength(10);
    expect(priorsSeen[0]).toBeNull();
    expect(priorsSeen[1]).toBe(result.rows[0]!.snapshot);
    expect(priorsSeen[9]).toBe(result.rows[8]!.snapshot);
  });

  it("emits one row per bar with rawFeatures.atMs matching the bar's own tMs", () => {
    const bars = buildFixtureBars(5);
    const result = replayCanonicalMarketRegimeHistory({
      bars,
      computeSnapshot: makeCyclingFakeComputeSnapshot(),
      calibrationParams: {},
    });
    expect(result.rows.map((r) => r.tMs)).toEqual(bars.map((b) => b.tMs));
    result.rows.forEach((r, i) => expect(r.rawFeatures.atMs).toBe(bars[i]!.tMs));
  });

  it("never fabricates a return before enough lookback history exists", () => {
    const bars = buildFixtureBars(3); // well under the 24-bar slow lookback
    const result = replayCanonicalMarketRegimeHistory({
      bars,
      computeSnapshot: makeCyclingFakeComputeSnapshot(),
      calibrationParams: {},
    });
    for (const row of result.rows) {
      for (const s of row.rawFeatures.perSymbol) {
        expect(s.returnFastPct).toBeNull();
        expect(s.returnSlowPct).toBeNull();
      }
    }
  });
});

describe("runCanonicalMarketRegimeCalibration", () => {
  it("returns BLOCKED_NO_DEVELOPMENT_DATA when there is no historical data at all", () => {
    const report = runCanonicalMarketRegimeCalibration({
      bars: [],
      computeSnapshot: makeCyclingFakeComputeSnapshot(),
      calibrationParams: {},
      nowMs: START_MS,
    });
    expect(report.status).toBe("BLOCKED_NO_DEVELOPMENT_DATA");
    expect(report.blockedReason).toBeTruthy();
    expect(report.metrics).toBeNull();
    expect(report.proposedCalibrationVersion).toBeNull();
  });

  it("returns BLOCKED_INSUFFICIENT_STATE_EPISODES on a development window too short to reach the episode floor", () => {
    const bars = buildFixtureBars(40); // ~30 dev bars after the 25% holdout -> ~10 episodes per state, well under 30
    const report = runCanonicalMarketRegimeCalibration({
      bars,
      computeSnapshot: makeCyclingFakeComputeSnapshot(),
      calibrationParams: {},
      nowMs: START_MS + 40 * HOUR_MS,
    });
    expect(report.status).toBe("BLOCKED_INSUFFICIENT_STATE_EPISODES");
    expect(report.blockedReason).toMatch(/episode/);
    expect(report.metrics).toBeNull();
    expect(report.proposedCalibrationVersion).toBeNull();
  });

  it("returns OK with a full metrics report once every state clears the episode floor", () => {
    const forcePanicAtMs = new Set<number>();
    for (let i = 0; i < 300; i += 35) forcePanicAtMs.add(START_MS + i * HOUR_MS);
    const report = buildOkReport(forcePanicAtMs);

    expect(report.status).toBe("OK");
    expect(report.blockedReason).toBeNull();
    expect(report.proposedCalibrationVersion).toMatch(/^\d{8}-\d+-\d+-v1$/);
    const metrics = report.metrics!;
    expect(metrics).not.toBeNull();

    expect(metrics.stateEpisodes.BULLISH.length).toBeGreaterThanOrEqual(MIN_CALIBRATION_STATE_EPISODES);
    expect(metrics.stateEpisodes.BEARISH.length).toBeGreaterThanOrEqual(MIN_CALIBRATION_STATE_EPISODES);
    expect(metrics.stateEpisodes.MIXED.length).toBeGreaterThanOrEqual(MIN_CALIBRATION_STATE_EPISODES);

    // coverage: the fake always reports VALID
    expect(metrics.coveragePct).toBe(100);

    // concentration: the WHALE fixture is engineered to force the 15% cap to engage
    expect(metrics.concentration.maxRealizedSingleSymbolWeightSharePct).toBeGreaterThan(10);
    expect(metrics.concentration.maxRealizedSingleSymbolWeightSharePct).toBeLessThanOrEqual(15 + 1e-6);
    expect(metrics.concentration.withinCapConfirmed).toBe(true);

    // missing-data robustness: 8 symbols is enough to meaningfully drop a fraction
    expect(metrics.missingDataRobustness).not.toBeNull();
    expect(metrics.missingDataRobustness!.droppedFraction).toBeGreaterThan(0);
    expect(metrics.missingDataRobustness!.droppedFraction).toBeLessThan(1);
    expect(metrics.missingDataRobustness!.stateAgreementPct).toBeGreaterThanOrEqual(0);
    expect(metrics.missingDataRobustness!.stateAgreementPct).toBeLessThanOrEqual(100);

    // panic: >=9 isolated forced-panic bars clears the 8-episode floor
    expect(metrics.panicDetectionQuality.episodes).toBeGreaterThanOrEqual(MIN_PANIC_EPISODES);
    expect(metrics.panicDetectionQuality.status).toBe("EVALUATED");

    // the holdout window is strictly after the development window and was never scored into it
    expect(report.holdoutWindow.barCount).toBeGreaterThan(0);
    expect(report.developmentWindow.endMs).toBeLessThan(report.holdoutWindow.startMs);
    expect(report.developmentWindow.barCount + report.holdoutWindow.barCount).toBe(400);

    expect(report.developmentFolds.length).toBeGreaterThan(0);
  });

  it("reports PANIC_UNEVALUATED (not a hard block) when zero panic episodes occur", () => {
    const report = buildOkReport(new Set()); // no forced panics
    expect(report.status).toBe("OK");
    expect(report.metrics!.panicDetectionQuality.episodes).toBe(0);
    expect(report.metrics!.panicDetectionQuality.status).toBe("PANIC_UNEVALUATED");
  });

  it("logs a non-blocking warning when the bar interval deviates from the assumed 1h grid", () => {
    const bars = buildFixtureBars(150).map((b, i) => ({ ...b, tMs: START_MS + i * (HOUR_MS / 4) })); // 15-min grid
    const warnSpy = vitestWarnSpy();
    const report = runCanonicalMarketRegimeCalibration({
      bars,
      computeSnapshot: makeCyclingFakeComputeSnapshot(),
      calibrationParams: {},
      nowMs: START_MS + 150 * (HOUR_MS / 4),
    });
    expect(report.status === "OK" || report.status === "BLOCKED_INSUFFICIENT_STATE_EPISODES").toBe(true);
    expect(warnSpy.calls.some((args) => String(args[0]).includes("deviates from the assumed 1h grid"))).toBe(true);
    warnSpy.restore();
  });
});

// Minimal console.warn spy (kept local/inline rather than pulling in a mocking library) — records
// calls and restores the original function afterward.
function vitestWarnSpy(): { calls: unknown[][]; restore: () => void } {
  const original = console.warn;
  const calls: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    calls.push(args);
  };
  return {
    calls,
    restore: () => {
      console.warn = original;
    },
  };
}

describe("buildCalibrationVersionId", () => {
  it("is deterministic and round-trips cleanly through a plain split('-')", () => {
    const id = buildCalibrationVersionId(1000, 2000, 1, Date.UTC(2026, 7, 4, 0, 0, 0));
    expect(id).toBe("20260804-1000-2000-v1");
    expect(id.split("-")).toEqual(["20260804", "1000", "2000", "v1"]);
  });
});

describe("CanonicalMarketRegimeCalibrationStore", () => {
  it("defaults activeCalibrationVersion to the un-promoted default and starts with no frozen runs", () => {
    const store = new CanonicalMarketRegimeCalibrationStore(freshDataDir());
    expect(store.getActiveCalibrationVersion()).toBe(ACTIVE_CALIBRATION_VERSION_DEFAULT);
    expect(store.listFrozenVersions()).toEqual([]);
  });

  it("freezes an OK report and makes it retrievable", () => {
    const store = new CanonicalMarketRegimeCalibrationStore(freshDataDir());
    const report = buildOkReport();
    const version = store.freezeCalibrationRun(report, START_MS + 500 * HOUR_MS);
    expect(version).toBe(report.proposedCalibrationVersion);
    expect(store.hasVersion(version)).toBe(true);
    expect(store.getFrozenRun(version)?.report).toBe(report);
    // freezing never auto-promotes
    expect(store.getActiveCalibrationVersion()).toBe(ACTIVE_CALIBRATION_VERSION_DEFAULT);
  });

  it("mints a collision-free v2 on a second freeze of the same proposed version, without touching v1", () => {
    const store = new CanonicalMarketRegimeCalibrationStore(freshDataDir());
    const reportA = buildOkReport();
    const reportB = buildOkReport();
    expect(reportA.proposedCalibrationVersion).toBe(reportB.proposedCalibrationVersion); // same window -> same proposed id

    const v1 = store.freezeCalibrationRun(reportA, START_MS + 500 * HOUR_MS);
    const v2 = store.freezeCalibrationRun(reportB, START_MS + 501 * HOUR_MS);
    expect(v1).not.toBe(v2);
    expect(v2.endsWith("-v2")).toBe(true);
    expect(store.listFrozenVersions().sort()).toEqual([v1, v2].sort());
    // v1's frozen record is untouched (add-only, immutable)
    expect(store.getFrozenRun(v1)?.report).toBe(reportA);
    expect(store.getFrozenRun(v2)?.report).toBe(reportB);
  });

  it("refuses to freeze a BLOCKED report", () => {
    const store = new CanonicalMarketRegimeCalibrationStore(freshDataDir());
    const blocked = runCanonicalMarketRegimeCalibration({
      bars: [],
      computeSnapshot: makeCyclingFakeComputeSnapshot(),
      calibrationParams: {},
      nowMs: START_MS,
    });
    expect(() => store.freezeCalibrationRun(blocked, START_MS)).toThrow(/non-OK/);
  });

  it("promotes a frozen version to active, and refuses to promote an unknown version", () => {
    const store = new CanonicalMarketRegimeCalibrationStore(freshDataDir());
    const report = buildOkReport();
    const version = store.freezeCalibrationRun(report, START_MS);
    store.promoteActiveCalibrationVersion(version);
    expect(store.getActiveCalibrationVersion()).toBe(version);
    expect(() => store.promoteActiveCalibrationVersion("nonexistent-version")).toThrow(/unknown calibration version/);
  });

  it("persists frozen runs and the active version across a fresh store instance on the same data dir", () => {
    const dir = freshDataDir();
    const report = buildOkReport();
    const store1 = new CanonicalMarketRegimeCalibrationStore(dir);
    const version = store1.freezeCalibrationRun(report, START_MS);
    store1.promoteActiveCalibrationVersion(version);

    const store2 = new CanonicalMarketRegimeCalibrationStore(dir);
    expect(store2.getActiveCalibrationVersion()).toBe(version);
    expect(store2.hasVersion(version)).toBe(true);
    expect(store2.getFrozenRun(version)?.calibrationVersion).toBe(version);
  });

  it("discards and re-seeds (never throws) on a corrupted persisted file", () => {
    const dir = freshDataDir();
    writeFileSync(join(dir, "canonical-market-regime-calibration.json"), "{ not valid json", "utf-8");
    const store = new CanonicalMarketRegimeCalibrationStore(dir);
    expect(store.getActiveCalibrationVersion()).toBe(ACTIVE_CALIBRATION_VERSION_DEFAULT);
    expect(store.listFrozenVersions()).toEqual([]);
  });

  it("discards and re-seeds on a schema-mismatched persisted file (never silently repairs)", () => {
    const dir = freshDataDir();
    writeFileSync(
      join(dir, "canonical-market-regime-calibration.json"),
      JSON.stringify({ schemaVersion: 999, activeCalibrationVersion: "whatever", runs: {} }),
      "utf-8",
    );
    const store = new CanonicalMarketRegimeCalibrationStore(dir);
    expect(store.getActiveCalibrationVersion()).toBe(ACTIVE_CALIBRATION_VERSION_DEFAULT);
  });
});

describe("getCanonicalMarketRegimeCalibrationStore singleton", () => {
  beforeEach(() => {
    _resetCanonicalMarketRegimeCalibrationStoreForTests();
  });

  it("returns the same instance on repeated calls until reset", () => {
    const dir = freshDataDir();
    const a = getCanonicalMarketRegimeCalibrationStore(dir);
    const b = getCanonicalMarketRegimeCalibrationStore(dir);
    expect(a).toBe(b);
    _resetCanonicalMarketRegimeCalibrationStoreForTests();
    const c = getCanonicalMarketRegimeCalibrationStore(dir);
    expect(c).not.toBe(a);
  });
});

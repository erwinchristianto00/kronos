/**
 * Tests for resolveControllerAlignedShadowObservations and the updated
 * buildRegimeControllerAlignedShadowReport economics.
 *
 * Report-only: no live behavior, no data/shadow-positions.json usage.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RegimeControllerAlignedShadowStore,
  buildRegimeControllerAlignedShadowReport,
  resolveControllerAlignedShadowObservations,
  type ControllerAlignedShadowPosition,
  type ResolveControllerAlignedShadowOptions,
} from "../src/lib/regime-controller-aligned-shadow.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "cas-resolver-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeStore(): RegimeControllerAlignedShadowStore {
  return new RegimeControllerAlignedShadowStore(tempDir);
}

/** Build an OPEN LONG position with known geometry. */
function makeOpenLongPosition(
  overrides: Partial<ControllerAlignedShadowPosition> = {},
): ControllerAlignedShadowPosition {
  const openedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30m ago
  return {
    id: "test-id-long",
    symbol: "BTCUSDT",
    direction: "LONG",
    routeMode: "RESEARCH_ONLY",
    entryVariant: "base_current_entry",
    exitVariant: "tp1_full_exit",
    entryPrice: 50000,
    stopLoss: 49500,  // 100 bps below entry → stopDistanceBps=100
    takeProfitLevels: [51000], // 200 bps above entry → grossR=2.0
    stopDistanceBps: 100,
    controllerMode: "LONG_ONLY",
    controllerAlignment: "ALIGNED",
    openedAt,
    closedAt: null,
    marketRegimeAtOpen: "TRENDING_UP",
    status: "OPEN",
    netR: null,
    grossR: null,
    costR: null,
    durationMinutes: null,
    resolutionSource: null,
    laneLabel: "REGIME_CONTROLLER_ALIGNED_SHADOW_V1",
    reportOnly: true,
    policyVersion: "v2",
    ...overrides,
  };
}

/** Make a candle that touches the entry price (fill), then also hits TP1. */
function makeFillAndWinCandles(entry: number, tp1: number, stop: number) {
  return [
    // Candle 1: fills the entry
    { openTime: Date.now() - 20 * 60 * 1000, high: entry + 100, low: entry - 10, close: entry + 50 },
    // Candle 2: hits TP1
    { openTime: Date.now() - 15 * 60 * 1000, high: tp1 + 10, low: stop + 50, close: tp1 },
  ];
}

/** Make a candle that fills then hits SL. */
function makeFillAndLossCandles(entry: number, tp1: number, stop: number) {
  return [
    // Candle 1: fills entry
    { openTime: Date.now() - 20 * 60 * 1000, high: entry + 100, low: entry - 10, close: entry + 50 },
    // Candle 2: hits SL (low <= stop), does NOT hit TP1
    { openTime: Date.now() - 15 * 60 * 1000, high: entry + 50, low: stop - 10, close: stop + 20 },
  ];
}

/** Make a candle that hits both SL and TP1 on the same candle. */
function makeSameCandleSlAndTpCandles(entry: number, tp1: number, stop: number) {
  return [
    // Candle 1: fills entry
    { openTime: Date.now() - 20 * 60 * 1000, high: entry + 100, low: entry - 10, close: entry + 50 },
    // Candle 2: hits BOTH SL and TP1 on the same candle
    { openTime: Date.now() - 15 * 60 * 1000, high: tp1 + 10, low: stop - 10, close: entry },
  ];
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("resolveControllerAlignedShadowObservations", () => {
  it("1. TP1 hit: WIN, netR > 0", async () => {
    const store = makeStore();
    const pos = makeOpenLongPosition();
    store.writeState({
      observations: [pos],
      lastUpdatedAt: new Date().toISOString(),
    });

    const opts: ResolveControllerAlignedShadowOptions = {
      getCandles: async () =>
        makeFillAndWinCandles(pos.entryPrice, pos.takeProfitLevels[0]!, pos.stopLoss),
      noFillWindowMs: 4 * 60 * 60 * 1000,
      expiryWindowMs: 72 * 60 * 60 * 1000,
      costPerSideBps: 14,
    };

    const result = await resolveControllerAlignedShadowObservations(store, opts);
    expect(result.resolved).toBe(1);
    expect(result.errors).toBe(0);

    const state = store.readState();
    const resolved = state.observations[0]!;
    expect(resolved.status).toBe("CLOSED_WIN");
    expect(resolved.grossR).toBeGreaterThan(0);
    expect(resolved.netR).not.toBeNull();
    expect(resolved.netR!).toBeGreaterThan(0);
    expect(resolved.resolutionSource).toBe("TP1_HIT");
    expect(resolved.closedAt).not.toBeNull();
    expect(resolved.durationMinutes).not.toBeNull();
  });

  it("2. SL hit: LOSS, netR < 0", async () => {
    const store = makeStore();
    const pos = makeOpenLongPosition();
    store.writeState({
      observations: [pos],
      lastUpdatedAt: new Date().toISOString(),
    });

    const opts: ResolveControllerAlignedShadowOptions = {
      getCandles: async () =>
        makeFillAndLossCandles(pos.entryPrice, pos.takeProfitLevels[0]!, pos.stopLoss),
      costPerSideBps: 14,
    };

    const result = await resolveControllerAlignedShadowObservations(store, opts);
    expect(result.resolved).toBe(1);

    const state = store.readState();
    const resolved = state.observations[0]!;
    expect(resolved.status).toBe("CLOSED_LOSS");
    expect(resolved.grossR).toBe(-1.0);
    expect(resolved.netR).not.toBeNull();
    expect(resolved.netR!).toBeLessThan(0);
    expect(resolved.resolutionSource).toBe("SL_HIT");
  });

  it("3. Same-candle TP and SL: SL wins (CLOSED_LOSS) — conservative", async () => {
    const store = makeStore();
    const pos = makeOpenLongPosition();
    store.writeState({
      observations: [pos],
      lastUpdatedAt: new Date().toISOString(),
    });

    const opts: ResolveControllerAlignedShadowOptions = {
      getCandles: async () =>
        makeSameCandleSlAndTpCandles(pos.entryPrice, pos.takeProfitLevels[0]!, pos.stopLoss),
      costPerSideBps: 14,
    };

    const result = await resolveControllerAlignedShadowObservations(store, opts);
    expect(result.resolved).toBe(1);

    const state = store.readState();
    const resolved = state.observations[0]!;
    expect(resolved.status).toBe("CLOSED_LOSS");
    expect(resolved.resolutionSource).toBe("SL_HIT");
  });

  it("4. NO_FILL: candle never fills entry within noFillWindowMs", async () => {
    const store = makeStore();
    // Position opened 5 hours ago — past the 4h no-fill window
    const openedAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const pos = makeOpenLongPosition({ openedAt });
    store.writeState({
      observations: [pos],
      lastUpdatedAt: new Date().toISOString(),
    });

    const opts: ResolveControllerAlignedShadowOptions = {
      // Candles where low > entry — LONG fill condition (low <= entry) is never satisfied
      getCandles: async () => [
        {
          openTime: Date.now() - 4 * 60 * 60 * 1000,
          high: pos.entryPrice + 500,
          low: pos.entryPrice + 100, // low ABOVE entry — no fill for LONG
          close: pos.entryPrice + 200,
        },
      ],
      noFillWindowMs: 4 * 60 * 60 * 1000,
      expiryWindowMs: 72 * 60 * 60 * 1000,
    };

    const result = await resolveControllerAlignedShadowObservations(store, opts);
    expect(result.resolved).toBe(1);

    const state = store.readState();
    const resolved = state.observations[0]!;
    expect(resolved.status).toBe("NO_FILL");
    expect(resolved.netR).toBeNull();
    expect(resolved.resolutionSource).toBe("NO_FILL");
  });

  it("5. EXPIRED: observation age > expiryWindowMs", async () => {
    const store = makeStore();
    // Position opened 80 hours ago — past the 72h expiry window
    const openedAt = new Date(Date.now() - 80 * 60 * 60 * 1000).toISOString();
    const pos = makeOpenLongPosition({ openedAt });
    store.writeState({
      observations: [pos],
      lastUpdatedAt: new Date().toISOString(),
    });

    const opts: ResolveControllerAlignedShadowOptions = {
      getCandles: async () => [],
      expiryWindowMs: 72 * 60 * 60 * 1000,
    };

    const result = await resolveControllerAlignedShadowObservations(store, opts);
    expect(result.resolved).toBe(1);

    const state = store.readState();
    const resolved = state.observations[0]!;
    expect(resolved.status).toBe("EXPIRED");
    expect(resolved.resolutionSource).toBe("EXPIRED");
    expect(resolved.netR).toBeNull();
  });

  it("6. Data failure (getCandles throws): observation stays OPEN, errors++", async () => {
    const store = makeStore();
    const pos = makeOpenLongPosition();
    store.writeState({
      observations: [pos],
      lastUpdatedAt: new Date().toISOString(),
    });

    const opts: ResolveControllerAlignedShadowOptions = {
      getCandles: async () => {
        throw new Error("Binance API error");
      },
    };

    const result = await resolveControllerAlignedShadowObservations(store, opts);
    expect(result.errors).toBe(1);
    expect(result.resolved).toBe(0);

    const state = store.readState();
    // Observation stays OPEN
    expect(state.observations[0]!.status).toBe("OPEN");
    // resolutionSource set to DATA_FAILURE for diagnostics
    expect(state.observations[0]!.resolutionSource).toBe("DATA_FAILURE");
  });

  it("6-A. OPEN observation with stopLoss=0 → status becomes FAILED_INVALID_GEOMETRY", async () => {
    const store = makeStore();
    const pos = makeOpenLongPosition({ stopLoss: 0 });
    store.writeState({ observations: [pos], lastUpdatedAt: new Date().toISOString() });

    const opts: ResolveControllerAlignedShadowOptions = {
      getCandles: async () => [],
    };

    const result = await resolveControllerAlignedShadowObservations(store, opts);
    // Counts as resolved (moved out of OPEN)
    expect(result.resolved).toBe(1);

    const state = store.readState();
    expect(state.observations[0]!.status).toBe("FAILED_INVALID_GEOMETRY");
    expect(state.observations[0]!.resolutionSource).toBe("DATA_FAILURE");
  });

  it("6-B. OPEN observation with empty takeProfitLevels → status becomes FAILED_INVALID_GEOMETRY", async () => {
    const store = makeStore();
    const pos = makeOpenLongPosition({ takeProfitLevels: [] });
    store.writeState({ observations: [pos], lastUpdatedAt: new Date().toISOString() });

    const opts: ResolveControllerAlignedShadowOptions = {
      getCandles: async () => [],
    };

    const result = await resolveControllerAlignedShadowObservations(store, opts);
    expect(result.resolved).toBe(1);

    const state = store.readState();
    expect(state.observations[0]!.status).toBe("FAILED_INVALID_GEOMETRY");
  });

  it("6-C. FAILED_INVALID_GEOMETRY is excluded from economics in report", () => {
    const invalidObs: ControllerAlignedShadowPosition = makeOpenLongPosition({
      status: "FAILED_INVALID_GEOMETRY",
      stopLoss: 0,
      takeProfitLevels: [],
      netR: null,
      grossR: null,
    });
    const validWin: ControllerAlignedShadowPosition = {
      ...makeOpenLongPosition(),
      status: "CLOSED_WIN",
      netR: 1.0,
      grossR: 1.14,
      costR: 0.14,
      closedAt: new Date().toISOString(),
      durationMinutes: 30,
      resolutionSource: "TP1_HIT",
    };

    const report = buildRegimeControllerAlignedShadowReport({ observations: [invalidObs, validWin] });

    // totalObservations includes invalid geometry obs
    expect(report.totalObservations).toBe(2);
    // invalidGeometryCount populated
    expect(report.invalidGeometryCount).toBe(1);
    // resolvedObservations only counts CLOSED_WIN/LOSS/BREAKEVEN
    expect(report.resolvedObservations).toBe(1);
    // Economics only from the valid win
    expect(report.overallNetAvgR).not.toBeNull();
    expect(typeof report.overallNetAvgR).toBe("number");
  });

  it("6-D. Valid geometry observation resolves normally (TP1 win)", async () => {
    const store = makeStore();
    const pos = makeOpenLongPosition({
      entryPrice: 50000,
      stopLoss: 49500,
      takeProfitLevels: [51000],
      stopDistanceBps: 100,
    });
    store.writeState({ observations: [pos], lastUpdatedAt: new Date().toISOString() });

    const opts: ResolveControllerAlignedShadowOptions = {
      getCandles: async () =>
        makeFillAndWinCandles(pos.entryPrice, pos.takeProfitLevels[0]!, pos.stopLoss),
      costPerSideBps: 14,
    };

    const result = await resolveControllerAlignedShadowObservations(store, opts);
    expect(result.resolved).toBe(1);
    expect(result.errors).toBe(0);

    const state = store.readState();
    expect(state.observations[0]!.status).toBe("CLOSED_WIN");
    expect(state.observations[0]!.grossR).toBeGreaterThan(0);
  });

  it("7. Already resolved observation is skipped (not re-resolved)", async () => {
    const store = makeStore();
    const pos = makeOpenLongPosition({ status: "CLOSED_WIN", netR: 1.5, grossR: 1.86 });
    store.writeState({
      observations: [pos],
      lastUpdatedAt: new Date().toISOString(),
    });

    let candleCallCount = 0;
    const opts: ResolveControllerAlignedShadowOptions = {
      getCandles: async () => {
        candleCallCount += 1;
        return [];
      },
    };

    const result = await resolveControllerAlignedShadowObservations(store, opts);
    expect(result.skipped).toBe(1);
    expect(result.resolved).toBe(0);
    expect(candleCallCount).toBe(0); // no candle fetch for already-resolved
  });

  it("8. costR computed correctly from costPerSideBps and stopDistanceBps", async () => {
    const store = makeStore();
    // stopDistanceBps=200, costPerSide=14 → costR = 28/200 = 0.14
    const pos = makeOpenLongPosition({
      stopLoss: 49000, // 200 bps below 50000
      stopDistanceBps: 200,
      takeProfitLevels: [51000],
    });
    store.writeState({
      observations: [pos],
      lastUpdatedAt: new Date().toISOString(),
    });

    const opts: ResolveControllerAlignedShadowOptions = {
      getCandles: async () =>
        makeFillAndWinCandles(pos.entryPrice, pos.takeProfitLevels[0]!, pos.stopLoss),
      costPerSideBps: 14,
    };

    await resolveControllerAlignedShadowObservations(store, opts);

    const state = store.readState();
    const resolved = state.observations[0]!;
    expect(resolved.costR).not.toBeNull();
    // costR = (14 * 2) / 200 = 0.14
    expect(resolved.costR!).toBeCloseTo(0.14, 5);
    // grossR for LONG win: (tp1 - entry) / (entry - stop) = (51000 - 50000) / (50000 - 49000) = 1.0
    expect(resolved.grossR!).toBeCloseTo(1.0, 5);
    // netR = grossR - costR = 1.0 - 0.14 = 0.86
    expect(resolved.netR!).toBeCloseTo(0.86, 5);
  });

  it("9. durationMinutes computed from openedAt to closedAt", async () => {
    const store = makeStore();
    const openedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 60 min ago
    const pos = makeOpenLongPosition({ openedAt });
    store.writeState({
      observations: [pos],
      lastUpdatedAt: new Date().toISOString(),
    });

    const opts: ResolveControllerAlignedShadowOptions = {
      getCandles: async () =>
        makeFillAndWinCandles(pos.entryPrice, pos.takeProfitLevels[0]!, pos.stopLoss),
    };

    await resolveControllerAlignedShadowObservations(store, opts);

    const state = store.readState();
    const resolved = state.observations[0]!;
    expect(resolved.durationMinutes).not.toBeNull();
    expect(resolved.durationMinutes!).toBeGreaterThan(0);
  });
});

// ─── Dashboard report tests ───────────────────────────────────────────────────

describe("buildRegimeControllerAlignedShadowReport (economics)", () => {
  function makeResolvedPosition(
    status: ControllerAlignedShadowPosition["status"],
    netR: number | null,
    controllerMode = "LONG_ONLY",
  ): ControllerAlignedShadowPosition {
    const now = new Date();
    return {
      ...makeOpenLongPosition({ controllerMode }),
      status,
      netR,
      grossR: netR !== null ? netR + 0.14 : null,
      costR: 0.14,
      closedAt: now.toISOString(),
      durationMinutes: 30,
      resolutionSource: status === "CLOSED_WIN" ? "TP1_HIT" : status === "CLOSED_LOSS" ? "SL_HIT" : null,
    };
  }

  it("10. W** renders netAvgR, PF, WR when resolved > 0", () => {
    const observations = [
      makeResolvedPosition("CLOSED_WIN", 0.86),
      makeResolvedPosition("CLOSED_LOSS", -1.14),
    ];

    const report = buildRegimeControllerAlignedShadowReport({ observations });

    expect(report.resolvedObservations).toBe(2);
    expect(report.overallNetAvgR).not.toBeNull();
    expect(typeof report.overallNetAvgR).toBe("number");
    expect(report.overallPF).not.toBeNull();
    expect(report.overallWR).not.toBeNull();

    const byMode = report.byMode[0]!;
    expect(byMode.resolvedN).toBe(2);
    expect(byMode.netAvgR).not.toBeNull();
    expect(byMode.WR).not.toBeNull();
  });

  it("11. Verdict = EVIDENCE_AVAILABLE when resolved >= 20", () => {
    const observations: ControllerAlignedShadowPosition[] = [];
    for (let i = 0; i < 20; i++) {
      observations.push(makeResolvedPosition("CLOSED_WIN", 0.5));
    }

    const report = buildRegimeControllerAlignedShadowReport({ observations });
    expect(report.resolvedObservations).toBe(20);
    expect(report.verdict).toBe("EVIDENCE_AVAILABLE");
  });

  it("12. Verdict = TOO_EARLY when resolved < 20", () => {
    const observations = [
      makeResolvedPosition("CLOSED_WIN", 0.86),
      makeResolvedPosition("CLOSED_LOSS", -1.14),
    ];

    const report = buildRegimeControllerAlignedShadowReport({ observations });
    expect(report.resolvedObservations).toBe(2);
    expect(report.verdict).toBe("TOO_EARLY");
  });
});

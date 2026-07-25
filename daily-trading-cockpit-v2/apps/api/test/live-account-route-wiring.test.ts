import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerLiveRoutes } from "../src/routes/live.js";
import type { LiveExecutionEngine } from "../src/lib/live-execution-engine.js";
import type { CrossSectionalExecutor, ExecutorBasket } from "../src/lib/cross-sectional-executor.js";
import type { SingleSymbolLaneExecutor, SingleSymbolPosition } from "../src/lib/single-symbol-lane-executor.js";

/**
 * 2026-07-09 audit finding: routes/live.ts's registerLiveRoutes() builds allCrossSectionalExecutors()/
 * allSingleSymbolExecutors() arrays (lines ~415-422) from 5 independent opts getters and loops over
 * BOTH arrays at TWO call sites (/api/live/account, /api/live/lane-performance-series). Only the
 * pure annotate/merge functions were ever unit-tested directly — never through the actual route
 * handler with all 5 opts getters wired in, which is the one place a "forgot to add the new
 * executor to the loop" or "forgot to spread a getter into opts" regression would actually surface.
 */

function fakeAccountSnapshot(): Awaited<ReturnType<LiveExecutionEngine["getAccountSnapshot"]>> {
  return {
    walletBalance: 1000,
    availableBalance: 900,
    unrealizedPnl: 0,
    accountEquity: 1000,
    openPositionCount: 2,
    openOrderCount: 0,
    positions: [
      {
        symbol: "AUSDT", direction: "LONG", quantity: 10, entryPrice: 1, markPrice: 1,
        targetTpPrice: null, targetTpGapPct: null, liquidationPrice: null, unrealizedPnl: 0,
        estimatedCloseCostUsd: 0, unrealizedAfterEstimatedCloseCostUsd: 0, leverage: 3,
        sourceOrderCount: 0, laneIds: [] as string[], intentDirection: null, intentQty: null,
        intentEntryPrice: null, intentUnrealizedPnl: null, basketQty: null, basketUnrealizedPnl: null,
        singleSymbolStopPrice: null,
      },
      {
        symbol: "BUSDT", direction: "SHORT", quantity: 5, entryPrice: 1, markPrice: 1,
        targetTpPrice: null, targetTpGapPct: null, liquidationPrice: null, unrealizedPnl: 0,
        estimatedCloseCostUsd: 0, unrealizedAfterEstimatedCloseCostUsd: 0, leverage: 3,
        sourceOrderCount: 0, laneIds: [] as string[], intentDirection: null, intentQty: null,
        intentEntryPrice: null, intentUnrealizedPnl: null, basketQty: null, basketUnrealizedPnl: null,
        singleSymbolStopPrice: null,
      },
    ],
    lanes: [],
    closedLanes: [],
  } as never;
}

function fakeLaneSeries(): ReturnType<LiveExecutionEngine["getLanePerformanceSeries"]> {
  return {
    view: "daily", period: "fixed", viewLabel: "Daily", periodLabel: "Fixed",
    bucketLabel: "day", bucketMs: 86_400_000,
    since: "2026-07-01T00:00:00.000Z", until: "2026-07-09T00:00:00.000Z", anchor: null,
    regimeFilter: "all", regimeOptions: [{ value: "all", label: "All" }],
    bucketStarts: ["2026-07-08T00:00:00.000Z"],
    lanes: [],
  } as never;
}

function fakeXsecExecutor(laneId: string, symbol: string): CrossSectionalExecutor {
  const basket: ExecutorBasket = {
    basketId: `b-${laneId}`, sourceObservationId: "o1", signal: "MOM24", variant: "FILTERED",
    openedAt: "2026-07-08T00:00:00.000Z", closesAtMs: 0,
    legs: [{ symbol, side: "LONG", qty: 5, entryPrice: 1, entryOrderId: 1, entryPriceConfirmed: true, exitPrice: null, exitOrderId: null, exitPriceConfirmed: null }],
    status: "OPEN", closedAt: null, closeReason: null, grossPnlUsd: null, feeEstimateUsd: null, netPnlUsd: null,
  };
  return {
    getStatus: () => ({ laneId, openBaskets: [basket] }),
    getClosedSummary: () => ({ closedCount: 0, wins: 0, losses: 0, realizedPnlUsd: 0, feesUsd: 0, symbols: [], lastClosedAt: null }),
    getClosedBaskets: () => [],
  } as unknown as CrossSectionalExecutor;
}

function fakeSingleSymbolExecutor(laneId: string, symbol: string): SingleSymbolLaneExecutor {
  const pos: SingleSymbolPosition = {
    positionId: "p1", sourceObservationId: "o1", symbol, direction: "SHORT", qty: 3, entryPrice: 1,
    entryOrderId: 1, entryPriceConfirmed: true, stopPrice: 1.05, stopAlgoOrderId: 900, stopFailureCount: 0,
    stopUnprotectedSinceIso: null, closeFailureCount: 0, closeFailureSinceIso: null, peakFavorableR: 0,
    openedAt: "2026-07-08T00:00:00.000Z", status: "OPEN", closedAt: null, closeReason: null, exitPrice: null,
    exitOrderId: null, exitPriceConfirmed: null, grossPnlUsd: null, feeEstimateUsd: null, netPnlUsd: null,
  };
  return {
    getStatus: () => ({ laneId, openPositions: [pos] }),
    getClosedSummary: () => ({ closedCount: 0, wins: 0, losses: 0, realizedPnlUsd: 0, feesUsd: 0, symbols: [], lastClosedAt: null }),
    getClosedPositions: () => [],
  } as unknown as SingleSymbolLaneExecutor;
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  if (app) { await app.close(); app = null; }
});

async function buildApp(): Promise<FastifyInstance> {
  const fakeEngine = {
    getAccountSnapshot: async () => fakeAccountSnapshot(),
    getLanePerformanceSeries: () => fakeLaneSeries(),
  } as unknown as LiveExecutionEngine;

  app = Fastify();
  await registerLiveRoutes(app, fakeEngine, {
    crossSectionalExecutor: () => fakeXsecExecutor("CROSS_SECTIONAL_MARKET_NEUTRAL", "AUSDT"),
    crossSectionalTrendExecutor: () => fakeXsecExecutor("CROSS_SECTIONAL_TREND", "AUSDT"),
    crossSectionalMixedExecutor: () => fakeXsecExecutor("CROSS_SECTIONAL_MIXED", "AUSDT"),
    shortFadeExecutor: () => fakeSingleSymbolExecutor("SHORT_FADE_EXHAUSTION_CROWDED", "BUSDT"),
    intradayMomentumExecutor: () => fakeSingleSymbolExecutor("INTRADAY_MOMENTUM_BREAKOUT_LONG", "BUSDT"),
  });
  await app.ready();
  return app;
}

describe("registerLiveRoutes — /api/live/account wires ALL 5 executor instances, not just the first", () => {
  it("annotates the AUSDT position with all 3 cross-sectional laneIds (FILTERED + TREND + MIXED)", async () => {
    const a = await buildApp();
    const res = await a.inject({ method: "GET", url: "/api/live/account" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const row = body.positions.find((p: { symbol: string }) => p.symbol === "AUSDT");
    expect(row.laneIds.sort()).toEqual(["CROSS_SECTIONAL_MARKET_NEUTRAL", "CROSS_SECTIONAL_MIXED", "CROSS_SECTIONAL_TREND"]);
  });

  it("annotates the BUSDT position with both single-symbol-executor laneIds (SHORT_FADE + INTRADAY_MOMENTUM)", async () => {
    const a = await buildApp();
    const res = await a.inject({ method: "GET", url: "/api/live/account" });
    const body = res.json();
    const row = body.positions.find((p: { symbol: string }) => p.symbol === "BUSDT");
    expect(row.laneIds.sort()).toEqual(["INTRADAY_MOMENTUM_BREAKOUT_LONG", "SHORT_FADE_EXHAUSTION_CROWDED"]);
  });

  it("still returns cleanly with only a partial subset of executor getters wired (older-deploy shape)", async () => {
    const fakeEngine = {
      getAccountSnapshot: async () => fakeAccountSnapshot(),
      getLanePerformanceSeries: () => fakeLaneSeries(),
    } as unknown as LiveExecutionEngine;
    app = Fastify();
    await registerLiveRoutes(app, fakeEngine, {
      crossSectionalExecutor: () => fakeXsecExecutor("CROSS_SECTIONAL_MARKET_NEUTRAL", "AUSDT"),
      // trend/mixed/shortFade/intradayMomentum all omitted — simulates an older deploy or a
      // disabled instance; the array-builder's `?? null` + `.filter()` must not throw.
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/live/account" });
    expect(res.statusCode).toBe(200);
    const row = res.json().positions.find((p: { symbol: string }) => p.symbol === "AUSDT");
    expect(row.laneIds).toEqual(["CROSS_SECTIONAL_MARKET_NEUTRAL"]);
  });
});

describe("registerLiveRoutes — /api/live/lane-performance-series wires ALL 5 executor instances", () => {
  it("merges closed-basket/closed-position lanes from all 5 instances into the 'all' regime view", async () => {
    // Give each executor at least one CLOSED basket/position so it contributes a lane row —
    // mergeCrossSectionalIntoLaneSeries/mergeSingleSymbolIntoLaneSeries both no-op on 0 closed.
    const closedBasket: ExecutorBasket = {
      basketId: "cb1", sourceObservationId: "o1", signal: "MOM24", variant: "FILTERED",
      openedAt: "2026-07-07T00:00:00.000Z", closesAtMs: 0,
      legs: [{ symbol: "AUSDT", side: "LONG", qty: 5, entryPrice: 1, entryOrderId: 1, entryPriceConfirmed: true, exitPrice: 1.01, exitOrderId: 2, exitPriceConfirmed: true }],
      status: "CLOSED", closedAt: "2026-07-08T00:00:00.000Z", closeReason: "PROFIT_BANK", grossPnlUsd: 1, feeEstimateUsd: 0.1, netPnlUsd: 0.9,
    };
    const closedPos: SingleSymbolPosition = {
      positionId: "cp1", sourceObservationId: "o1", symbol: "BUSDT", direction: "SHORT", qty: 3, entryPrice: 1,
      entryOrderId: 1, entryPriceConfirmed: true, stopPrice: 1.05, stopAlgoOrderId: 900, stopFailureCount: 0,
      stopUnprotectedSinceIso: null, closeFailureCount: 0, closeFailureSinceIso: null, peakFavorableR: 0.5,
      openedAt: "2026-07-07T00:00:00.000Z", status: "CLOSED", closedAt: "2026-07-08T00:00:00.000Z", closeReason: "TP_HIT",
      exitPrice: 0.99, exitOrderId: 2, exitPriceConfirmed: true, grossPnlUsd: 1, feeEstimateUsd: 0.1, netPnlUsd: 0.9,
    };
    function closedXsec(laneId: string): CrossSectionalExecutor {
      return {
        getStatus: () => ({ laneId, openBaskets: [] }),
        getClosedSummary: () => ({ closedCount: 0, wins: 0, losses: 0, realizedPnlUsd: 0, feesUsd: 0, symbols: [], lastClosedAt: null }),
        getClosedBaskets: () => [closedBasket],
      } as unknown as CrossSectionalExecutor;
    }
    function closedSingle(laneId: string): SingleSymbolLaneExecutor {
      return {
        getStatus: () => ({ laneId, openPositions: [] }),
        getClosedSummary: () => ({ closedCount: 0, wins: 0, losses: 0, realizedPnlUsd: 0, feesUsd: 0, symbols: [], lastClosedAt: null }),
        getClosedPositions: () => [closedPos],
      } as unknown as SingleSymbolLaneExecutor;
    }
    const fakeEngine = {
      getAccountSnapshot: async () => fakeAccountSnapshot(),
      getLanePerformanceSeries: () => ({ ...fakeLaneSeries(), bucketStarts: ["2026-07-08T00:00:00.000Z"] }),
    } as unknown as LiveExecutionEngine;
    app = Fastify();
    await registerLiveRoutes(app, fakeEngine, {
      crossSectionalExecutor: () => closedXsec("CROSS_SECTIONAL_MARKET_NEUTRAL"),
      crossSectionalTrendExecutor: () => closedXsec("CROSS_SECTIONAL_TREND"),
      crossSectionalMixedExecutor: () => closedXsec("CROSS_SECTIONAL_MIXED"),
      shortFadeExecutor: () => closedSingle("SHORT_FADE_EXHAUSTION_CROWDED"),
      intradayMomentumExecutor: () => closedSingle("INTRADAY_MOMENTUM_BREAKOUT_LONG"),
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/live/lane-performance-series?view=daily&regime=all" });
    expect(res.statusCode).toBe(200);
    const laneIds = res.json().lanes.map((l: { laneId: string }) => l.laneId).sort();
    expect(laneIds).toEqual([
      "CROSS_SECTIONAL_MARKET_NEUTRAL", "CROSS_SECTIONAL_MIXED", "CROSS_SECTIONAL_TREND",
      "INTRADAY_MOMENTUM_BREAKOUT_LONG", "SHORT_FADE_EXHAUSTION_CROWDED",
    ]);
  });
});

describe("[2026-07-22] /api/live/cortex-promoted-weights — direct visibility into the engine's currently-installed tilt", () => {
  it("503s with engine disabled — same contract as every other route in this file", async () => {
    app = Fastify();
    await registerLiveRoutes(app, null);
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/live/cortex-promoted-weights" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false });
  });

  it("reports active:false and an empty map when CORTEX has no promoted override installed", async () => {
    const fakeEngine = {
      getCortexPromotedWeights: () => null,
    } as unknown as LiveExecutionEngine;
    app = Fastify();
    await registerLiveRoutes(app, fakeEngine);
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/live/cortex-promoted-weights" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, active: false, weights: {} });
  });

  it("reports active:true and the exact installed map when CORTEX has a live promoted override", async () => {
    const fakeEngine = {
      getCortexPromotedWeights: () => ({ CG_MFE_GIVEBACK_SHORT: 23.71776, INTRADAY_MOMENTUM_BREAKOUT_LONG: 7.808 }),
    } as unknown as LiveExecutionEngine;
    app = Fastify();
    await registerLiveRoutes(app, fakeEngine);
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/live/cortex-promoted-weights" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      active: true,
      weights: { CG_MFE_GIVEBACK_SHORT: 23.71776, INTRADAY_MOMENTUM_BREAKOUT_LONG: 7.808 },
    });
  });
});

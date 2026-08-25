import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerLiveRoutes } from "../src/routes/live.js";
import type { LiveExecutionEngine } from "../src/lib/live-execution-engine.js";
import { BinanceFuturesPrivateError } from "../src/lib/binance-futures-private.js";
import type { CrossSectionalExecutor, ExecutorBasket } from "../src/lib/cross-sectional-executor.js";
import type { SingleSymbolLaneExecutor, SingleSymbolPosition } from "../src/lib/single-symbol-lane-executor.js";
import type { SymbolReliabilitySnapshot } from "../src/lib/cross-sectional-symbol-reliability.js";

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
    getRegimeSkewCounterfactual: () => null,
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

async function buildSnapshotApp(
  engine: LiveExecutionEngine,
  dashboardAccountSnapshot?: { nowMs?: () => number; cacheTtlMs?: number; rateLimitBackoffMs?: number },
): Promise<FastifyInstance> {
  app = Fastify();
  await registerLiveRoutes(app, engine, { dashboardAccountSnapshot });
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

    // The second response is served from the short dashboard cache. Attribution remains exactly
    // once per executor; cache reuse must not retain /api/live/account's mutable annotations.
    const again = await a.inject({ method: "GET", url: "/api/live/account" });
    const againRow = again.json().positions.find((p: { symbol: string }) => p.symbol === "AUSDT");
    expect(againRow.sourceOrderCount).toBe(row.sourceOrderCount);
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

describe("registerLiveRoutes — Symbol Reliability V1 runtime contract", () => {
  it("returns the API-owned snapshot beside the executor status rather than requiring dashboard inference", async () => {
    const snapshot: SymbolReliabilitySnapshot = {
      version: "SYMBOL_RELIABILITY_V1",
      enabled: true,
      persistence: { status: "HEALTHY", source: "PRIMARY", reason: null, recoveredAt: null },
      evidenceContract: "ACTUAL_NO_TP_HOLD_36H_INDEPENDENT_EPISODES_V1",
      evaluatedAt: "2026-08-21T00:00:00.000Z",
      evaluationId: "sr-v1-route-test",
      evaluationCycle: 1,
      evidenceChanged: false,
      independentEpisodes: 0,
      eligibleBaskets: 0,
      excludedBaskets: {},
      minimumIndependentEpisodes: 8,
      statuses: [],
      quarantined: [],
      lastFormationDecision: null,
    };
    const fakeEngine = {
      getAccountSnapshot: async () => fakeAccountSnapshot(),
      getLanePerformanceSeries: () => fakeLaneSeries(),
    } as unknown as LiveExecutionEngine;
    app = Fastify();
    await registerLiveRoutes(app, fakeEngine, {
      crossSectionalExecutor: () => fakeXsecExecutor("CROSS_SECTIONAL_MARKET_NEUTRAL", "AUSDT"),
      symbolReliabilitySnapshotGetter: () => snapshot,
    });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/api/live/cross-sectional-executor" });
    expect(response.statusCode).toBe(200);
    expect(response.json().symbolReliability).toEqual(snapshot);
  });
});

describe("registerLiveRoutes — dashboard account snapshot pressure guard", () => {
  it("coalesces concurrent dashboard routes onto one USD-M account read", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const engine = {
      getAccountSnapshot: async () => {
        calls += 1;
        await gate;
        return fakeAccountSnapshot();
      },
      getLanePerformanceSeries: () => fakeLaneSeries(),
      laneSelectionWeightPctForLane: () => 0,
    } as unknown as LiveExecutionEngine;
    const a = await buildSnapshotApp(engine);

    const account = a.inject({ method: "GET", url: "/api/live/account" });
    const positions = a.inject({ method: "GET", url: "/api/live/single-symbol/positions" });
    const evaluation = a.inject({ method: "GET", url: "/api/live/lane-evaluation" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);

    release();
    const [accountResponse, positionsResponse, evaluationResponse] = await Promise.all([account, positions, evaluation]);
    expect(accountResponse.statusCode).toBe(200);
    expect(positionsResponse.statusCode).toBe(200);
    expect(evaluationResponse.statusCode).toBe(200);
    expect(calls).toBe(1);
  });

  it("returns an explicitly stale last-good snapshot during a 418 cooldown without another exchange read", async () => {
    let nowMs = 1_000;
    let calls = 0;
    const engine = {
      getAccountSnapshot: async () => {
        calls += 1;
        if (calls === 1) return fakeAccountSnapshot();
        throw new BinanceFuturesPrivateError("429", "rate limited (HTTP 418)", { httpStatus: 418 });
      },
      getLanePerformanceSeries: () => fakeLaneSeries(),
      laneSelectionWeightPctForLane: () => 0,
    } as unknown as LiveExecutionEngine;
    const a = await buildSnapshotApp(engine, {
      nowMs: () => nowMs,
      cacheTtlMs: 10,
      rateLimitBackoffMs: 1_000,
    });

    const first = await a.inject({ method: "GET", url: "/api/live/account" });
    expect(first.statusCode).toBe(200);
    expect(first.json().accountSnapshot).toMatchObject({ source: "USD_M_PRIVATE_ACCOUNT", stale: false });

    nowMs += 11;
    const stale = await a.inject({ method: "GET", url: "/api/live/account" });
    expect(stale.statusCode).toBe(200);
    expect(stale.json().accountSnapshot).toMatchObject({
      source: "LAST_GOOD_USD_M_PRIVATE_CACHE",
      stale: true,
      lastFailure: "rate limited (HTTP 418)",
    });
    expect(calls).toBe(2);

    nowMs += 1;
    const positions = await a.inject({ method: "GET", url: "/api/live/single-symbol/positions" });
    expect(positions.statusCode).toBe(200);
    expect(calls).toBe(2);
  });

  it("fails closed on the first 418, then enforces the cooldown without retrying Binance", async () => {
    let calls = 0;
    const engine = {
      getAccountSnapshot: async () => {
        calls += 1;
        throw new BinanceFuturesPrivateError("429", "rate limited (HTTP 418)", { httpStatus: 418 });
      },
      getLanePerformanceSeries: () => fakeLaneSeries(),
      laneSelectionWeightPctForLane: () => 0,
    } as unknown as LiveExecutionEngine;
    const a = await buildSnapshotApp(engine, { rateLimitBackoffMs: 1_000 });

    const first = await a.inject({ method: "GET", url: "/api/live/account" });
    expect(first.statusCode).toBe(503);
    expect(first.json()).toMatchObject({ ok: false, reason: "rate limited (HTTP 418)" });

    const second = await a.inject({ method: "GET", url: "/api/live/lane-evaluation" });
    expect(second.statusCode).toBe(503);
    expect(calls).toBe(1);
  });
});

describe("[operator close] /api/live/cross-sectional-close stays scoped to one market-neutral basket", () => {
  const operatorDrainEngine = {
    setNewEntriesPaused: () => ({ enabled: true, effective: true, pausedAt: "2026-07-08T00:00:00.000Z", reason: "test" }),
  } as unknown as LiveExecutionEngine;

  const basket = (basketId: string): ExecutorBasket => ({
    basketId, sourceObservationId: "o1", signal: "MOM24", variant: "FILTERED",
    openedAt: "2026-07-08T00:00:00.000Z", closesAtMs: 0,
    legs: [{ symbol: "AUSDT", side: "LONG", qty: 5, entryPrice: 1, entryOrderId: 1, entryPriceConfirmed: true, exitPrice: null, exitOrderId: null, exitPriceConfirmed: null }],
    status: "COMPLETE", closedAt: null, closeReason: null, grossPnlUsd: null, feeEstimateUsd: null, netPnlUsd: null,
  });

  it("uses only the market-neutral executor, and only when its exact target is the sole open basket", async () => {
    const previousEnv = process.env.LIVE_BINANCE_ENV;
    process.env.LIVE_BINANCE_ENV = "testnet";
    try {
      const target = basket("only-core-basket");
      let targetOpen = true;
      let closeCalls = 0;
      let closeReason = "";
      let directionalGetterCalls = 0;
      const coreExecutor = {
        getStatus: () => ({ laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", openBaskets: targetOpen ? [target] : [] }),
        closeAllBasketsOrderly: async (reason: string) => {
          closeCalls += 1;
          closeReason = reason;
          targetOpen = false;
          return { closed: 1, failed: 0 };
        },
      } as unknown as CrossSectionalExecutor;

      app = Fastify();
      await registerLiveRoutes(app, operatorDrainEngine, {
        crossSectionalExecutor: () => coreExecutor,
        crossSectionalDirectionalShortExecutor: () => {
          directionalGetterCalls += 1;
          return fakeSingleSymbolExecutor("CROSS_SECTIONAL_DIRECTIONAL_SHORT", "SUSDT");
        },
      });
      await app.ready();
      const res = await app.inject({
        method: "POST",
        url: "/api/live/cross-sectional-close",
        remoteAddress: "127.0.0.1",
        payload: { confirm: "CLOSE_ONLY_THIS_CROSS_SECTIONAL_BASKET", basketId: target.basketId },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, basketId: target.basketId, openBasketIds: [] });
      expect(closeCalls).toBe(1);
      expect(closeReason).toBe(`OPERATOR_SCOPED_CLOSE:${target.basketId}`);
      expect(directionalGetterCalls).toBe(0);
    } finally {
      if (previousEnv === undefined) delete process.env.LIVE_BINANCE_ENV;
      else process.env.LIVE_BINANCE_ENV = previousEnv;
    }
  });

  it("refuses to turn a one-basket request into a bulk cross-sectional close", async () => {
    const previousEnv = process.env.LIVE_BINANCE_ENV;
    process.env.LIVE_BINANCE_ENV = "testnet";
    try {
      const target = basket("target-basket");
      let closeCalls = 0;
      const coreExecutor = {
        getStatus: () => ({ laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", openBaskets: [target, basket("another-basket")] }),
        closeAllBasketsOrderly: async () => {
          closeCalls += 1;
          return { closed: 2, failed: 0 };
        },
      } as unknown as CrossSectionalExecutor;

      app = Fastify();
      await registerLiveRoutes(app, operatorDrainEngine, { crossSectionalExecutor: () => coreExecutor });
      await app.ready();
      const res = await app.inject({
        method: "POST",
        url: "/api/live/cross-sectional-close",
        remoteAddress: "127.0.0.1",
        payload: { confirm: "CLOSE_ONLY_THIS_CROSS_SECTIONAL_BASKET", basketId: target.basketId },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ ok: false, basketId: target.basketId, openBasketIds: [target.basketId, "another-basket"] });
      expect(closeCalls).toBe(0);
    } finally {
      if (previousEnv === undefined) delete process.env.LIVE_BINANCE_ENV;
      else process.env.LIVE_BINANCE_ENV = previousEnv;
    }
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

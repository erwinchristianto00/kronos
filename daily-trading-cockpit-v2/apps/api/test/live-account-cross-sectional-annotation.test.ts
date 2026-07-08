import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import os from "node:os";

import { annotateCrossSectionalAccount, mergeCrossSectionalIntoLaneSeries } from "../src/routes/live.js";
import {
  CrossSectionalExecutor,
  CrossSectionalExecutorStore,
  type ExecutorBasket,
} from "../src/lib/cross-sectional-executor.js";
import { CrossSectionalStore } from "../src/lib/cross-sectional-edge.js";

let n = 0;
function tmpDir(): string {
  return resolve(os.tmpdir(), `xsec-account-annotation-${process.pid}-${++n}`);
}

function leg(symbol: string, side: "LONG" | "SHORT", qty: number, entryPrice: number): ExecutorBasket["legs"][number] {
  return { symbol, side, qty, entryPrice, entryOrderId: 1, entryPriceConfirmed: true, exitPrice: null, exitOrderId: null, exitPriceConfirmed: null };
}

function openBasket(id: string, legs: ExecutorBasket["legs"]): ExecutorBasket {
  return {
    basketId: id,
    sourceObservationId: `src-${id}`,
    signal: "MOM24_FILTERED",
    variant: "FILTERED",
    openedAt: "2026-07-07T00:00:00.000Z",
    closesAtMs: Date.parse("2026-07-08T00:00:00.000Z"),
    legs,
    status: "OPEN",
    closedAt: null,
    closeReason: null,
    grossPnlUsd: null,
    feeEstimateUsd: null,
    netPnlUsd: null,
  };
}

function makeExecutorWithBaskets(baskets: ExecutorBasket[], laneId?: string): CrossSectionalExecutor {
  const store = new CrossSectionalExecutorStore(tmpDir());
  store.getState().baskets = baskets;
  const signalStore = new CrossSectionalStore(tmpDir());
  return new CrossSectionalExecutor({
    client: {} as never,
    signalStore,
    store,
    isAllowed: () => true,
    ...(laneId !== undefined ? { laneId } : {}),
  });
}

function position(symbol: string, direction: "LONG" | "SHORT", quantity: number, unrealizedPnl: number) {
  return {
    symbol,
    direction,
    quantity,
    entryPrice: 1,
    markPrice: 1,
    targetTpPrice: null,
    targetTpGapPct: null,
    liquidationPrice: null,
    unrealizedPnl,
    estimatedCloseCostUsd: 0,
    unrealizedAfterEstimatedCloseCostUsd: unrealizedPnl,
    leverage: 3,
    sourceOrderCount: 0,
    laneIds: [] as string[],
  };
}

function snapshot(positions: ReturnType<typeof position>[]) {
  return {
    positions,
    lanes: [] as Array<{ laneId: string; sourceOrderCount: number; symbols: string[]; notionalUsd: number; unrealizedPnl: number }>,
    closedLanes: [] as unknown[],
  } as never;
}

// [MULTI-BASKET] 2026-07-07 audit: annotateCrossSectionalAccount only ever attributed the FIRST
// open basket (executor.getStatus().openBasket, singular, a .find()). MAX_OPEN_BASKETS can exceed
// 1 (testnet runs 4) — confirmed on real testnet data: 4 concurrent baskets, only one basket's
// symbols got tagged CROSS_SECTIONAL_MARKET_NEUTRAL, the other 3 baskets' real exchange positions
// showed "unattributed" on the dashboard's Exchange Positions table.
describe("annotateCrossSectionalAccount — attributes EVERY open basket, not just the first", () => {
  it("tags positions belonging to a 2nd/3rd concurrently-open basket, not only the first", () => {
    const basketA = openBasket("xb-a", [leg("ETHUSDT", "LONG", 0.01, 1800), leg("ADAUSDT", "SHORT", 100, 0.4)]);
    const basketB = openBasket("xb-b", [leg("BNBUSDT", "LONG", 0.05, 600), leg("XRPUSDT", "SHORT", 50, 0.5)]);
    const executor = makeExecutorWithBaskets([basketA, basketB]);

    const snap = snapshot([
      position("ETHUSDT", "LONG", 0.01, 5),
      position("ADAUSDT", "SHORT", 100, -2),
      position("BNBUSDT", "LONG", 0.05, 3), // belongs ONLY to basketB — the bug this test catches
      position("XRPUSDT", "SHORT", 50, 1),
    ]);

    const annotated = annotateCrossSectionalAccount(snap, executor);
    for (const sym of ["ETHUSDT", "ADAUSDT", "BNBUSDT", "XRPUSDT"]) {
      const row = annotated.positions.find((p: { symbol: string }) => p.symbol === sym)!;
      expect(row.laneIds).toContain("CROSS_SECTIONAL_MARKET_NEUTRAL");
    }
    const lane = annotated.lanes.find((l: { laneId: string }) => l.laneId === "CROSS_SECTIONAL_MARKET_NEUTRAL")!;
    expect(lane.symbols.sort()).toEqual(["ADAUSDT", "BNBUSDT", "ETHUSDT", "XRPUSDT"]);
    expect(lane.sourceOrderCount).toBe(4); // one leg per basket per symbol
  });

  it("leaves a genuinely foreign position (no matching leg in ANY open basket) unattributed", () => {
    const basketA = openBasket("xb-a", [leg("ETHUSDT", "LONG", 0.01, 1800)]);
    const executor = makeExecutorWithBaskets([basketA]);
    const snap = snapshot([position("ETHUSDT", "LONG", 0.01, 5), position("SOLUSDT", "LONG", 1, 2)]);
    const annotated = annotateCrossSectionalAccount(snap, executor);
    expect(annotated.positions.find((p: { symbol: string }) => p.symbol === "SOLUSDT")!.laneIds).toEqual([]);
  });

  // 2026-07-08 operator ("pisahkan unrealized antara cross sectional dan directional"): each
  // netted row gains the BASKET book's own qty + P&L, computed from the LEGS' entries.
  it("[BOOK-SPLIT] fills basketQty + basketUnrealizedPnl from leg entries, matching by SYMBOL even when the netted row direction differs", () => {
    const basketA = openBasket("xb-a", [leg("WLDUSDT", "SHORT", 64, 0.3832)]);
    const basketB = openBasket("xb-b", [leg("WLDUSDT", "SHORT", 64, 0.384)]);
    const executor = makeExecutorWithBaskets([basketA, basketB]);
    const p = { ...position("WLDUSDT", "SHORT", 244, -1.0), markPrice: 0.38 };
    const annotated = annotateCrossSectionalAccount(snapshot([p]), executor);
    const row = annotated.positions[0]! as { basketQty?: number | null; basketUnrealizedPnl?: number | null };
    expect(row.basketQty).toBeCloseTo(-128, 9); // two short legs, signed
    // (0.38−0.3832)×64×(−1) + (0.38−0.384)×64×(−1) = 0.2048 + 0.256
    expect(row.basketUnrealizedPnl).toBeCloseTo(0.2048 + 0.256, 6);

    // Direction flip: basket LONG leg while the netted row shows SHORT — still attributed.
    const long = openBasket("xb-l", [leg("SUIUSDT", "LONG", 34, 0.73)]);
    const exec2 = makeExecutorWithBaskets([long]);
    const p2 = { ...position("SUIUSDT", "SHORT", 10, 0), markPrice: 0.74 };
    const a2 = annotateCrossSectionalAccount(snapshot([p2]), exec2);
    const r2 = a2.positions[0]! as { basketQty?: number | null; basketUnrealizedPnl?: number | null };
    expect(r2.basketQty).toBeCloseTo(34, 9);
    expect(r2.basketUnrealizedPnl).toBeCloseTo((0.74 - 0.73) * 34, 9);
  });

  it("is a no-op when there are no open baskets at all", () => {
    const executor = makeExecutorWithBaskets([]);
    const snap = snapshot([position("ETHUSDT", "LONG", 0.01, 5)]);
    const annotated = annotateCrossSectionalAccount(snap, executor);
    expect(annotated.positions[0]!.laneIds).toEqual([]);
    expect(annotated.lanes).toEqual([]);
  });

  // [CLOSED-REALIZED] 2026-07-07: a banked basket (+1.45) moved the REAL wallet balance but every
  // realized-P&L surface stayed flat — the engine's ledger deliberately excludes executor positions,
  // so closed baskets must reach the account snapshot via closedLanes or they are invisible.
  it("[CLOSED-REALIZED] merges closed baskets into closedLanes (even with zero open baskets)", () => {
    const win = { ...openBasket("xb-w", [leg("SOLUSDT", "LONG", 0.3, 80)]), status: "CLOSED" as const, closedAt: "2026-07-07T05:00:00.000Z", closeReason: "PROFIT_BANK", netPnlUsd: 1.447, feeEstimateUsd: 0.05, grossPnlUsd: 1.497 };
    const loss = { ...openBasket("xb-l", [leg("ADAUSDT", "SHORT", 100, 0.2)]), status: "CLOSED" as const, closedAt: "2026-07-07T03:00:00.000Z", closeReason: "HORIZON", netPnlUsd: -0.15, feeEstimateUsd: 0.04, grossPnlUsd: -0.11 };
    const executor = makeExecutorWithBaskets([win, loss]);
    const annotated = annotateCrossSectionalAccount(snapshot([]), executor);
    const row = annotated.closedLanes.find((l: { laneId: string }) => l.laneId === "CROSS_SECTIONAL_MARKET_NEUTRAL")!;
    expect(row).toBeTruthy();
    expect(row.closedCount).toBe(2);
    expect(row.wins).toBe(1);
    expect(row.losses).toBe(1);
    expect(row.realizedPnlUsd).toBeCloseTo(1.297, 6);
    expect(row.feesUsd).toBeCloseTo(0.09, 6);
    expect(row.symbols).toEqual(["ADAUSDT", "SOLUSDT"]);
    expect(row.lastClosedAt).toBe("2026-07-07T05:00:00.000Z");
  });

  it("[CLOSED-REALIZED] ABORTED baskets do not count as closed results", () => {
    const aborted = { ...openBasket("xb-a", [leg("SOLUSDT", "LONG", 0.3, 80)]), status: "ABORTED" as const, closedAt: "2026-07-07T02:00:00.000Z", closeReason: "OPEN_FAILED:x" };
    const executor = makeExecutorWithBaskets([aborted]);
    const annotated = annotateCrossSectionalAccount(snapshot([]), executor);
    expect(annotated.closedLanes.find((l: { laneId: string }) => l.laneId === "CROSS_SECTIONAL_MARKET_NEUTRAL")).toBeUndefined();
  });

  // 2026-07-08: generalized to executor.getStatus().laneId so the SAME function serves the two
  // new TREND/MIXED executor instances (app.ts), each tagged with their OWN lane id instead of
  // every instance being hardcoded to CROSS_SECTIONAL_MARKET_NEUTRAL.
  it("[MULTI-INSTANCE] tags positions + closedLanes with the executor's OWN laneId, not the market-neutral default", () => {
    const openTrend = openBasket("xb-trend", [leg("BTCUSDT", "LONG", 0.01, 60000)]);
    const closedTrend = { ...openBasket("xb-trend-c", [leg("ETHUSDT", "LONG", 0.1, 2000)]), status: "CLOSED" as const, closedAt: "2026-07-08T00:00:00.000Z", closeReason: "PROFIT_BANK", netPnlUsd: 0.8, feeEstimateUsd: 0.02, grossPnlUsd: 0.82 };
    const executor = makeExecutorWithBaskets([openTrend, closedTrend], "CROSS_SECTIONAL_TREND");
    const annotated = annotateCrossSectionalAccount(snapshot([position("BTCUSDT", "LONG", 0.01, 5)]), executor);
    expect(annotated.positions[0]!.laneIds).toEqual(["CROSS_SECTIONAL_TREND"]);
    expect(annotated.lanes.find((l: { laneId: string }) => l.laneId === "CROSS_SECTIONAL_TREND")).toBeTruthy();
    expect(annotated.lanes.find((l: { laneId: string }) => l.laneId === "CROSS_SECTIONAL_MARKET_NEUTRAL")).toBeUndefined();
    expect(annotated.closedLanes.find((l: { laneId: string }) => l.laneId === "CROSS_SECTIONAL_TREND")).toBeTruthy();
  });
});

// [TIMELINE] 2026-07-07 operator: "wire cross sectional ke lane performance timeline juga" —
// the timeline is built from engine intents only, so basket P&L (the foundation strategy) was
// invisible on the chart while it moved the real wallet.
describe("mergeCrossSectionalIntoLaneSeries — baskets appear on the lane-performance timeline", () => {
  function seriesReport(bucketStarts: string[], lanes: never[] = []) {
    const startsMs = bucketStarts.map((s) => new Date(s).getTime());
    return {
      view: "hourly",
      period: "day",
      viewLabel: "Hourly",
      periodLabel: "Today",
      bucketLabel: "hour",
      bucketMs: 3_600_000,
      since: bucketStarts[0]!,
      until: new Date(startsMs[startsMs.length - 1]! + 3_600_000).toISOString(),
      anchor: bucketStarts[0]!.slice(0, 10),
      regimeFilter: "all",
      regimeOptions: [],
      bucketStarts,
      lanes,
    } as never;
  }
  const closedBasket = (id: string, closedAt: string, netPnlUsd: number, symbol = "SOLUSDT") => ({
    ...openBasket(id, [leg(symbol, "LONG", 0.3, 80)]),
    status: "CLOSED" as const,
    closedAt,
    closeReason: "PROFIT_BANK",
    netPnlUsd,
    feeEstimateUsd: 0.05,
    grossPnlUsd: netPnlUsd + 0.05,
  });

  it("buckets closed baskets into the right hour and builds cumulative points", () => {
    const buckets = ["2026-07-07T10:00:00.000Z", "2026-07-07T11:00:00.000Z", "2026-07-07T12:00:00.000Z"];
    const executor = makeExecutorWithBaskets([
      closedBasket("xb-1", "2026-07-07T10:20:00.000Z", 1.5),
      closedBasket("xb-2", "2026-07-07T12:59:00.000Z", -0.4, "ADAUSDT"),
      closedBasket("xb-old", "2026-07-06T10:00:00.000Z", 99), // outside the window — excluded
    ]);
    const merged = mergeCrossSectionalIntoLaneSeries(seriesReport(buckets), executor) as {
      lanes: Array<{ laneId: string; realizedPnlUsd: number; closedCount: number; wins: number; losses: number; symbols: string[]; points: Array<{ bucketStart: string; realizedPnlUsd: number; cumulativePnlUsd: number }> }>;
    };
    const lane = merged.lanes.find((l) => l.laneId === "CROSS_SECTIONAL_MARKET_NEUTRAL")!;
    expect(lane).toBeTruthy();
    expect(lane.realizedPnlUsd).toBeCloseTo(1.1, 9);
    expect(lane.closedCount).toBe(2);
    expect(lane.wins).toBe(1);
    expect(lane.losses).toBe(1);
    expect(lane.symbols).toEqual(["ADAUSDT", "SOLUSDT"]);
    expect(lane.points.map((p) => p.realizedPnlUsd)).toEqual([1.5, 0, -0.4]);
    expect(lane.points.map((p) => p.cumulativePnlUsd)).toEqual([1.5, 1.5, 1.1]);
  });

  it("does NOT pollute a regime-filtered view (baskets carry no regime tag)", () => {
    const executor = makeExecutorWithBaskets([closedBasket("xb-1", "2026-07-07T10:20:00.000Z", 1.5)]);
    const report = { ...(seriesReport(["2026-07-07T10:00:00.000Z"]) as object), regimeFilter: "trending" } as never;
    const merged = mergeCrossSectionalIntoLaneSeries(report, executor) as { lanes: Array<{ laneId: string }> };
    expect(merged.lanes.find((l) => l.laneId === "CROSS_SECTIONAL_MARKET_NEUTRAL")).toBeUndefined();
  });

  it("is a no-op with no closed baskets in the window / no executor", () => {
    const executor = makeExecutorWithBaskets([]);
    const report = seriesReport(["2026-07-07T10:00:00.000Z"]);
    expect((mergeCrossSectionalIntoLaneSeries(report, executor) as { lanes: unknown[] }).lanes).toEqual([]);
    expect((mergeCrossSectionalIntoLaneSeries(report, null) as { lanes: unknown[] }).lanes).toEqual([]);
  });

  // 2026-07-08: same laneId generalization as annotateCrossSectionalAccount above — the MIXED
  // instance's closed baskets must land under its OWN lane id on the timeline.
  it("[MULTI-INSTANCE] merges under the executor's OWN laneId, not the market-neutral default", () => {
    const executor = makeExecutorWithBaskets([closedBasket("xb-mixed", "2026-07-07T10:20:00.000Z", 0.6)], "CROSS_SECTIONAL_MIXED");
    const merged = mergeCrossSectionalIntoLaneSeries(seriesReport(["2026-07-07T10:00:00.000Z"]), executor) as {
      lanes: Array<{ laneId: string; realizedPnlUsd: number }>;
    };
    expect(merged.lanes.find((l) => l.laneId === "CROSS_SECTIONAL_MIXED")?.realizedPnlUsd).toBeCloseTo(0.6, 9);
    expect(merged.lanes.find((l) => l.laneId === "CROSS_SECTIONAL_MARKET_NEUTRAL")).toBeUndefined();
  });
});

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import os from "node:os";

import { annotateSingleSymbolAccount, mergeSingleSymbolIntoLaneSeries, flattenSingleSymbolPositions, buildLaneEvaluationRows } from "../src/routes/live.js";
import {
  SingleSymbolLaneExecutor,
  SingleSymbolLaneExecutorStore,
  makeFixedRewardExitPolicy,
  type SingleSymbolPosition,
} from "../src/lib/single-symbol-lane-executor.js";

const NOW = "2026-07-08T03:00:00.000Z";

let n = 0;
function tmpDir(): string {
  return resolve(os.tmpdir(), `ssle-account-annotation-${process.pid}-${++n}`);
}

function positionOf(over: Partial<SingleSymbolPosition> = {}): SingleSymbolPosition {
  return {
    positionId: "ssl-shor-1",
    sourceObservationId: "sf:BTCUSDT:1",
    symbol: "BTCUSDT",
    direction: "SHORT",
    qty: 0.01,
    entryPrice: 60000,
    entryOrderId: 1,
    entryPriceConfirmed: true,
    stopPrice: 61800,
    stopAlgoOrderId: 900,
    stopFailureCount: 0,
    stopUnprotectedSinceIso: null,
    closeFailureCount: 0,
    closeFailureSinceIso: null,
    peakFavorableR: 0,
    openedAt: NOW,
    status: "OPEN",
    closedAt: null,
    closeReason: null,
    exitPrice: null,
    exitOrderId: null,
    exitPriceConfirmed: null,
    grossPnlUsd: null,
    feeEstimateUsd: null,
    netPnlUsd: null,
    ...over,
  };
}

function makeExecutorWithPositions(positions: SingleSymbolPosition[], laneId = "SHORT_FADE_EXHAUSTION_CROWDED"): SingleSymbolLaneExecutor {
  const store = new SingleSymbolLaneExecutorStore(tmpDir(), "test.json");
  store.getState().positions = positions;
  return new SingleSymbolLaneExecutor({
    client: {} as never,
    store,
    laneId,
    direction: "SHORT",
    getOpenSignals: () => [],
    exitPolicy: makeFixedRewardExitPolicy({ rewardMultiple: 0.5, maxHoldMs: 48 * 3_600_000 }),
    isAllowed: () => true,
    legUsd: () => 25,
    leverage: () => 3,
  });
}

function position(symbol: string, direction: "LONG" | "SHORT", quantity: number, unrealizedPnl: number) {
  return {
    symbol, direction, quantity, entryPrice: 1, markPrice: 1, targetTpPrice: null, targetTpGapPct: null,
    liquidationPrice: null, unrealizedPnl, estimatedCloseCostUsd: 0, unrealizedAfterEstimatedCloseCostUsd: unrealizedPnl,
    leverage: 3, sourceOrderCount: 0, laneIds: [] as string[],
  };
}

function snapshot(positions: ReturnType<typeof position>[]) {
  return {
    positions,
    lanes: [] as Array<{ laneId: string; sourceOrderCount: number; symbols: string[]; notionalUsd: number; unrealizedPnl: number }>,
    closedLanes: [] as unknown[],
  } as never;
}

describe("annotateSingleSymbolAccount", () => {
  it("tags a matching exchange position with the executor's laneId and fills basketQty/basketUnrealizedPnl", () => {
    const executor = makeExecutorWithPositions([positionOf()]);
    const p = { ...position("BTCUSDT", "SHORT", 0.01, 2), markPrice: 59000 };
    const annotated = annotateSingleSymbolAccount(snapshot([p]), executor);
    const row = annotated.positions[0]! as { laneIds: string[]; basketQty?: number; basketUnrealizedPnl?: number; singleSymbolStopPrice?: number | null };
    expect(row.laneIds).toEqual(["SHORT_FADE_EXHAUSTION_CROWDED"]);
    // SHORT: (entry 60000 - mark 59000) * qty 0.01 = 10
    expect(row.basketUnrealizedPnl).toBeCloseTo(10, 6);
    expect(row.basketQty).toBeCloseTo(-0.01, 6); // SHORT dir = -1
    // 2026-07-09: real exchange-side stop, distinct from a basket horizon or engine TP1 — the
    // dashboard fix for the single-symbol/basket-leg conflation reads this field directly.
    expect(row.singleSymbolStopPrice).toBe(61800);
  });

  it("leaves a foreign position (different symbol) unattributed", () => {
    const executor = makeExecutorWithPositions([positionOf()]);
    const p = position("ETHUSDT", "LONG", 1, 5);
    const annotated = annotateSingleSymbolAccount(snapshot([p]), executor);
    expect((annotated.positions[0]! as { laneIds: string[] }).laneIds).toEqual([]);
  });

  it("is a no-op with no open positions and no closed positions", () => {
    const executor = makeExecutorWithPositions([]);
    const annotated = annotateSingleSymbolAccount(snapshot([position("BTCUSDT", "SHORT", 0.01, 0)]), executor);
    expect((annotated.positions[0]! as { laneIds: string[] }).laneIds).toEqual([]);
    expect(annotated.lanes).toEqual([]);
  });

  it("is a no-op with a null executor", () => {
    const snap = snapshot([position("BTCUSDT", "SHORT", 0.01, 0)]);
    expect(annotateSingleSymbolAccount(snap, null)).toBe(snap);
  });

  it("merges CLOSED positions into closedLanes, tagged with the executor's laneId", () => {
    const closed = positionOf({
      positionId: "ssl-shor-2", status: "CLOSED", closedAt: "2026-07-08T04:00:00.000Z",
      closeReason: "TP_HIT", grossPnlUsd: 3, feeEstimateUsd: 0.1, netPnlUsd: 2.9,
    });
    const executor = makeExecutorWithPositions([closed]);
    const annotated = annotateSingleSymbolAccount(snapshot([]), executor);
    const row = annotated.closedLanes.find((l: { laneId: string }) => l.laneId === "SHORT_FADE_EXHAUSTION_CROWDED") as {
      closedCount: number; wins: number; losses: number; realizedPnlUsd: number; feesUsd: number;
    };
    expect(row).toBeTruthy();
    expect(row.closedCount).toBe(1);
    expect(row.wins).toBe(1);
    expect(row.losses).toBe(0);
    expect(row.realizedPnlUsd).toBeCloseTo(2.9, 6);
    expect(row.feesUsd).toBeCloseTo(0.1, 6);
  });

  it("[MULTI-INSTANCE] tags with the INTRADAY_MOMENTUM_BREAKOUT_LONG laneId when that executor is passed", () => {
    const executor = makeExecutorWithPositions(
      [positionOf({ symbol: "ETHUSDT", direction: "LONG" })],
      "INTRADAY_MOMENTUM_BREAKOUT_LONG",
    );
    const annotated = annotateSingleSymbolAccount(snapshot([position("ETHUSDT", "LONG", 0.01, 1)]), executor);
    expect((annotated.positions[0]! as { laneIds: string[] }).laneIds).toEqual(["INTRADAY_MOMENTUM_BREAKOUT_LONG"]);
  });
});

describe("mergeSingleSymbolIntoLaneSeries", () => {
  function seriesReport(bucketStarts: string[]) {
    const startsMs = bucketStarts.map((s) => new Date(s).getTime());
    return {
      view: "hourly", period: "day", viewLabel: "Hourly", periodLabel: "Today", bucketLabel: "hour", bucketMs: 3_600_000,
      since: bucketStarts[0]!, until: new Date(startsMs[startsMs.length - 1]! + 3_600_000).toISOString(),
      anchor: bucketStarts[0]!.slice(0, 10), regimeFilter: "all", regimeOptions: [], bucketStarts, lanes: [],
    } as never;
  }

  it("buckets a closed position into the right hour with cumulative points", () => {
    const closed = positionOf({ status: "CLOSED", closedAt: "2026-07-08T10:20:00.000Z", netPnlUsd: 1.2, feeEstimateUsd: 0.05 });
    const executor = makeExecutorWithPositions([closed]);
    const buckets = ["2026-07-08T10:00:00.000Z", "2026-07-08T11:00:00.000Z"];
    const merged = mergeSingleSymbolIntoLaneSeries(seriesReport(buckets), executor) as {
      lanes: Array<{ laneId: string; realizedPnlUsd: number; closedCount: number; wins: number; points: Array<{ realizedPnlUsd: number; cumulativePnlUsd: number }> }>;
    };
    const lane = merged.lanes.find((l) => l.laneId === "SHORT_FADE_EXHAUSTION_CROWDED")!;
    expect(lane).toBeTruthy();
    expect(lane.realizedPnlUsd).toBeCloseTo(1.2, 9);
    expect(lane.closedCount).toBe(1);
    expect(lane.wins).toBe(1);
    expect(lane.points.map((p) => p.realizedPnlUsd)).toEqual([1.2, 0]);
    expect(lane.points.map((p) => p.cumulativePnlUsd)).toEqual([1.2, 1.2]);
  });

  it("does not pollute a regime-filtered view", () => {
    const closed = positionOf({ status: "CLOSED", closedAt: "2026-07-08T10:20:00.000Z", netPnlUsd: 1.2 });
    const executor = makeExecutorWithPositions([closed]);
    const report = { ...(seriesReport(["2026-07-08T10:00:00.000Z"]) as object), regimeFilter: "trending" } as never;
    const merged = mergeSingleSymbolIntoLaneSeries(report, executor) as { lanes: Array<{ laneId: string }> };
    expect(merged.lanes.find((l) => l.laneId === "SHORT_FADE_EXHAUSTION_CROWDED")).toBeUndefined();
  });

  it("is a no-op with no closed positions in the window / null executor", () => {
    const executor = makeExecutorWithPositions([]);
    const report = seriesReport(["2026-07-08T10:00:00.000Z"]);
    expect((mergeSingleSymbolIntoLaneSeries(report, executor) as { lanes: unknown[] }).lanes).toEqual([]);
    expect((mergeSingleSymbolIntoLaneSeries(report, null) as { lanes: unknown[] }).lanes).toEqual([]);
  });

  it("excludes a closed position outside the reporting window", () => {
    const old = positionOf({ status: "CLOSED", closedAt: "2026-07-01T00:00:00.000Z", netPnlUsd: 99 });
    const executor = makeExecutorWithPositions([old]);
    const merged = mergeSingleSymbolIntoLaneSeries(seriesReport(["2026-07-08T10:00:00.000Z"]), executor) as { lanes: unknown[] };
    expect(merged.lanes).toEqual([]);
  });
});

describe("flattenSingleSymbolPositions (2026-07-10: per-lane close-now button)", () => {
  it("returns one row per open position, tagged with the owning executor's laneId", () => {
    const a = makeExecutorWithPositions([positionOf({ positionId: "a1", symbol: "BTCUSDT" })], "SHORT_FADE_EXHAUSTION_CROWDED");
    const b = makeExecutorWithPositions(
      [positionOf({ positionId: "b1", symbol: "BTCUSDT", direction: "LONG", entryPrice: 63000, stopPrice: 62000 })],
      "REGIME_COMPOSITE_CONFIRMATION_LONG",
    );
    const rows = flattenSingleSymbolPositions([a, b], new Map([["BTCUSDT", 63500]]));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.laneId).sort()).toEqual(["REGIME_COMPOSITE_CONFIRMATION_LONG", "SHORT_FADE_EXHAUSTION_CROWDED"]);
    expect(rows.find((r) => r.positionId === "a1")!.laneId).toBe("SHORT_FADE_EXHAUSTION_CROWDED");
    expect(rows.find((r) => r.positionId === "b1")!.laneId).toBe("REGIME_COMPOSITE_CONFIRMATION_LONG");
  });

  it("does NOT sum two lanes on the same symbol into one row — each keeps its own qty/entry/unrealized", () => {
    // Same symbol, two different lanes, two different entries/qty — must stay as two independent
    // rows so each can be inspected/closed on its own (this is the whole point of the feature: the
    // operator noticed one lane's leg on a symbol can be proven+protected while another lane's leg
    // on the SAME symbol is unproven+unprotected, and wanted to tell them apart).
    const wide = makeExecutorWithPositions(
      [positionOf({ positionId: "wide1", symbol: "SOLUSDT", direction: "LONG", qty: 1.91, entryPrice: 78.13, stopPrice: 75.95 })],
      "COMPOSITE_ESTIMATOR_BIDI_WIDE_LONG",
    );
    const regime = makeExecutorWithPositions(
      [positionOf({ positionId: "regime1", symbol: "SOLUSDT", direction: "LONG", qty: 0.76, entryPrice: 78.3, stopPrice: 77.08 })],
      "REGIME_COMPOSITE_CONFIRMATION_LONG",
    );
    const rows = flattenSingleSymbolPositions([wide, regime], new Map([["SOLUSDT", 79]]));
    expect(rows).toHaveLength(2);
    const wideRow = rows.find((r) => r.positionId === "wide1")!;
    const regimeRow = rows.find((r) => r.positionId === "regime1")!;
    expect(wideRow.qty).toBe(1.91);
    expect(wideRow.unrealizedPnl).toBeCloseTo((79 - 78.13) * 1.91, 6);
    expect(regimeRow.qty).toBe(0.76);
    expect(regimeRow.unrealizedPnl).toBeCloseTo((79 - 78.3) * 0.76, 6);
  });

  it("computes SHORT unrealizedPnl direction-aware", () => {
    const executor = makeExecutorWithPositions([positionOf({ direction: "SHORT", qty: 0.01, entryPrice: 60000, stopPrice: 61800 })]);
    const rows = flattenSingleSymbolPositions([executor], new Map([["BTCUSDT", 59000]]));
    expect(rows[0]!.unrealizedPnl).toBeCloseTo((60000 - 59000) * 0.01, 6);
  });

  it("returns markPrice/unrealizedPnl null when no mark is available for the symbol", () => {
    const executor = makeExecutorWithPositions([positionOf()]);
    const rows = flattenSingleSymbolPositions([executor], new Map());
    expect(rows[0]!.markPrice).toBeNull();
    expect(rows[0]!.unrealizedPnl).toBeNull();
  });

  it("returns an empty list with no executors and with executors that have no open positions", () => {
    expect(flattenSingleSymbolPositions([], new Map())).toEqual([]);
    const empty = makeExecutorWithPositions([]);
    expect(flattenSingleSymbolPositions([empty], new Map())).toEqual([]);
  });
});

describe("buildLaneEvaluationRows (2026-07-10: testnet 9-lane evaluation section)", () => {
  it("merges a SingleSymbolLaneExecutor lane's real status with its measured stats", () => {
    const exec = makeExecutorWithPositions(
      [positionOf({ status: "CLOSED", netPnlUsd: 3, closedAt: NOW })],
      "SHORT_FADE_EXHAUSTION_CROWDED",
    );
    const status = exec.getStatus();
    const measured = new Map([
      ["SHORT_FADE_EXHAUSTION_CROWDED", { resolvedCount: 12, openCount: 2, netAvgR: 0.15, wr: 0.5, pf: 1.4, edgeReady: false }],
    ]);
    const rows = buildLaneEvaluationRows([status], measured, null, () => 100);
    const row = rows.find((r) => r.laneId === "SHORT_FADE_EXHAUSTION_CROWDED")!;
    expect(row.realClosedCount).toBe(status.closedCount);
    expect(row.realNetPnlUsd).toBe(status.totalNetPnlUsd);
    expect(row.allocationWeightPct).toBe(status.allocationWeightPct);
    expect(row.allowed).toBe(status.allowed);
    expect(row.measuredResolvedCount).toBe(12);
    expect(row.measuredNetAvgR).toBe(0.15);
    expect(row.measuredEdgeReady).toBe(false);
  });

  it("PROFIT_CORE_SHORT_TRAIL (no executor, no measured report) falls back to closedLanes + the weight callback, with null measured fields — not fabricated 0s", () => {
    const rows = buildLaneEvaluationRows(
      [],
      new Map(),
      { closedCount: 7, realizedPnlUsd: 12.5 },
      (laneId) => (laneId === "PROFIT_CORE_SHORT_TRAIL" ? 11 : 0),
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.laneId).toBe("PROFIT_CORE_SHORT_TRAIL");
    expect(row.realClosedCount).toBe(7);
    expect(row.realNetPnlUsd).toBe(12.5);
    expect(row.allocationWeightPct).toBe(11);
    expect(row.allowed).toBeNull();
    expect(row.measuredResolvedCount).toBeNull();
    expect(row.measuredNetAvgR).toBeNull();
    expect(row.measuredEdgeReady).toBeNull();
  });

  it("a lane with an executor but no measured report yet shows real stats with null measured fields", () => {
    const exec = makeExecutorWithPositions([], "REGIME_COMPOSITE_CONFIRMATION_LONG");
    const rows = buildLaneEvaluationRows([exec.getStatus()], new Map(), null, () => 0);
    const row = rows.find((r) => r.laneId === "REGIME_COMPOSITE_CONFIRMATION_LONG")!;
    expect(row.realClosedCount).toBe(0);
    expect(row.realOpenCount).toBe(0);
    expect(row.measuredResolvedCount).toBeNull();
    expect(row.measuredWr).toBeNull();
  });

  it("PROFIT_CORE_SHORT_TRAIL with no closedLanes entry defaults real stats to 0, not null", () => {
    const rows = buildLaneEvaluationRows([], new Map(), null, () => 5);
    const row = rows[0]!;
    expect(row.realClosedCount).toBe(0);
    expect(row.realNetPnlUsd).toBe(0);
    expect(row.allocationWeightPct).toBe(5);
  });

  it("always includes PROFIT_CORE_SHORT_TRAIL first, followed by every executor's laneId in order", () => {
    const a = makeExecutorWithPositions([], "SHORT_FADE_EXHAUSTION_CROWDED");
    const b = makeExecutorWithPositions([], "PANIC_WASHOUT_RECLAIM_LONG");
    const rows = buildLaneEvaluationRows([a.getStatus(), b.getStatus()], new Map(), null, () => 0);
    expect(rows.map((r) => r.laneId)).toEqual([
      "PROFIT_CORE_SHORT_TRAIL",
      "SHORT_FADE_EXHAUSTION_CROWDED",
      "PANIC_WASHOUT_RECLAIM_LONG",
    ]);
  });
});

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import os from "node:os";

import { annotateSingleSymbolAccount, mergeSingleSymbolIntoLaneSeries } from "../src/routes/live.js";
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
    const row = annotated.positions[0]! as { laneIds: string[]; basketQty?: number; basketUnrealizedPnl?: number };
    expect(row.laneIds).toEqual(["SHORT_FADE_EXHAUSTION_CROWDED"]);
    // SHORT: (entry 60000 - mark 59000) * qty 0.01 = 10
    expect(row.basketUnrealizedPnl).toBeCloseTo(10, 6);
    expect(row.basketQty).toBeCloseTo(-0.01, 6); // SHORT dir = -1
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

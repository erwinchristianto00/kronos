import { describe, it, expect } from "vitest";

import {
  buildFrozenPromotionTrackerReport,
} from "../src/lib/frozen-current-guard-promotion-tracker.js";
import type {
  FrozenCurrentGuardReport,
  FrozenCurrentGuardObservation,
  FrozenTapeVelocity,
  OosSegmentWatch,
} from "../src/lib/base-route-current-guard-frozen.js";
import type { SegmentStats, CostSensitivityRow } from "../src/lib/base-route-current-guard-stability-audit.js";

const FROZEN_LANE = "BASE_ROUTE_STOP175_CURRENT_GUARD_FROZEN_V1" as const;

function seg(label: string, n: number, netAvgR: number): SegmentStats {
  return { label, n, netAvgR, grossAvgR: netAvgR + 0.05, pf: netAvgR > 0 ? 2.0 : 0.5, wr: netAvgR > 0 ? 0.7 : 0.3 };
}

function obs(i: number, netR: number): FrozenCurrentGuardObservation {
  const grossR = netR + 0.1;
  return {
    reportOnly: true,
    laneVersion: FROZEN_LANE,
    observationKey: `SYM${i}|LONG|2026-01-${String((i % 27) + 1).padStart(2, "0")}T00:00:00.000Z`,
    symbol: `SYM${i % 5}`,
    direction: "LONG",
    openedAt: `2026-01-01T00:00:00.000Z`,
    closedAt: `2026-01-0${(i % 9) + 1}T00:00:00.000Z`,
    status: grossR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS",
    grossR,
    netR,
    costR: 0.1,
    regime: "Bullish expansion",
    entryVariant: "fib_500_entry",
    exitVariant: "fib_tp1_exit",
    policyVersion: "base-route-anchor-consistent-v2",
    mirroredAt: "2026-01-10T00:00:00.000Z",
  };
}

function makeOosWatch(netSegs: [number, number, number]): OosSegmentWatch {
  const segments = netSegs.map((v, i) => seg(`segment_${i + 1}`, 16, v));
  const positiveSegmentCount = netSegs.filter((v) => v > 0).length;
  const allSegmentsPositive = positiveSegmentCount === 3;
  const weakest = netSegs.indexOf(Math.min(...netSegs));
  return {
    segment1: segments[0]!,
    segment2: segments[1]!,
    segment3: segments[2]!,
    weakestSegment: { label: `segment_${weakest + 1}`, netAvgR: netSegs[weakest]! },
    positiveSegmentCount,
    allSegmentsPositive,
    requiredFuturePositiveSegments: 3 - positiveSegmentCount,
    stabilityStatus: allSegmentsPositive ? "STABILITY_OK" : "STABILITY_BLOCKED",
    note: "test",
  };
}

function costSensitivity(plus10Positive: boolean): CostSensitivityRow[] {
  return [
    { scenario: "default", roundTripBps: 28, netAvgR: 0.12, pf: 3.0, stillPositive: true },
    { scenario: "plus_10bps_slippage", roundTripBps: 38, netAvgR: plus10Positive ? 0.03 : -0.02, pf: plus10Positive ? 1.3 : 0.8, stillPositive: plus10Positive },
  ];
}

function makeFrozenReport(over: Partial<FrozenCurrentGuardReport> = {}): FrozenCurrentGuardReport {
  const velocity: FrozenTapeVelocity = {
    resolvedPerDay: 12.5,
    freshValidPerDay: 12.5,
    etaToN100Days: 4,
    etaToN200Days: 12,
    etaToN100Date: "2026-06-01",
    etaToN200Date: "2026-06-09",
  };
  return {
    reportOnly: true,
    laneVersion: FROZEN_LANE,
    computedAt: "2026-05-28T00:00:00.000Z",
    criteriaFrozenAt: "2026-05-20T00:00:00.000Z",
    total: 50,
    open: 0,
    resolved: 50,
    freshValid: 50,
    netAvgR: 0.1089,
    pf: 3.1,
    wr: 0.8,
    daysCovered: 4,
    oosSegments: [seg("segment_1", 16, -0.32), seg("segment_2", 16, 0.12), seg("segment_3", 18, 0.48)],
    allThreeSegmentsPositive: false,
    costSensitivity: costSensitivity(true),
    topSymbolPnlShare: 0.25,
    velocity,
    oosWatch: makeOosWatch([-0.32, 0.12, 0.48]),
    status: "WATCHABLE",
    statusReason: "test",
    resolvedObservations: Array.from({ length: 50 }, (_, i) => obs(i, 0.1)),
    ...over,
  };
}

describe("F**** frozen current-guard promotion tracker", () => {
  it("1. passes through ETA to n=100 and n=200 from velocity", () => {
    const r = buildFrozenPromotionTrackerReport(makeFrozenReport(), undefined);
    expect(r.etaToN100Days).toBe(4);
    expect(r.etaToN200Days).toBe(12);
    expect(r.etaToN100Date).toBe("2026-06-01");
    expect(r.etaToN200Date).toBe("2026-06-09");
  });

  it("2. STABILITY_BLOCKED when net>0 but OOS thirds not all positive", () => {
    const r = buildFrozenPromotionTrackerReport(
      makeFrozenReport({ oosWatch: makeOosWatch([-0.32, 0.12, 0.48]) }),
      undefined,
    );
    expect(r.status).toBe("STABILITY_BLOCKED");
    expect(r.oosSegmentsAllPositive).toBe(false);
    expect(r.positiveSegmentCount).toBe(2);
  });

  it("3. STABLE_CANDIDATE only when freshValid>=100 + all OOS positive + net>0.05 + PF>1.2 + +10bps positive", () => {
    const r = buildFrozenPromotionTrackerReport(
      makeFrozenReport({
        freshValid: 120,
        netAvgR: 0.1,
        pf: 2.5,
        oosWatch: makeOosWatch([0.05, 0.12, 0.2]),
        allThreeSegmentsPositive: true,
        costSensitivity: costSensitivity(true),
      }),
      undefined,
    );
    expect(r.status).toBe("STABLE_CANDIDATE");
  });

  it("3b. NOT STABLE_CANDIDATE when freshValid<100 even with all OOS positive (→ WATCHABLE)", () => {
    const r = buildFrozenPromotionTrackerReport(
      makeFrozenReport({
        freshValid: 60,
        netAvgR: 0.1,
        pf: 2.5,
        oosWatch: makeOosWatch([0.05, 0.12, 0.2]),
        allThreeSegmentsPositive: true,
      }),
      undefined,
    );
    expect(r.status).toBe("WATCHABLE");
  });

  it("4. PROMOTION_CANDIDATE requires freshValid>=200 and all gates", () => {
    const r = buildFrozenPromotionTrackerReport(
      makeFrozenReport({
        freshValid: 220,
        netAvgR: 0.1,
        pf: 2.5,
        topSymbolPnlShare: 0.25,
        oosWatch: makeOosWatch([0.05, 0.12, 0.2]),
        allThreeSegmentsPositive: true,
        costSensitivity: costSensitivity(true),
        resolvedObservations: Array.from({ length: 220 }, (_, i) => obs(i, 0.1)),
      }),
      undefined,
    );
    expect(r.status).toBe("PROMOTION_CANDIDATE");
  });

  it("5. REJECT when netAvgR <= 0", () => {
    const r = buildFrozenPromotionTrackerReport(
      makeFrozenReport({ netAvgR: -0.05 }),
      undefined,
    );
    expect(r.status).toBe("REJECT");
  });

  it("6. killWarning set when rolling last_10 net is negative", () => {
    // Make the last 10 observations negative
    const observations = [
      ...Array.from({ length: 40 }, (_, i) => obs(i, 0.2)),
      ...Array.from({ length: 10 }, (_, i) => obs(40 + i, -0.5)),
    ];
    const r = buildFrozenPromotionTrackerReport(
      makeFrozenReport({ resolvedObservations: observations }),
      undefined,
    );
    expect(r.killWarning).not.toBeNull();
    expect(r.killWarning).toMatch(/Rolling net turned negative/);
  });

  it("7. WATCHABLE when n>=50, net>0, PF>1.2, OOS all positive but n<100", () => {
    const r = buildFrozenPromotionTrackerReport(
      makeFrozenReport({
        freshValid: 55,
        netAvgR: 0.08,
        pf: 1.5,
        oosWatch: makeOosWatch([0.02, 0.05, 0.1]),
        allThreeSegmentsPositive: true,
      }),
      undefined,
    );
    expect(r.status).toBe("WATCHABLE");
  });

  it("rolling windows are computed (last_10/20/50)", () => {
    const r = buildFrozenPromotionTrackerReport(makeFrozenReport(), undefined);
    expect(r.rolling.map((w) => w.window)).toEqual(["last_10", "last_20", "last_50"]);
  });
});

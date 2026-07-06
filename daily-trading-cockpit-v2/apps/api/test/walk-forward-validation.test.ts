import { describe, it, expect } from "vitest";
import {
  buildWalkForwardReport,
  computePBO,
  buildMultiStrategyReturnsMatrix,
  buildLaneVariantPboReport,
  type TimedReturn,
  type ReturnsMatrix,
} from "../src/lib/walk-forward-validation.js";

const DAY = 24 * 3_600_000;
const WEEK = 7 * DAY;

describe("rolling walk-forward report", () => {
  it("buckets time-ordered observations into consecutive weekly windows", () => {
    const t0 = 1_000_000_000_000;
    const obs: TimedReturn[] = [
      { atMs: t0, netR: 1 },
      { atMs: t0 + 1 * DAY, netR: -0.5 },
      { atMs: t0 + WEEK + 1 * DAY, netR: 2 }, // 2nd bucket
    ];
    const r = buildWalkForwardReport(obs, WEEK);
    expect(r.buckets.length).toBe(2);
    expect(r.buckets[0]!.n).toBe(2);
    expect(r.buckets[0]!.netAvgR).toBeCloseTo(0.25, 6);
    expect(r.buckets[1]!.n).toBe(1);
    expect(r.buckets[1]!.netAvgR).toBeCloseTo(2, 6);
  });

  it("emits empty buckets for gaps (visible, not silently skipped)", () => {
    const t0 = 1_000_000_000_000;
    const obs: TimedReturn[] = [
      { atMs: t0, netR: 1 },
      { atMs: t0 + 3 * WEEK, netR: 1 }, // 2 empty buckets between
    ];
    const r = buildWalkForwardReport(obs, WEEK);
    expect(r.buckets.length).toBe(4);
    expect(r.buckets[1]!.n).toBe(0);
    expect(r.buckets[2]!.n).toBe(0);
  });

  it("flags stability only with enough non-empty buckets, and computes positive-bucket share", () => {
    const t0 = 1_000_000_000_000;
    const obs: TimedReturn[] = Array.from({ length: 3 }, (_, i) => ({ atMs: t0 + i * WEEK, netR: 1 }));
    const thin = buildWalkForwardReport(obs, WEEK);
    expect(thin.hasEnoughBucketsForVerdict).toBe(false); // only 3 non-empty buckets

    const obs2: TimedReturn[] = [
      ...Array.from({ length: 3 }, (_, i) => ({ atMs: t0 + i * WEEK, netR: 1 })),
      ...Array.from({ length: 2 }, (_, i) => ({ atMs: t0 + (3 + i) * WEEK, netR: -1 })),
    ];
    const wide = buildWalkForwardReport(obs2, WEEK);
    expect(wide.hasEnoughBucketsForVerdict).toBe(true); // 5 non-empty buckets
    expect(wide.positiveBucketShare).toBeCloseTo(3 / 5, 6);
  });

  it("returns an empty report for no observations", () => {
    const r = buildWalkForwardReport([]);
    expect(r.buckets).toEqual([]);
    expect(r.hasEnoughBucketsForVerdict).toBe(false);
  });
});

describe("PBO via CSCV — input validation", () => {
  it("throws with fewer than 2 strategies", () => {
    expect(() => computePBO([[1, 2, 3, 4, 5, 6, 7, 8]])).toThrow(/at least 2 strategies/);
  });

  it("throws when strategies don't share the same time-bucket count", () => {
    expect(() => computePBO([[1, 2, 3], [1, 2]])).toThrow(/same time-bucket count/);
  });

  it("throws with fewer time buckets than subsets", () => {
    expect(() => computePBO([[1, 2, 3], [1, 2, 3]], 8)).toThrow(/at least 8 time buckets/);
  });

  it("throws with an odd subsets count", () => {
    const row = Array.from({ length: 8 }, () => 1);
    expect(() => computePBO([row, row], 7)).toThrow(/even number/);
  });
});

describe("PBO via CSCV — directional correctness", () => {
  it("assigns LOW PBO to a strategy with a genuinely consistent edge (real, not overfit)", () => {
    // Strategy 0 is uniformly the best in EVERY bucket -> always wins in-sample AND out-of-sample.
    const returns: ReturnsMatrix = [
      Array.from({ length: 8 }, () => 1), // consistently positive & best
      Array.from({ length: 8 }, () => 0),
      Array.from({ length: 8 }, () => -1),
    ];
    const r = computePBO(returns, 8);
    expect(r.pbo).toBeCloseTo(0, 6);
    expect(r.splitsEvaluated).toBeGreaterThan(0);
    // strategy 0 should be the in-sample winner on every split.
    expect(r.isWinCountByStrategy[0]).toBe(r.splitsEvaluated);
  });

  it("assigns a HIGHER PBO to strategies whose apparent edge is bucket-specific (the overfitting signature)", () => {
    // Each strategy "spikes" in exactly ONE bucket and is flat elsewhere — whichever strategy wins
    // in-sample (because its spike bucket landed in the training half) has no reason to keep winning
    // out-of-sample (its spike is a one-off, not a persistent edge).
    const spikeMatrix: ReturnsMatrix = Array.from({ length: 4 }, (_, s) =>
      Array.from({ length: 8 }, (_, t) => (t === s ? 10 : 0)),
    );
    const genuineMatrix: ReturnsMatrix = [
      Array.from({ length: 8 }, () => 1),
      Array.from({ length: 8 }, () => 0.5),
      Array.from({ length: 8 }, () => 0),
      Array.from({ length: 8 }, () => -1),
    ];
    const spikeResult = computePBO(spikeMatrix, 8);
    const genuineResult = computePBO(genuineMatrix, 8);
    expect(spikeResult.pbo).toBeGreaterThan(genuineResult.pbo);
  });

  it("evaluates C(8,4)=70 splits for subsets=8", () => {
    const row = Array.from({ length: 8 }, (_, i) => i);
    const r = computePBO([row, [...row].reverse()], 8);
    expect(r.splitsEvaluated).toBe(70);
  });
});

describe("buildMultiStrategyReturnsMatrix", () => {
  it("shares one global bucket set across strategies with different observation spans", () => {
    const t0 = 1_000_000_000_000;
    const { strategyIds, matrix, bucketCount } = buildMultiStrategyReturnsMatrix(
      {
        A: [{ atMs: t0, netR: 1 }, { atMs: t0 + WEEK, netR: 1 }],
        B: [{ atMs: t0 + 2 * WEEK, netR: -1 }],
      },
      WEEK,
    );
    expect(strategyIds).toEqual(["A", "B"]);
    expect(bucketCount).toBe(3); // spans bucket 0,1,2
    expect(matrix[0]).toHaveLength(3);
    expect(matrix[1]).toHaveLength(3);
    expect(matrix[0]![0]).toBeCloseTo(1, 6);
    expect(matrix[0]![2]).toBeCloseTo(0, 6); // A has no obs in bucket 2 -> flat 0
    expect(matrix[1]![2]).toBeCloseTo(-1, 6);
  });

  it("returns empty rows for no observations at all", () => {
    const r = buildMultiStrategyReturnsMatrix({ A: [], B: [] });
    expect(r.bucketCount).toBe(0);
    expect(r.matrix).toEqual([[], []]);
  });
});

describe("buildLaneVariantPboReport — real-data audit wiring", () => {
  const t0 = 1_000_000_000_000;

  it("reports insufficient-data (not a fabricated PBO) with fewer than 2 eligible variants", () => {
    const obs = Array.from({ length: 40 }, (_, i) => ({ variantId: "ONLY_ONE", atMs: t0 + i * DAY, netR: 0.1 }));
    const r = buildLaneVariantPboReport(obs);
    expect(r.pbo).toBeNull();
    expect(r.insufficientDataReason).toMatch(/>=2 variants/);
  });

  it("reports insufficient-data when the time span doesn't cover enough buckets", () => {
    // 2 eligible variants but all observations crammed into 1 day -> 1 weekly bucket, need 8.
    const obs = [
      ...Array.from({ length: 40 }, (_, i) => ({ variantId: "A", atMs: t0 + i * 1000, netR: 0.1 })),
      ...Array.from({ length: 40 }, (_, i) => ({ variantId: "B", atMs: t0 + i * 1000, netR: -0.1 })),
    ];
    const r = buildLaneVariantPboReport(obs);
    expect(r.pbo).toBeNull();
    expect(r.insufficientDataReason).toMatch(/time buckets/);
  });

  it("computes a real PBO + per-variant walk-forward once there is enough eligible, spread-out data", () => {
    const obs: Array<{ variantId: string; atMs: number; netR: number }> = [];
    for (let bucket = 0; bucket < 8; bucket++) {
      for (let i = 0; i < 5; i++) {
        obs.push({ variantId: "GOOD", atMs: t0 + bucket * WEEK + i * DAY, netR: 0.2 }); // consistently positive
        obs.push({ variantId: "BAD", atMs: t0 + bucket * WEEK + i * DAY, netR: -0.2 }); // consistently negative
      }
    }
    const r = buildLaneVariantPboReport(obs, { minObsPerVariant: 30 });
    expect(r.insufficientDataReason).toBeNull();
    expect(r.pbo).not.toBeNull();
    expect(r.pbo!.pbo).toBeCloseTo(0, 6); // GOOD always wins IS and OOS -> no overfitting
    expect(r.walkForwardByVariant.GOOD?.hasEnoughBucketsForVerdict).toBe(true);
    expect(r.walkForwardByVariant.GOOD?.positiveBucketShare).toBeCloseTo(1, 6);
  });

  it("ignores unresolved (null netR) observations and low-sample variants", () => {
    const obs = [
      ...Array.from({ length: 40 }, (_, i) => ({ variantId: "ENOUGH", atMs: t0 + i * DAY, netR: 0.1 })),
      ...Array.from({ length: 5 }, (_, i) => ({ variantId: "TOO_FEW", atMs: t0 + i * DAY, netR: 0.1 })),
      { variantId: "ENOUGH", atMs: t0, netR: null }, // still open / unresolved
    ];
    const r = buildLaneVariantPboReport(obs, { minObsPerVariant: 30 });
    expect(r.variantIds).toEqual(["ENOUGH"]);
    expect(r.variantN.TOO_FEW).toBe(5);
  });
});

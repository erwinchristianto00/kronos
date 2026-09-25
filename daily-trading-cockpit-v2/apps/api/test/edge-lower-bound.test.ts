import { describe, it, expect } from "vitest";
import { computeEffectiveN, conservativeLowerBoundR } from "../src/lib/edge-lower-bound.js";

describe("computeEffectiveN — distinct (symbol, time-block) clustering", () => {
  it("counts one block per distinct key, not one per item", () => {
    const items = [{ k: "A:1" }, { k: "A:1" }, { k: "A:1" }, { k: "A:2" }, { k: "B:1" }];
    expect(computeEffectiveN(items, (x) => x.k)).toBe(3);
  });

  it("many rows clustered in one block count as effectiveN=1, never inflated by raw count", () => {
    const items = Array.from({ length: 50 }, () => ({ k: "SAME" }));
    expect(computeEffectiveN(items, (x) => x.k)).toBe(1);
  });

  it("the SAME item count spread across enough distinct blocks clears a higher effectiveN", () => {
    const clustered = Array.from({ length: 20 }, () => ({ k: "SAME" }));
    const spread = Array.from({ length: 20 }, (_, i) => ({ k: `BLOCK_${i}` }));
    expect(computeEffectiveN(clustered, (x) => x.k)).toBe(1);
    expect(computeEffectiveN(spread, (x) => x.k)).toBe(20);
  });

  it("empty input ⇒ 0", () => {
    expect(computeEffectiveN([], (x: { k: string }) => x.k)).toBe(0);
  });
});

describe("conservativeLowerBoundR — one-sided lower confidence bound, never a point estimate", () => {
  it("returns null (never a fabricated bound) when effectiveN < 2", () => {
    expect(conservativeLowerBoundR([0.5, 0.6, 0.7], 1)).toBeNull();
    expect(conservativeLowerBoundR([0.5, 0.6, 0.7], 0)).toBeNull();
  });

  it("returns null on fewer than 2 raw values even if effectiveN is claimed higher", () => {
    expect(conservativeLowerBoundR([0.5], 5)).toBeNull();
    expect(conservativeLowerBoundR([], 5)).toBeNull();
  });

  it("is strictly below the raw mean whenever there is any variance", () => {
    const values = [0.1, 0.3, 0.2, 0.4, -0.1, 0.5, 0.2, 0.3];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const bound = conservativeLowerBoundR(values, values.length)!;
    expect(bound).toBeLessThan(mean);
  });

  it("a low-effectiveN stat with a positive point estimate can still read a NEGATIVE (unproven) bound", () => {
    // High variance, small effectiveN — the raw mean is positive but the bound must not be.
    const values = [2, -1.5, 1.8, -1.2];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean).toBeGreaterThan(0);
    const bound = conservativeLowerBoundR(values, 2); // effectiveN clustered down from raw n=4
    expect(bound).not.toBeNull();
    expect(bound as number).toBeLessThan(0);
  });

  it("the SAME point estimate with a larger effectiveN produces a TIGHTER (higher) bound", () => {
    const values = [0.1, 0.15, 0.05, 0.12, 0.08, 0.11];
    const tightBound = conservativeLowerBoundR(values, 6)!;
    const looseBound = conservativeLowerBoundR(values, 2)!;
    expect(tightBound).toBeGreaterThan(looseBound);
  });

  it("zero variance (all identical values) ⇒ bound equals the mean exactly", () => {
    const values = [0.25, 0.25, 0.25, 0.25];
    const bound = conservativeLowerBoundR(values, 4);
    expect(bound).toBeCloseTo(0.25, 10);
  });
});

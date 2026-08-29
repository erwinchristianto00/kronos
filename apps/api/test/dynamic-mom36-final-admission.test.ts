import { describe, expect, it } from "vitest";
import {
  evaluateDynamicMom36Formation,
  validateDynamicMom36FormationAdmissionParity,
} from "../src/lib/cross-sectional-edge.js";
import {
  DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1,
  type DynamicMom36RankedSymbol,
} from "../src/lib/dynamic-mom36-shock-strategy.js";

const HOUR = 3_600_000;
const CUT = Date.parse("2026-08-29T07:00:00.000Z");

function row(
  symbol: string,
  mom36: number,
  fastReturn = mom36,
  overrides: Partial<DynamicMom36RankedSymbol> = {},
): DynamicMom36RankedSymbol {
  return {
    symbol,
    mom36,
    price: 100,
    volatility: 0.01,
    fastReturn,
    extensionVol: 0,
    longEligible: true,
    shortEligible: true,
    shortBlocked: false,
    slowSourceTimestampMs: CUT,
    slowStartTimestampMs: CUT - 36 * HOUR,
    fastSourceTimestampMs: CUT,
    fastStartTimestampMs: CUT - 4 * HOUR,
    slowFastDataValid: true,
    ...overrides,
  };
}

function signedRows(positiveCount: number, negativeCount: number, magnitude = 0.20): DynamicMom36RankedSymbol[] {
  return [
    ...Array.from({ length: positiveCount }, (_, index) => row(
      `P${String(index + 1).padStart(2, "0")}`,
      magnitude - index / 1_000,
    )),
    ...Array.from({ length: negativeCount }, (_, index) => row(
      `N${String(index + 1).padStart(2, "0")}`,
      -magnitude + index / 1_000,
    )),
  ];
}

function evaluate(
  activeUniverse: DynamicMom36RankedSymbol[],
  overrides: Partial<Parameters<typeof evaluateDynamicMom36Formation>[0]> = {},
) {
  return evaluateDynamicMom36Formation({
    activeUniverse,
    now: new Date(CUT).toISOString(),
    openedAtMs: CUT,
    horizonMs: 36 * HOUR,
    featureTimestampMs: CUT,
    decisionInformationCutoffMs: CUT,
    maxPerCluster: 0,
    admissionScoreGapFloor: 0.058,
    admissionScoreBySymbol: Object.fromEntries(activeUniverse.map((candidate) => [candidate.symbol, candidate.mom36])),
    strategyVersion: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1,
    continuationRuntime: null,
    ...overrides,
  });
}

describe("Dynamic MOM36 V6.1 final-allocation-aware admission", () => {
  it("admits the observed-style bearish 0L6S plan without a synthetic 3L3S score gap", () => {
    const rows = signedRows(0, 21);
    const evaluated = evaluate(rows);

    expect(evaluated.basket).toMatchObject({ longK: 0, shortK: 6 });
    expect(evaluated.snapshot).toMatchObject({
      positiveCount: 0,
      negativeCount: 21,
      finalAllocation: { label: "0L6S", longCount: 0, shortCount: 6 },
      selectedLongs: [],
      selectedShorts: ["N01", "N02", "N03", "N04", "N05", "N06"],
      admission: {
        passed: true,
        reason: "ADMISSION_PASSED",
        scoreGap: null,
        scoreGapApplicable: false,
        scoreGapReason: "ONE_SIDED_FINAL_ALLOCATION",
        finalLongCount: 0,
        finalShortCount: 6,
      },
    });
    expect(validateDynamicMom36FormationAdmissionParity(evaluated.snapshot)).toMatchObject({ valid: true });
  });

  it("admits the mirror bullish 6L0S plan with score gap explicitly N/A", () => {
    const evaluated = evaluate(signedRows(21, 0));

    expect(evaluated.basket).toMatchObject({ longK: 6, shortK: 0 });
    expect(evaluated.snapshot?.admission).toMatchObject({
      passed: true,
      scoreGap: null,
      scoreGapApplicable: false,
      scoreGapReason: "ONE_SIDED_FINAL_ALLOCATION",
    });
  });

  it.each([
    [5, 1, "5L1S"],
    [4, 2, "4L2S"],
    [3, 3, "3L3S"],
    [2, 4, "2L4S"],
    [1, 5, "1L5S"],
  ])("uses exactly the selected %iL/%iS (%s) sides for two-sided admission", (longCount, shortCount, label) => {
    const evaluated = evaluate(signedRows(longCount, shortCount));
    const snapshot = evaluated.snapshot!;

    expect(evaluated.basket).not.toBeNull();
    expect(snapshot.finalAllocation).toMatchObject({ longCount, shortCount, label });
    expect(snapshot.selectedLongs).toHaveLength(longCount);
    expect(snapshot.selectedShorts).toHaveLength(shortCount);
    expect(snapshot.admission).toMatchObject({
      passed: true,
      reason: "ADMISSION_PASSED",
      scoreGapApplicable: true,
      scoreGapReason: "TWO_SIDED_FINAL_ALLOCATION",
      finalLongCount: longCount,
      finalShortCount: shortCount,
    });
  });

  it("preserves 3L3S score-gap semantics: absolute difference between selected-side means", () => {
    const evaluated = evaluate(signedRows(3, 3));
    const snapshot = evaluated.snapshot!;
    const score = (symbol: string): number => snapshot.activeUniverse.find((candidate) => candidate.symbol === symbol)!.mom36;
    const mean = (values: number[]): number => values.reduce((total, value) => total + value, 0) / values.length;
    const expected = Math.abs(
      mean(snapshot.selectedLongs.map(score)) - mean(snapshot.selectedShorts.map(score)),
    );

    expect(snapshot.admission.scoreGap).toBeCloseTo(expected, 12);
    expect(snapshot.admission.scoreGap).toBeGreaterThanOrEqual(snapshot.admission.scoreGapFloor);
  });

  it("preserves the existing per-side cluster cap instead of inventing a cross-side cap in admission", () => {
    const rows = [
      row("BTCUSDT", 0.30), row("SOLUSDT", 0.29), row("SUIUSDT", 0.28),
      row("ETHUSDT", -0.30), row("ADAUSDT", -0.29), row("AVAXUSDT", -0.28),
    ];
    const evaluated = evaluate(rows, { maxPerCluster: 2 });

    expect(evaluated.basket).toMatchObject({ longK: 3, shortK: 3 });
    expect(evaluated.snapshot?.admission).toMatchObject({ passed: true, reason: "ADMISSION_PASSED" });
  });

  it("rejects the exact 4L2S final plan when its actual selected-side score gap fails", () => {
    const evaluated = evaluate(signedRows(4, 2, 0.01));

    expect(evaluated.basket).toBeNull();
    expect(evaluated.snapshot).toMatchObject({
      finalAllocation: { label: "4L2S" },
      admission: {
        scoreGapApplicable: true,
        scoreGapReason: "TWO_SIDED_FINAL_ALLOCATION",
        passed: false,
        reason: "ADMISSION_SCORE_GAP_FAIL",
      },
      noEntryReason: "ADMISSION_SCORE_GAP_FAIL",
    });
  });

  it("does not fill a required one-sided slot with a non-aligned sixth short", () => {
    const rows = signedRows(0, 6);
    rows[5] = { ...rows[5]!, fastReturn: 0.01 };
    const evaluated = evaluate(rows);

    expect(evaluated.basket).toBeNull();
    expect(evaluated.snapshot).toMatchObject({
      finalAllocation: { label: "0L6S" },
      selectedShorts: ["N01", "N02", "N03", "N04", "N05"],
      admission: { passed: false, reason: "ADMISSION_FINAL_ALLOCATION_INFEASIBLE" },
    });
  });

  it("keeps a blocked short in breadth but never lets it occupy the final 0L6S plan", () => {
    const rows = signedRows(0, 7);
    rows[0] = {
      ...rows[0]!,
      shortEligible: false,
      shortBlocked: true,
      shortExecutionBlockReason: "SHORT_BLOCKED",
    };
    const evaluated = evaluate(rows);

    expect(evaluated.basket).not.toBeNull();
    expect(evaluated.snapshot?.negativeCount).toBe(7);
    expect(evaluated.snapshot?.selectedShorts).not.toContain("N01");
    expect(evaluated.snapshot?.blockedShortsSkipped).toContain("N01");
  });

  it("does not auto-pass one-sided formation when the current cluster guard prevents six legs", () => {
    const evaluated = evaluate(signedRows(0, 7), { maxPerCluster: 2 });

    expect(evaluated.basket).toBeNull();
    expect(evaluated.snapshot).toMatchObject({
      finalAllocation: { label: "0L6S" },
      admission: { passed: false, reason: "ADMISSION_CLUSTER_GUARD" },
      noEntryReason: "ADMISSION_CLUSTER_GUARD",
    });
  });

  it("keeps V6 directional feasibility: a strict-infeasible 4L2S may resolve to 6L0S, then admits that exact plan", () => {
    const rows = [
      ...signedRows(6, 0),
      row("N01", -0.10, 0.01),
      row("N02", -0.09, 0.01),
    ];
    const evaluated = evaluate(rows);

    expect(evaluated.basket).toMatchObject({ longK: 6, shortK: 0 });
    expect(evaluated.snapshot).toMatchObject({
      requestedAllocation: { label: "4L2S" },
      finalAllocation: { label: "6L0S" },
      directionalFeasibility: { outcome: "FALLBACK_APPLIED" },
      admission: { scoreGapApplicable: false, scoreGapReason: "ONE_SIDED_FINAL_ALLOCATION", passed: true },
    });
  });

  it("has deterministic formation/admission identity under equivalent input permutations and fails closed on mutation", () => {
    const rows = signedRows(0, 9);
    const first = evaluate(rows);
    const second = evaluate([...rows].reverse());

    expect(second.snapshot?.selectedShorts).toEqual(first.snapshot?.selectedShorts);
    expect(second.snapshot?.formationId).toBe(first.snapshot?.formationId);
    const corrupted = structuredClone(first.snapshot!);
    corrupted.admission.formationId = "different-plan";
    expect(validateDynamicMom36FormationAdmissionParity(corrupted)).toMatchObject({
      valid: false,
      reason: "FORMATION_ADMISSION_PLAN_MISMATCH",
    });
  });

  it("fails closed when the formation data timestamp is after its decision cutoff", () => {
    const evaluated = evaluate(signedRows(0, 6), { featureTimestampMs: CUT + 1 });
    expect(evaluated).toMatchObject({
      formation: null,
      snapshot: null,
      basket: null,
      noEntryReason: "DYNAMIC_MOM36_FEATURE_TIMESTAMP_AFTER_DECISION_CUTOFF",
    });
  });
});

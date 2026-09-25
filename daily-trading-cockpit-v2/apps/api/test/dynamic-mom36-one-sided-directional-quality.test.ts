import { describe, expect, it } from "vitest";
import {
  evaluateDynamicMom36Formation,
  validateDynamicMom36FormationAdmissionParity,
} from "../src/lib/cross-sectional-edge.js";
import {
  DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1,
  DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_ONE_SIDED_DIRECTIONAL_QUALITY_SL2_MFE30_36H_V6_2,
  DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_ZERO_NEUTRAL_BREADTH_ONE_SIDED_DIRECTIONAL_QUALITY_SL2_MFE30_36H_V6_3,
  type DynamicMom36RankedSymbol,
} from "../src/lib/dynamic-mom36-shock-strategy.js";

const HOUR = 3_600_000;
const CUT = Date.parse("2026-08-30T07:00:00.000Z");

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

function signedRows(positive: number, negative: number): DynamicMom36RankedSymbol[] {
  return [
    ...Array.from({ length: positive }, (_, i) => row(`P${String(i + 1).padStart(2, "0")}`, 0.20 - i / 1000)),
    ...Array.from({ length: negative }, (_, i) => row(`N${String(i + 1).padStart(2, "0")}`, -0.20 + i / 1000)),
  ];
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    breadthScans: [{
      featureTimestamp: new Date(CUT - HOUR).toISOString(),
      positiveCount: 0,
      negativeCount: 12,
      zeroCount: 0,
    }],
    btcFast4hReturn: -0.01,
    ethFast4hReturn: -0.01,
    selectedOneHourReturnBySymbol: {},
    absMom36PercentileBySymbol: {},
    percentileWindowHours: null,
    percentileRequiredWindowHours: 90 * 24,
    percentileSource: null,
    ...overrides,
  };
}

function evaluate(
  rows: DynamicMom36RankedSymbol[],
  qualityContext = context(),
  strategyVersion = DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_ONE_SIDED_DIRECTIONAL_QUALITY_SL2_MFE30_36H_V6_2,
) {
  return evaluateDynamicMom36Formation({
    activeUniverse: rows,
    now: new Date(CUT).toISOString(),
    openedAtMs: CUT,
    horizonMs: 36 * HOUR,
    featureTimestampMs: CUT,
    decisionInformationCutoffMs: CUT,
    maxPerCluster: 0,
    admissionScoreGapFloor: 0.058,
    admissionScoreBySymbol: Object.fromEntries(rows.map((candidate) => [candidate.symbol, candidate.mom36])),
    strategyVersion,
    continuationRuntime: null,
    oneSidedQualityContext: qualityContext,
  });
}

describe("Dynamic MOM36 V6.2 — One-Sided Directional Quality V1", () => {
  it("treats NO_EDGE as neutral: exactly six strict shorts pass at score 2", () => {
    const evaluated = evaluate(signedRows(0, 6));
    const quality = evaluated.snapshot?.admission.oneSidedDirectionalQuality;

    expect(evaluated.basket).toMatchObject({ longK: 0, shortK: 6 });
    expect(quality).toMatchObject({
      score: 2,
      minScore: 2,
      decision: "PASS",
      reason: "ONE_SIDED_ADMISSION_PASSED",
      components: {
        breadthPersistence: { score: 1 },
        strictEligibleDepth: { score: 0, strictEligibleCount: 6 },
        btcEthAlignment: { score: 1 },
        selectedTrajectory: { score: 0 },
        modelSupport: { score: 0, continuationDecision: "NO_EDGE", shockState: "NO_EDGE" },
        exhaustionRisk: { score: 0, dataAvailable: false },
      },
    });
    expect(evaluated.snapshot?.admission).toMatchObject({
      scoreGap: null,
      scoreGapApplicable: false,
      scoreGapReason: "ONE_SIDED_FINAL_ALLOCATION",
      passed: true,
      reason: "ONE_SIDED_ADMISSION_PASSED",
    });
    expect(validateDynamicMom36FormationAdmissionParity(evaluated.snapshot)).toMatchObject({ valid: true });
  });

  it("keeps V6.2 one-sided directional quality active in V6.3", () => {
    const evaluated = evaluate(
      signedRows(0, 6),
      context(),
      DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_ZERO_NEUTRAL_BREADTH_ONE_SIDED_DIRECTIONAL_QUALITY_SL2_MFE30_36H_V6_3,
    );
    expect(evaluated.basket).toMatchObject({ longK: 0, shortK: 6 });
    expect(evaluated.snapshot?.admission).toMatchObject({
      passed: true,
      reason: "ONE_SIDED_ADMISSION_PASSED",
      oneSidedDirectionalQuality: { policyId: "one-sided-directional-quality-v1", decision: "PASS" },
    });
  });

  it("adds only the broad strict-depth bonus at eight or more eligible directional legs", () => {
    const evaluated = evaluate(signedRows(0, 8), context({ btcFast4hReturn: null, ethFast4hReturn: null }));
    expect(evaluated.snapshot?.admission.oneSidedDirectionalQuality?.components.strictEligibleDepth).toMatchObject({
      score: 1,
      strictEligibleCount: 8,
      requiredCount: 8,
    });
    expect(evaluated.snapshot?.admission.oneSidedDirectionalQuality?.score).toBe(2); // breadth + depth
  });

  it("keeps exhaustion alone soft: score 3 less one exhaustion point still passes", () => {
    const percentiles = Object.fromEntries(signedRows(0, 6).map((candidate) => [candidate.symbol, 0.95]));
    const evaluated = evaluate(signedRows(0, 6), context({
      selectedOneHourReturnBySymbol: Object.fromEntries(signedRows(0, 6).map((candidate) => [candidate.symbol, -0.01])),
      absMom36PercentileBySymbol: percentiles,
      percentileWindowHours: 90 * 24,
      percentileSource: "test-90d",
    }));
    expect(evaluated.snapshot?.admission.oneSidedDirectionalQuality).toMatchObject({
      score: 2,
      decision: "PASS",
      components: { exhaustionRisk: { score: -1, medianAbsMom36Percentile: 0.95 } },
    });
  });

  it("vetoes a short when both macro and selected one-hour path have reversed", () => {
    const returns = Object.fromEntries(signedRows(0, 6).map((candidate) => [candidate.symbol, 0.01]));
    const evaluated = evaluate(signedRows(0, 6), context({
      btcFast4hReturn: 0.01,
      ethFast4hReturn: 0.01,
      selectedOneHourReturnBySymbol: returns,
    }));
    expect(evaluated.basket).toBeNull();
    expect(evaluated.snapshot?.admission.oneSidedDirectionalQuality).toMatchObject({
      strongReversal: { macro: true, trajectory: true, model: false, count: 2, veto: true },
      decision: "REJECT",
      reason: "ONE_SIDED_STRONG_REVERSAL_CONFLICT",
    });
    expect(evaluated.snapshot?.noEntryReason).toBe("ONE_SIDED_STRONG_REVERSAL_CONFLICT");
  });

  it("does not turn one reversal warning into a hard veto", () => {
    const rows = signedRows(0, 8);
    const returns = Object.fromEntries(rows.map((candidate) => [candidate.symbol, -0.01]));
    const evaluated = evaluate(rows, context({
      btcFast4hReturn: 0.01,
      ethFast4hReturn: 0.01,
      selectedOneHourReturnBySymbol: returns,
    }));
    expect(evaluated.basket).not.toBeNull();
    expect(evaluated.snapshot?.admission.oneSidedDirectionalQuality).toMatchObject({
      score: 2,
      strongReversal: { macro: true, count: 1, veto: false },
      decision: "PASS",
    });
  });

  it("mirrors the long calculation and preserves one-sided score-gap N/A", () => {
    const longRows = signedRows(6, 0);
    const returns = Object.fromEntries(longRows.map((candidate) => [candidate.symbol, 0.01]));
    const evaluated = evaluate(longRows, context({
      breadthScans: [{ featureTimestamp: new Date(CUT - HOUR).toISOString(), positiveCount: 12, negativeCount: 0, zeroCount: 0 }],
      btcFast4hReturn: 0.01,
      ethFast4hReturn: 0.01,
      selectedOneHourReturnBySymbol: returns,
    }));
    expect(evaluated.basket).toMatchObject({ longK: 6, shortK: 0 });
    expect(evaluated.snapshot?.admission).toMatchObject({
      scoreGap: null,
      scoreGapApplicable: false,
      scoreGapReason: "ONE_SIDED_FINAL_ALLOCATION",
      reason: "ONE_SIDED_ADMISSION_PASSED",
    });
    expect(evaluated.snapshot?.admission.oneSidedDirectionalQuality?.direction).toBe("LONG");
  });

  it("does not run the quality module for two-sided V6 allocations", () => {
    for (const [longs, shorts] of [[5, 1], [4, 2], [3, 3], [2, 4], [1, 5]] as const) {
      const evaluated = evaluate(signedRows(longs, shorts), context({ btcFast4hReturn: 0.01, ethFast4hReturn: 0.01 }));
      expect(evaluated.basket, `${longs}L${shorts}S`).not.toBeNull();
      expect(evaluated.snapshot?.admission, `${longs}L${shorts}S`).toMatchObject({
        passed: true,
        reason: "ADMISSION_PASSED",
        scoreGapApplicable: true,
        scoreGapReason: "TWO_SIDED_FINAL_ALLOCATION",
      });
      expect(evaluated.snapshot?.admission.oneSidedDirectionalQuality, `${longs}L${shorts}S`).toBeUndefined();
      expect(evaluated.snapshot?.oneSidedDirectionalQuality, `${longs}L${shorts}S`).toBeUndefined();
    }
  });

  it("keeps existing safety above quality: an external safety rejection cannot be overridden", () => {
    const rows = signedRows(0, 8);
    const evaluated = evaluateDynamicMom36Formation({
      activeUniverse: rows,
      now: new Date(CUT).toISOString(),
      openedAtMs: CUT,
      horizonMs: 36 * HOUR,
      featureTimestampMs: CUT,
      decisionInformationCutoffMs: CUT,
      maxPerCluster: 0,
      admissionScoreGapFloor: 0.058,
      admissionScoreBySymbol: Object.fromEntries(rows.map((candidate) => [candidate.symbol, candidate.mom36])),
      admissionExternalReason: "OWNERSHIP_CONFLICT",
      strategyVersion: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_ONE_SIDED_DIRECTIONAL_QUALITY_SL2_MFE30_36H_V6_2,
      continuationRuntime: null,
      oneSidedQualityContext: context(),
    });
    expect(evaluated.basket).toBeNull();
    expect(evaluated.snapshot?.admission).toMatchObject({
      passed: false,
      reason: "ADMISSION_EXTERNAL_GUARD",
      externalReason: "OWNERSHIP_CONFLICT",
    });
    expect(evaluated.snapshot?.admission.oneSidedDirectionalQuality).toBeUndefined();
  });

  it("keeps V6.1 one-sided behavior frozen while V6.2 records its new policy", () => {
    const rows = signedRows(0, 6);
    const legacy = evaluateDynamicMom36Formation({
      activeUniverse: rows,
      now: new Date(CUT).toISOString(),
      openedAtMs: CUT,
      horizonMs: 36 * HOUR,
      featureTimestampMs: CUT,
      decisionInformationCutoffMs: CUT,
      maxPerCluster: 0,
      admissionScoreGapFloor: 0.058,
      admissionScoreBySymbol: Object.fromEntries(rows.map((candidate) => [candidate.symbol, candidate.mom36])),
      strategyVersion: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1,
      continuationRuntime: null,
    });
    expect(legacy.snapshot?.admission).toMatchObject({ passed: true, reason: "ADMISSION_PASSED" });
    expect(legacy.snapshot?.admission.oneSidedDirectionalQuality).toBeUndefined();
  });

  it("is deterministic under candidate permutations and fails closed when quality identity is mutated", () => {
    const rows = signedRows(0, 8);
    const first = evaluate(rows);
    const second = evaluate([...rows].reverse());
    expect(second.snapshot?.selectedShorts).toEqual(first.snapshot?.selectedShorts);
    expect(second.snapshot?.admission.oneSidedDirectionalQuality).toEqual(first.snapshot?.admission.oneSidedDirectionalQuality);
    const corrupted = structuredClone(first.snapshot!);
    corrupted.admission.oneSidedDirectionalQuality!.selectedSymbols = ["different"];
    expect(validateDynamicMom36FormationAdmissionParity(corrupted)).toMatchObject({
      valid: false,
      reason: "FORMATION_ONE_SIDED_QUALITY_MISMATCH",
    });
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CrossSectionalStore,
  evaluateDynamicMom36Formation,
} from "../src/lib/cross-sectional-edge.js";
import {
  DYNAMIC_MOM36_CONTINUATION_SLOWFAST_PREFERRED_SL2_MFE30_36H_V5,
  DYNAMIC_MOM36_CONTINUATION_SLOWFAST_SL2_MFE30_36H_V4,
  buildDynamicMom36Formation,
  isDynamicMom36SlowFastStrategy,
  selectDynamicMom36Legs,
  type DynamicMom36Allocation,
  type DynamicMom36RankedSymbol,
  type DynamicMom36StrategyVersion,
  type FrozenContinuationOverlay,
} from "../src/lib/dynamic-mom36-shock-strategy.js";
import {
  DYNAMIC_MOM36_SLOW_FAST_IMPLEMENTATION_VERSION,
  DYNAMIC_MOM36_SLOW_FAST_POLICY_ID,
  evaluateDynamicMom36SlowFast,
  isDynamicMom36SlowFastAligned,
} from "../src/lib/dynamic-mom36-slowfast.js";

const HOUR = 3_600_000;
const CUT = Date.parse("2026-08-26T12:00:00.000Z");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function allocation(longCount: number): DynamicMom36Allocation {
  const labels = ["0L6S", "1L5S", "2L4S", "3L3S", "4L2S", "5L1S", "6L0S"] as const;
  return { longCount, shortCount: 6 - longCount, label: labels[longCount]! };
}

function row(
  symbol: string,
  mom36: number,
  fastReturn: number | null = mom36,
  opts: Partial<DynamicMom36RankedSymbol> = {},
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
    ...opts,
  };
}

function signedRows(positive: number, negative: number): DynamicMom36RankedSymbol[] {
  return [
    ...Array.from({ length: positive }, (_, index) => row(`P${String(index + 1).padStart(2, "0")}`, 0.20 - index / 1_000)),
    ...Array.from({ length: negative }, (_, index) => row(`N${String(index + 1).padStart(2, "0")}`, -0.20 + index / 1_000)),
  ];
}

function continuation(decision: FrozenContinuationOverlay["decision"]): FrozenContinuationOverlay {
  return {
    continuationArtifactId: "dm-36h-v4-20260824T153338Z:sha256:test",
    artifactSha256: "test",
    schemaVersion: 4,
    featureVersion: "direction-model-features-v4-975c996",
    calibrationVersion: "temperature-1.1",
    runtimeFunction: "test",
    available: true,
    reason: null,
    featureAtMs: CUT,
    horizons: [],
    bullVotes: 0,
    bearVotes: 0,
    neutralVotes: 4,
    agreementScore: 0,
    persistenceScore: 0,
    persistenceDirection: "PERSIST_NEUTRAL",
    topPath: "CHOP",
    pathProbabilities: { CHOP: 1 },
    reversalRisk: 0.5,
    reversalRiskBand: "HIGH",
    decision,
    rawOutput: { test: true, decision },
  };
}

function evaluationInput(
  activeUniverse: DynamicMom36RankedSymbol[],
  admissionPassed = true,
  strategyVersion: DynamicMom36StrategyVersion = DYNAMIC_MOM36_CONTINUATION_SLOWFAST_SL2_MFE30_36H_V4,
) {
  return {
    activeUniverse,
    now: new Date(CUT).toISOString(),
    openedAtMs: CUT,
    horizonMs: 36 * HOUR,
    featureTimestampMs: CUT,
    decisionInformationCutoffMs: CUT,
    maxPerCluster: 0,
    admissionScoreGap: 0.1,
    admissionScoreGapFloor: 0.058,
    admissionPassed,
    strategyVersion,
    continuationRuntime: null,
  } as const;
}

describe("Dynamic MOM36 v4 — recovered legacy SLOW_AND_FAST", () => {
  it("uses the exact strict-sign legacy predicate, including neutral and missing fail-close", () => {
    expect(evaluateDynamicMom36SlowFast(0.01, 0.02)).toMatchObject({
      slowDirection: "BULLISH", fastDirection: "BULLISH", longAligned: true, shortAligned: false,
    });
    expect(evaluateDynamicMom36SlowFast(-0.01, -0.02)).toMatchObject({
      slowDirection: "BEARISH", fastDirection: "BEARISH", longAligned: false, shortAligned: true,
    });
    expect(isDynamicMom36SlowFastAligned(0.01, 0, "LONG")).toBe(false);
    expect(isDynamicMom36SlowFastAligned(0, -0.01, "SHORT")).toBe(false);
    expect(isDynamicMom36SlowFastAligned(null, 0.01, "LONG")).toBe(false);
    expect(isDynamicMom36SlowFastAligned(-0.01, Number.NaN, "SHORT")).toBe(false);
  });

  it("replays the known MOM36_FILTERED + SLOW_AND_FAST basket's persisted side decisions", () => {
    const replay = [
      ["INJUSDT", 0.080508, 0.015936, "LONG"],
      ["TAOUSDT", 0.033069, 0.004717, "LONG"],
      ["NEARUSDT", 0.031844, 0.016186, "LONG"],
      ["SEIUSDT", -0.021451, -0.005131, "SHORT"],
      ["SUIUSDT", -0.020406, -0.005120, "SHORT"],
      ["ARBUSDT", -0.006006, -0.001006, "SHORT"],
    ] as const;

    for (const [symbol, mom36, fast4h, side] of replay) {
      expect(isDynamicMom36SlowFastAligned(mom36, fast4h, side), symbol).toBe(true);
    }
  });

  it("walks the MOM36 long ranking and skips an unaligned DOGE without reranking", () => {
    const selection = selectDynamicMom36Legs([
      row("SOL", 0.10, 0.01), row("SUI", 0.09, 0.01), row("DOGE", 0.08, -0.01),
      row("XRP", 0.07, 0.01), row("BNB", 0.06, 0.01), row("ADA", 0.05, 0.01),
      row("OP", 0.04, -0.01), row("SEI", -0.05, -0.01),
    ], allocation(5), 0, { slowFastApplied: true });

    expect(selection.selectedLongs.map((candidate) => candidate.symbol)).toEqual(["SOL", "SUI", "XRP", "BNB", "ADA"]);
    expect(selection.selectedShorts.map((candidate) => candidate.symbol)).toEqual(["SEI"]);
    expect(selection.candidateAudit.long.find((candidate) => candidate.symbol === "DOGE")).toMatchObject({
      mom36Rank: 3, slowFastAligned: false, skipReason: "SLOW_FAST_NOT_ALIGNED",
    });
  });

  it("walks the MOM36 short ranking and rejects ARB before selecting OP and SEI", () => {
    const selection = selectDynamicMom36Legs([
      row("SOL", 0.10, 0.01), row("SUI", 0.09, 0.01), row("DOGE", 0.08, 0.01), row("XRP", 0.07, 0.01),
      row("ARB", -0.10, 0.01), row("OP", -0.09, -0.01), row("SEI", -0.08, -0.01), row("ADA", -0.07, -0.01),
    ], allocation(4), 0, { slowFastApplied: true });

    expect(selection.selectedShorts.map((candidate) => candidate.symbol)).toEqual(["OP", "SEI"]);
    expect(selection.candidateAudit.short.find((candidate) => candidate.symbol === "ARB")).toMatchObject({
      mom36Rank: 1, slowFastAligned: false, skipReason: "SLOW_FAST_NOT_ALIGNED",
    });
  });

  it("does not fall back to raw MOM36 when five longs are required but only four align", () => {
    const rows = [
      row("SOL", 0.10, 0.01), row("SUI", 0.09, 0.01), row("DOGE", 0.08, -0.01),
      row("XRP", 0.07, 0.01), row("BNB", 0.06, 0.01), row("ADA", 0.05, -0.01),
      row("OP", 0.04, -0.01), row("SEI", -0.05, -0.01),
    ];
    const formation = buildDynamicMom36Formation({
      activeUniverse: rows,
      maxPerCluster: 0,
      continuation: continuation("NO_EDGE"),
      continuationOnly: true,
      slowFastRequired: true,
    });
    const evaluated = evaluateDynamicMom36Formation(evaluationInput(rows));

    expect(formation.baseAllocation).toMatchObject({ label: "5L1S" });
    expect(formation.finalAllocation).toMatchObject({ label: "5L1S" });
    expect(formation.rawV3Selection).toMatchObject({ insufficientReason: null, requiredLongs: 5, requiredShorts: 1 });
    expect(formation.rawV3Selection.selectedLongs).toHaveLength(5);
    expect(formation.selection.selectedLongs).toHaveLength(4);
    expect(formation.selection.selectedShorts).toHaveLength(1);
    expect(formation.selection.insufficientReason).toBe("INSUFFICIENT_SLOW_FAST_ALIGNED_LEGS");
    expect(evaluated.basket).toBeNull();
    expect(evaluated.snapshot).toMatchObject({
      rawV3SelectedLongs: ["SOL", "SUI", "DOGE", "XRP", "BNB"],
      selectedLongs: ["SOL", "SUI", "XRP", "BNB"],
      noEntryReason: "INSUFFICIENT_SLOW_FAST_ALIGNED_LEGS",
      requiredLongs: 5,
      availableAlignedLongs: 4,
    });
  });

  it("V5 uses the complete same-snapshot raw V3 selection only when strict SLOW_AND_FAST cannot fill all legs", () => {
    const rows = [
      row("SOL", 0.10, 0.01), row("SUI", 0.09, 0.01), row("DOGE", 0.08, -0.01),
      row("XRP", 0.07, 0.01), row("BNB", 0.06, 0.01), row("ADA", 0.05, -0.01),
      row("OP", 0.04, -0.01), row("SEI", -0.05, -0.01),
    ];
    const formation = buildDynamicMom36Formation({
      activeUniverse: rows,
      maxPerCluster: 0,
      continuation: continuation("NO_EDGE"),
      continuationOnly: true,
      slowFastMode: "PREFER",
    });
    const evaluated = evaluateDynamicMom36Formation(
      evaluationInput(rows, true, DYNAMIC_MOM36_CONTINUATION_SLOWFAST_PREFERRED_SL2_MFE30_36H_V5),
    );

    expect(formation.slowFast).toMatchObject({ active: true, mode: "PREFER" });
    expect(formation.slowFastStrictSelection).toMatchObject({
      insufficientReason: "insufficient ranked execution-eligible symbols after current pool, blocklist, and cluster guards",
    });
    expect(formation.slowFastStrictSelection?.selectedLongs).toHaveLength(4);
    expect(formation.rawV3Selection).toMatchObject({ insufficientReason: null, requiredLongs: 5, requiredShorts: 1 });
    expect(formation.selectionSource).toBe("RAW_V3_FALLBACK");
    expect(formation.selection.selectedLongs.map((candidate) => candidate.symbol)).toEqual(["SOL", "SUI", "DOGE", "XRP", "BNB"]);
    expect(formation.selection.selectedShorts.map((candidate) => candidate.symbol)).toEqual(["SEI"]);
    expect(evaluated.basket?.longLeg.map((leg) => leg.symbol)).toEqual(["SOL", "SUI", "DOGE", "XRP", "BNB"]);
    expect(evaluated.snapshot).toMatchObject({
      strategyVersion: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_PREFERRED_SL2_MFE30_36H_V5,
      selectionSource: "RAW_V3_FALLBACK",
      slowFastStrictSelectedLongs: ["SOL", "SUI", "XRP", "BNB"],
      slowFastStrictSelectionInsufficientReason: "insufficient ranked execution-eligible symbols after current pool, blocklist, and cluster guards",
      noEntryReason: null,
    });
  });

  it("V5 still rejects an incomplete raw V3 selection instead of making a partial basket", () => {
    const rows = [
      row("SOL", 0.10, 0.01), row("SUI", 0.09, 0.01), row("DOGE", 0.08, -0.01),
      row("XRP", 0.07, 0.01),
      row("BNB", 0.06, 0.01, { longEligible: false, longExecutionBlockReason: "EXECUTION_INELIGIBLE" }),
      row("ADA", 0.05, -0.01, { longEligible: false, longExecutionBlockReason: "EXECUTION_INELIGIBLE" }),
      row("OP", 0.04, -0.01, { longEligible: false, longExecutionBlockReason: "EXECUTION_INELIGIBLE" }),
      row("SEI", -0.05, -0.01, { longEligible: false, longExecutionBlockReason: "EXECUTION_INELIGIBLE" }),
    ];
    const evaluated = evaluateDynamicMom36Formation(
      evaluationInput(rows, true, DYNAMIC_MOM36_CONTINUATION_SLOWFAST_PREFERRED_SL2_MFE30_36H_V5),
    );

    expect(evaluated.formation?.rawV3Selection.selectedLongs).toHaveLength(4);
    expect(evaluated.formation?.selectionSource).toBe("RAW_V3");
    expect(evaluated.basket).toBeNull();
    expect(evaluated.noEntryReason).toContain("insufficient ranked execution-eligible symbols");
  });

  it("preserves the short blocklist as an execution guard separate from alignment", () => {
    const selection = selectDynamicMom36Legs([
      row("SOL", 0.10, 0.01), row("SUI", 0.09, 0.01), row("DOGE", 0.08, 0.01), row("XRP", 0.07, 0.01),
      row("ARB", -0.10, -0.01, {
        shortEligible: false,
        shortBlocked: true,
        shortExecutionBlockReason: "SHORT_BLOCKED",
      }),
      row("OP", -0.09, -0.01), row("SEI", -0.08, -0.01),
    ], allocation(4), 0, { slowFastApplied: true });

    expect(selection.selectedShorts.map((candidate) => candidate.symbol)).toEqual(["OP", "SEI"]);
    expect(selection.blockedShortsSkipped).toContain("ARB");
    expect(selection.candidateAudit.short.find((candidate) => candidate.symbol === "ARB")).toMatchObject({
      slowFastAligned: true, executionEligible: false, shortBlocked: true, skipReason: "SHORT_BLOCKED",
    });
  });

  it("rejects neutral, missing, future, and stale source data rather than treating them as aligned", () => {
    const neutral = row("NEUTRAL", 0.10, 0);
    const missing = row("MISSING", 0.09, null);
    const future = row("FUTURE", 0.08, 0.01, { fastSourceTimestampMs: CUT + 1, slowFastDataValid: false });
    const stale = row("STALE", 0.075, 0.01, { slowSourceTimestampMs: CUT - HOUR, fastSourceTimestampMs: CUT - HOUR });
    const selection = selectDynamicMom36Legs([
      neutral, missing, future, row("OK1", 0.07, 0.01), row("OK2", 0.06, 0.01), row("OK3", 0.05, 0.01),
      row("OK4", 0.04, 0.01), row("SEI", -0.05, -0.01),
    ], allocation(5), 0, { slowFastApplied: true });

    expect(selection.selectedLongs.map((candidate) => candidate.symbol)).toEqual(["OK1", "OK2", "OK3", "OK4"]);
    expect(selection.insufficientReason).toBe("insufficient ranked execution-eligible symbols after current pool, blocklist, and cluster guards");
    expect(selection.candidateAudit.long.find((candidate) => candidate.symbol === "NEUTRAL")?.skipReason).toBe("SLOW_FAST_NOT_ALIGNED");
    expect(selection.candidateAudit.long.find((candidate) => candidate.symbol === "MISSING")?.skipReason).toBe("SLOW_FAST_DATA_MISSING");
    expect(selection.candidateAudit.long.find((candidate) => candidate.symbol === "FUTURE")?.skipReason).toBe("SLOW_FAST_DATA_MISSING");
    // The pure selector trusts caller-provided source validity.  The production evaluator owns the
    // decision-cut check below, so prove the stale source cannot reach selection through that path.
    expect(evaluateDynamicMom36Formation(evaluationInput([
      stale, row("SUI", 0.09, 0.01), row("XRP", 0.08, 0.01), row("BNB", 0.07, 0.01),
      row("ADA", 0.06, 0.01), row("OP", 0.05, 0.01), row("DOGE", 0.04, 0.01), row("SEI", -0.05, -0.01),
    ])).snapshot?.selectionCandidateAudit?.long.find((candidate) => candidate.symbol === "STALE")).toMatchObject({
      slowFastDataAvailable: false,
      skipReason: "SLOW_FAST_DATA_MISSING",
    });
  });

  it("asserts timestamp <= decision cut at the evaluator boundary, even if a caller forgot to mark a future source invalid", () => {
    const rows = [
      row("FUTURE", 0.10, 0.01, { fastSourceTimestampMs: CUT + 1 }),
      row("SUI", 0.09, 0.01), row("XRP", 0.08, 0.01), row("BNB", 0.07, 0.01),
      row("ADA", 0.06, 0.01), row("OP", 0.05, 0.01), row("DOGE", 0.04, 0.01), row("SEI", -0.05, -0.01),
    ];
    const evaluated = evaluateDynamicMom36Formation(evaluationInput(rows));

    expect(evaluated.basket?.longLeg.map((leg) => leg.symbol)).not.toContain("FUTURE");
    expect(evaluated.snapshot?.selectionCandidateAudit?.long.find((candidate) => candidate.symbol === "FUTURE")).toMatchObject({
      fastSourceTimestampMs: CUT + 1,
      slowFastDataAvailable: false,
      skipReason: "SLOW_FAST_DATA_MISSING",
    });
  });

  it("coexists with V4 confirmation: breadth and overlay freeze 4L2S -> 5L1S before strict leg selection", () => {
    const formation = buildDynamicMom36Formation({
      activeUniverse: signedRows(18, 2),
      maxPerCluster: 0,
      continuation: continuation("CONFIRM_LONG"),
      continuationOnly: true,
      slowFastRequired: true,
    });

    expect(formation.baseAllocation).toMatchObject({ label: "4L2S" });
    expect(formation.finalAllocation).toMatchObject({ label: "5L1S" });
    expect(formation.slowFast).toEqual({
      active: true,
      mode: "STRICT",
      policyId: DYNAMIC_MOM36_SLOW_FAST_POLICY_ID,
      implementationVersion: DYNAMIC_MOM36_SLOW_FAST_IMPLEMENTATION_VERSION,
      interval: "1h",
      slowBars: 36,
      fastBars: 4,
    });
    expect(formation.selection).toMatchObject({ insufficientReason: null, requiredLongs: 5, requiredShorts: 1 });
    expect(formation.selection.selectedLongs).toHaveLength(5);
    expect(formation.selection.selectedShorts).toHaveLength(1);
  });

  it("fails closed for the mathematically impossible V4 conflict 5L1S -> 4L2S, never borrowing a positive-MOM36 short", () => {
    const formation = buildDynamicMom36Formation({
      activeUniverse: signedRows(19, 1),
      maxPerCluster: 0,
      continuation: continuation("CONFLICT_LONG"),
      continuationOnly: true,
      slowFastRequired: true,
    });

    expect(formation.baseAllocation).toMatchObject({ label: "5L1S" });
    expect(formation.finalAllocation).toMatchObject({ label: "4L2S" });
    expect(formation.rawV3Selection.insufficientReason).toBeNull();
    expect(formation.rawV3Selection.selectedShorts).toHaveLength(2);
    expect(formation.selection.selectedShorts.map((candidate) => candidate.symbol)).toEqual(["N01"]);
    expect(formation.selection.insufficientReason).toBe("INSUFFICIENT_SLOW_FAST_ALIGNED_LEGS");
    expect(formation.selection.candidateAudit.short.filter((candidate) => candidate.selected)).toHaveLength(1);
    expect(formation.selection.candidateAudit.short.find((candidate) => candidate.symbol === "P19")).toMatchObject({
      slowDirection: "BULLISH", slowFastAligned: false, skipReason: "SLOW_FAST_NOT_ALIGNED",
    });
  });

  it("keeps one-sided 6L0S / 0L6S and mirror selection deterministic", () => {
    const bulls = buildDynamicMom36Formation({
      activeUniverse: signedRows(20, 0), maxPerCluster: 0, continuation: continuation("NO_EDGE"), continuationOnly: true, slowFastRequired: true,
    });
    const bears = buildDynamicMom36Formation({
      activeUniverse: signedRows(0, 20), maxPerCluster: 0, continuation: continuation("NO_EDGE"), continuationOnly: true, slowFastRequired: true,
    });
    const repeated = buildDynamicMom36Formation({
      activeUniverse: signedRows(20, 0), maxPerCluster: 0, continuation: continuation("NO_EDGE"), continuationOnly: true, slowFastRequired: true,
    });

    expect(bulls.finalAllocation).toMatchObject({ label: "6L0S" });
    expect(bulls.selection.selectedLongs).toHaveLength(6);
    expect(bulls.selection.selectedShorts).toHaveLength(0);
    expect(bears.finalAllocation).toMatchObject({ label: "0L6S" });
    expect(bears.selection.selectedLongs).toHaveLength(0);
    expect(bears.selection.selectedShorts).toHaveLength(6);
    expect(repeated).toEqual(bulls);
  });

  it("persists a no-entry formation across restart and is independent of the retired legacy env switch", () => {
    const rows = [
      row("SOL", 0.10, 0.01), row("SUI", 0.09, 0.01), row("DOGE", 0.08, -0.01),
      row("XRP", 0.07, 0.01), row("BNB", 0.06, 0.01), row("ADA", 0.05, -0.01),
      row("OP", 0.04, -0.01), row("SEI", -0.05, -0.01),
    ];
    const evaluated = evaluateDynamicMom36Formation(evaluationInput(rows));
    const dir = mkdtempSync(join(tmpdir(), "dynamic-mom36-slowfast-v4-"));
    dirs.push(dir);
    const store = new CrossSectionalStore(dir);
    store.recordDynamicMom36Formation(evaluated.snapshot!);
    store.save();
    const restored = new CrossSectionalStore(dir);

    expect(restored.latestDynamicMom36Formation).toMatchObject({
      strategyVersion: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_SL2_MFE30_36H_V4,
      noEntryReason: "INSUFFICIENT_SLOW_FAST_ALIGNED_LEGS",
      rawV3SelectedLongs: ["SOL", "SUI", "DOGE", "XRP", "BNB"],
    });
    expect(isDynamicMom36SlowFastStrategy({
      CROSS_SECTIONAL_STRATEGY_VERSION: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_SL2_MFE30_36H_V4,
      CROSS_SECTIONAL_FILTERED_SIDE_TREND_ALIGNMENT: "0",
    } as NodeJS.ProcessEnv)).toBe(true);
    expect(isDynamicMom36SlowFastStrategy({
      CROSS_SECTIONAL_STRATEGY_VERSION: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_PREFERRED_SL2_MFE30_36H_V5,
    } as NodeJS.ProcessEnv)).toBe(true);
  });
});

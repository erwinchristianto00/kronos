import { describe, expect, it } from "vitest";

import type {
  ExecutionEntryVariant,
  ShadowPosition,
  ShadowPositionVariant,
  VariantSelectionSnapshot,
} from "@dtc/shared";

import { buildCohortPerformanceReport } from "../src/lib/cohort-performance.js";

type EraFlavor = "LEGACY" | "POST_ROUTING" | "POST_CALIBRATION";

function makeSelection(flavor: EraFlavor): VariantSelectionSnapshot | null {
  if (flavor === "LEGACY") return null;
  const base: VariantSelectionSnapshot = {
    selectedEntryVariant: "fib_500_entry",
    selectedExitVariant: "tp1_full_exit",
    expectedGrossR: 0.5,
    expectedNetR: 0.4,
    netEdgeAfterCost: 0.4,
    profitFactor: null,
    fillRate: null,
    noFillRate: null,
    costR: 0.2,
    spreadR: 0.05,
    feeSlippageR: 0.15,
    stopDistanceBps: 30,
    variantSampleSize: 0,
    variantConfidenceTier: "provisional",
    routeMode: "DATA_COLLECTION",
    selectionSource: "heuristic_fallback",
    costAssumption: "",
    selectionReason: "",
    entryDriftPct: null,
    entryDriftAtr: null,
    entryQualityExplanation: [],
    exitPlanExplanation: [],
    chaseRisk: "LOW",
  };
  if (flavor === "POST_ROUTING") return base;
  // POST_CALIBRATION
  return {
    ...base,
    calibratedExpectedNetR: 0.2,
    calibrationVerdict: "CALIBRATED_POSITIVE",
    calibrationConfidence: "MEDIUM",
    calibrationSampleSize: 9,
    calibrationSourceUsed: "combo",
    calibrationPenaltyR: -0.2,
    calibrationDiagnosisCodes: [],
    evidenceEra: "POST_CALIBRATION",
    decisionPolicyVersion: "calibrated-expectancy-v1",
  };
}

function makePosition(
  id: string,
  flavor: EraFlavor,
  closedNetR: number,
  symbol = "BTCUSDT",
): ShadowPosition {
  const entry: ExecutionEntryVariant = "fib_500_entry";
  const exit: ShadowPositionVariant = "tp1_full_exit";
  const selection = makeSelection(flavor);
  const variant = {
    variant: exit,
    state: "CLOSED" as const,
    openedAt: "2026-05-10T10:00:00.000Z",
    lastUpdatedAt: "2026-05-10T11:00:00.000Z",
    closedAt: "2026-05-10T11:00:00.000Z",
    remainingSizePct: 0,
    realizedGrossR: closedNetR,
    realizedNetR: closedNetR,
    tp1Hit: closedNetR > 0,
    tp2Hit: false,
    tp3Hit: false,
    slHit: closedNetR < 0,
    closeReason: (closedNetR > 0 ? "TP1_FULL" : "SL") as "TP1_FULL" | "SL",
  };
  return {
    id, ideaKey: id, symbol, direction: "LONG", signalFamily: "BREAKOUT",
    scannedAt: "2026-05-10T10:00:00.000Z", firstSeenAt: "2026-05-10T10:00:00.000Z",
    lastSeenAt: "2026-05-10T10:00:00.000Z", lastEvaluatedAt: "2026-05-10T11:00:00.000Z",
    scanCount: 1, latestStatus: "READY", latestScore: 60, latestReason: [],
    entryZone: [99, 101], entryPrice: 100, stopLoss: 97, tp1: 103, tp2: 105, tp3: 108,
    riskReward: 2, dangerScore: 30,
    selectedEntryVariant: entry, selectedExitVariant: exit,
    variantSelection: selection as VariantSelectionSnapshot,
    primaryVariant: exit,
    tradePlan: {
      entryZone: [99, 101], stopLoss: 97, tp1: 103, tp2: 105, tp3: 108,
      riskReward: 2, runnerAllowed: false, reason: "", explanation: "", contextExplanation: [],
      trailing: { active: false, mode: "NONE", anchor: null, distancePct: null, distanceR: null, explanation: [] },
      partialPlan: { tp1Action: "FULL_EXIT", tp1ExitPct: 100, breakevenAfterTp1: true, runnerPct: 0, runnerInvalidations: [] },
      timing: { entryAction: "ENTER_ON_TRIGGER", entryAnchor: "MID_ZONE", waitForCloseConfirmation: false, cancelIfInvalidated: true, reentryRule: "NO_REENTRY", driftWarning: null },
      playbook: { entryPlaybook: "PULLBACK_RECLAIM", exitMode: "TP1_FAST", confidence: 0.6 },
      biasSummary: "", contextSummary: "",
    },
    variants: [variant],
  };
}

describe("buildCohortPerformanceReport", () => {
  it("splits records by inferred era", () => {
    const positions = [
      makePosition("L1", "LEGACY", -1.0),
      makePosition("L2", "LEGACY", -0.8),
      makePosition("R1", "POST_ROUTING", -0.2),
      makePosition("C1", "POST_CALIBRATION", 0.4),
      makePosition("C2", "POST_CALIBRATION", 0.5),
    ];
    const r = buildCohortPerformanceReport({ positions });
    expect(r.byEra.LEGACY_PRE_ROUTING?.closedCount).toBe(2);
    expect(r.byEra.POST_ROUTING_PRE_CALIBRATION?.closedCount).toBe(1);
    expect(r.byEra.POST_CALIBRATION?.closedCount).toBe(2);
  });

  it("currentEra POST_CALIBRATION metrics exclude legacy records", () => {
    const positions = [
      makePosition("L1", "LEGACY", -1.5),
      makePosition("C1", "POST_CALIBRATION", 0.5),
      makePosition("C2", "POST_CALIBRATION", 0.4),
    ];
    const r = buildCohortPerformanceReport({ positions });
    const current = r.byEra.POST_CALIBRATION!;
    expect(current.avgRealizedNetR).toBeCloseTo(0.45, 4);
  });

  it("delta vs legacy computes correctly when both eras exist", () => {
    const positions = [
      makePosition("L1", "LEGACY", -1.0),
      makePosition("L2", "LEGACY", -1.0),
      makePosition("C1", "POST_CALIBRATION", 0.5),
      makePosition("C2", "POST_CALIBRATION", 0.5),
    ];
    const r = buildCohortPerformanceReport({ positions });
    expect(r.currentEraVsLegacyDelta).not.toBeNull();
    expect(r.currentEraVsLegacyDelta!.netAvgRDelta).toBeCloseTo(1.5, 4);
  });

  it("delta is null when one of the eras is missing", () => {
    const positions = [
      makePosition("C1", "POST_CALIBRATION", 0.4),
      makePosition("C2", "POST_CALIBRATION", 0.4),
    ];
    const r = buildCohortPerformanceReport({ positions });
    expect(r.currentEraVsLegacyDelta).toBeNull();
  });

  it("currentEra is POST_CALIBRATION and exposed in the report", () => {
    const r = buildCohortPerformanceReport({ positions: [] });
    expect(r.currentEra).toBe("POST_CALIBRATION");
  });
});

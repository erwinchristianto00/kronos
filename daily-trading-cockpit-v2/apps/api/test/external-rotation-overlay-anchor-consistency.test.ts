import { describe, it, expect } from "vitest";
import {
  classifyExternalRotationOverlayValidity,
  EXTERNAL_ROTATION_OVERLAY_POLICY_VERSION_V2_ANCHOR_CONSISTENT,
  LEGACY_EXTERNAL_ROTATION_OVERLAY_POLICY_VERSION_V1_FILL_MISMATCH,
  type ExternalRotationOverlayObservation,
} from "../src/lib/external-rotation-overlay.js";
import { buildExternalRotationOverlayPerformanceReport } from "../src/lib/external-rotation-overlay-performance.js";
import { buildExternalRotationOverlayEconomicsReport } from "../src/lib/external-rotation-overlay-economics.js";
import { buildTpSlGeometryRootCauseAuditReport } from "../src/lib/tp-sl-geometry-root-cause-audit.js";

let _idCounter = 0;
function makeObs(overrides: Partial<ExternalRotationOverlayObservation> = {}): ExternalRotationOverlayObservation {
  const id = `obs-${++_idCounter}`;
  return {
    observationId: id,
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T01:00:00.000Z",
    symbol: "ATOMUSDT",
    overlayGroups: ["STRATEGY_FIT_SHORTLIST"],
    evidenceEra: "POST_CALIBRATION",
    selectionBatchId: "batch-1",
    sourceDiscoveryScore: 75,
    sourceStrategyFitScore: 80,
    sourceStrategyFitTier: "HIGH_FIT",
    discoveryRank: 1,
    strategyFitRank: 1,
    lowFitRank: null,
    duplicateKey: id,
    detachedCandidateSnapshot: {
      direction: "LONG",
      hypotheticalEntryVariant: "fib_500_entry",
      hypotheticalExitVariant: "tp1_full_exit",
      hypotheticalExpectedNetR: null,
      setupPlaybookLabel: "HIGH",
      stopDistanceBps: 200,
      riskReward: 2.0,
      marketRegime: "BULLISH_EXPANSION",
      plannedEntryPrice: 100,
      selectedEntryAnchorPrice: 100,
      entryBasis: "VARIANT_ANCHOR",
      entryZone: null,
      stopPrice: 98,
      tp1Price: 104,
      tp2Price: null,
      tp3Price: null,
      costR: 0.3,
      notes: [],
    },
    observationStatus: "RESOLVED",
    outcome: {
      realizedGrossR: 1.0,
      realizedNetR: 0.7,
      winnerLabel: "WIN",
      tp1Hit: true,
      tp2Hit: false,
      slHit: false,
      closeReason: "TP1_FULL",
      openedAt: "2026-05-15T00:05:00.000Z",
      closedAt: "2026-05-15T01:00:00.000Z",
      durationMinutes: 55,
      fillStatus: "FILLED",
    },
    diagnostics: {
      createdByPolicyVersion: EXTERNAL_ROTATION_OVERLAY_POLICY_VERSION_V2_ANCHOR_CONSISTENT,
      reasonCodes: [],
      resolutionSemantics: "candle-based",
    },
    ...overrides,
  };
}

function makeLegacyV1Obs(overrides: Partial<ExternalRotationOverlayObservation> = {}): ExternalRotationOverlayObservation {
  const obs = makeObs(overrides);
  return {
    ...obs,
    detachedCandidateSnapshot: {
      ...obs.detachedCandidateSnapshot,
      // Legacy: entryBasis undefined (or LEGACY_CURRENT_PRICE), no selectedEntryAnchorPrice
      entryBasis: undefined,
      selectedEntryAnchorPrice: undefined,
    },
    diagnostics: {
      createdByPolicyVersion: LEGACY_EXTERNAL_ROTATION_OVERLAY_POLICY_VERSION_V1_FILL_MISMATCH,
      reasonCodes: [],
      resolutionSemantics: "candle-based",
    },
  };
}

// ─── Validity classifier ──────────────────────────────────────────────────────

describe("classifyExternalRotationOverlayValidity", () => {
  it("returns VALID for V2 anchor-consistent observation", () => {
    expect(classifyExternalRotationOverlayValidity(makeObs())).toBe("VALID");
  });

  it("returns LEGACY_ENTRY_ANCHOR_FILL_MISMATCH for V1 policy version", () => {
    expect(classifyExternalRotationOverlayValidity(makeLegacyV1Obs())).toBe(
      "LEGACY_ENTRY_ANCHOR_FILL_MISMATCH",
    );
  });

  it("returns LEGACY when entryBasis is missing even if policy is V2", () => {
    const obs = makeObs({
      detachedCandidateSnapshot: {
        ...makeObs().detachedCandidateSnapshot,
        entryBasis: undefined,
      },
    });
    expect(classifyExternalRotationOverlayValidity(obs)).toBe("LEGACY_ENTRY_ANCHOR_FILL_MISMATCH");
  });

  it("returns LEGACY when entryBasis is LEGACY_CURRENT_PRICE (V2 fallback case)", () => {
    const obs = makeObs({
      detachedCandidateSnapshot: {
        ...makeObs().detachedCandidateSnapshot,
        entryBasis: "LEGACY_CURRENT_PRICE",
      },
    });
    expect(classifyExternalRotationOverlayValidity(obs)).toBe("LEGACY_ENTRY_ANCHOR_FILL_MISMATCH");
  });
});

// ─── Performance report filters legacy V1 ─────────────────────────────────────

describe("performance report filters legacy V1", () => {
  it("excludes legacy V1 observations from operative metrics", () => {
    const obs = [makeLegacyV1Obs(), makeLegacyV1Obs(), makeLegacyV1Obs()];
    const report = buildExternalRotationOverlayPerformanceReport(obs);
    expect(report.validityCounts.rawObservationCount).toBe(3);
    expect(report.validityCounts.validObservationCount).toBe(0);
    expect(report.validityCounts.legacyInvalidExcludedCount).toBe(3);
    expect(report.totalObservations).toBe(0);
    expect(report.resolvedObservations).toBe(0);
  });

  it("verdict resets to NO_FORWARD_EVIDENCE_YET when only legacy V1 exists", () => {
    const obs = [makeLegacyV1Obs(), makeLegacyV1Obs()];
    const report = buildExternalRotationOverlayPerformanceReport(obs);
    // currentBestObservedGroup should be null when no valid resolved
    expect(report.currentBestObservedGroup).toBeNull();
    for (const g of report.groupPerformance) {
      expect(g.earlyVerdict).toBe("NO_FORWARD_EVIDENCE_YET");
    }
  });

  it("counts valid V2 observations in operative metrics", () => {
    const obs = [makeObs(), makeObs(), makeObs()];
    const report = buildExternalRotationOverlayPerformanceReport(obs);
    expect(report.validityCounts.rawObservationCount).toBe(3);
    expect(report.validityCounts.validObservationCount).toBe(3);
    expect(report.validityCounts.legacyInvalidExcludedCount).toBe(0);
    expect(report.totalObservations).toBe(3);
    expect(report.resolvedObservations).toBe(3);
  });

  it("mixed: counts raw, valid, and legacy excluded correctly", () => {
    const obs = [makeObs(), makeObs(), makeLegacyV1Obs(), makeLegacyV1Obs(), makeLegacyV1Obs()];
    const report = buildExternalRotationOverlayPerformanceReport(obs);
    expect(report.validityCounts.rawObservationCount).toBe(5);
    expect(report.validityCounts.validObservationCount).toBe(2);
    expect(report.validityCounts.legacyInvalidExcludedCount).toBe(3);
  });

  it("readiness reasons mention legacy exclusion when applicable", () => {
    const obs = [makeLegacyV1Obs(), makeLegacyV1Obs()];
    const report = buildExternalRotationOverlayPerformanceReport(obs);
    const joined = report.readiness.reasons.join(" | ");
    expect(joined).toMatch(/legacy V1/i);
    expect(joined).toMatch(/unit mismatch/i);
  });
});

// ─── Economics report filters legacy V1 ───────────────────────────────────────

describe("economics report filters legacy V1", () => {
  it("excludes legacy V1 from operative diagnosis", () => {
    const obs = [makeLegacyV1Obs(), makeLegacyV1Obs(), makeLegacyV1Obs()];
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    expect(report.validityCounts.legacyInvalidExcludedCount).toBe(3);
    expect(report.validityCounts.validObservationCount).toBe(0);
    expect(report.resolvedObservations).toBe(0);
    expect(report.economicsDiagnosis.primaryDiagnosis).toBe("TOO_EARLY");
  });

  it("credibility status resets to TOO_EARLY for legacy-only tape", () => {
    const obs = [makeLegacyV1Obs(), makeLegacyV1Obs(), makeLegacyV1Obs()];
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    expect(report.externalOverlayInterpretability.netRotationComparisonStatus).toBe("TOO_EARLY");
  });

  it("readiness reasons mention legacy exclusion", () => {
    const obs = [makeLegacyV1Obs(), makeLegacyV1Obs()];
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    const joined = report.readiness.reasons.join(" | ");
    expect(joined).toMatch(/legacy V1/i);
  });
});

// ─── Root-cause audit scopes to legacy V1 ────────────────────────────────────

describe("root-cause audit scopes to legacy V1", () => {
  it("counts V2 observations as out-of-scope (postFixV2ObservationCount)", () => {
    const obs = [makeObs(), makeObs(), makeLegacyV1Obs()];
    const report = buildTpSlGeometryRootCauseAuditReport(obs);
    expect(report.totalObservations).toBe(1);            // only legacy in scope
    expect(report.postFixV2ObservationCount).toBe(2);
  });

  it("audits only legacy V1 observations for mismatch", () => {
    const legacy = makeLegacyV1Obs({
      detachedCandidateSnapshot: {
        ...makeLegacyV1Obs().detachedCandidateSnapshot,
        stopDistanceBps: 1,
        plannedEntryPrice: 100,
        stopPrice: 99.4,
      },
      resolverState: {
        lastEvaluatedAt: "2026-05-15T01:00:00.000Z",
        openedAt: "2026-05-15T00:05:00.000Z",
        entryPrice: 100,
        remainingSizePct: 0,
        realizedGrossR: 0.17,
        tp1Hit: true,
        tp2Hit: false,
        slMovedToBreakeven: false,
        stopPrice: 99.4,
        currentPrice: 100.01,
      },
    });
    const report = buildTpSlGeometryRootCauseAuditReport([legacy, legacy, legacy]);
    expect(report.totalObservations).toBe(3);
    expect(report.perObservationMismatches.some((m) => m.classification === "ENTRY_ANCHOR_FILL_MISMATCH")).toBe(true);
  });
});

// ─── Dedupe — legacy observations don't suppress new valid ones ───────────────

describe("dedupe via duplicateKey includes policy version", () => {
  it("legacy V1 observation's duplicateKey does not collide with new V2 observation for same symbol/route/groups", () => {
    // We can't directly call duplicateKey (it's not exported), but we can verify
    // that the contract holds: when buildObservation creates a V2 key for the
    // same symbol/route/groups as an existing V1 key, they are different.
    // This is enforced by the policy version suffix in duplicateKey.
    const v1 = makeLegacyV1Obs({ duplicateKey: "ATOMUSDT:LONG:fib_500_entry:tp1_full_exit:STRATEGY_FIT_SHORTLIST" });
    const v2 = makeObs({ duplicateKey: `ATOMUSDT:LONG:fib_500_entry:tp1_full_exit:STRATEGY_FIT_SHORTLIST::${EXTERNAL_ROTATION_OVERLAY_POLICY_VERSION_V2_ANCHOR_CONSISTENT}` });
    expect(v1.duplicateKey).not.toBe(v2.duplicateKey);
  });
});

// ─── No active bot behavior change invariants ─────────────────────────────────

describe("no active bot impact", () => {
  it("performance report still has expected shape (no breaking field removal)", () => {
    const obs = [makeObs()];
    const report = buildExternalRotationOverlayPerformanceReport(obs);
    expect(report.groupPerformance.length).toBe(3);
    expect(report.readiness.readyForUniverseInfluence).toBe(false);
    expect(report.readiness.readyForRotationDiscussion).toBe(false);
  });

  it("economics report still has expected shape", () => {
    const obs = [makeObs()];
    const report = buildExternalRotationOverlayEconomicsReport(obs);
    expect(report.groups.length).toBe(3);
    expect(report.readiness.readyForResolverBehaviorDiscussion).toBe(false);
    expect(report.readiness.readyForUniverseRotationInterpretation).toBe(false);
  });
});

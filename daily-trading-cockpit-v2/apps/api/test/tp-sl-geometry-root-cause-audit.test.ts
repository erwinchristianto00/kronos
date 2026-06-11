import { describe, it, expect } from "vitest";
import {
  buildTpSlGeometryRootCauseAuditReport,
  classifyObservationGeometryMismatch,
} from "../src/lib/tp-sl-geometry-root-cause-audit.js";
import type { ExternalRotationOverlayObservation } from "../src/lib/external-rotation-overlay.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _idCounter = 0;
function makeObs(overrides: Partial<ExternalRotationOverlayObservation> = {}): ExternalRotationOverlayObservation {
  const id = `obs-${++_idCounter}`;
  return {
    observationId: id,
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
    symbol: "TESTUSDT",
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
      stopDistanceBps: 1,
      riskReward: 5.0,
      marketRegime: "BULLISH_EXPANSION",
      plannedEntryPrice: 1.0,
      entryZone: [0.9995, 0.9996],
      stopPrice: 0.9994,
      tp1Price: 1.0001,
      tp2Price: null,
      tp3Price: null,
      costR: 28.99,
      notes: [],
    },
    observationStatus: "RESOLVED",
    resolverState: {
      lastEvaluatedAt: "2026-05-15T01:00:00.000Z",
      openedAt: "2026-05-15T00:05:00.000Z",
      entryPrice: 1.0,
      remainingSizePct: 0,
      realizedGrossR: 0.17,
      tp1Hit: true,
      tp2Hit: false,
      slMovedToBreakeven: false,
      stopPrice: 0.9994,
      currentPrice: 1.0001,
    },
    outcome: {
      realizedGrossR: 0.17,
      realizedNetR: -28.82,
      winnerLabel: "LOSS",
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
      // Tests target legacy V1 (the audit is FOR legacy V1 observations that
      // suffered the entry-anchor / fill-price unit mismatch).
      createdByPolicyVersion: "external-rotation-overlay-v1",
      reasonCodes: [],
      resolutionSemantics: "candle-based",
    },
    ...overrides,
  };
}

function makeConsistentObs(opts: { stopBps: number; grossR: number; netR: number; entry?: number; stopPrice?: number; entryVariant?: string }): ExternalRotationOverlayObservation {
  const entry = opts.entry ?? 100.0;
  const stopPrice = opts.stopPrice ?? entry * (1 - opts.stopBps / 10000);
  return makeObs({
    detachedCandidateSnapshot: {
      direction: "LONG",
      hypotheticalEntryVariant: opts.entryVariant ?? "fib_500_entry",
      hypotheticalExitVariant: "tp1_full_exit",
      hypotheticalExpectedNetR: null,
      setupPlaybookLabel: "HIGH",
      stopDistanceBps: opts.stopBps,
      riskReward: 2.0,
      marketRegime: "BULLISH_EXPANSION",
      plannedEntryPrice: entry,
      entryZone: null,
      stopPrice,
      tp1Price: entry * 1.02,
      tp2Price: null,
      tp3Price: null,
      costR: 0.3,
      notes: [],
    },
    resolverState: {
      lastEvaluatedAt: "2026-05-15T01:00:00.000Z",
      openedAt: "2026-05-15T00:05:00.000Z",
      entryPrice: entry,
      remainingSizePct: 0,
      realizedGrossR: opts.grossR,
      tp1Hit: opts.grossR > 0,
      tp2Hit: false,
      slMovedToBreakeven: false,
      stopPrice,
      currentPrice: entry,
    },
    outcome: {
      realizedGrossR: opts.grossR,
      realizedNetR: opts.netR,
      winnerLabel: opts.netR > 0 ? "WIN" : "LOSS",
      tp1Hit: opts.grossR > 0,
      tp2Hit: false,
      slHit: opts.netR < 0,
      closeReason: opts.netR > 0 ? "TP1_FULL" : "SL",
      openedAt: "2026-05-15T00:05:00.000Z",
      closedAt: "2026-05-15T01:00:00.000Z",
      durationMinutes: 55,
      fillStatus: "FILLED",
    },
  });
}

// ─── Empty/safe ───────────────────────────────────────────────────────────────

describe("buildTpSlGeometryRootCauseAuditReport — empty input", () => {
  it("safe on empty observations", () => {
    const report = buildTpSlGeometryRootCauseAuditReport([]);
    expect(report.totalObservations).toBe(0);
    expect(report.resolvedObservations).toBe(0);
    expect(report.rootCauseVerdict).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("readiness flags are always false", () => {
    const report = buildTpSlGeometryRootCauseAuditReport([]);
    expect(report.readiness.readyForResolverBehaviorChange).toBe(false);
    expect(report.readiness.readyForCostModelChange).toBe(false);
  });

  it("patchDirections are always present and never marked as implemented now", () => {
    const report = buildTpSlGeometryRootCauseAuditReport([]);
    expect(report.patchDirections.length).toBeGreaterThan(0);
    expect(report.patchDirections.every((p) => p.doesNotImplementNow === true)).toBe(true);
  });
});

// ─── Per-observation classifier ───────────────────────────────────────────────

describe("classifyObservationGeometryMismatch", () => {
  it("detects ENTRY_ANCHOR_FILL_MISMATCH when actual stop is much wider than stored", () => {
    // USD1USDT-like: stored 1bps, actual fill 60bps → ratio = 60x
    const obs = makeObs();
    const result = classifyObservationGeometryMismatch(obs);
    expect(result.classification).toBe("ENTRY_ANCHOR_FILL_MISMATCH");
    expect(result.inflationRatio).not.toBeNull();
    expect(result.inflationRatio!).toBeGreaterThan(2);
  });

  it("returns CONSISTENT_GEOMETRY when actual stop matches stored", () => {
    const obs = makeConsistentObs({ stopBps: 200, grossR: 1.0, netR: 0.7 });
    const result = classifyObservationGeometryMismatch(obs);
    expect(result.classification).toBe("CONSISTENT_GEOMETRY");
  });

  it("returns GENUINELY_TIGHT_STOP when stop is truly tight and consistent", () => {
    const obs = makeConsistentObs({ stopBps: 60, grossR: -1.0, netR: -1.6 });
    const result = classifyObservationGeometryMismatch(obs);
    expect(result.classification).toBe("GENUINELY_TIGHT_STOP");
    expect(result.inflationRatio).toBeCloseTo(1.0, 1);
  });

  it("returns UNRESOLVED for non-FILLED observation", () => {
    const obs = makeObs({
      observationStatus: "OPEN",
      outcome: undefined,
    });
    const result = classifyObservationGeometryMismatch(obs);
    expect(result.classification).toBe("UNRESOLVED");
  });

  it("captures costDragR = grossR - netR", () => {
    const obs = makeObs();
    const result = classifyObservationGeometryMismatch(obs);
    expect(result.costDragR).toBeCloseTo(0.17 - -28.82, 1);
  });
});

// ─── Root cause verdict ───────────────────────────────────────────────────────

describe("rootCauseVerdict", () => {
  it("EXTERNAL_OVERLAY_ENTRY_ANCHOR_FILL_MISMATCH when >= 40% mismatch", () => {
    const obs = Array.from({ length: 5 }, () => makeObs());
    const report = buildTpSlGeometryRootCauseAuditReport(obs);
    expect(report.rootCauseVerdict).toBe("EXTERNAL_OVERLAY_ENTRY_ANCHOR_FILL_MISMATCH");
    expect(report.secondaryGeometryFinding).toBe("ULTRA_TIGHT_STOP_GEOMETRY_AMPLIFIED_THE_DAMAGE");
    expect(report.activeBotHasSameMismatchBug).toBe(false);
    expect(report.legacyV1Only).toBe(true);
  });

  it("INSUFFICIENT_EVIDENCE when fewer than 3 resolved", () => {
    const obs = [makeConsistentObs({ stopBps: 200, grossR: 1.0, netR: 0.7 })];
    const report = buildTpSlGeometryRootCauseAuditReport(obs);
    expect(report.rootCauseVerdict).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("SHARED_STOP_GEOMETRY_WEAKNESS_EXTERNALLY_AMPLIFIED when most are genuinely tight + consistent", () => {
    const obs = Array.from({ length: 5 }, () =>
      makeConsistentObs({ stopBps: 60, grossR: -1.0, netR: -1.5 }),
    );
    const report = buildTpSlGeometryRootCauseAuditReport(obs);
    expect(report.rootCauseVerdict).toBe("SHARED_STOP_GEOMETRY_WEAKNESS_EXTERNALLY_AMPLIFIED");
  });
});

// ─── Cost model sanity ────────────────────────────────────────────────────────

describe("cost model sanity", () => {
  it("flags COST_MODEL_BUG_SUSPECTED when many mismatches present", () => {
    const obs = Array.from({ length: 5 }, () => makeObs());
    const report = buildTpSlGeometryRootCauseAuditReport(obs);
    expect(report.costModelSanity).toBe("COST_ARITHMETIC_CORRECT_BUT_V1_ENTRY_BASIS_MISMATCH");
    expect(report.costModelNotes.length).toBeGreaterThan(0);
    expect(report.costModelNotes.join(" ")).toMatch(/No double-subtraction detected/i);
  });

  it("keeps legacy V1 cost wording aligned with the audit's mismatch scope", () => {
    const obs = Array.from({ length: 5 }, () =>
      makeConsistentObs({ stopBps: 200, grossR: 1.0, netR: 0.7 }),
    );
    const report = buildTpSlGeometryRootCauseAuditReport(obs);
    expect(report.rootCauseVerdict).toBe("EXTERNAL_OVERLAY_ENTRY_ANCHOR_FILL_MISMATCH");
    expect(report.costModelSanity).toBe("COST_ARITHMETIC_CORRECT_BUT_V1_ENTRY_BASIS_MISMATCH");
  });

  it("keeps cost semantics aligned with mismatch root cause even when mismatch share is below the old threshold", () => {
    const obs = [
      makeObs(),
      makeConsistentObs({ stopBps: 60, grossR: -1.0, netR: -1.6 }),
      makeConsistentObs({ stopBps: 80, grossR: 1.0, netR: 0.7 }),
      makeConsistentObs({ stopBps: 120, grossR: 0.5, netR: 0.2 }),
      makeConsistentObs({ stopBps: 140, grossR: 0.4, netR: 0.1 }),
    ];
    const report = buildTpSlGeometryRootCauseAuditReport(obs);
    expect(report.rootCauseVerdict).toBe("EXTERNAL_OVERLAY_ENTRY_ANCHOR_FILL_MISMATCH");
    expect(report.costModelSanity).toBe("COST_ARITHMETIC_CORRECT_BUT_V1_ENTRY_BASIS_MISMATCH");
    expect(report.secondaryGeometryFinding).toBe("ULTRA_TIGHT_STOP_GEOMETRY_AMPLIFIED_THE_DAMAGE");
  });
});

// ─── External vs active comparison ────────────────────────────────────────────

describe("externalVsActiveComparison", () => {
  it("reports SHARED_BUT_EXTERNAL_AMPLIFIED based on static code-path tracing", () => {
    const report = buildTpSlGeometryRootCauseAuditReport([]);
    expect(report.externalVsActiveComparison).toBe("SHARED_BUT_EXTERNAL_AMPLIFIED");
    expect(report.externalVsActiveNotes.length).toBeGreaterThan(0);
    expect(report.externalVsActiveNotes.join(" ")).toMatch(/does NOT share the same entry-anchor/i);
  });
});

// ─── RR inflation analysis ────────────────────────────────────────────────────

describe("RR inflation analysis", () => {
  it("STOP_TOO_TIGHT_DENOMINATOR_INFLATION when most high-RR cases also have tight stops", () => {
    const obs = Array.from({ length: 5 }, () => makeObs()); // RR=5, stop=1bps
    const report = buildTpSlGeometryRootCauseAuditReport(obs);
    expect(report.rrInflationDriver).toBe("STOP_TOO_TIGHT_DENOMINATOR_INFLATION");
  });

  it("INSUFFICIENT_EVIDENCE when too few resolved", () => {
    const obs = [makeObs()];
    const report = buildTpSlGeometryRootCauseAuditReport(obs);
    expect(report.rrInflationDriver).toBe("INSUFFICIENT_EVIDENCE");
  });
});

// ─── Route variant breakdown ──────────────────────────────────────────────────

describe("routeVariantBreakdown", () => {
  it("groups observations by entry variant", () => {
    const obs = [
      makeConsistentObs({ stopBps: 200, grossR: 1.0, netR: 0.7, entryVariant: "fib_500_entry" }),
      makeConsistentObs({ stopBps: 200, grossR: 1.0, netR: 0.7, entryVariant: "fib_500_entry" }),
      makeConsistentObs({ stopBps: 200, grossR: 1.0, netR: 0.7, entryVariant: "vwap_retest_entry" }),
    ];
    const report = buildTpSlGeometryRootCauseAuditReport(obs);
    expect(report.routeVariantBreakdown.length).toBe(2);
    const fib = report.routeVariantBreakdown.find((r) => r.entryVariant === "fib_500_entry");
    expect(fib?.observationCount).toBe(2);
  });
});

// ─── Era filtering ────────────────────────────────────────────────────────────

describe("era filtering", () => {
  it("POST_CALIBRATION excludes ALL_TIME observations", () => {
    const obs = [
      makeObs(),
      makeObs({ evidenceEra: "ALL_TIME" as "POST_CALIBRATION" }),
    ];
    const report = buildTpSlGeometryRootCauseAuditReport(obs, { evidenceEra: "POST_CALIBRATION" });
    expect(report.totalObservations).toBe(1);
  });
});

// ─── Behavior safety invariants ───────────────────────────────────────────────

describe("behavior safety invariants", () => {
  it("all patch directions carry doesNotImplementNow=true", () => {
    const obs = Array.from({ length: 5 }, () => makeObs());
    const report = buildTpSlGeometryRootCauseAuditReport(obs);
    expect(report.patchDirections.every((p) => p.doesNotImplementNow === true)).toBe(true);
  });

  it("readyForResolverBehaviorChange is always false", () => {
    const obs = Array.from({ length: 10 }, () => makeObs());
    const report = buildTpSlGeometryRootCauseAuditReport(obs);
    expect(report.readiness.readyForResolverBehaviorChange).toBe(false);
  });

  it("readyForCostModelChange is always false", () => {
    const obs = Array.from({ length: 10 }, () => makeObs());
    const report = buildTpSlGeometryRootCauseAuditReport(obs);
    expect(report.readiness.readyForCostModelChange).toBe(false);
  });

  it("generatedAt uses provided now parameter", () => {
    const now = new Date("2026-05-15T10:00:00.000Z");
    const report = buildTpSlGeometryRootCauseAuditReport([], {}, now);
    expect(report.generatedAt).toBe("2026-05-15T10:00:00.000Z");
  });
});

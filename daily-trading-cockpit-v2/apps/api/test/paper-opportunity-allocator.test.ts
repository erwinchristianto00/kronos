/**
 * PAPER OPPORTUNITY ALLOCATOR V1 — 23-test suite.
 *
 * Verifies the allocator evaluates EVERY fresh scan candidate × paper lane,
 * constructs CG_WIDE geometry directly from the candidate (no pre-existing
 * observation required), enforces regime / economics / freshness / dedupe
 * gates, emits rich no-opportunity diagnostics, and that admission creates
 * paper orders without touching live behavior or data/shadow-positions.json.
 */
import { describe, it, expect } from "vitest";
import os from "node:os";
import { mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { Candidate, Direction } from "@dtc/shared";

import {
  buildPaperOpportunityAllocatorReport,
  buildPaperOpportunityAllocatorBriefLines,
  computeAutoQuarantinedVariantLanes,
  paperOpportunityStopFloorRejection,
  type PaperOpportunityAllocatorInputs,
  type AllocatorLaneState,
} from "../src/lib/paper-opportunity-allocator.js";
import {
  PaperExecutionRouterStore,
  admitPaperOpportunities,
  buildPaperPerformanceReport,
  buildPaperExecutionRouterBriefLines,
  buildPaperProvenanceAudit,
  simulateLoserFingerprintGate,
  buildPaperProvenanceBriefLines,
  DEFAULT_PAPER_EQUITY,
  type PaperOrder,
  type PaperOrderProvenance,
} from "../src/lib/paper-execution-router.js";
import {
  buildCurrentGuardVariantMatrixReport,
  CurrentGuardVariantMatrixStore,
  mirrorVariantMatrixSignals,
  resolveVariantMatrixObservations,
  type VariantMatrixSignal,
  type KlineTuple,
  type CurrentGuardVariantMatrixReport,
} from "../src/lib/current-guard-variant-matrix.js";
import { buildAdaptiveLaneRouterReport } from "../src/lib/adaptive-lane-router.js";
import { buildRegimeDirectionControllerReport } from "../src/lib/regime-direction-controller.js";
import { buildLiveTradingGateReport } from "../src/lib/live-trading-gate.js";
import { buildOperatorBrief } from "../src/lib/operator-brief.js";
import {
  buildMixedRegimeReport,
  MIXED_LONG_WIDE_LANE,
  type MixedRegimeReport,
} from "../src/lib/mixed-regime-router.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return mkdtempSync(join(os.tmpdir(), "paper-opp-allocator-test-"));
}

function emptyGate() {
  return buildLiveTradingGateReport({});
}

function routerOf(regime: string | null) {
  return buildAdaptiveLaneRouterReport({
    generatedAt: new Date().toISOString(),
    regimeReport: buildRegimeDirectionControllerReport({
      currentRegime: regime,
      adaptiveDirectionBias: null,
      primaryValidationLane: null,
    }),
    gateReport: emptyGate(),
  });
}

/** VM store with 60 winning SHORT signals so the canonical scaleout headline lane passes economics. */
async function buildWinningVmReport(dir: string): Promise<CurrentGuardVariantMatrixReport> {
  const vmStore = new CurrentGuardVariantMatrixStore(dir);
  const recentBase = Date.now() - 6 * 24 * 60 * 60 * 1000;
  const signals: VariantMatrixSignal[] = Array.from({ length: 60 }, (_, i) => ({
    sourceSignalId: `sig-${i}`,
    symbol: `SYM${String(i).padStart(3, "0")}USDT`,
    direction: "SHORT" as const,
    entryPrice: 100,
    stopLoss: 103,
    tp1: 96,
    tp2: null,
    tp3: null,
    stopDistanceBps: 300,
    regime: "BEARISH_EXPANSION",
    entryVariant: "base_current_entry",
    openedAt: new Date(recentBase + i * 60_000).toISOString(),
    closedAt: null,
  }));
  mirrorVariantMatrixSignals(signals, vmStore, new Date().toISOString());
  const flexBinance = {
    getKlines: async (
      _s: string,
      _i: string,
      opts: { startTime: number; endTime: number; limit: number },
    ): Promise<KlineTuple[]> => {
      const signalMs = opts.startTime + 300_000;
      return [
        [signalMs - 300_000, "0", "100.2", "99.9", "100", "0", signalMs] as KlineTuple,
        [signalMs, "0", "100.5", "95.5", "96", "0", signalMs + 300_000] as KlineTuple,
        [signalMs + 300_000, "0", "97", "95", "95.5", "0", signalMs + 600_000] as KlineTuple,
      ];
    },
  };
  await resolveVariantMatrixObservations(vmStore, flexBinance);
  return buildCurrentGuardVariantMatrixReport(vmStore, { capturedAt: new Date().toISOString() });
}

/** Empty/insufficient VM report — CG_WIDE row exists but has freshValid 0. */
function buildEmptyVmReport(dir: string): CurrentGuardVariantMatrixReport {
  const vmStore = new CurrentGuardVariantMatrixStore(dir);
  return buildCurrentGuardVariantMatrixReport(vmStore, { capturedAt: new Date().toISOString() });
}

interface CandOverrides {
  symbol?: string;
  direction?: Direction;
  currentPrice?: number | null;
  stopLoss?: number | null;
  tp1?: number | null;
  tp2?: number | null;
  tp3?: number | null;
  entryVariant?: string | null;
  // ── candidate-level quality-gate fields (Part 4). Defaults PASS all gates. ──
  calibratedExpectedNetR?: number | null;
  calibrationVerdict?: string | null;
  chaseRisk?: string | null;
  routeReasonCodes?: string[];
  costR?: number | null;
  sourceConflict?: boolean;
  /** When true the candidate carries no selectedExecutionPlan (FIELD_MISSING). */
  noExecutionPlan?: boolean;
  kronosBias?: string | null;
  whaleSignal?: string | null;
  trendScore?: number;
  directionConflict?: boolean;
}

/**
 * Minimal Candidate carrying only the fields the allocator reads. By default it
 * carries a passing selectedExecutionPlan (CALIBRATED_POSITIVE, +netR, LOW
 * chase, no negative route codes, small cost) so the Part-4 candidate gates
 * admit it as HEADLINE; overrides flip individual gate inputs.
 */
function makeCandidate(o: CandOverrides = {}): Candidate {
  const direction: Direction = o.direction ?? "SHORT";
  const plan = o.noExecutionPlan
    ? null
    : {
        selectedEntryVariant: o.entryVariant ?? null,
        calibratedExpectedNetR: o.calibratedExpectedNetR === undefined ? 0.2 : o.calibratedExpectedNetR,
        calibrationVerdict: o.calibrationVerdict === undefined ? "CALIBRATED_POSITIVE" : o.calibrationVerdict,
        chaseRisk: o.chaseRisk === undefined ? "LOW" : o.chaseRisk,
        routeReasonCodes: o.routeReasonCodes ?? [],
        costR: o.costR === undefined ? -0.05 : o.costR,
      };
  const c = {
    rank: 1,
    symbol: o.symbol ?? "ETHUSDT",
    direction,
    finalDirection: direction,
    currentPrice: o.currentPrice === undefined ? 100 : o.currentPrice,
    stopLoss: o.stopLoss === undefined ? 103 : o.stopLoss,
    takeProfits: {
      tp1: o.tp1 === undefined ? 96 : o.tp1,
      tp2: o.tp2 ?? null,
      tp3: o.tp3 ?? null,
    },
    indicators: { fiveMinute: { latestClose: 100 } },
    sourceConflict: o.sourceConflict ?? false,
    directionConflict: o.directionConflict ?? false,
    trendScore: o.trendScore ?? 75,
    selectedExecutionPlan: plan,
    ...(o.kronosBias !== undefined ? { kronosBias: o.kronosBias } : {}),
    ...(o.whaleSignal !== undefined ? { whale: { signal: o.whaleSignal, score: 60 } } : {}),
  } as unknown as Candidate;
  return c;
}

/** A degraded active-lane state (closed≥10, negative net, sub-30% WR). */
function degradedLaneState(over: Partial<AllocatorLaneState> = {}): AllocatorLaneState {
  return {
    activeLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
    laneConfidence: "DEGRADED",
    closedCount: 28,
    netAvgR: -0.9157,
    pf: 0.07,
    wr: 0.071,
    betterLaneAvailable: false,
    selectedNextLaneId: null,
    worstSymbols: [{ symbol: "ETHUSDT", closed: 8, netSumR: -6.2, wr: 0.0 }],
    topLossContributors: [
      { symbol: "ETHUSDT", direction: "SHORT", netR: -1.0, closeReason: "SL_HIT" },
    ],
    ...over,
  };
}

/** A healthy active-lane state (HIGH confidence, positive economics). */
function healthyLaneState(over: Partial<AllocatorLaneState> = {}): AllocatorLaneState {
  return {
    activeLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
    laneConfidence: "HIGH",
    closedCount: 12,
    netAvgR: 0.12,
    pf: 1.8,
    wr: 0.55,
    betterLaneAvailable: false,
    selectedNextLaneId: null,
    ...over,
  };
}

function baseInputs(
  over: Partial<PaperOpportunityAllocatorInputs> & {
    vmReport: CurrentGuardVariantMatrixReport;
  },
): PaperOpportunityAllocatorInputs {
  const now = new Date().toISOString();
  return {
    candidates: [],
    scanBatchId: "batch-1",
    scanFinishedAt: now,
    marketRegime: "Bearish pressure",
    routerReport: routerOf("Bearish pressure"),
    now,
    paperStartAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    paperValidationAllowed: false,
    ...over,
  };
}

// ── Provenance / shadow-gate seed helpers (Part 5) ───────────────────────────

/** A full, valid PaperOrderProvenance; overrides flip individual fields. */
function mixedReportFor(
  symbol: string | null,
  direction: Direction | null,
  orders: PaperOrder[] = [],
): MixedRegimeReport {
  return buildMixedRegimeReport({
    regime: "Mixed rotation",
    candidates: [{
      symbol,
      direction,
      regime: "Mixed rotation",
      laneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
      atrPercent: 0.8,
      volatilityScore: 0.5,
      liquidityScore: 0.9,
    }],
    orders,
    nowMs: Date.now(),
    trailLaneAvailable: true,
  });
}

function fullProvenance(over: Partial<PaperOrderProvenance> = {}): PaperOrderProvenance {
  return {
    sourceRank: 1,
    sourceStatus: "OK",
    currentPriceAtAdmission: 100,
    referencePrice: 100,
    stopBucket: "300-399bps",
    tpDistanceBps: 300,
    riskReward: 1,
    selectedEntryVariant: null,
    selectedExitVariant: null,
    expectedGrossR: 0.3,
    expectedNetR: 0.2,
    calibratedExpectedNetR: 0.2,
    calibrationVerdict: "CALIBRATED_POSITIVE",
    calibrationPenaltyR: 0,
    calibrationConfidence: "MEDIUM",
    calibrationDiagnosisCodes: [],
    routeMode: "PROFIT_CANDIDATE",
    routeScore: 0.5,
    routeReasonCodes: [],
    primaryProfitEligible: true,
    dataCollectionReason: null,
    sourceConflict: false,
    directionConflict: false,
    horizonConflict: false,
    kronosBias: "BEARISH",
    kronosConfidence: 0.6,
    whaleSignal: "NEUTRAL",
    whaleScore: 0,
    sentimentSignal: "NEUTRAL",
    sentimentScore: 0,
    chaseRisk: "LOW",
    entryDriftPct: 0.1,
    entryDriftAtr: 0.2,
    costR: -0.05,
    spreadR: -0.02,
    feeSlippageR: -0.03,
    stopDistanceBpsFromPlan: 300,
    symbolHistoricalNet: -1,
    variantSampleSize: 30,
    variantConfidenceTier: "MEDIUM",
    candidateQualityFlags: [],
    ...over,
  };
}

let _seedCounter = 0;

/** Seed a closed HEADLINE paper order (with provenance) directly into the store. */
function seedClosed(
  store: PaperExecutionRouterStore,
  over: Partial<PaperOrder> = {},
): PaperOrder {
  const id = `seed-${_seedCounter++}`;
  const now = new Date().toISOString();
  const order: PaperOrder = {
    paperOrderId: id,
    sourceType: "SCAN_CANDIDATE_LANE_ALLOCATOR",
    sourceCandidateId: id,
    scanBatchId: "batch-seed",
    sourceObservationId: `alloc:batch-seed:${id}`,
    sourceSignalId: id,
    dedupeKey: `alloc:batch-seed:${id}`,
    createdAt: now,
    updatedAt: now,
    openedAt: now,
    symbol: "ETHUSDT",
    direction: "SHORT",
    regime: "Bearish pressure",
    controllerMode: "SHORT_ONLY",
    selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
    routerPermission: "SHADOW_ONLY",
    entryPrice: 100,
    stopLoss: 103,
    takeProfitLevels: [96],
    plannedStopDistanceBps: 300,
    riskPctOfEquity: 1,
    paperEquity: DEFAULT_PAPER_EQUITY,
    plannedRiskAmount: 20,
    plannedPositionNotional: 666.67,
    plannedRiskR: 1,
    oosUnconfirmed: true,
    infraNotReady: true,
    paperRiskLabel: "EXPERIMENTAL",
    paperOrderMode: "HEADLINE",
    operationalSafetyStatus: "OK",
    diagnosticLabel: null,
    paperStatus: "PAPER_CLOSED_LOSS",
    grossR: -1,
    costR: -0.07,
    netR: -1.07,
    netPnlAmount: -21.4,
    closeReason: "SL_HIT",
    provenance: fullProvenance(),
    provenanceFieldMissing: [],
    reportOnly: true,
    paperOnly: true,
    ...over,
  };
  store.add(order);
  return order;
}

/** A closed WINNER convenience wrapper. */
function seedWin(store: PaperExecutionRouterStore, over: Partial<PaperOrder> = {}): PaperOrder {
  return seedClosed(store, {
    paperStatus: "PAPER_CLOSED_WIN",
    grossR: 1,
    costR: -0.07,
    netR: 0.93,
    netPnlAmount: 18.6,
    closeReason: "TP_HIT",
    ...over,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("paper-opportunity-allocator", () => {
  // [1]
  it("[1] evaluates every candidate across all SHORT-eligible lanes", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate()] }),
    );
    expect(report.candidatesEvaluated).toBe(1);
    // 9 = the 6 bidirectional CG lanes + shortOnly CG_WIDE_FAST_SHORT + the 2 new
    // direction-agnostic fast-exit research lanes (CG_TIGHT_FAST_05, CG_BE_AFTER_05).
    // (CG_WIDE_FAST_LONG is longOnly → not SHORT-eligible.)
    expect(report.laneEvaluationsCreated).toBe(9);
    expect(report.byLane.length).toBe(9);
  });

  // [2]
  it("[2] creates a paper opportunity without any pre-existing observation", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate()] }),
    );
    expect(report.paperEligibleCount).toBeGreaterThanOrEqual(1);
    expect(report.selectedOpportunities.length).toBeGreaterThanOrEqual(1);
    expect(report.selectedOpportunities[0]!.variantId).toBe("CG_SCALEOUT_TP1_TRAIL");
  });

  // [3]
  it("[3] CG_WIDE transform computes widened (>=300bps) stop geometry", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate()] }),
    );
    const opp = report.selectedOpportunities[0]!;
    expect(opp.plannedStopDistanceBps).toBeGreaterThanOrEqual(300);
    expect(opp.takeProfitLevels.length).toBe(1);
  });

  // [4]
  it("[4] tight-base candidate is not auto-rejected — wide geometry still valid", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    // SHORT, entry 100, stop 100.5 → only 50bps base; wide widens to 300bps.
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate({ stopLoss: 100.5, tp1: 99 })],
        paperCgWidePriority: true,
      }),
    );
    expect(report.paperEligibleCount).toBe(1);
    expect(report.selectedOpportunities[0]!.plannedStopDistanceBps).toBeGreaterThanOrEqual(300);
  });

  // [5]
  it("[5] rejects with MISSING_WIDE_GEOMETRY when wide stop cannot be computed", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    // stopLoss === entry → zero baseline risk → geometry derivation fails.
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate({ stopLoss: 100, tp1: 96 })] }),
    );
    expect(report.paperEligibleCount).toBe(0);
    const reasons = report.topRejects.map((r) => r.key);
    expect(reasons).toContain("MISSING_WIDE_GEOMETRY");
  });

  it("[5b] paper opportunity floor rejects micro-stops and accepts 300bps", () => {
    expect(paperOpportunityStopFloorRejection(50)).toBe("STOP_DISTANCE_BELOW_FLOOR");
    expect(paperOpportunityStopFloorRejection(299.999)).toBe("STOP_DISTANCE_BELOW_FLOOR");
    expect(paperOpportunityStopFloorRejection(Number.NaN)).toBe("STOP_DISTANCE_BELOW_FLOOR");
    expect(paperOpportunityStopFloorRejection(300)).toBeNull();
  });

  // [6]
  it("[6] baseline/maker lanes are evaluated but never admitted", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate()] }),
    );
    const baseline = report.byLane.find((l) => l.laneId === "CG_BASELINE_CURRENT");
    const maker = report.byLane.find((l) => l.laneId === "CG_MAKER_LIMIT_SIM");
    expect(baseline?.evaluated).toBe(1);
    expect(maker?.evaluated).toBe(1);
    expect(baseline?.eligible).toBe(0);
    expect(maker?.eligible).toBe(0);
    expect(report.selectedOpportunities.every((o) => o.variantId === "CG_SCALEOUT_TP1_TRAIL")).toBe(true);
    expect(report.topRejects.map((r) => r.key)).toContain("LANE_DIAGNOSTIC_ONLY");
  });

  // [7]
  it("[7] candidate against a REJECT-status lane is not admitted (independent economics)", async () => {
    const dir = tmpDir();
    // Empty VM → CG_WIDE has insufficient sample / negative economics.
    const vmReport = buildEmptyVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate()] }),
    );
    expect(report.paperEligibleCount).toBe(0);
    expect(report.selectedOpportunities.length).toBe(0);
  });

  // [8]
  it("[8] eligible lane is admitted regardless of router's stable lane selection", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    // Router selection is advisory; allocator validates independently.
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate()] }),
    );
    expect(report.paperEligibleCount).toBeGreaterThanOrEqual(1);
  });

  // [9]
  it("[9] Bearish SHORT_ONLY creates a SHORT paper opportunity", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        routerReport: routerOf("Bearish pressure"),
        candidates: [makeCandidate({ direction: "SHORT" })],
      }),
    );
    expect(report.controllerMode).toBe("SHORT_ONLY");
    expect(report.paperEligibleCount).toBe(1);
    expect(report.selectedOpportunities[0]!.direction).toBe("SHORT");
  });

  // [10]
  it("[10] Mixed paper admission uses the active SYMBOL_SAFE_RELAXED budget profile", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const occupancyStore = new PaperExecutionRouterStore(tmpDir());
    const nowMs = Date.now();
    const currentPaperOrders = Array.from({ length: 10 }, (_, i) =>
      seedClosed(occupancyStore, {
        paperOrderId: `mixed-open-${i}`,
        dedupeKey: `mixed-open-${i}`,
        sourceObservationId: `mixed-open-${i}`,
        symbol: `OPEN${i}USDT`,
        direction: "SHORT",
        regime: "Mixed rotation",
        selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
        paperStatus: "PAPER_SUBMITTED",
        netR: null,
        openedAt: new Date(nowMs - (i < 3 ? 40 : 2) * 60 * 60 * 1000).toISOString(),
      }),
    );
    const mixedRegimeReport = buildMixedRegimeReport({
      regime: "Mixed rotation",
      candidates: [{
        symbol: "ETHUSDT",
        direction: "SHORT",
        regime: "Mixed rotation",
        laneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
        atrPercent: 0.8,
        volatilityScore: 0.5,
        liquidityScore: 0.9,
      }],
      orders: currentPaperOrders,
      nowMs,
      trailLaneAvailable: true,
    });
    expect(mixedRegimeReport.admissionResult).toBe("ALLOW_REDUCED");
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        marketRegime: "Mixed rotation",
        routerReport: routerOf("Mixed rotation"),
        candidates: [makeCandidate({ direction: "SHORT" })],
        paperValidationAllowed: false,
        currentPaperOrders,
        mixedRegimeReport,
      }),
    );
    expect(report.paperEligibleCount).toBe(1);
    const opp = report.selectedOpportunities[0]!;
    expect(opp.variantId).toBe("CG_WIDE_STOP_TP_WIDE");
    expect(opp.mixedBudgetProfile).toBe("SYMBOL_SAFE_RELAXED");
    expect(opp.mixedBudgetVersion).toBe(1);
    expect(opp.budgetActivationScope).toBe("PAPER_ONLY");
    expect(opp.admissionResult).toBe("ALLOW_REDUCED");
    expect(opp.occupancyMode).toBe("REDUCED_RISK");
    expect(opp.stalePassHealth).toBeDefined();
    expect(opp.riskMultiplierAfterOccupancy).toBeGreaterThan(0);
    expect(opp.budgetUsed).toBeDefined();
    expect(opp.budgetReason).toBeTruthy();

    const store = new PaperExecutionRouterStore(dir);
    const originalPaperStartAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    store.ensurePaperStartAt(originalPaperStartAt);
    const admitted = admitPaperOpportunities({
      store,
      opportunities: report.selectedOpportunities,
      routerReport: routerOf("Mixed rotation"),
      gateReport: emptyGate(),
      now: new Date().toISOString(),
    });
    expect(admitted.admitted).toBe(1);
    expect(store.getState().paperStartAt).toBe(originalPaperStartAt);
    const order = store.all.find((o) => o.sourceType === "SCAN_CANDIDATE_LANE_ALLOCATOR");
    expect(order).toBeDefined();
    expect(order!.mixedBudgetProfile).toBe("SYMBOL_SAFE_RELAXED");
    expect(order!.mixedBudgetVersion).toBe(1);
    expect(order!.budgetActivationScope).toBe("PAPER_ONLY");
    expect(order!.admissionResult).toBe(opp.admissionResult);
    expect(order!.occupancyMode).toBe(opp.occupancyMode);
    expect(order!.stalePassHealth).toBe(opp.stalePassHealth);
    expect(order!.riskMultiplierAfterOccupancy).toBe(opp.riskMultiplierAfterOccupancy);
    expect(order!.budgetUsed).toEqual(opp.budgetUsed);
    expect(order!.budgetReason).toBe(opp.budgetReason);
    expect(order!.riskPctOfEquity).toBeCloseTo(opp.riskMultiplierAfterOccupancy!);
    expect(order!.plannedRiskAmount).toBeCloseTo(
      DEFAULT_PAPER_EQUITY * 0.01 * opp.riskMultiplierAfterOccupancy!,
    );
    expect(order!.plannedPositionNotional).toBeLessThan(DEFAULT_PAPER_EQUITY * 0.01 / 0.03);
  });

  it("[10b] Mixed WAIT_FOR_CAPACITY creates no paper opportunity or order", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const baseMixedReport = mixedReportFor("ETHUSDT", "SHORT");
    const mixedRegimeReport: MixedRegimeReport = {
      ...baseMixedReport,
      activeMixedLane: null,
      activeMixedLanes: [],
      admissionResult: "WAIT_FOR_CAPACITY",
      occupancyMode: "WAIT_FOR_CAPACITY",
      states: baseMixedReport.states.map((state) => ({
        ...state,
        admissionResult: "WAIT_FOR_CAPACITY",
        occupancyMode: "WAIT_FOR_CAPACITY",
        risk: { ...state.risk, mBacklog: 0, riskMultiplier: 0 },
      })),
    };
    expect(mixedRegimeReport.admissionResult).toBe("WAIT_FOR_CAPACITY");

    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        marketRegime: "Mixed rotation",
        routerReport: routerOf("Mixed rotation"),
        candidates: [makeCandidate({ symbol: "ETHUSDT", direction: "SHORT" })],
        mixedRegimeReport,
      }),
    );
    expect(report.selectedOpportunities).toHaveLength(0);
    expect(report.topRejects.map((r) => r.key)).toContain("MIXED_WAIT_FOR_CAPACITY");
  });

  it("[10c] Mixed REJECT creates no paper opportunity or order", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const mixedRegimeReport = mixedReportFor("SEIUSDT", "SHORT");
    expect(mixedRegimeReport.admissionResult).toBe("REJECT");

    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        marketRegime: "Mixed rotation",
        routerReport: routerOf("Mixed rotation"),
        candidates: [makeCandidate({ symbol: "SEIUSDT", direction: "SHORT" })],
        mixedRegimeReport,
      }),
    );
    expect(report.selectedOpportunities).toHaveLength(0);
    expect(report.topRejects.map((r) => r.key)).toContain("MIXED_REJECT");
  });

  it("[10d] Mixed INSUFFICIENT_CONTEXT creates no paper opportunity or order", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const mixedRegimeReport = mixedReportFor(null, "SHORT");
    expect(mixedRegimeReport.admissionResult).toBe("INSUFFICIENT_CONTEXT");

    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        marketRegime: "Mixed rotation",
        routerReport: routerOf("Mixed rotation"),
        candidates: [makeCandidate({ symbol: "ETHUSDT", direction: "SHORT" })],
        mixedRegimeReport,
      }),
    );
    expect(report.selectedOpportunities).toHaveLength(0);
    expect(report.topRejects.map((r) => r.key)).toContain("MIXED_INSUFFICIENT_CONTEXT");
  });

  it("[10e] Mixed LONG creates an isolated DIAGNOSTIC_ONLY paper order", async () => {
    const dir = tmpDir();
    const vmReport = buildEmptyVmReport(dir);
    const candidate = makeCandidate({
      symbol: "BTCUSDT",
      direction: "LONG",
      stopLoss: 97,
      tp1: 104,
    });
    const mixedRegimeReport = buildMixedRegimeReport({
      regime: "Mixed rotation",
      candidates: [{
        symbol: "BTCUSDT",
        direction: "LONG",
        regime: "Mixed rotation",
        laneId: MIXED_LONG_WIDE_LANE,
        atrPercent: 0.8,
        volatilityScore: 0.5,
        liquidityScore: 0.9,
      }],
      orders: [],
      nowMs: Date.now(),
    });

    expect(mixedRegimeReport.states[0]!.mixedRouteDecision).toBe("ROUTE_LONG_CG_WIDE");
    expect(mixedRegimeReport.activeMixedLanes).toContain(MIXED_LONG_WIDE_LANE);

    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        marketRegime: "Mixed rotation",
        routerReport: routerOf("Mixed rotation"),
        candidates: [candidate],
        mixedRegimeReport,
      }),
    );

    expect(report.selectedOpportunities).toHaveLength(1);
    const opportunity = report.selectedOpportunities[0]!;
    expect(opportunity.laneId).toBe(MIXED_LONG_WIDE_LANE);
    expect(opportunity.direction).toBe("LONG");
    expect(opportunity.paperOrderMode).toBe("DIAGNOSTIC_ONLY");
    expect(opportunity.provenance?.candidateQualityFlags).toContain("MIXED_LONG_PAPER_OOS_COLLECTION");

    const store = new PaperExecutionRouterStore(dir);
    const paperStartAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    store.ensurePaperStartAt(paperStartAt);
    const admitted = admitPaperOpportunities({
      store,
      opportunities: report.selectedOpportunities,
      routerReport: routerOf("Mixed rotation"),
      gateReport: emptyGate(),
      now: new Date().toISOString(),
    });
    expect(admitted.admitted).toBe(1);
    expect(admitted.admittedDiagnostic).toBe(1);
    const order = store.all[0]!;
    expect(order.selectedLaneId).toBe(MIXED_LONG_WIDE_LANE);
    expect(order.direction).toBe("LONG");
    expect(order.paperOrderMode).toBe("DIAGNOSTIC_ONLY");
    expect(order.mixedBudgetProfile).toBe("SYMBOL_SAFE_RELAXED");
    expect(store.getState().paperStartAt).toBe(paperStartAt);
  });

  it("[10f] Mixed toxic LONG creates no paper order", async () => {
    const dir = tmpDir();
    const vmReport = buildEmptyVmReport(dir);
    const mixedRegimeReport = buildMixedRegimeReport({
      regime: "Mixed rotation",
      candidates: [{
        symbol: "SEIUSDT",
        direction: "LONG",
        regime: "Mixed rotation",
        laneId: MIXED_LONG_WIDE_LANE,
        atrPercent: 0.8,
        volatilityScore: 0.5,
        liquidityScore: 0.9,
      }],
      orders: [],
      nowMs: Date.now(),
    });
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        marketRegime: "Mixed rotation",
        routerReport: routerOf("Mixed rotation"),
        candidates: [makeCandidate({
          symbol: "SEIUSDT",
          direction: "LONG",
          stopLoss: 97,
          tp1: 104,
        })],
        mixedRegimeReport,
      }),
    );
    expect(report.selectedOpportunities).toHaveLength(0);
    expect(report.topRejects.map((r) => r.key)).toContain("MIXED_REJECT");
  });

  // [11]
  it("[11] Bullish LONG_ONLY does not create a SHORT paper order", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        marketRegime: "Bullish expansion",
        routerReport: routerOf("Bullish expansion"),
        candidates: [makeCandidate({ direction: "SHORT" })],
      }),
    );
    expect(report.controllerMode).toBe("LONG_ONLY");
    expect(report.selectedOpportunities.length).toBe(0);
  });

  it("[11b] Bullish LONG_ONLY creates isolated LONG paper-headline opportunities", async () => {
    const dir = tmpDir();
    const vmReport = buildEmptyVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        marketRegime: "Bullish expansion",
        routerReport: routerOf("Bullish expansion"),
        candidates: [makeCandidate({
          symbol: "BTCUSDT",
          direction: "LONG",
          stopLoss: 97,
          tp1: 104,
        })],
      }),
    );

    expect(report.controllerMode).toBe("LONG_ONLY");
    expect(report.selectedOpportunities).toHaveLength(1);
    const opportunity = report.selectedOpportunities[0]!;
    expect(opportunity.laneId).toBe("CG_LONG_VARIANT_MATRIX:CG_SCALEOUT_TP1_TRAIL");
    expect(opportunity.variantId).toBe("CG_SCALEOUT_TP1_TRAIL");
    expect(opportunity.direction).toBe("LONG");
    expect(opportunity.paperOrderMode).toBe("HEADLINE");
    expect(opportunity.paperRiskLabel).toBe("EXPERIMENTAL");
    expect(opportunity.provenance?.candidateQualityFlags).toContain("LONG_HEADLINE_FORWARD_OOS_COLLECTION");
    expect(opportunity.stopLoss).toBeLessThan(opportunity.entryPrice);
    expect(opportunity.takeProfitLevels[0]).toBeGreaterThan(opportunity.entryPrice);

    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    const admitted = admitPaperOpportunities({
      store,
      opportunities: report.selectedOpportunities,
      routerReport: routerOf("Bullish expansion"),
      gateReport: emptyGate(),
      now: new Date().toISOString(),
    });
    expect(admitted.admitted).toBe(1);
    expect(admitted.admittedHeadline).toBe(1);
    const order = store.all[0]!;
    expect(order.direction).toBe("LONG");
    expect(order.selectedLaneId).toBe("CG_LONG_VARIANT_MATRIX:CG_SCALEOUT_TP1_TRAIL");
    expect(order.paperOrderMode).toBe("HEADLINE");
    expect(order.reportOnly).toBe(true);
    expect(order.paperOnly).toBe(true);
  });

  it("[11b-bull] Bullish LONG_ONLY admits the pure bull trend lane alongside LONG scaleout headline", async () => {
    const dir = tmpDir();
    const vmReport = buildEmptyVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        marketRegime: "Bullish expansion",
        routerReport: routerOf("Bullish expansion"),
        paperVariantMatrixDiagnosticEnabled: true,
        candidates: [makeCandidate({
          symbol: "BTCUSDT",
          direction: "LONG",
          stopLoss: 97,
          tp1: 104,
          trendScore: 78,
          kronosBias: "LONG",
          whaleSignal: "BULLISH",
        })],
      }),
    );

    const bull = report.selectedOpportunities.find(
      (opportunity) => opportunity.variantId === "BL_TREND_R15_STOP200_FULL",
    );
    expect(bull).toBeDefined();
    expect(bull?.laneId).toBe("CG_LONG_VARIANT_MATRIX:BL_TREND_R15_STOP200_FULL");
    expect(bull?.paperOrderMode).toBe("DIAGNOSTIC_ONLY");
    expect(bull?.plannedStopDistanceBps).toBeGreaterThanOrEqual(200);
    expect(bull?.takeProfitLevels[0]).toBeGreaterThan(bull!.entryPrice);
    expect(bull?.provenance?.candidateQualityFlags).toContain("PURE_BULLISH_TREND_OOS");
    expect(
      report.selectedOpportunities.some(
        (opportunity) => opportunity.laneId === "CG_LONG_VARIANT_MATRIX:CG_SCALEOUT_TP1_TRAIL",
      ),
    ).toBe(true);
  });

  it("[11b-bull-gates] pure bull trend lane rejects weak trend and contra evidence", async () => {
    const dir = tmpDir();
    const vmReport = buildEmptyVmReport(dir);
    const common = {
      vmReport,
      marketRegime: "Bullish expansion",
      routerReport: routerOf("Bullish expansion"),
      paperVariantMatrixDiagnosticEnabled: true,
    };

    const weak = buildPaperOpportunityAllocatorReport(
      baseInputs({
        ...common,
        candidates: [makeCandidate({ direction: "LONG", stopLoss: 98, tp1: 103, trendScore: 59 })],
      }),
    );
    expect(
      weak.selectedOpportunities.some((opportunity) => opportunity.variantId === "BL_TREND_R15_STOP200_FULL"),
    ).toBe(false);
    expect(weak.topRejects.map((row) => row.key)).toContain("BULL_TREND_SCORE_BELOW_60");

    const contra = buildPaperOpportunityAllocatorReport(
      baseInputs({
        ...common,
        candidates: [makeCandidate({
          direction: "LONG",
          stopLoss: 98,
          tp1: 103,
          trendScore: 80,
          kronosBias: "SHORT",
        })],
      }),
    );
    expect(
      contra.selectedOpportunities.some((opportunity) => opportunity.variantId === "BL_TREND_R15_STOP200_FULL"),
    ).toBe(false);
    expect(contra.topRejects.map((row) => row.key)).toContain("BULL_TREND_KRONOS_CONTRA");
  });

  it("[11c] LONG collection does not alter bearish SHORT lane admission", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        marketRegime: "Bearish pressure",
        routerReport: routerOf("Bearish pressure"),
        candidates: [makeCandidate({ direction: "SHORT" })],
      }),
    );

    expect(report.selectedOpportunities).toHaveLength(1);
    expect(report.selectedOpportunities[0]!.laneId).toBe("CG_VARIANT_MATRIX:CG_SCALEOUT_TP1_TRAIL");
    expect(report.selectedOpportunities[0]!.paperOrderMode).toBe("HEADLINE");
  });

  // [12]
  it("[12] stale scan candidate is skipped (source freshness window)", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const stale = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min old
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        scanFinishedAt: stale,
        paperStartAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        candidates: [makeCandidate()],
      }),
    );
    expect(report.paperEligibleCount).toBe(0);
    expect(report.topRejects.map((r) => r.key)).toContain("SOURCE_STALE_FOR_PAPER");
  });

  // [13]
  it("[13] pre-paperStartAt candidate is excluded from headline admission", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const scanAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        scanFinishedAt: scanAt,
        // paperStartAt AFTER the scan → candidate predates paper start.
        paperStartAt: new Date(Date.now() - 60 * 1000).toISOString(),
        candidates: [makeCandidate()],
      }),
    );
    expect(report.paperEligibleCount).toBe(0);
    expect(report.topRejects.map((r) => r.key)).toContain("BACKFILL_PRE_PAPER_START");
  });

  // [14]
  it("[14] duplicate candidate in batch does not create a duplicate opportunity", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate(), makeCandidate()], // identical symbol+direction
      }),
    );
    expect(report.paperEligibleCount).toBe(1);
    expect(report.duplicateSuppressed).toBeGreaterThanOrEqual(1);
  });

  // [15]
  it("[15] no safe opportunity yields diagnostics, never blocker=none", async () => {
    const dir = tmpDir();
    const vmReport = buildEmptyVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate()] }),
    );
    expect(report.paperEligibleCount).toBe(0);
    expect(report.noOpportunityReason).toBe("NO_SAFE_PAPER_OPPORTUNITY");
    const lines = buildPaperOpportunityAllocatorBriefLines(report);
    const blockerLine = lines.find((l) => l.includes("allocatorBlocker="));
    expect(blockerLine).toBeDefined();
    expect(blockerLine).not.toContain("allocatorBlocker=none");
  });

  // [16]
  it("[16] operator brief renders allocator diagnostics line", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate()] }),
    );
    const brief = buildOperatorBrief({
      generatedAt: new Date().toISOString(),
      era: "POST_CALIBRATION",
      scanStatus: null,
      regimeReport: buildRegimeDirectionControllerReport({
        currentRegime: "Bearish pressure",
        adaptiveDirectionBias: null,
        primaryValidationLane: null,
      }),
      postCutoverReport: undefined,
      variantMatrixReport: vmReport,
      gateReport: emptyGate(),
      allocatorReport: report,
    });
    expect(brief).toContain("allocator: candidatesSeen=");
    expect(brief).toContain("universeAction=");
  });

  // [17]
  it("[17] Section 7 no longer says 'NO paper simulator until ≥100'", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const brief = buildOperatorBrief({
      generatedAt: new Date().toISOString(),
      era: "POST_CALIBRATION",
      scanStatus: null,
      regimeReport: buildRegimeDirectionControllerReport({
        currentRegime: "Bearish pressure",
        adaptiveDirectionBias: null,
        primaryValidationLane: null,
      }),
      postCutoverReport: undefined,
      variantMatrixReport: vmReport,
      gateReport: emptyGate(),
    });
    expect(brief).not.toContain("NO paper simulator until");
    expect(brief).toContain("Paper execution router is active for eligible experimental lanes only");
  });

  // [18]
  it("[18] report is reportOnly/paperOnly and never authorizes live trading", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate()] }),
    );
    expect(report.reportOnly).toBe(true);
    expect(report.paperOnly).toBe(true);
    expect(vmReport.liveBlocked).toBe(true);
  });

  // [19]
  it("[19] microPilotAllowed stays false", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    expect(vmReport.microPilotAllowed).toBe(false);
  });

  // [20]
  it("[20] admission writes only the paper store — never data/shadow-positions.json", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate()] }),
    );
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    admitPaperOpportunities({
      store,
      opportunities: report.selectedOpportunities,
      routerReport: routerOf("Bearish pressure"),
      gateReport: emptyGate(),
      now: new Date().toISOString(),
    });
    expect(existsSync(join(dir, "shadow-positions.json"))).toBe(false);
    expect(existsSync(join(dir, "paper-execution-router.json"))).toBe(true);
  });

  // [21]
  it("[21] admitted paper order is reportOnly/paperOnly with deterministic 1% sizing", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate()] }),
    );
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    const result = admitPaperOpportunities({
      store,
      opportunities: report.selectedOpportunities,
      routerReport: routerOf("Bearish pressure"),
      gateReport: emptyGate(),
      now: new Date().toISOString(),
    });
    expect(result.admitted).toBe(1);
    const order = store.all.find((o) => o.paperStatus === "CREATED");
    expect(order).toBeDefined();
    expect(order!.reportOnly).toBe(true);
    expect(order!.paperOnly).toBe(true);
    expect(order!.sourceType).toBe("SCAN_CANDIDATE_LANE_ALLOCATOR");
    expect(order!.paperEquity).toBe(DEFAULT_PAPER_EQUITY);
    expect(order!.plannedRiskAmount).toBe(DEFAULT_PAPER_EQUITY * 0.01);
  });

  // [22]
  it("[22] admission is deterministic — no exchange client involved, dedupe holds", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate()] }),
    );
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    const now = new Date().toISOString();
    admitPaperOpportunities({
      store,
      opportunities: report.selectedOpportunities,
      routerReport: routerOf("Bearish pressure"),
      gateReport: emptyGate(),
      now,
    });
    // Re-admit the same opportunities → all suppressed as duplicates.
    const second = admitPaperOpportunities({
      store,
      opportunities: report.selectedOpportunities,
      routerReport: routerOf("Bearish pressure"),
      gateReport: emptyGate(),
      now,
    });
    expect(second.admitted).toBe(0);
    expect(second.duplicateSuppressed).toBeGreaterThanOrEqual(1);
  });

  // [23]
  it("[23] zero scan candidates yields NO_FRESH_SCAN_CANDIDATE diagnostics", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [] }),
    );
    expect(report.candidatesSeen).toBe(0);
    expect(report.paperEligibleCount).toBe(0);
    expect(report.noOpportunityReason).toBe("NO_FRESH_SCAN_CANDIDATE");
    expect(report.suggestedUniverseAction).toBe("WAIT_NEXT_SCAN");
  });

  // ── PART 7 — adaptive lane quarantine / candidate gating / rotation (16) ────

  // [P7-1]
  it("[P7-1] DEGRADED lane (closed≥10, net<0) is quarantined", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate()], laneState: degradedLaneState() }),
    );
    expect(report.laneAdmissionStatus).toBe("QUARANTINED");
    expect(report.rotationAction).toBe("PAPER_ONLY_NO_REAL_APPROVAL");
    expect(report.blocker).toBe("ACTIVE_LANE_DEGRADED");
    expect(report.quarantineReason).toBeTruthy();
  });

  // [P7-2]
  it("[P7-2] a quarantined lane admits NO new HEADLINE orders", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate()], laneState: degradedLaneState() }),
    );
    expect(report.headlineEligibleCount).toBe(0);
    expect(report.selectedOpportunities.length).toBe(0);
    expect(report.topRejects.map((r) => r.key)).toContain("ACTIVE_LANE_DEGRADED");
    expect(report.noNewHeadlineOrderReason).toBeTruthy();
  });

  // [P7-3]
  it("[P7-3] quarantined lane collects DIAGNOSTIC_ONLY only when PAPER_DIAGNOSTIC_CONTINUE=1", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    // Flag OFF → no orders at all.
    const off = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate()], laneState: degradedLaneState() }),
    );
    expect(off.selectedOpportunities.length).toBe(0);
    // Flag ON → DIAGNOSTIC_ONLY collection.
    const on = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate()],
        laneState: degradedLaneState(),
        paperDiagnosticContinue: true,
      }),
    );
    expect(on.laneAdmissionStatus).toBe("DIAGNOSTIC_ONLY");
    expect(on.rotationAction).toBe("CONTINUE_DIAGNOSTIC_ONLY");
    expect(on.diagnosticEligibleCount).toBeGreaterThanOrEqual(1);
    expect(on.headlineEligibleCount).toBe(0);
    expect(on.selectedOpportunities.every((o) => o.paperOrderMode === "DIAGNOSTIC_ONLY")).toBe(true);
  });

  it("[P7-3b] quarantined wide lane can still collect one qualified trail challenger diagnostic", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const trail = vmReport.rows.find((row) => row.variantId === "CG_TRAIL_AFTER_TP1")!;
    trail.status = "COLLECTING";
    trail.freshValid = 60;
    trail.netAvgR = 0.2;
    trail.pf = 2;
    trail.plus10bpsStillPositive = true;

    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate({ symbol: "BTCUSDT" }), makeCandidate({ symbol: "ETHUSDT" })],
        laneState: degradedLaneState(),
        paperChallengerDiagnosticEnabled: true,
        paperChallengerDiagnosticMaxPerScan: 1,
      }),
    );

    const challengers = report.selectedOpportunities.filter(
      (opportunity) => opportunity.variantId === "CG_TRAIL_AFTER_TP1",
    );
    expect(challengers).toHaveLength(1);
    expect(challengers[0]!.paperOrderMode).toBe("DIAGNOSTIC_ONLY");
    expect(challengers[0]!.variantExitRule).toBe("trail_after_tp1");
    expect(challengers[0]!.plannedStopDistanceBps).toBeGreaterThanOrEqual(300);
    const challengerRisk = Math.abs(challengers[0]!.entryPrice - challengers[0]!.stopLoss);
    const challengerReward = Math.abs(challengers[0]!.takeProfitLevels[0]! - challengers[0]!.entryPrice);
    expect(challengerReward / challengerRisk).toBeCloseTo(1, 6);
    expect(report.challengerDiagnosticSelected).toBe(1);
    expect(report.headlineEligibleCount).toBe(0);
    expect(report.topRejects.map((row) => row.key)).toContain("CHALLENGER_DIAGNOSTIC_CAP_REACHED");
  });

  // [P7-3c] Gate A: raw candidate TP1 too close to entry → TRAIL_TP1_TOO_CLOSE_FOR_TRAIL
  it("[P7-3c] Gate A: SHORT challenger with raw tp1 too close to entry is rejected (TRAIL_TP1_TOO_CLOSE_FOR_TRAIL)", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const trail = vmReport.rows.find((row) => row.variantId === "CG_TRAIL_AFTER_TP1")!;
    trail.status = "COLLECTING";
    trail.freshValid = 60;
    trail.netAvgR = 0.2;
    trail.pf = 2;
    trail.plus10bpsStillPositive = true;

    // SHORT: entry=100, stop=103 (300bps), tp1=99.98 (~2bps raw TP1)
    // rawTp1Bps ≈ 2, threshold = 300 * 0.15 = 45 → 2 < 45 → Gate A fires.
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate({ tp1: 99.98 })],
        laneState: degradedLaneState(),
        paperChallengerDiagnosticEnabled: true,
      }),
    );

    expect(report.topRejects.map((r) => r.key)).toContain("TRAIL_TP1_TOO_CLOSE_FOR_TRAIL");
    expect(report.selectedOpportunities.filter((o) => o.variantId === "CG_TRAIL_AFTER_TP1")).toHaveLength(0);
  });

  // [P7-3d] Gate B: Kronos contra-direction → TRAIL_KRONOS_CONTRA_BIAS
  it("[P7-3d] Gate B: SHORT challenger with kronosBias LONG is rejected (TRAIL_KRONOS_CONTRA_BIAS)", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const trail = vmReport.rows.find((row) => row.variantId === "CG_TRAIL_AFTER_TP1")!;
    trail.status = "COLLECTING";
    trail.freshValid = 60;
    trail.netAvgR = 0.2;
    trail.pf = 2;
    trail.plus10bpsStillPositive = true;

    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate({ kronosBias: "LONG" })],
        laneState: degradedLaneState(),
        paperChallengerDiagnosticEnabled: true,
      }),
    );

    expect(report.topRejects.map((r) => r.key)).toContain("TRAIL_KRONOS_CONTRA_BIAS");
    expect(report.selectedOpportunities.filter((o) => o.variantId === "CG_TRAIL_AFTER_TP1")).toHaveLength(0);
  });

  // [P7-3e] Gate C: open TRAIL order for same symbol+direction → TRAIL_SYMBOL_SLOT_OCCUPIED
  it("[P7-3e] Gate C: challenger for symbol with an open TRAIL order is rejected (TRAIL_SYMBOL_SLOT_OCCUPIED)", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const trail = vmReport.rows.find((row) => row.variantId === "CG_TRAIL_AFTER_TP1")!;
    trail.status = "COLLECTING";
    trail.freshValid = 60;
    trail.netAvgR = 0.2;
    trail.pf = 2;
    trail.plus10bpsStillPositive = true;

    // Build an open TRAIL SHORT for ETHUSDT using seedClosed overrides.
    const seedStore = new PaperExecutionRouterStore(tmpDir());
    const openTrailOrder = seedClosed(seedStore, {
      symbol: "ETHUSDT",
      direction: "SHORT",
      selectedLaneId: "CG_VARIANT_MATRIX:CG_TRAIL_AFTER_TP1",
      paperStatus: "CREATED",
      closeReason: null,
    });

    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate({ symbol: "ETHUSDT" })],
        laneState: degradedLaneState(),
        paperChallengerDiagnosticEnabled: true,
        currentPaperOrders: [openTrailOrder],
      }),
    );

    expect(report.topRejects.map((r) => r.key)).toContain("TRAIL_SYMBOL_SLOT_OCCUPIED");
    expect(report.selectedOpportunities.filter((o) => o.variantId === "CG_TRAIL_AFTER_TP1")).toHaveLength(0);
  });

  // [P7-3f] Gate D: contra-direction whale → TRAIL_WHALE_CONTRA_BIAS
  it("[P7-3f] Gate D: SHORT challenger with whaleSignal BULLISH is rejected (TRAIL_WHALE_CONTRA_BIAS)", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const trail = vmReport.rows.find((row) => row.variantId === "CG_TRAIL_AFTER_TP1")!;
    trail.status = "COLLECTING";
    trail.freshValid = 60;
    trail.netAvgR = 0.2;
    trail.pf = 2;
    trail.plus10bpsStillPositive = true;

    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate({ whaleSignal: "BULLISH" })],
        laneState: degradedLaneState(),
        paperChallengerDiagnosticEnabled: true,
      }),
    );

    expect(report.topRejects.map((r) => r.key)).toContain("TRAIL_WHALE_CONTRA_BIAS");
    expect(report.selectedOpportunities.filter((o) => o.variantId === "CG_TRAIL_AFTER_TP1")).toHaveLength(0);
  });

  // [P7-3g] Gate D pass-through: aligned/NEUTRAL whale does not block admission.
  it("[P7-3g] Gate D: BEARISH (aligned) whale on a SHORT challenger is NOT rejected by Gate D", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const t = vmReport.rows.find((row) => row.variantId === "CG_TRAIL_AFTER_TP1")!;
    t.status = "COLLECTING";
    t.freshValid = 60;
    t.netAvgR = 0.2;
    t.pf = 2;
    t.plus10bpsStillPositive = true;

    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate({ whaleSignal: "BEARISH" })],
        laneState: degradedLaneState(),
        paperChallengerDiagnosticEnabled: true,
        paperChallengerDiagnosticMaxPerScan: 1,
      }),
    );

    expect(report.topRejects.map((r) => r.key)).not.toContain("TRAIL_WHALE_CONTRA_BIAS");
  });

  // [P7-3h] Gate E: quarantine rejects an otherwise-clean challenger candidate.
  it("[P7-3h] Gate E: with paperChallengerQuarantined a gate-clean trail candidate is rejected (TRAIL_LANE_QUARANTINED)", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const t = vmReport.rows.find((row) => row.variantId === "CG_TRAIL_AFTER_TP1")!;
    t.status = "COLLECTING";
    t.freshValid = 60;
    t.netAvgR = 0.2;
    t.pf = 2;
    t.plus10bpsStillPositive = true;

    // makeCandidate() default is gate-clean (passes A–D); only the quarantine blocks it.
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate()],
        laneState: degradedLaneState(),
        paperChallengerDiagnosticEnabled: true,
        paperChallengerQuarantined: true,
      }),
    );

    expect(report.topRejects.map((r) => r.key)).toContain("TRAIL_LANE_QUARANTINED");
    expect(report.topRejects.map((r) => r.key)).not.toContain("TRAIL_TP1_TOO_CLOSE_FOR_TRAIL");
    expect(
      report.selectedOpportunities.filter((o) => o.variantId === "CG_TRAIL_AFTER_TP1"),
    ).toHaveLength(0);
  });

  // [P7-3i] Full variant-matrix diagnostic admits the 4 non-headline variants as DIAGNOSTIC_ONLY.
  it("[P7-3i] variant-matrix diagnostic admits baseline/scaleout/no-fib500/maker as DIAGNOSTIC_ONLY (never HEADLINE)", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);

    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate()], // gate-clean SHORT ETHUSDT
        laneState: degradedLaneState(),
        paperVariantMatrixDiagnosticEnabled: true,
      }),
    );

    const diagVariants = report.selectedOpportunities
      .filter((o) => o.paperOrderMode === "DIAGNOSTIC_ONLY")
      .map((o) => o.variantId);
    for (const v of [
      "CG_BASELINE_CURRENT",
      "CG_SCALEOUT_TP1_TRAIL",
      "CG_NO_FIB500_ENTRYSET",
      "CG_MAKER_LIMIT_SIM",
    ]) {
      expect(diagVariants).toContain(v);
    }
    // Maker carries its fill mode so the resolver models no-fill honestly.
    const maker = report.selectedOpportunities.find((o) => o.variantId === "CG_MAKER_LIMIT_SIM");
    expect(maker?.fillMode).toBe("maker_limit");
    // These sleeves must NEVER enter headline accounting.
    const headlineVariants = report.selectedOpportunities
      .filter((o) => o.paperOrderMode === "HEADLINE")
      .map((o) => o.variantId);
    expect(headlineVariants).not.toContain("CG_SCALEOUT_TP1_TRAIL");
    expect(headlineVariants).not.toContain("CG_MAKER_LIMIT_SIM");
  });

  // [P7-3j] When the flag is OFF, those variants stay rejected (no behavior change by default).
  it("[P7-3j] without the flag, scaleout/maker are NOT admitted", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate()], laneState: degradedLaneState() }),
    );
    const admitted = report.selectedOpportunities.map((o) => o.variantId);
    expect(admitted).not.toContain("CG_SCALEOUT_TP1_TRAIL");
    expect(admitted).not.toContain("CG_MAKER_LIMIT_SIM");
  });

  // [P7-3k] Auto-quarantine detection: confident net-negative variant lanes only; never headline.
  it("[P7-3k] computeAutoQuarantinedVariantLanes flags only confident net-negative variant lanes", () => {
    const mk = (laneId: string, netR: number) =>
      ({ selectedLaneId: laneId, netR } as unknown as Parameters<typeof computeAutoQuarantinedVariantLanes>[0][number]);
    const orders = [
      // confirmed-negative baseline LONG: 120 closed at -0.05R → quarantine
      ...Array.from({ length: 120 }, () => mk("CG_LONG_VARIANT_MATRIX:CG_BASELINE_CURRENT", -0.05)),
      // winning scaleout SHORT: 120 closed at +0.1R → keep
      ...Array.from({ length: 120 }, () => mk("CG_VARIANT_MATRIX:CG_SCALEOUT_TP1_TRAIL", 0.1)),
      // small-sample negative no-fib500: only 30 closed → below MIN (40), keep
      ...Array.from({ length: 30 }, () => mk("CG_VARIANT_MATRIX:CG_NO_FIB500_ENTRYSET", -0.1)),
      // headline CG_WIDE losing hard: NEVER a candidate (not a variant-diagnostic id)
      ...Array.from({ length: 300 }, () => mk("CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE", -0.2)),
    ];
    const q = computeAutoQuarantinedVariantLanes(orders);
    expect(q).toContain("CG_LONG_VARIANT_MATRIX:CG_BASELINE_CURRENT");
    expect(q).not.toContain("CG_VARIANT_MATRIX:CG_SCALEOUT_TP1_TRAIL");
    expect(q).not.toContain("CG_VARIANT_MATRIX:CG_NO_FIB500_ENTRYSET");
    expect(q).not.toContain("CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE");
  });

  // [P7-3l] An auto-quarantined variant lane stops admitting; sibling variants keep collecting.
  it("[P7-3l] auto-quarantined variant lane halts admission (VARIANT_LANE_AUTO_QUARANTINED)", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    // Seed a confirmed-negative SHORT baseline lane (matches the SHORT candidate's baseline lane id).
    const losers = Array.from(
      { length: 130 },
      () =>
        ({
          selectedLaneId: "CG_VARIANT_MATRIX:CG_BASELINE_CURRENT",
          direction: "SHORT",
          netR: -0.05,
          paperStatus: "PAPER_CLOSED_LOSS",
        } as unknown as PaperOpportunityAllocatorInputs["currentPaperOrders"][number]),
    );

    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate()],
        laneState: degradedLaneState(),
        paperVariantMatrixDiagnosticEnabled: true,
        paperVariantAutoQuarantineEnabled: true,
        currentPaperOrders: losers,
      }),
    );

    // Baseline is halted...
    expect(
      report.selectedOpportunities.filter((o) => o.variantId === "CG_BASELINE_CURRENT"),
    ).toHaveLength(0);
    expect(report.topRejects.map((r) => r.key)).toContain("VARIANT_LANE_AUTO_QUARANTINED");
    // ...while sibling variants still collect.
    expect(
      report.selectedOpportunities.some((o) => o.variantId === "CG_SCALEOUT_TP1_TRAIL"),
    ).toBe(true);
  });

  // [P7-3m] CG_WIDE priority overrides the VM-sim ECONOMICS_REJECT veto.
  it("[P7-3m] paperCgWidePriority admits CG_WIDE even when its VM-sim row is REJECT", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const wide = vmReport.rows.find((r) => r.variantId === "CG_WIDE_STOP_TP_WIDE")!;
    wide.status = "REJECT";
    wide.netAvgR = -0.24;
    wide.pf = 0.61;

    // Without priority → CG_WIDE is vetoed by ECONOMICS_REJECT.
    const off = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate()] }),
    );
    expect(off.selectedOpportunities.some((o) => o.variantId === "CG_WIDE_STOP_TP_WIDE")).toBe(false);
    expect(off.topRejects.map((r) => r.key)).toContain("ECONOMICS_REJECT");

    // With priority → admitted despite the REJECT row.
    const on = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate()], paperCgWidePriority: true }),
    );
    expect(on.selectedOpportunities.some((o) => o.variantId === "CG_WIDE_STOP_TP_WIDE")).toBe(true);
  });

  // [P7-3n] CG_WIDE priority trims diagnostics so CG_WIDE keeps the target share.
  it("[P7-3n] paperCgWidePriority trims diagnostics to keep CG_WIDE at >= target share", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);

    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate()],
        paperCgWidePriority: true,
        paperVariantMatrixDiagnosticEnabled: true,
        paperCgWideTargetShare: 0.9,
      }),
    );
    const wideN = report.selectedOpportunities.filter((o) => o.variantId === "CG_WIDE_STOP_TP_WIDE").length;
    const otherN = report.selectedOpportunities.filter((o) => o.variantId !== "CG_WIDE_STOP_TP_WIDE").length;
    expect(wideN).toBeGreaterThanOrEqual(1);
    // 1 CG_WIDE ⇒ maxOthers = floor(1 * 0.1/0.9) = 0 ⇒ all diagnostics trimmed this scan.
    expect(otherN).toBe(0);
  });

  it("[P7-3o] CG_WIDE priority respects the 26-open occupancy cap and renders explicit capacity", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const now = new Date().toISOString();
    const openWide = Array.from({ length: 26 }, (_, i) => ({
      paperOrderId: `wide-open-${i}`,
      sourceType: "SCAN_CANDIDATE_LANE_ALLOCATOR",
      sourceCandidateId: `wide-open-${i}`,
      scanBatchId: "seed-batch",
      sourceObservationId: `wide-open-${i}`,
      sourceSignalId: `wide-open-${i}`,
      dedupeKey: `wide-open-${i}`,
      createdAt: now,
      updatedAt: now,
      openedAt: now,
      symbol: `SYM${i}USDT`,
      direction: "SHORT",
      selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
      paperOrderMode: "DIAGNOSTIC_ONLY",
      paperStatus: "PAPER_SUBMITTED",
      reportOnly: true,
      paperOnly: true,
    } as unknown as PaperOrder));

    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate()],
        paperCgWidePriority: true,
        currentPaperOrders: openWide,
      }),
    );

    expect(report.selectedOpportunities.some((o) => o.variantId === "CG_WIDE_STOP_TP_WIDE")).toBe(false);
    expect(report.topRejects.map((row) => row.key)).toContain("CG_WIDE_MAX_OPEN_REACHED");
    expect(report.cgWideOpenCount).toBe(26);
    expect(report.cgWideMaxOpen).toBe(26);
    expect(report.cgWideMaxPerSymbolOpen).toBe(2);
    expect(report.cgWideMaxPerDirectionOpen).toBe(24);
    expect(report.cgWideMaxStaleOpen).toBe(16);
    expect(report.cgWideElevatedOpenThreshold).toBe(19);
    expect(report.cgWideCapacityPressure).toBe("FULL");
    expect(report.headlineOpenCount).toBe(0);
    expect(report.diagnosticOpenCount).toBe(26);

    const lines = buildPaperOpportunityAllocatorBriefLines(report);
    expect(lines.some((line) => line.includes("longPaperLane="))).toBe(false);
    expect(lines.some((line) => line.includes("longHeadlineLane=CG_LONG_VARIANT_MATRIX:CG_SCALEOUT_TP1_TRAIL"))).toBe(true);
    expect(lines.some((line) => line.includes("longDiagnosticLane=CG_LONG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE"))).toBe(true);
    expect(lines.some((line) => line.includes("paperAccounting: headlineCreated=0"))).toBe(true);
    expect(lines.some((line) => line.includes("headlineOpen=0 diagnosticCreated=0 diagnosticOpen=26 note=DIAGNOSTIC_OPEN_ONLY"))).toBe(true);
    expect(lines.some((line) => line.includes("cgWideCapacity: open=26/26"))).toBe(true);
    expect(lines.some((line) => line.includes("warningAt=19 pressure=FULL"))).toBe(true);
  });

  // [P7-4]
  it("[P7-4] DIAGNOSTIC_ONLY orders are excluded from headline net/PF/WR accounting", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const alloc = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate()],
        laneState: degradedLaneState(),
        paperDiagnosticContinue: true,
      }),
    );
    expect(alloc.selectedOpportunities.length).toBeGreaterThanOrEqual(1);
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    admitPaperOpportunities({
      store,
      opportunities: alloc.selectedOpportunities,
      routerReport: routerOf("Bearish pressure"),
      gateReport: emptyGate(),
      now: new Date().toISOString(),
    });
    const order = store.all.find((o) => o.paperStatus === "CREATED");
    expect(order?.paperOrderMode).toBe("DIAGNOSTIC_ONLY");
    const perf = buildPaperPerformanceReport(store);
    expect(perf.diagnosticOnlyTotal).toBe(1);
    expect(perf.headlineTotal).toBe(0);
    expect(perf.headlineClosed).toBe(0);
    expect(perf.headlineNetAvgR).toBeNull();
    expect(perf.headlinePF).toBeNull();
    expect(perf.headlineWR).toBeNull();
  });

  // [P7-5]
  it("[P7-5] RAW_EDGE_NOT_VALIDATED candidate is rejected for HEADLINE CG_WIDE", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [
          makeCandidate({ calibrationVerdict: "RAW_EDGE_NOT_VALIDATED", calibratedExpectedNetR: -0.1 }),
        ],
      }),
    );
    expect(report.paperEligibleCount).toBe(0);
    expect(report.topRejects.map((r) => r.key)).toContain("CANDIDATE_RAW_EDGE_NOT_VALIDATED");
  });

  // [P7-6]
  it("[P7-6] ALL_REPLAY_VARIANTS_NEGATIVE candidate is rejected for HEADLINE", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate({ routeReasonCodes: ["ALL_REPLAY_VARIANTS_NEGATIVE"] })],
      }),
    );
    expect(report.paperEligibleCount).toBe(0);
    expect(report.topRejects.map((r) => r.key)).toContain("CANDIDATE_ALL_REPLAY_VARIANTS_NEGATIVE");
  });

  // [P7-7]
  it("[P7-7] SYMBOL_NET_NEGATIVE is rejected unless the symbol has positive cohort evidence", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    // No cohort override → rejected.
    const rejected = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate({ symbol: "ETHUSDT", routeReasonCodes: ["SYMBOL_NET_NEGATIVE"] })],
      }),
    );
    expect(rejected.paperEligibleCount).toBe(0);
    expect(rejected.topRejects.map((r) => r.key)).toContain("CANDIDATE_SYMBOL_NET_NEGATIVE");
    // Cohort override for that symbol → admitted.
    const admitted = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate({ symbol: "ETHUSDT", routeReasonCodes: ["SYMBOL_NET_NEGATIVE"] })],
        symbolsWithPositiveCohort: ["ETHUSDT"],
      }),
    );
    expect(admitted.paperEligibleCount).toBe(1);
    expect(admitted.headlineEligibleCount).toBe(1);
  });

  // [P7-8]
  it("[P7-8] chaseRisk=HIGH is rejected for HEADLINE but eligible as DIAGNOSTIC_ONLY", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    // HEADLINE batch (healthy lane) → rejected.
    const headline = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate({ chaseRisk: "HIGH" })],
        laneState: healthyLaneState(),
      }),
    );
    expect(headline.paperEligibleCount).toBe(0);
    expect(headline.topRejects.map((r) => r.key)).toContain("CANDIDATE_CHASE_RISK_HIGH");
    // DIAGNOSTIC_ONLY batch (degraded lane + continue) → collected.
    const diag = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate({ chaseRisk: "HIGH" })],
        laneState: degradedLaneState(),
        paperDiagnosticContinue: true,
      }),
    );
    expect(diag.diagnosticEligibleCount).toBe(1);
    expect(diag.selectedOpportunities[0]!.paperOrderMode).toBe("DIAGNOSTIC_ONLY");
  });

  // [P7-9]
  it("[P7-9] sourceConflict is rejected unless calibrated-positive compensating evidence exists", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    // Conflict + no compensating calibration → rejected.
    const rejected = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [
          makeCandidate({
            sourceConflict: true,
            calibrationVerdict: "INSUFFICIENT_SAMPLE",
            calibratedExpectedNetR: 0,
          }),
        ],
      }),
    );
    expect(rejected.paperEligibleCount).toBe(0);
    expect(rejected.topRejects.map((r) => r.key)).toContain("CANDIDATE_SOURCE_CONFLICT");
    // Conflict + calibrated-positive net>0 → admitted.
    const admitted = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [
          makeCandidate({
            sourceConflict: true,
            calibrationVerdict: "CALIBRATED_POSITIVE",
            calibratedExpectedNetR: 0.2,
          }),
        ],
      }),
    );
    expect(admitted.paperEligibleCount).toBe(1);
  });

  // [P7-10]
  it("[P7-10] a better eligible lane yields ROTATE_TO_BETTER_LANE", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    // Better lane is a DIFFERENT (non-admissible) lane → quarantine + rotate, no orders.
    const other = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate()],
        laneState: degradedLaneState({
          betterLaneAvailable: true,
          selectedNextLaneId: "CG_VARIANT_MATRIX:CG_TRAIL_RUNNER",
        }),
      }),
    );
    expect(other.rotationAction).toBe("ROTATE_TO_BETTER_LANE");
    expect(other.laneAdmissionStatus).toBe("QUARANTINED");
    expect(other.headlineEligibleCount).toBe(0);
    // Better lane IS the allocator's admission target → resume HEADLINE there.
    const target = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate()],
        laneState: degradedLaneState({
          activeLaneId: "CG_VARIANT_MATRIX:CG_TRAIL_RUNNER",
          betterLaneAvailable: true,
          selectedNextLaneId: "CG_VARIANT_MATRIX:CG_SCALEOUT_TP1_TRAIL",
        }),
      }),
    );
    expect(target.rotationAction).toBe("ROTATE_TO_BETTER_LANE");
    expect(target.laneAdmissionStatus).toBe("ACTIVE");
    expect(target.headlineEligibleCount).toBe(1);
  });

  // [P7-11]
  it("[P7-11] no better lane → CONTINUE_DIAGNOSTIC_ONLY (flag) else PAPER_ONLY_NO_REAL_APPROVAL", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const noFlag = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate()], laneState: degradedLaneState() }),
    );
    expect(noFlag.rotationAction).toBe("PAPER_ONLY_NO_REAL_APPROVAL");
    const withFlag = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate()],
        laneState: degradedLaneState(),
        paperDiagnosticContinue: true,
      }),
    );
    expect(withFlag.rotationAction).toBe("CONTINUE_DIAGNOSTIC_ONLY");
  });

  // [P7-12]
  it("[P7-12] brief never shows allocatorBlocker=none when the lane is DEGRADED", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate()], laneState: degradedLaneState() }),
    );
    const lines = buildPaperOpportunityAllocatorBriefLines(report);
    const blockerLine = lines.find((l) => l.includes("allocatorBlocker="));
    expect(blockerLine).toBeDefined();
    expect(blockerLine).not.toContain("allocatorBlocker=none");
    expect(blockerLine).toContain("ACTIVE_LANE_DEGRADED");
    expect(lines.some((l) => l.includes("laneAdmission=QUARANTINED"))).toBe(true);
  });

  // [P7-13]
  it("[P7-13] quarantine never authorizes live trading (liveBlocked stays true)", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate()], laneState: degradedLaneState() }),
    );
    expect(report.reportOnly).toBe(true);
    expect(report.paperOnly).toBe(true);
    expect(vmReport.liveBlocked).toBe(true);
  });

  // [P7-14]
  it("[P7-14] microPilotAllowed stays false under quarantine", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate()], laneState: degradedLaneState() }),
    );
    expect(vmReport.microPilotAllowed).toBe(false);
  });

  // [P7-15]
  it("[P7-15] DIAGNOSTIC_ONLY admission writes only the paper store — never shadow-positions.json", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const alloc = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate()],
        laneState: degradedLaneState(),
        paperDiagnosticContinue: true,
      }),
    );
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    admitPaperOpportunities({
      store,
      opportunities: alloc.selectedOpportunities,
      routerReport: routerOf("Bearish pressure"),
      gateReport: emptyGate(),
      now: new Date().toISOString(),
    });
    expect(existsSync(join(dir, "shadow-positions.json"))).toBe(false);
    expect(existsSync(join(dir, "paper-execution-router.json"))).toBe(true);
  });

  // [P7-16]
  it("[P7-16] admission involves no real exchange client — orders stay reportOnly/paperOnly", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const alloc = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate()],
        laneState: degradedLaneState(),
        paperDiagnosticContinue: true,
      }),
    );
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    // admitPaperOpportunities takes NO binance/exchange client argument.
    const result = admitPaperOpportunities({
      store,
      opportunities: alloc.selectedOpportunities,
      routerReport: routerOf("Bearish pressure"),
      gateReport: emptyGate(),
      now: new Date().toISOString(),
    });
    expect(result.admitted).toBeGreaterThanOrEqual(1);
    for (const o of store.all) {
      expect(o.reportOnly).toBe(true);
      expect(o.paperOnly).toBe(true);
      // No real submission: paper orders never reach a live/exchange status.
      expect(o.paperStatus).not.toBe("PAPER_SUBMITTED");
    }
  });

  // ── PART 8 — provenance V1 + shadow loser-fingerprint gate (report-only) (14) ─

  // [PV-1]
  it("[PV-1] admission persists candidate provenance (sourceConflict/chaseRisk/calibrationVerdict/calibratedExpectedNetR/routeReasonCodes)", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const alloc = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [
          makeCandidate({
            calibrationVerdict: "CALIBRATED_POSITIVE",
            calibratedExpectedNetR: 0.33,
            chaseRisk: "MEDIUM",
          }),
        ],
      }),
    );
    expect(alloc.selectedOpportunities.length).toBeGreaterThanOrEqual(1);
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    admitPaperOpportunities({
      store,
      opportunities: alloc.selectedOpportunities,
      routerReport: routerOf("Bearish pressure"),
      gateReport: emptyGate(),
      now: new Date().toISOString(),
    });
    const order = store.all.find((o) => o.paperStatus === "CREATED");
    expect(order).toBeDefined();
    const p = order!.provenance;
    expect(p).not.toBeNull();
    expect(p!.calibrationVerdict).toBe("CALIBRATED_POSITIVE");
    expect(p!.calibratedExpectedNetR).toBe(0.33);
    expect(p!.chaseRisk).toBe("MEDIUM");
    expect(p!.sourceConflict).toBe(false);
    expect(Array.isArray(p!.routeReasonCodes)).toBe(true);
  });

  // [PV-2]
  it("[PV-2] unavailable provenance fields persist as null and are named in provenanceFieldMissing", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    // A candidate with no execution plan is HEADLINE-ineligible (FIELD_MISSING)
    // but DIAGNOSTIC_ONLY-collectable under a quarantined lane + continue flag.
    const alloc = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [makeCandidate({ noExecutionPlan: true })],
        laneState: degradedLaneState(),
        paperDiagnosticContinue: true,
      }),
    );
    expect(alloc.selectedOpportunities.length).toBeGreaterThanOrEqual(1);
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    admitPaperOpportunities({
      store,
      opportunities: alloc.selectedOpportunities,
      routerReport: routerOf("Bearish pressure"),
      gateReport: emptyGate(),
      now: new Date().toISOString(),
    });
    const order = store.all.find((o) => o.paperStatus === "CREATED");
    expect(order).toBeDefined();
    expect(order!.paperOrderMode).toBe("DIAGNOSTIC_ONLY");
    expect(order!.provenance!.calibrationVerdict).toBeNull();
    expect(order!.provenance!.calibratedExpectedNetR).toBeNull();
    expect(order!.provenance!.chaseRisk).toBeNull();
    const missing = order!.provenanceFieldMissing ?? [];
    expect(missing).toContain("calibrationVerdict");
    expect(missing).toContain("calibratedExpectedNetR");
    expect(missing).toContain("chaseRisk");
  });

  // [PV-3]
  it("[PV-3] provenance audit groups losses by symbol/regime/routeMode/calibrationVerdict/chaseRisk", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    seedClosed(store, { symbol: "SEIUSDT", provenance: fullProvenance({ chaseRisk: "HIGH", routeMode: "DATA_COLLECTION", calibrationVerdict: "RAW_EDGE_NOT_VALIDATED" }) });
    seedClosed(store, { symbol: "SEIUSDT", provenance: fullProvenance({ chaseRisk: "HIGH", routeMode: "DATA_COLLECTION", calibrationVerdict: "RAW_EDGE_NOT_VALIDATED" }) });
    seedClosed(store, { symbol: "WLDUSDT", regime: "Bullish pressure", provenance: fullProvenance({ chaseRisk: "LOW", routeMode: "PROFIT_CANDIDATE", calibrationVerdict: "CALIBRATED_POSITIVE" }) });
    const audit = buildPaperProvenanceAudit(store);
    expect(audit.closed).toBe(3);
    expect(audit.lossesBySymbol.find((r) => r.key === "SEIUSDT")?.losses).toBe(2);
    expect(audit.lossesByRegime.find((r) => r.key === "Bearish pressure")?.losses).toBe(2);
    expect(audit.lossesByRegime.find((r) => r.key === "Bullish pressure")?.losses).toBe(1);
    expect(audit.lossesByRouteMode.find((r) => r.key === "DATA_COLLECTION")?.losses).toBe(2);
    expect(audit.lossesByCalibrationVerdict.find((r) => r.key === "RAW_EDGE_NOT_VALIDATED")?.losses).toBe(2);
    expect(audit.lossesByChaseRisk.find((r) => r.key === "HIGH")?.losses).toBe(2);
    expect(audit.topLoserFingerprints.length).toBeGreaterThanOrEqual(1);
  });

  // [PV-4]
  it("[PV-4] gate simulation is strictly report-only — never blocks/activates and never mutates the store", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    for (let i = 0; i < 5; i++) seedClosed(store);
    const before = store.all.length;
    const gate = simulateLoserFingerprintGate(store);
    expect(gate.active).toBe(false);
    expect(gate.activeGateChange).toBe("NO");
    expect(gate.reportOnly).toBe(true);
    expect(gate.paperOnly).toBe(true);
    // Pure read — order count is unchanged and no order flipped status.
    expect(store.all.length).toBe(before);
    expect(store.all.every((o) => o.paperStatus === "PAPER_CLOSED_LOSS")).toBe(true);
  });

  // [PV-5]
  it("[PV-5] gate simulation reports both losses avoided and wins sacrificed", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    // SOURCE_CONFLICT gate matches both a loser and a winner.
    seedClosed(store, { provenance: fullProvenance({ sourceConflict: true }) });
    seedClosed(store, { provenance: fullProvenance({ sourceConflict: true }) });
    seedWin(store, { provenance: fullProvenance({ sourceConflict: true }) });
    seedWin(store, { provenance: fullProvenance({ sourceConflict: false }) });
    const gate = simulateLoserFingerprintGate(store);
    const sc = gate.gates.find((g) => g.gateId === "SOURCE_CONFLICT")!;
    expect(sc.lossesAvoided).toBe(2);
    expect(sc.winsSacrificed).toBe(1);
    expect(sc.falsePositiveCostR).toBeGreaterThan(0);
  });

  // [PV-6]
  it("[PV-6] RAW_EDGE_NOT_VALIDATED gate matches only orders with that calibration verdict", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    seedClosed(store, { provenance: fullProvenance({ calibrationVerdict: "RAW_EDGE_NOT_VALIDATED" }) });
    seedClosed(store, { provenance: fullProvenance({ calibrationVerdict: "RAW_EDGE_NOT_VALIDATED" }) });
    seedClosed(store, { provenance: fullProvenance({ calibrationVerdict: "CALIBRATED_POSITIVE" }) });
    const gate = simulateLoserFingerprintGate(store);
    const g = gate.gates.find((x) => x.gateId === "RAW_EDGE_NOT_VALIDATED")!;
    expect(g.tradesRemoved).toBe(2);
    expect(g.lossesAvoided).toBe(2);
    expect(g.netRImprovement).toBeGreaterThan(0);
  });

  // [PV-7]
  it("[PV-7] ALL_REPLAY_VARIANTS_NEGATIVE gate matches orders carrying that route reason code", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    seedClosed(store, { provenance: fullProvenance({ routeReasonCodes: ["ALL_REPLAY_VARIANTS_NEGATIVE"] }) });
    seedClosed(store, { provenance: fullProvenance({ routeReasonCodes: ["SYMBOL_NET_NEGATIVE"] }) });
    const gate = simulateLoserFingerprintGate(store);
    const g = gate.gates.find((x) => x.gateId === "ALL_REPLAY_VARIANTS_NEGATIVE")!;
    expect(g.tradesRemoved).toBe(1);
    const sn = gate.gates.find((x) => x.gateId === "SYMBOL_NET_NEGATIVE")!;
    expect(sn.tradesRemoved).toBe(1);
  });

  // [PV-8]
  it("[PV-8] HIGH_BETA_BEARISH_SHORT_WIDE gate matches high-beta SHORT in bearish regime with wide stop", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    // matches: high-beta alt SHORT, bearish regime, wide stop >=400bps.
    seedClosed(store, { symbol: "SEIUSDT", direction: "SHORT", regime: "Bearish pressure", plannedStopDistanceBps: 450 });
    // does NOT match: large-cap (BTC) even though SHORT/bearish/wide.
    seedClosed(store, { symbol: "BTCUSDT", direction: "SHORT", regime: "Bearish pressure", plannedStopDistanceBps: 450 });
    // does NOT match: high-beta alt SHORT bearish but narrow stop.
    seedClosed(store, { symbol: "WLDUSDT", direction: "SHORT", regime: "Bearish pressure", plannedStopDistanceBps: 250 });
    const gate = simulateLoserFingerprintGate(store);
    const g = gate.gates.find((x) => x.gateId === "HIGH_BETA_BEARISH_SHORT_WIDE")!;
    expect(g.tradesRemoved).toBe(1);
    expect(g.lossesAvoided).toBe(1);
  });

  // [PV-9]
  it("[PV-9] ROUTE_DATA_COLLECTION gate matches routeMode=DATA_COLLECTION headline orders", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    seedClosed(store, { provenance: fullProvenance({ routeMode: "DATA_COLLECTION" }) });
    seedClosed(store, { provenance: fullProvenance({ routeMode: "PROFIT_CANDIDATE" }) });
    const gate = simulateLoserFingerprintGate(store);
    const g = gate.gates.find((x) => x.gateId === "ROUTE_DATA_COLLECTION")!;
    expect(g.tradesRemoved).toBe(1);
  });

  // [PV-10]
  it("[PV-10] provenance brief lines render coverage + recommendation + activeGateChange=NO", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    for (let i = 0; i < 4; i++) seedClosed(store, { provenance: fullProvenance({ calibrationVerdict: "RAW_EDGE_NOT_VALIDATED" }) });
    const audit = buildPaperProvenanceAudit(store);
    const gate = simulateLoserFingerprintGate(store);
    const lines = buildPaperProvenanceBriefLines(audit, gate);
    expect(lines.some((l) => l.includes("provenanceCoverage:"))).toBe(true);
    expect(lines.some((l) => l.trim().startsWith("headline="))).toBe(true);
    expect(lines.some((l) => l.includes("headlineGateRecommendation="))).toBe(true);
    expect(lines.some((l) => l.includes("activeGateChange=NO"))).toBe(true);
  });

  // [PV-11]
  it("[PV-11] provenance audit + gate simulation never authorize live trading (liveBlocked stays true)", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    seedClosed(store);
    const audit = buildPaperProvenanceAudit(store);
    const gate = simulateLoserFingerprintGate(store);
    expect(audit.reportOnly).toBe(true);
    expect(audit.paperOnly).toBe(true);
    expect(gate.active).toBe(false);
    expect(vmReport.liveBlocked).toBe(true);
  });

  // [PV-12]
  it("[PV-12] microPilotAllowed stays false while provenance audit + gate simulation run", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    seedClosed(store);
    buildPaperProvenanceAudit(store);
    simulateLoserFingerprintGate(store);
    expect(vmReport.microPilotAllowed).toBe(false);
  });

  // [PV-13]
  it("[PV-13] provenance audit + gate read only the paper store — never shadow-positions.json", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    seedClosed(store);
    buildPaperProvenanceAudit(store);
    simulateLoserFingerprintGate(store);
    expect(existsSync(join(dir, "shadow-positions.json"))).toBe(false);
    expect(existsSync(join(dir, "paper-execution-router.json"))).toBe(true);
  });

  // ── SECTION-10 CONSISTENCY + PROVENANCE-GATE CONFIDENCE FIXES (8) ───────────

  // [SQ-1]
  it("[SQ-1] negative paper performance (closed≥10, netAvgR<0) shows paperLaneConfidence=DEGRADED, never laneConfidence=HIGH", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    // Seed 12 headline losses — mirrors real 42-trade negative outcome.
    for (let i = 0; i < 12; i++) seedClosed(store);
    // Routing still says HIGH (e.g. the adaptive-lane-router selected CG_WIDE historically).
    const report = buildPaperPerformanceReport(store, { laneConfidence: "HIGH" });
    expect(report.laneConfidence).toBe("HIGH");               // routing unchanged
    expect(report.paperLaneConfidence).toBe("DEGRADED");       // derived from paper economics
    const lines = buildPaperExecutionRouterBriefLines(report);
    expect(lines.some((l) => l.includes("paperLaneConfidence=DEGRADED"))).toBe(true);
    // The active-lane line must NOT show the routing HIGH as the lane confidence.
    expect(lines.every((l) => !l.includes("laneConfidence=HIGH"))).toBe(true);
  });

  // [SQ-2]
  it("[SQ-2] blocker is ACTIVE_LANE_DEGRADED when paperLaneConfidence=DEGRADED (even if routing says HIGH)", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    for (let i = 0; i < 12; i++) seedClosed(store);
    const report = buildPaperPerformanceReport(store, { laneConfidence: "HIGH" });
    expect(report.paperLaneConfidence).toBe("DEGRADED");
    const lines = buildPaperExecutionRouterBriefLines(report);
    const blockerLine = lines.find((l) => l.startsWith("   blocker:"));
    expect(blockerLine).toBeDefined();
    expect(blockerLine).toContain("ACTIVE_LANE_DEGRADED");
    expect(blockerLine).not.toContain("blocker: none");
  });

  // [SQ-3]
  it("[SQ-3] provenanceCoverage<50% downgrades provenance-dependent gate recommendation to PROMISING_BUT_PROVENANCE_BLIND", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    // 15 legacy losses (no provenance) + 5 provenance losses with RAW_EDGE.
    // provCoverage = 5/20 = 25% < 50% → provBlind = true.
    // RAW_EDGE gate: removed=5, baseClosed=20, conf=MEDIUM → normally PROMISING → downgraded.
    for (let i = 0; i < 15; i++) seedClosed(store, { provenance: null, provenanceFieldMissing: [] });
    for (let i = 0; i < 5; i++) seedClosed(store, { provenance: fullProvenance({ calibrationVerdict: "RAW_EDGE_NOT_VALIDATED" }) });
    const gate = simulateLoserFingerprintGate(store);
    expect(gate.provenanceCoverageWarning).not.toBeNull();
    const rawEdge = gate.gates.find((g) => g.gateId === "RAW_EDGE_NOT_VALIDATED")!;
    expect(rawEdge.tradesRemoved).toBe(5);
    expect(rawEdge.recommendation).toBe("PROMISING_BUT_PROVENANCE_BLIND");
    // Non-provenance gates must NOT be downgraded — their predicates work on top-level fields.
    const wideCgGate = gate.gates.find((g) => g.gateId === "WIDE_STOP_GE_400_CG_WIDE")!;
    expect(wideCgGate.recommendation).not.toBe("PROMISING_BUT_PROVENANCE_BLIND");
  });

  // [SQ-4]
  it("[SQ-4] provenanceCoverage=0% sets provenanceBlind=true and brief shows PROVENANCE_BLIND", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    for (let i = 0; i < 5; i++) seedClosed(store, { provenance: null, provenanceFieldMissing: [] });
    const audit = buildPaperProvenanceAudit(store);
    expect(audit.provenanceBlind).toBe(true);
    expect(audit.withProvenance).toBe(0);
    const gate = simulateLoserFingerprintGate(store);
    const lines = buildPaperProvenanceBriefLines(audit, gate);
    expect(lines.some((l) => l.includes("PROVENANCE_BLIND"))).toBe(true);
    expect(lines.some((l) => l.includes("calibration/chase/sourceConflict/routeMode"))).toBe(true);
  });

  // [SQ-5]
  it("[SQ-5] activeGateChange remains NO when provenanceCoverage is low", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    for (let i = 0; i < 15; i++) seedClosed(store, { provenance: null, provenanceFieldMissing: [] });
    for (let i = 0; i < 5; i++) seedClosed(store, { provenance: fullProvenance({ calibrationVerdict: "RAW_EDGE_NOT_VALIDATED" }) });
    const gate = simulateLoserFingerprintGate(store);
    expect(gate.active).toBe(false);
    expect(gate.activeGateChange).toBe("NO");
  });

  // [SQ-6]
  it("[SQ-6] liveBlocked stays true after paperLaneConfidence=DEGRADED + provenance-gate simulation", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    for (let i = 0; i < 12; i++) seedClosed(store);
    buildPaperPerformanceReport(store, { laneConfidence: "HIGH" });
    simulateLoserFingerprintGate(store);
    expect(vmReport.liveBlocked).toBe(true);
  });

  // [SQ-7]
  it("[SQ-7] microPilotAllowed stays false after paperLaneConfidence=DEGRADED + provenance-gate simulation", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    for (let i = 0; i < 12; i++) seedClosed(store);
    buildPaperPerformanceReport(store, { laneConfidence: "HIGH" });
    simulateLoserFingerprintGate(store);
    expect(vmReport.microPilotAllowed).toBe(false);
  });

  // [SQ-8]
  it("[SQ-8] section-10 consistency fix never writes shadow-positions.json", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    for (let i = 0; i < 12; i++) seedClosed(store);
    buildPaperPerformanceReport(store, { laneConfidence: "HIGH" });
    buildPaperProvenanceAudit(store);
    simulateLoserFingerprintGate(store);
    expect(existsSync(join(dir, "shadow-positions.json"))).toBe(false);
    expect(existsSync(join(dir, "paper-execution-router.json"))).toBe(true);
  });

  // ── PHASE-3 SECTION-10 CONSISTENCY FIXES (3) ────────────────────────────────

  // [SQ-9] req#1: allocator activeLanePerf must render paperConfidence=DEGRADED
  // when paper metrics are negative/PF<1, even while routing confidence is HIGH.
  it("[SQ-9] allocator activeLanePerf shows paperConfidence=DEGRADED (routing HIGH) on negative paper economics", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    // Routing/lane confidence is HIGH, but closed>=10 with netAvgR<0 & PF<1.
    const laneState = degradedLaneState({ laneConfidence: "HIGH", closedCount: 28, netAvgR: -0.3477, pf: 0.49, wr: 0.357 });
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: [makeCandidate()], laneState }),
    );
    expect(report.laneConfidence).toBe("HIGH");          // routing echoed unchanged
    expect(report.paperLaneConfidence).toBe("DEGRADED");  // derived from paper economics
    const lines = buildPaperOpportunityAllocatorBriefLines(report);
    const perfLine = lines.find((l) => l.includes("activeLanePerf:"));
    expect(perfLine).toBeDefined();
    expect(perfLine).toContain("paperConfidence=DEGRADED");
    expect(perfLine).toContain("routingConfidence=HIGH");
    // The rendered paperConfidence must never read HIGH while quarantined.
    expect(perfLine).not.toContain("paperConfidence=HIGH");
  });

  // [SQ-10] req#2: a NON-provenance gate (SYMBOL_NET_AVG_TOXIC) that would read
  // PROMISING must be downgraded when provenanceCoverage<50%, so best.recommendation
  // is never plain PROMISING/READY at low coverage.
  it("[SQ-10] provenanceCoverage<50% downgrades a non-provenance gate; best is never PROMISING/READY", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    // 20 legacy losses (no provenance) on one toxic symbol → coverage 0% (provBlind).
    // SYMBOL_NET_AVG_TOXIC removes all 20 (netAvg<-0.5, closed>=3): netImprovement>0,
    // winsSacrificed=0, baseClosed=20 → MEDIUM → would normally be PROMISING.
    for (let i = 0; i < 20; i++) {
      seedClosed(store, { symbol: "TOXICUSDT", provenance: null, provenanceFieldMissing: [] });
    }
    const gate = simulateLoserFingerprintGate(store);
    expect(gate.provenanceCoverageWarning).not.toBeNull();
    const toxic = gate.gates.find((g) => g.gateId === "SYMBOL_NET_AVG_TOXIC")!;
    expect(toxic.tradesRemoved).toBe(20);
    expect(toxic.recommendation).toBe("PROMISING_BUT_PROVENANCE_BLIND");
    expect(gate.best).not.toBeNull();
    expect(gate.best!.recommendation).not.toBe("PROMISING");
    expect(gate.best!.recommendation).not.toBe("READY_FOR_ACTIVE_GATE");
  });

  // [SQ-11] req#3: recomputing paperReport / provenanceAudit / shadowGateReport
  // from a SINGLE store snapshot keeps their closed counts consistent — the
  // route now recomputes all of them post-resolve from one final snapshot.
  it("[SQ-11] single post-resolve snapshot yields consistent closed counts across report/audit/gate", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    for (let i = 0; i < 42; i++) seedClosed(store);
    // Pre-resolve snapshot (closed=42).
    const preReport = buildPaperPerformanceReport(store, { laneConfidence: "HIGH" });
    expect(preReport.headlineClosed).toBe(42);
    // Resolver closes one more order (store mutates → closed=43).
    seedClosed(store);
    // Recompute ALL three from the SAME post-resolve store snapshot.
    const report = buildPaperPerformanceReport(store, { laneConfidence: "HIGH" });
    const audit = buildPaperProvenanceAudit(store);
    const gate = simulateLoserFingerprintGate(store);
    expect(report.headlineClosed).toBe(43);
    expect(audit.closed).toBe(43);
    expect(gate.closedSample).toBe(43);
    // No three-way disagreement (the bug was closed=43 vs closed=42).
    expect(report.headlineClosed).toBe(audit.closed);
    expect(audit.closed).toBe(gate.closedSample);
  });

  // ── DIAGNOSTIC PROVENANCE COVERAGE V1 (9) ───────────────────────────────────

  // [DPC-1] diagnostic-only orders do not affect headline metrics or headline coverage.
  it("[DPC-1] DIAGNOSTIC_ONLY closes never touch headline net/PF/WR or headline coverage", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    for (let i = 0; i < 5; i++) seedClosed(store);
    const before = buildPaperPerformanceReport(store, { laneConfidence: "HIGH" });
    const auditBefore = buildPaperProvenanceAudit(store);
    // Add diagnostic-only closes (a mix of wins/losses) — must not move headline.
    for (let i = 0; i < 10; i++) seedClosed(store, { paperOrderMode: "DIAGNOSTIC_ONLY" });
    seedWin(store, { paperOrderMode: "DIAGNOSTIC_ONLY" });
    const after = buildPaperPerformanceReport(store, { laneConfidence: "HIGH" });
    const auditAfter = buildPaperProvenanceAudit(store);
    expect(after.headlineClosed).toBe(before.headlineClosed);
    expect(after.headlineNetAvgR).toBe(before.headlineNetAvgR);
    expect(after.headlinePF).toBe(before.headlinePF);
    expect(after.headlineWR).toBe(before.headlineWR);
    expect(auditAfter.headlineProvenanceCoverage.closed).toBe(auditBefore.headlineProvenanceCoverage.closed);
    expect(auditAfter.headlineProvenanceCoverage.closed).toBe(5);
  });

  // [DPC-2] diagnostic-only closed orders increase diagnosticProvenanceCoverage.
  it("[DPC-2] DIAGNOSTIC_ONLY closes raise diagnosticProvenanceCoverage", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    const empty = buildPaperProvenanceAudit(store);
    expect(empty.diagnosticProvenanceCoverage.closed).toBe(0);
    expect(empty.diagnosticProvenanceCoverage.coveragePct).toBe(0);
    for (let i = 0; i < 4; i++) {
      seedClosed(store, { paperOrderMode: "DIAGNOSTIC_ONLY", provenance: fullProvenance() });
    }
    const audit = buildPaperProvenanceAudit(store);
    expect(audit.diagnosticProvenanceCoverage.closed).toBe(4);
    expect(audit.diagnosticProvenanceCoverage.withProvenance).toBe(4);
    expect(audit.diagnosticProvenanceCoverage.coveragePct).toBe(100);
    expect(audit.diagnosticProvenanceCoverage.provenanceBlind).toBe(false);
  });

  // [DPC-3] allPaperProvenanceCoverage includes headline + diagnostic.
  it("[DPC-3] allPaperProvenanceCoverage spans headline + diagnostic samples", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    for (let i = 0; i < 6; i++) seedClosed(store, { provenance: fullProvenance() });
    for (let i = 0; i < 4; i++) seedClosed(store, { paperOrderMode: "DIAGNOSTIC_ONLY", provenance: fullProvenance() });
    const audit = buildPaperProvenanceAudit(store);
    expect(audit.allPaperProvenanceCoverage.closed).toBe(10);
    expect(audit.allPaperProvenanceCoverage.closed).toBe(
      audit.headlineProvenanceCoverage.closed + audit.diagnosticProvenanceCoverage.closed,
    );
    expect(audit.allPaperProvenanceCoverage.withProvenance).toBe(10);
  });

  // [DPC-4] headlineProvenanceCoverage remains headline-only.
  it("[DPC-4] headlineProvenanceCoverage counts only headline closes", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    for (let i = 0; i < 3; i++) seedClosed(store, { provenance: fullProvenance() });
    for (let i = 0; i < 5; i++) seedClosed(store, { paperOrderMode: "DIAGNOSTIC_ONLY", provenance: fullProvenance() });
    const audit = buildPaperProvenanceAudit(store);
    expect(audit.headlineProvenanceCoverage.closed).toBe(3);
    expect(audit.closed).toBe(3); // legacy top-level field stays headline-scoped
  });

  // [DPC-5] shadowGateScope is rendered clearly and the gate reports carry scope.
  it("[DPC-5] shadowGateScope is rendered; gate reports carry their scope", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    for (let i = 0; i < 4; i++) seedClosed(store);
    for (let i = 0; i < 4; i++) seedClosed(store, { paperOrderMode: "DIAGNOSTIC_ONLY" });
    const headlineGate = simulateLoserFingerprintGate(store, { scope: "HEADLINE_ONLY" });
    const diagGate = simulateLoserFingerprintGate(store, { scope: "DIAGNOSTIC_ONLY" });
    expect(headlineGate.scope).toBe("HEADLINE_ONLY");
    expect(diagGate.scope).toBe("DIAGNOSTIC_ONLY");
    expect(headlineGate.closedSample).toBe(4);
    expect(diagGate.closedSample).toBe(4);
    const audit = buildPaperProvenanceAudit(store);
    const lines = buildPaperProvenanceBriefLines(audit, headlineGate, diagGate);
    expect(lines.some((l) => l.includes("shadowGateScope=HEADLINE_ONLY"))).toBe(true);
  });

  // [DPC-6] req#5: headline<50% + diagnostic>=50% renders the two recommendations,
  // and the diagnostic gate NEVER changes activeGateChange from NO.
  it("[DPC-6] headline-blind + diagnostic-evidence renders REPORT_ONLY_PROMISING, activeGateChange stays NO", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    // Headline coverage 25% (<50%): 15 legacy null + 5 provenance losses (all ETHUSDT → toxic).
    for (let i = 0; i < 15; i++) seedClosed(store, { provenance: null, provenanceFieldMissing: [] });
    for (let i = 0; i < 5; i++) seedClosed(store, { provenance: fullProvenance({ calibrationVerdict: "RAW_EDGE_NOT_VALIDATED" }) });
    // Diagnostic coverage 100% (>=50%): 20 DIAGNOSTIC_ONLY provenance losses on ETHUSDT.
    for (let i = 0; i < 20; i++) seedClosed(store, { paperOrderMode: "DIAGNOSTIC_ONLY", provenance: fullProvenance() });

    const audit = buildPaperProvenanceAudit(store);
    expect(audit.headlineProvenanceCoverage.coveragePct).toBeLessThan(50);
    expect(audit.diagnosticProvenanceCoverage.coveragePct).toBeGreaterThanOrEqual(50);

    const headlineGate = simulateLoserFingerprintGate(store, { scope: "HEADLINE_ONLY" });
    const diagGate = simulateLoserFingerprintGate(store, { scope: "DIAGNOSTIC_ONLY" });
    // The diagnostic gate can NEVER move the active gate.
    expect(diagGate.activeGateChange).toBe("NO");
    expect(headlineGate.activeGateChange).toBe("NO");

    const lines = buildPaperProvenanceBriefLines(audit, headlineGate, diagGate);
    expect(lines.some((l) => l.includes("headlineGateRecommendation=PROMISING_BUT_PROVENANCE_BLIND"))).toBe(true);
    expect(lines.some((l) => l.includes("diagnosticGateRecommendation=REPORT_ONLY_PROMISING"))).toBe(true);
    expect(lines.some((l) => l.includes("diagnosticEvidenceStatus=DIAGNOSTIC_EVIDENCE_REPORT_ONLY"))).toBe(true);
    expect(lines.some((l) => l.includes("activeGateChange=NO"))).toBe(true);
    // REPORT_ONLY_PROMISING must never read as a promotable headline verdict.
    expect(lines.every((l) => !l.includes("diagnosticGateRecommendation=READY_FOR_ACTIVE_GATE"))).toBe(true);
  });

  // [DPC-7] diagnostic evidence never enables live trading.
  it("[DPC-7] liveBlocked stays true with diagnostic provenance evidence present", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    for (let i = 0; i < 20; i++) seedClosed(store, { paperOrderMode: "DIAGNOSTIC_ONLY", provenance: fullProvenance() });
    buildPaperProvenanceAudit(store);
    simulateLoserFingerprintGate(store, { scope: "DIAGNOSTIC_ONLY" });
    expect(vmReport.liveBlocked).toBe(true);
  });

  // [DPC-8] diagnostic evidence never enables micro-pilot.
  it("[DPC-8] microPilotAllowed stays false with diagnostic provenance evidence present", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    for (let i = 0; i < 20; i++) seedClosed(store, { paperOrderMode: "DIAGNOSTIC_ONLY", provenance: fullProvenance() });
    buildPaperProvenanceAudit(store);
    simulateLoserFingerprintGate(store, { scope: "DIAGNOSTIC_ONLY" });
    expect(vmReport.microPilotAllowed).toBe(false);
  });

  // [DPC-9] diagnostic coverage computation writes nothing to shadow-positions.json.
  it("[DPC-9] diagnostic coverage + scoped gates never write shadow-positions.json", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    for (let i = 0; i < 6; i++) seedClosed(store);
    for (let i = 0; i < 6; i++) seedClosed(store, { paperOrderMode: "DIAGNOSTIC_ONLY", provenance: fullProvenance() });
    buildPaperProvenanceAudit(store);
    simulateLoserFingerprintGate(store, { scope: "HEADLINE_ONLY" });
    simulateLoserFingerprintGate(store, { scope: "DIAGNOSTIC_ONLY" });
    simulateLoserFingerprintGate(store, { scope: "ALL_PAPER" });
    expect(existsSync(join(dir, "shadow-positions.json"))).toBe(false);
    expect(existsSync(join(dir, "paper-execution-router.json"))).toBe(true);
  });

  // ── Rejected Candidate Diagnostic Sampler V1 ([RDS-1]..[RDS-10]) ───────────

  /** Three distinct-symbol candidates each rejected by a sampleable quality gate. */
  function rejectedCandidates(): Candidate[] {
    return [
      makeCandidate({ symbol: "AAAUSDT", routeReasonCodes: ["ALL_REPLAY_VARIANTS_NEGATIVE"] }),
      makeCandidate({ symbol: "BBBUSDT", calibrationVerdict: "RAW_EDGE_NOT_VALIDATED", calibratedExpectedNetR: -0.1 }),
      makeCandidate({ symbol: "CCCUSDT", chaseRisk: "HIGH" }),
    ];
  }

  // [RDS-1] OFF by default — rejected candidates are never sampled.
  it("[RDS-1] sampler is OFF by default — rejected candidates create no diagnostic samples", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({ vmReport, candidates: rejectedCandidates(), laneState: healthyLaneState() }),
    );
    expect(report.rejectedDiagnosticSamplerActive).toBe(false);
    expect(report.rejectedDiagnosticSampled).toBe(0);
    expect(report.selectedOpportunities.length).toBe(0);
    expect(report.headlineEligibleCount).toBe(0);
  });

  // [RDS-2] ON + healthy lane + no headline opp → samples DIAGNOSTIC_ONLY orders.
  it("[RDS-2] sampler ON samples rejected candidates as DIAGNOSTIC_ONLY when no headline opp exists", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: rejectedCandidates(),
        laneState: healthyLaneState(),
        paperRejectDiagnosticContinue: true,
      }),
    );
    expect(report.rejectedDiagnosticSamplerActive).toBe(true);
    expect(report.headlineEligibleCount).toBe(0);
    expect(report.rejectedDiagnosticSampled).toBe(3);
    expect(report.selectedOpportunities.length).toBe(3);
    expect(report.selectedOpportunities.every((o) => o.paperOrderMode === "DIAGNOSTIC_ONLY")).toBe(true);
    expect(report.diagnosticEligibleCount).toBe(3);
    expect(report.rejectedDiagnosticReasons.map((r) => r.key)).toEqual(
      expect.arrayContaining([
        "CANDIDATE_ALL_REPLAY_VARIANTS_NEGATIVE",
        "CANDIDATE_RAW_EDGE_NOT_VALIDATED",
        "CANDIDATE_CHASE_RISK_HIGH",
      ]),
    );
  });

  // [RDS-3] never creates HEADLINE orders from rejected candidates.
  it("[RDS-3] sampled rejects never become HEADLINE orders (createdHeadline stays 0)", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const alloc = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: rejectedCandidates(),
        laneState: healthyLaneState(),
        paperRejectDiagnosticContinue: true,
      }),
    );
    expect(alloc.selectedOpportunities.some((o) => o.paperOrderMode === "HEADLINE")).toBe(false);
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    const admit = admitPaperOpportunities({
      store,
      opportunities: alloc.selectedOpportunities,
      routerReport: routerOf("Bearish pressure"),
      gateReport: emptyGate(),
      now: new Date().toISOString(),
    });
    expect(admit.admittedHeadline).toBe(0);
    expect(admit.admittedDiagnostic).toBe(3);
  });

  // [RDS-4] cap respected: maxPerScan bounds the sample count.
  it("[RDS-4] sampler respects PAPER_REJECT_DIAGNOSTIC_MAX_PER_SCAN cap", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const candidates = [
      ...rejectedCandidates(),
      makeCandidate({
        symbol: "DDDUSDT",
        sourceConflict: true,
        calibrationVerdict: "INSUFFICIENT_SAMPLE",
        calibratedExpectedNetR: 0,
      }),
      makeCandidate({ symbol: "EEEUSDT", routeReasonCodes: ["SYMBOL_NET_NEGATIVE"] }),
    ];
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates,
        laneState: healthyLaneState(),
        paperRejectDiagnosticContinue: true,
        paperRejectDiagnosticMaxPerScan: 2,
      }),
    );
    expect(report.rejectedDiagnosticSampled).toBe(2);
    expect(report.selectedOpportunities.length).toBe(2);
  });

  // [RDS-5] diversifies symbols — sampled orders cover distinct symbols.
  it("[RDS-5] sampler diversifies symbols across the sampled diagnostic orders", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const candidates = [
      ...rejectedCandidates(),
      makeCandidate({
        symbol: "DDDUSDT",
        sourceConflict: true,
        calibrationVerdict: "INSUFFICIENT_SAMPLE",
        calibratedExpectedNetR: 0,
      }),
    ];
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates,
        laneState: healthyLaneState(),
        paperRejectDiagnosticContinue: true,
        paperRejectDiagnosticMaxPerScan: 3,
      }),
    );
    expect(report.rejectedDiagnosticSampled).toBe(3);
    const symbols = report.selectedOpportunities.map((o) => o.symbol);
    expect(new Set(symbols).size).toBe(3);
  });

  // [RDS-6] does NOT fire when a headline opportunity exists this scan.
  it("[RDS-6] sampler stays inert when a HEADLINE opportunity is created this scan", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: [
          makeCandidate({ symbol: "PASSUSDT" }), // passes all gates → HEADLINE
          makeCandidate({ symbol: "AAAUSDT", routeReasonCodes: ["ALL_REPLAY_VARIANTS_NEGATIVE"] }),
        ],
        laneState: healthyLaneState(),
        paperRejectDiagnosticContinue: true,
      }),
    );
    expect(report.headlineEligibleCount).toBe(1);
    expect(report.rejectedDiagnosticSampled).toBe(0);
    expect(report.selectedOpportunities.filter((o) => o.paperOrderMode === "DIAGNOSTIC_ONLY").length).toBe(0);
  });

  // [RDS-7] does NOT bypass quarantine — degraded lane never reject-samples.
  it("[RDS-7] sampler does not bypass a quarantined (degraded) lane", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: rejectedCandidates(),
        laneState: degradedLaneState(),
        paperRejectDiagnosticContinue: true, // armed, but lane is degraded → NONE batch
      }),
    );
    expect(report.laneAdmissionStatus).toBe("QUARANTINED");
    expect(report.rejectedDiagnosticSampled).toBe(0);
    expect(report.selectedOpportunities.length).toBe(0);
  });

  // [RDS-8] sampled orders persist full provenance, are excluded from headline
  //          metrics, and are included in diagnostic + allPaper coverage scopes.
  it("[RDS-8] sampled diagnostics carry provenance, stay out of headline, feed diagnostic coverage", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const alloc = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: rejectedCandidates(),
        laneState: healthyLaneState(),
        paperRejectDiagnosticContinue: true,
      }),
    );
    expect(alloc.rejectedDiagnosticSampled).toBe(3);
    expect(alloc.selectedOpportunities.every((o) => o.provenance != null)).toBe(true);
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    admitPaperOpportunities({
      store,
      opportunities: alloc.selectedOpportunities,
      routerReport: routerOf("Bearish pressure"),
      gateReport: emptyGate(),
      now: new Date().toISOString(),
    });
    // Close the admitted diagnostic orders as losses (mirrors the resolver).
    for (const o of store.all) {
      if (o.paperStatus === "CREATED") {
        store.update(o.paperOrderId, { paperStatus: "PAPER_CLOSED_LOSS", grossR: -1, netR: -1 });
      }
    }
    const perf = buildPaperPerformanceReport(store);
    expect(perf.headlineTotal).toBe(0);
    expect(perf.headlineClosed).toBe(0);
    expect(perf.headlineNetAvgR).toBeNull();
    expect(perf.diagnosticOnlyTotal).toBe(3);
    const audit = buildPaperProvenanceAudit(store);
    expect(audit.headlineProvenanceCoverage.closed).toBe(0);
    expect(audit.diagnosticProvenanceCoverage.closed).toBe(3);
    expect(audit.diagnosticProvenanceCoverage.withProvenance).toBe(3);
    expect(audit.allPaperProvenanceCoverage.closed).toBe(3);
  });

  // [RDS-9] sampling never authorizes live trading and never writes shadow-positions.json.
  it("[RDS-9] reject sampling stays reportOnly/paperOnly — no live, no shadow-positions.json", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const alloc = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: rejectedCandidates(),
        laneState: healthyLaneState(),
        paperRejectDiagnosticContinue: true,
      }),
    );
    expect(alloc.reportOnly).toBe(true);
    expect(alloc.paperOnly).toBe(true);
    expect(vmReport.liveBlocked).toBe(true);
    expect(vmReport.microPilotAllowed).toBe(false);
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    admitPaperOpportunities({
      store,
      opportunities: alloc.selectedOpportunities,
      routerReport: routerOf("Bearish pressure"),
      gateReport: emptyGate(),
      now: new Date().toISOString(),
    });
    for (const o of store.all) {
      expect(o.reportOnly).toBe(true);
      expect(o.paperOnly).toBe(true);
      expect(o.paperStatus).not.toBe("PAPER_SUBMITTED");
    }
    expect(existsSync(join(dir, "shadow-positions.json"))).toBe(false);
    expect(existsSync(join(dir, "paper-execution-router.json"))).toBe(true);
  });

  // [RDS-10] Section 10 renders the sampler status line.
  it("[RDS-10] brief renders rejectedDiagnosticSampler / Created / Reasons", async () => {
    const dir = tmpDir();
    const vmReport = await buildWinningVmReport(dir);
    const report = buildPaperOpportunityAllocatorReport(
      baseInputs({
        vmReport,
        candidates: rejectedCandidates(),
        laneState: healthyLaneState(),
        paperRejectDiagnosticContinue: true,
      }),
    );
    const lines = buildPaperOpportunityAllocatorBriefLines(report);
    const line = lines.find((l) => l.includes("rejectedDiagnosticSampler="));
    expect(line).toBeDefined();
    expect(line).toContain("rejectedDiagnosticSampler=ON");
    expect(line).toContain("rejectedDiagnosticCreated=3");
    expect(line).toContain("rejectedDiagnosticReasons=");
    // OFF rendering when the env flag is not set.
    const off = buildPaperOpportunityAllocatorBriefLines(
      buildPaperOpportunityAllocatorReport(
        baseInputs({ vmReport, candidates: rejectedCandidates(), laneState: healthyLaneState() }),
      ),
    );
    expect(off.find((l) => l.includes("rejectedDiagnosticSampler="))).toContain("rejectedDiagnosticSampler=OFF");
  });

  // [PV-14]
  it("[PV-14] gate simulation involves no real exchange client and stays reportOnly/paperOnly", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    seedClosed(store);
    seedWin(store);
    // simulateLoserFingerprintGate takes ONLY the store — no exchange/binance client.
    const gate = simulateLoserFingerprintGate(store);
    expect(gate.reportOnly).toBe(true);
    expect(gate.paperOnly).toBe(true);
    expect(gate.activeGateChange).toBe("NO");
    for (const o of store.all) {
      expect(o.reportOnly).toBe(true);
      expect(o.paperOnly).toBe(true);
      expect(o.paperStatus).not.toBe("PAPER_SUBMITTED");
    }
  });
});

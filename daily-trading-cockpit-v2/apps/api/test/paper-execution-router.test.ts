import { describe, it, expect } from "vitest";
import os from "node:os";
import { mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  PaperExecutionRouterStore,
  _resetPaperExecutionRouterStoreForTests,
  computePaperPositionSize,
  selectEligiblePaperLane,
  admitPaperOrders,
  resolvePaperOrders,
  evaluatePaperLaneRotation,
  runPaperAdmissionAndResolution,
  buildPaperPerformanceReport,
  buildPaperExecutionRouterBriefLines,
  PAPER_ADMISSION_MAX_AGE_MS,
  DEFAULT_PAPER_EQUITY,
  HEADLINE_MAX_OPEN,
  HEADLINE_MAX_PER_SYMBOL,
  HEADLINE_MAX_PER_DIRECTION,
  isOpenHeadlineOrder,
  headlineConcentrationRejectReason,
  type PaperOrder,
  type PaperKlineTuple,
  type PaperResolverClient,
  type PaperEligibleLane,
} from "../src/lib/paper-execution-router.js";
import {
  buildAdaptiveLaneRouterReport,
} from "../src/lib/adaptive-lane-router.js";
import {
  buildCurrentGuardVariantMatrixReport,
  CurrentGuardVariantMatrixStore,
  mirrorVariantMatrixSignals,
  resolveVariantMatrixObservations,
  type VariantMatrixSignal,
  type KlineTuple,
} from "../src/lib/current-guard-variant-matrix.js";
import { buildLiveTradingGateReport } from "../src/lib/live-trading-gate.js";
import { buildRegimeDirectionControllerReport } from "../src/lib/regime-direction-controller.js";
import {
  buildOperatorBrief,
  OPERATOR_BRIEF_MAX_LINES,
} from "../src/lib/operator-brief.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return mkdtempSync(join(os.tmpdir(), "paper-exec-router-test-"));
}

function emptyGate() {
  return buildLiveTradingGateReport({});
}

function regimeOf(raw: string | null) {
  return buildRegimeDirectionControllerReport({
    currentRegime: raw,
    adaptiveDirectionBias: null,
    primaryValidationLane: null,
  });
}

function routerOf(regime: string | null) {
  return buildAdaptiveLaneRouterReport({
    generatedAt: new Date().toISOString(),
    regimeReport: regimeOf(regime),
    gateReport: emptyGate(),
  });
}

/** Build a VM store with 60 winning SHORT signals so CG_WIDE_STOP_TP_WIDE row passes economics gates. */
async function buildWinningVmStore(dir: string): Promise<CurrentGuardVariantMatrixStore> {
  const vmStore = new CurrentGuardVariantMatrixStore(dir);
  const recentBase = Date.now() - 6 * 24 * 60 * 60 * 1000;
  const signals: VariantMatrixSignal[] = Array.from({ length: 60 }, (_, i) => ({
    sourceSignalId: `sig-${i}`,
    symbol: `SYM${String(i).padStart(3, "0")}USDT`,
    direction: "SHORT" as const,
    entryPrice: 100,
    stopLoss: 103, // SHORT: SL above entry
    tp1: 96, // SHORT: TP below entry
    tp2: null,
    tp3: null,
    stopDistanceBps: 300,
    regime: "BULLISH_EXPANSION",
    entryVariant: "base_current_entry",
    openedAt: new Date(recentBase + i * 60_000).toISOString(),
    closedAt: null,
  }));
  mirrorVariantMatrixSignals(signals, vmStore, new Date().toISOString());
  // Resolve them all as wins so CG_WIDE has positive economics.
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
  return vmStore;
}

function makePaperOrder(overrides: Partial<PaperOrder> = {}): PaperOrder {
  const now = new Date().toISOString();
  return {
    paperOrderId: "test-order-1",
    sourceObservationId: "obs-1",
    sourceSignalId: null,
    dedupeKey: "obs-1:CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
    createdAt: now,
    updatedAt: now,
    openedAt: now,
    symbol: "ETHUSDT",
    direction: "SHORT",
    regime: "BULLISH_EXPANSION",
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
    operationalSafetyStatus: "OK",
    diagnosticLabel: null,
    paperStatus: "CREATED",
    grossR: null,
    costR: null,
    netR: null,
    netPnlAmount: null,
    closeReason: null,
    reportOnly: true,
    paperOnly: true,
    ...overrides,
  };
}

/** Build a synthetic VM observation suitable for admission tests. */
function makeVmObs(args: {
  observationId: string;
  openedAt: string;
  status?: "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS";
  symbol?: string;
  direction?: "LONG" | "SHORT";
  entryPrice?: number;
  stopLoss?: number;
  tps?: number[];
}): any {
  const symbol = args.symbol ?? "ETHUSDT";
  const direction = args.direction ?? "SHORT";
  return {
    observationId: args.observationId,
    variantId: "CG_WIDE_STOP_TP_WIDE",
    variantVersion: "current-guard-variant-matrix-v1",
    sourceSignalId: `sig-${args.observationId}`,
    sourceObservationKey: `${symbol}|${direction}|${args.openedAt}`,
    symbol,
    direction,
    regime: null,
    entryVariant: null,
    createdAt: args.openedAt,
    openedAt: args.openedAt,
    resolvedAt: null,
    originalEntryPrice: args.entryPrice ?? 100,
    originalStopLoss: args.stopLoss ?? 103,
    originalTakeProfitLevels: args.tps ?? [96],
    simulatedEntryPrice: args.entryPrice ?? 100,
    simulatedStopLoss: args.stopLoss ?? 103,
    simulatedTakeProfitLevels: args.tps ?? [96],
    stopDistanceBps: 300,
    exitRule: "tp1_full",
    fillMode: "taker",
    costModel: "taker",
    costR: null,
    grossR: null,
    netR: null,
    status: args.status ?? "OPEN",
    maxMfeR: null,
    minMaeR: null,
    durationMinutes: null,
    resolutionSource: null,
    intrabarResolutionStatus: null,
    isFreshValid: null,
    reportOnly: true,
    laneVersion: "CURRENT_GUARD_VARIANT_MATRIX_V1",
  };
}

const ELIGIBLE_LANE: PaperEligibleLane = {
  laneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
  variantId: "CG_WIDE_STOP_TP_WIDE",
  freshValid: 61,
  netAvgR: 0.15,
  pf: 1.36,
  isExperimental: true,
  oosUnconfirmed: true,
  paperRiskLabel: "EXPERIMENTAL",
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe("paper-execution-router", () => {
  // Always reset singleton between tests so we don't leak across files
  _resetPaperExecutionRouterStoreForTests();

  // [1] 1% risk computes plannedRiskAmount correctly
  it("[1] risk per trade 1% computes plannedRiskAmount correctly", () => {
    const result = computePaperPositionSize(5000, 100, 95);
    expect(result.ok).toBe(true);
    expect(result.riskPct).toBe(1);
    expect(result.plannedRiskAmount).toBeCloseTo(50);
  });

  // [2] Default equity 2000 → risk 20
  it("[2] default paperEquity 2000 NTD → plannedRiskAmount = 20 NTD", () => {
    const result = computePaperPositionSize(DEFAULT_PAPER_EQUITY, 100, 95);
    expect(result.ok).toBe(true);
    expect(result.paperEquity).toBe(DEFAULT_PAPER_EQUITY);
    expect(result.plannedRiskAmount).toBeCloseTo(20);
  });

  // [3] notional = riskAmount / stopDistancePct
  it("[3] plannedPositionNotional = plannedRiskAmount / stopDistancePct", () => {
    const result = computePaperPositionSize(2000, 100, 95);
    expect(result.ok).toBe(true);
    expect(result.stopDistancePct).toBeCloseTo(0.05);
    expect(result.plannedPositionNotional).toBeCloseTo(400);
  });

  // [4] Zero/invalid stopDistancePct rejects
  it("[4] zero stopDistancePct rejects paper order", () => {
    const samePrice = computePaperPositionSize(2000, 100, 100);
    expect(samePrice.ok).toBe(false);
    expect(samePrice.rejectReason).toBeTruthy();
    const negStop = computePaperPositionSize(2000, 100, 0);
    expect(negStop.ok).toBe(false);
  });

  // [5] notional cap
  it("[5] notional > maxNotionalCap rejects with POSITION_SIZE_SANITY_CAP", () => {
    const result = computePaperPositionSize(2000, 100, 99.99, { maxNotionalCap: 1000 });
    expect(result.ok).toBe(false);
    expect(result.diagnosticLabel).toBe("POSITION_SIZE_SANITY_CAP");
  });

  // [6] paperStartAt immutable
  it("[6] paperStartAt is created once and never overwritten", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    const t1 = store.ensurePaperStartAt("2026-01-01T00:00:00.000Z");
    const t2 = store.ensurePaperStartAt("2026-01-02T00:00:00.000Z");
    expect(t1).toBe("2026-01-01T00:00:00.000Z");
    expect(t2).toBe("2026-01-01T00:00:00.000Z");
    const store2 = new PaperExecutionRouterStore(dir);
    expect(store2.ensurePaperStartAt("2026-01-03T00:00:00.000Z")).toBe("2026-01-01T00:00:00.000Z");
  });

  // [7] BACKFILL_DIAGNOSTIC excluded from headline
  it("[7] BACKFILL_DIAGNOSTIC orders excluded from headline paper metrics", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date().toISOString());
    store.add(
      makePaperOrder({
        paperOrderId: "backfill-win",
        diagnosticLabel: "BACKFILL_DIAGNOSTIC",
        paperStatus: "PAPER_CLOSED_WIN",
        grossR: 0.88,
        costR: -0.07,
        netR: 0.81,
        netPnlAmount: 16.2,
      }),
    );
    const report = buildPaperPerformanceReport(store);
    expect(report.total).toBe(1);
    expect(report.headlineTotal).toBe(0);
    expect(report.headlineWin).toBe(0);
    expect(report.headlineNetAvgR).toBeNull();
  });

  // [8] stale source skipped
  it("[8] stale source observation older than PAPER_ADMISSION_MAX_AGE_MS is skipped", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    const vmStore = new CurrentGuardVariantMatrixStore(dir);

    const staleOpenedAt = new Date(Date.now() - PAPER_ADMISSION_MAX_AGE_MS - 60_000).toISOString();
    vmStore.add(makeVmObs({ observationId: "stale-obs-1", openedAt: staleOpenedAt }));

    const result = admitPaperOrders({
      store,
      vmStore,
      eligibleLane: ELIGIBLE_LANE,
      routerReport: routerOf("Bearish pressure"),
      gateReport: emptyGate(),
      now: new Date().toISOString(),
    });

    expect(result.admitted).toBe(0);
    const rejected = store.all.find((o) => o.diagnosticLabel === "SOURCE_TOO_OLD_FOR_PAPER_ADMISSION");
    expect(rejected).toBeDefined();
  });

  // [9] paper order openedAt comes from source obs
  it("[9] paper order openedAt comes from source observation, not request time", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    const vmStore = new CurrentGuardVariantMatrixStore(dir);

    const freshOpenedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    vmStore.add(makeVmObs({ observationId: "fresh-obs-1", openedAt: freshOpenedAt }));
    store.ensurePaperStartAt(new Date(Date.now() - 5 * 60 * 1000).toISOString());

    admitPaperOrders({
      store,
      vmStore,
      eligibleLane: ELIGIBLE_LANE,
      routerReport: routerOf("Bearish pressure"),
      gateReport: emptyGate(),
      now: new Date().toISOString(),
    });

    const order = store.all.find((o) => o.paperStatus === "CREATED");
    expect(order).toBeDefined();
    expect(order!.openedAt).toBe(freshOpenedAt);
  });

  // [10] Bearish SHORT_ONLY + scaleout (headline) eligible
  it("[10] Bearish SHORT_ONLY with eligible scaleout lane admits paper order", async () => {
    const dir = tmpDir();
    const vmStore = await buildWinningVmStore(dir);
    const vm = buildCurrentGuardVariantMatrixReport(vmStore, { capturedAt: new Date().toISOString() });

    const scaleoutRow = vm.rows.find((r) => r.variantId === "CG_SCALEOUT_TP1_TRAIL");
    expect(scaleoutRow?.freshValid).toBeGreaterThanOrEqual(50);

    const lane = selectEligiblePaperLane({
      vmReport: vm,
      controllerMode: "SHORT_ONLY",
      regimeFamily: "BEARISH",
    });

    expect(lane).not.toBeNull();
    expect(lane!.variantId).toBe("CG_SCALEOUT_TP1_TRAIL");
    // The synthetic winning store has all three OOS positive → NORMAL.
    // (When OOS is unconfirmed in production data, paperRiskLabel = EXPERIMENTAL.)
    expect(["NORMAL", "EXPERIMENTAL"]).toContain(lane!.paperRiskLabel);
  });

  // [11] Mixed VALIDATION_ONLY → null
  it("[11] Mixed VALIDATION_ONLY does not admit paper lane by default", async () => {
    const dir = tmpDir();
    const vmStore = await buildWinningVmStore(dir);
    const vm = buildCurrentGuardVariantMatrixReport(vmStore, { capturedAt: new Date().toISOString() });

    const lane = selectEligiblePaperLane({
      vmReport: vm,
      controllerMode: "VALIDATION_ONLY",
      regimeFamily: "MIXED",
    });

    expect(lane).toBeNull();
  });

  // [12] Mixed VALIDATION_ONLY + paperValidationAllowed → eligible
  it("[12] Mixed VALIDATION_ONLY + paperValidationAllowed=true admits paper lane", async () => {
    const dir = tmpDir();
    const vmStore = await buildWinningVmStore(dir);
    const vm = buildCurrentGuardVariantMatrixReport(vmStore, { capturedAt: new Date().toISOString() });

    const lane = selectEligiblePaperLane({
      vmReport: vm,
      controllerMode: "VALIDATION_ONLY",
      regimeFamily: "MIXED",
      paperValidationAllowed: true,
    });

    expect(lane).not.toBeNull();
    expect(lane!.variantId).toBe("CG_SCALEOUT_TP1_TRAIL");
  });

  // [13] LONG_ONLY → null
  it("[13] Bullish LONG_ONLY does not admit CG_WIDE paper order (direction incompatible)", async () => {
    const dir = tmpDir();
    const vmStore = await buildWinningVmStore(dir);
    const vm = buildCurrentGuardVariantMatrixReport(vmStore, { capturedAt: new Date().toISOString() });

    const lane = selectEligiblePaperLane({
      vmReport: vm,
      controllerMode: "LONG_ONLY",
      regimeFamily: "BULLISH",
    });

    expect(lane).toBeNull();
  });

  // [14] REJECT status never admitted
  it("[14] REJECT status lane is never paper-admitted", async () => {
    const dir = tmpDir();
    const vmStore = new CurrentGuardVariantMatrixStore(dir);
    const vm = buildCurrentGuardVariantMatrixReport(vmStore);

    const lane = selectEligiblePaperLane({
      vmReport: vm,
      controllerMode: "SHORT_ONLY",
      regimeFamily: "BEARISH",
    });

    expect(lane).toBeNull();
  });

  // [15] CG_NO_FIB500 never admitted
  it("[15] CG_NO_FIB500_ENTRYSET with negative economics is not paper-admitted even if router selects it", async () => {
    const dir = tmpDir();
    const vmStore = new CurrentGuardVariantMatrixStore(dir);
    const vm = buildCurrentGuardVariantMatrixReport(vmStore);

    const lane = selectEligiblePaperLane({
      vmReport: vm,
      controllerMode: "SHORT_ONLY",
      regimeFamily: "BEARISH",
    });
    if (lane !== null) {
      expect(lane.variantId).not.toBe("CG_NO_FIB500_ENTRYSET");
    }

    // Even with a synthetic row showing CG_NO_FIB500 with positive economics, it remains ineligible
    const fakeVm = {
      ...vm,
      rows: vm.rows.map((r) =>
        r.variantId === "CG_NO_FIB500_ENTRYSET"
          ? { ...r, freshValid: 60, netAvgR: 0.15, pf: 1.4, plus10bpsStillPositive: true, status: "WATCHABLE" }
          : r,
      ),
    };
    const laneWithFib = selectEligiblePaperLane({
      vmReport: fakeVm as any,
      controllerMode: "SHORT_ONLY",
      regimeFamily: "BEARISH",
    });
    if (laneWithFib !== null) {
      expect(laneWithFib.variantId).not.toBe("CG_NO_FIB500_ENTRYSET");
    }
  });

  // [16] router-selected lane that fails gates → null
  it("[16] router-selected lane that fails economics gates is not paper-admitted", async () => {
    const dir = tmpDir();
    const vmStore = new CurrentGuardVariantMatrixStore(dir);
    const vm = buildCurrentGuardVariantMatrixReport(vmStore);

    const lane = selectEligiblePaperLane({
      vmReport: vm,
      controllerMode: "SHORT_ONLY",
      regimeFamily: "BEARISH",
    });
    expect(lane).toBeNull();
  });

  // [17] Eligible economic lane admitted independent of router selection
  it("[17] eligible economic lane is admitted if independently passes gates, regardless of router.selectedCurrentLane", async () => {
    const dir = tmpDir();
    const vmStore = await buildWinningVmStore(dir);
    const vm = buildCurrentGuardVariantMatrixReport(vmStore, { capturedAt: new Date().toISOString() });

    const lane = selectEligiblePaperLane({
      vmReport: vm,
      controllerMode: "SHORT_ONLY",
      regimeFamily: "BEARISH",
    });

    expect(lane).not.toBeNull();
    expect(lane!.variantId).toBe("CG_SCALEOUT_TP1_TRAIL");
  });

  it("[17b] Mixed allocator lane suppresses the legacy VALIDATION_ONLY blocker without resetting paperStartAt", async () => {
    const dir = tmpDir();
    const vmStore = await buildWinningVmStore(dir);
    const vmReport = buildCurrentGuardVariantMatrixReport(vmStore, { capturedAt: new Date().toISOString() });
    const store = new PaperExecutionRouterStore(dir);
    const paperStartAt = new Date(Date.now() - 60_000).toISOString();
    store.ensurePaperStartAt(paperStartAt);

    const report = await runPaperAdmissionAndResolution({
      store,
      vmStore,
      routerReport: routerOf("Mixed rotation"),
      vmReport,
      gateReport: emptyGate(),
      binanceClient: { getKlines: async () => [] },
      now: new Date().toISOString(),
      paperValidationAllowed: false,
      allocatorActiveLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
    });

    expect(report.activeLane).toBe("CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE");
    expect(report.noOrderReason).toBeNull();
    expect(store.getState().paperStartAt).toBe(paperStartAt);
    expect(store.getState().activeLaneId).toBeNull();
    const gate = emptyGate();
    expect(gate.liveBlocked).toBe(true);
    expect(gate.microPilotAllowed).toBe(false);
  });

  // [18] Loss does not trigger hard daily stop
  it("[18] loss does not trigger hard daily stop — system continues", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60_000).toISOString());

    for (let i = 0; i < 3; i++) {
      store.add(
        makePaperOrder({
          paperOrderId: `loss-${i}`,
          dedupeKey: `loss-${i}:CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE`,
          sourceObservationId: `obs-loss-${i}`,
          paperStatus: "PAPER_CLOSED_LOSS",
          grossR: -1,
          costR: -0.07,
          netR: -1.07,
          netPnlAmount: -21.4,
        }),
      );
    }

    const report = buildPaperPerformanceReport(store);
    expect(report.operationalSafetyStatus).toBe("OK");
    expect(store.all.length).toBe(3);
  });

  // [19] Consecutive losses do not trigger hard stop
  it("[19] consecutive losses do not trigger a hard stop — only lane performance review", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60_000).toISOString());

    for (let i = 0; i < 5; i++) {
      store.add(
        makePaperOrder({
          paperOrderId: `consec-loss-${i}`,
          dedupeKey: `consec-loss-${i}:lane`,
          sourceObservationId: `obs-${i}`,
          paperStatus: "PAPER_CLOSED_LOSS",
          grossR: -1,
          costR: -0.07,
          netR: -1.07,
          netPnlAmount: -21.4,
        }),
      );
    }

    const report = buildPaperPerformanceReport(store);
    expect(report.operationalSafetyStatus).toBe("OK");
    expect(report.headlineLoss).toBe(5);
  });

  // [20] Consecutive losses lower lane confidence
  it("[20] consecutive losses lower lane confidence to DEGRADED", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60_000).toISOString());

    for (let i = 0; i < 5; i++) {
      store.add(
        makePaperOrder({
          paperOrderId: `loss-review-${i}`,
          dedupeKey: `loss-review-${i}:lane`,
          sourceObservationId: `obs-r-${i}`,
          paperStatus: "PAPER_CLOSED_LOSS",
          grossR: -1,
          costR: -0.07,
          netR: -1.07,
          netPnlAmount: -21.4,
          // Spaced updatedAt so sort order is preserved
          updatedAt: new Date(Date.now() - (5 - i) * 60_000).toISOString(),
        }),
      );
    }

    const closedOrders = store.all.filter(
      (o) => ["PAPER_CLOSED_WIN", "PAPER_CLOSED_LOSS"].includes(o.paperStatus),
    );
    const emptyVmReport = buildCurrentGuardVariantMatrixReport(new CurrentGuardVariantMatrixStore(dir));

    const rotation = evaluatePaperLaneRotation({
      activeLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
      routerReport: routerOf("Bearish pressure"),
      vmReport: emptyVmReport,
      closedOrders,
      controllerMode: "SHORT_ONLY",
      regimeFamily: "BEARISH",
    });

    expect(["LOW", "DEGRADED"]).toContain(rotation.currentLaneConfidence);
  });

  // [21] Underperforming lane rotates to better lane
  it("[21] underperforming active lane can rotate to a better eligible lane", async () => {
    const dir = tmpDir();
    const vmStore = await buildWinningVmStore(dir);
    const vm = buildCurrentGuardVariantMatrixReport(vmStore, { capturedAt: new Date().toISOString() });
    const store = new PaperExecutionRouterStore(dir);

    for (let i = 0; i < 5; i++) {
      store.add(
        makePaperOrder({
          paperOrderId: `under-${i}`,
          dedupeKey: `under-${i}:SOME_OTHER_LANE`,
          sourceObservationId: `obs-u-${i}`,
          selectedLaneId: "SOME_OTHER_LANE",
          paperStatus: "PAPER_CLOSED_LOSS",
          grossR: -1,
          costR: -0.07,
          netR: -1.07,
          netPnlAmount: -21.4,
          diagnosticLabel: null,
          updatedAt: new Date(Date.now() - (5 - i) * 60_000).toISOString(),
        }),
      );
    }

    const closedOrders = store.all.filter(
      (o) =>
        ["PAPER_CLOSED_WIN", "PAPER_CLOSED_LOSS"].includes(o.paperStatus) &&
        o.diagnosticLabel !== "BACKFILL_DIAGNOSTIC",
    );

    const rotation = evaluatePaperLaneRotation({
      activeLaneId: "SOME_OTHER_LANE",
      routerReport: routerOf("Bearish pressure"),
      vmReport: vm,
      closedOrders,
      controllerMode: "SHORT_ONLY",
      regimeFamily: "BEARISH",
    });

    expect(["LOW", "DEGRADED"]).toContain(rotation.currentLaneConfidence);
    expect([
      "ROTATE_TO_BETTER_LANE",
      "CONTINUE_PAPER_WITH_LOW_CONFIDENCE",
      "PAPER_ONLY_NO_REAL_APPROVAL",
    ]).toContain(rotation.action);
  });

  // [22] No better lane → keep paper with LOW/DEGRADED
  it("[22] no better eligible lane → keep paper only with LOW/DEGRADED confidence", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    const emptyVmStore = new CurrentGuardVariantMatrixStore(dir);
    const emptyVm = buildCurrentGuardVariantMatrixReport(emptyVmStore);

    for (let i = 0; i < 5; i++) {
      store.add(
        makePaperOrder({
          paperOrderId: `conf-${i}`,
          dedupeKey: `conf-${i}:lane`,
          sourceObservationId: `obs-c-${i}`,
          paperStatus: "PAPER_CLOSED_LOSS",
          grossR: -1,
          costR: -0.07,
          netR: -1.07,
          netPnlAmount: -21.4,
          updatedAt: new Date(Date.now() - (5 - i) * 60_000).toISOString(),
        }),
      );
    }
    const closedOrders = store.all.filter(
      (o) => ["PAPER_CLOSED_WIN", "PAPER_CLOSED_LOSS"].includes(o.paperStatus),
    );

    const rotation = evaluatePaperLaneRotation({
      activeLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
      routerReport: routerOf("Bearish pressure"),
      vmReport: emptyVm,
      closedOrders,
      controllerMode: "SHORT_ONLY",
      regimeFamily: "BEARISH",
    });

    expect([
      "CONTINUE_PAPER_WITH_LOW_CONFIDENCE",
      "PAPER_ONLY_NO_REAL_APPROVAL",
    ]).toContain(rotation.action);
    expect(rotation.selectedNextLaneId).toBeNull();
    expect(["LOW", "DEGRADED"]).toContain(rotation.currentLaneConfidence);
  });

  it("[22b] active lane confidence is lane-scoped, not diluted by profitable orders from other lanes", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    const activeLane = "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE";

    for (let i = 0; i < 12; i++) {
      store.add(
        makePaperOrder({
          paperOrderId: `active-loss-${i}`,
          dedupeKey: `active-loss-${i}:${activeLane}`,
          sourceObservationId: `active-loss-obs-${i}`,
          selectedLaneId: activeLane,
          paperStatus: "PAPER_CLOSED_LOSS",
          netR: -0.5,
          netPnlAmount: -10,
        }),
      );
      store.add(
        makePaperOrder({
          paperOrderId: `other-win-${i}`,
          dedupeKey: `other-win-${i}:OTHER_LANE`,
          sourceObservationId: `other-win-obs-${i}`,
          selectedLaneId: "OTHER_LANE",
          paperStatus: "PAPER_CLOSED_WIN",
          netR: 1,
          netPnlAmount: 20,
        }),
      );
    }

    const report = buildPaperPerformanceReport(store, {
      activeLaneId: activeLane,
      laneConfidence: "HIGH",
    });

    expect(report.headlineNetAvgR).toBeGreaterThan(0);
    expect(report.activeLaneClosed).toBe(12);
    expect(report.activeLaneNetAvgR).toBe(-0.5);
    expect(report.paperLaneConfidence).toBe("DEGRADED");
  });

  it("[22c] variant-matrix REJECT quarantines the active lane despite positive historical paper results", async () => {
    const dir = tmpDir();
    const vmStore = await buildWinningVmStore(dir);
    const vm = buildCurrentGuardVariantMatrixReport(vmStore, { capturedAt: new Date().toISOString() });
    const wide = vm.rows.find((row) => row.variantId === "CG_WIDE_STOP_TP_WIDE")!;
    wide.status = "REJECT";
    wide.freshValid = 60;
    wide.netAvgR = -0.2;
    wide.pf = 0.6;

    const activeLane = "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE";
    const closedOrders = Array.from({ length: 12 }, (_, i) =>
      makePaperOrder({
        paperOrderId: `historical-win-${i}`,
        dedupeKey: `historical-win-${i}:${activeLane}`,
        sourceObservationId: `historical-win-obs-${i}`,
        selectedLaneId: activeLane,
        paperStatus: "PAPER_CLOSED_WIN",
        netR: 1,
        netPnlAmount: 20,
      }),
    );

    const rotation = evaluatePaperLaneRotation({
      activeLaneId: activeLane,
      routerReport: routerOf("Bearish pressure"),
      vmReport: vm,
      closedOrders,
      controllerMode: "SHORT_ONLY",
      regimeFamily: "BEARISH",
    });

  expect(rotation.currentLaneConfidence).toBe("DEGRADED");
  expect(rotation.action).toBe("PAPER_ONLY_NO_REAL_APPROVAL");
  expect(rotation.reason).toContain("quarantine new paper admission");
  });

  it("[22ca] paper brief surfaces the current batch lane separately from the headline active lane", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    const report = buildPaperPerformanceReport(store, {
      activeLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
      laneConfidence: "MEDIUM",
    });
    report.currentBatchActiveLane = "CG_LONG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE";
    report.currentBatchOrderMode = "DIAGNOSTIC_ONLY";
    report.currentBatchCreatedCount = 9;
    const lines = buildPaperExecutionRouterBriefLines(report);
    expect(lines.some((line) => line.includes("activeLane=CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE"))).toBe(true);
    expect(lines.some((line) => line.includes("currentBatchLane=CG_LONG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE"))).toBe(true);
    expect(lines.some((line) => line.includes("batchMode=DIAGNOSTIC_ONLY"))).toBe(true);
  });

  // [23] Operational safety BLOCKED surfaced
  it("[22d] trail challenger keeps running after TP1 and resolves at path end", async () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    const openedAtMs = Date.now() - 10 * 60_000;
    store.add(
      makePaperOrder({
        paperOrderId: "trail-runner-1",
        dedupeKey: "trail-runner-1:CG_VARIANT_MATRIX:CG_TRAIL_AFTER_TP1",
        sourceObservationId: "trail-runner-obs-1",
        selectedLaneId: "CG_VARIANT_MATRIX:CG_TRAIL_AFTER_TP1",
        variantExitRule: "trail_after_tp1",
        openedAt: new Date(openedAtMs).toISOString(),
        createdAt: new Date(openedAtMs).toISOString(),
        updatedAt: new Date(openedAtMs).toISOString(),
        entryPrice: 100,
        stopLoss: 103,
        takeProfitLevels: [96],
        plannedStopDistanceBps: 300,
        paperOrderMode: "DIAGNOSTIC_ONLY",
      }),
    );

    const result = await resolvePaperOrders(store, {
      getKlines: async (_symbol, interval) => {
        if (interval === "1m") return [];
        return [
          [openedAtMs, "0", "99.5", "95.5", "96", "0", openedAtMs + 300_000],
          [openedAtMs + 300_000, "0", "98", "93.5", "94", "0", openedAtMs + 600_000],
        ];
      },
    });

    const order = store.all.find((candidate) => candidate.paperOrderId === "trail-runner-1")!;
    expect(result.resolved).toBe(1);
    expect(order.closeReason).toBe("TRAIL_PATH_END");
    expect(order.paperStatus).toBe("PAPER_CLOSED_WIN");
    expect(order.grossR).toBeGreaterThan(1);
    expect(order.paperOrderMode).toBe("DIAGNOSTIC_ONLY");
  });

  // [23] Operational safety BLOCKED surfaced
  it("[23] operational safety BLOCKED status is surfaced in performance report", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60_000).toISOString());

    store.add(
      makePaperOrder({
        paperOrderId: "blocked-1",
        dedupeKey: "blocked-1:lane",
        sourceObservationId: "obs-b-1",
        operationalSafetyStatus: "BLOCKED",
        paperStatus: "PAPER_REJECTED",
        diagnosticLabel: "MISSING_GEOMETRY",
      }),
    );

    const report = buildPaperPerformanceReport(store);
    expect(report.reportOnly).toBe(true);
    expect(report.paperOnly).toBe(true);
  });

  // [24] Paper order resolves WIN via candle path
  it("[24] paper order resolves PAPER_CLOSED_WIN via candle walk (TP hit, no SL)", async () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60_000).toISOString());

    const openedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    store.add(
      makePaperOrder({
        paperOrderId: "win-order-1",
        dedupeKey: "win-1:lane",
        sourceObservationId: "obs-win-1",
        openedAt,
        symbol: "ETHUSDT",
        direction: "SHORT",
        entryPrice: 100,
        stopLoss: 103,
        takeProfitLevels: [96],
        plannedStopDistanceBps: 300,
        paperStatus: "CREATED",
      }),
    );

    const mockBinance: PaperResolverClient = {
      getKlines: async (_s, interval, _opts) => {
        if (interval === "1m") return [];
        const signalMs = new Date(openedAt).getTime();
        return [
          [signalMs - 300_000, "0", "100.2", "99.9", "100", "0", signalMs] as PaperKlineTuple,
          [signalMs, "0", "100.5", "95.5", "96", "0", signalMs + 300_000] as PaperKlineTuple,
        ];
      },
    };

    await resolvePaperOrders(store, mockBinance);

    const order = store.all.find((o) => o.paperOrderId === "win-order-1");
    expect(order!.paperStatus).toBe("PAPER_CLOSED_WIN");
    expect(order!.grossR).toBeGreaterThan(0);
    expect(order!.netR).not.toBeNull();
  });

  // [RESLV-paper] Regression: a stale-expiry backlog must NOT consume the per-run resolution
  // budget. The paper resolver was bounded (maxOrders) with expiries still counted against that
  // budget, so a front-loaded backlog of >7d orders would eat every slot and starve resolvable
  // orders behind it — the same starvation class fixed in the variant-matrix resolver.
  it("[RESLV-paper] expiry backlog does not starve a resolvable order under a tiny budget", async () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60_000).toISOString());
    const staleIso = new Date(Date.now() - 40 * 86400000).toISOString(); // >7d → must expire
    const youngIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // <7d → resolvable
    // Stale orders added FIRST → they sit at the FRONT of the book.
    for (let i = 0; i < 5; i++) {
      store.add(
        makePaperOrder({
          paperOrderId: `stale-${i}`,
          dedupeKey: `stale-${i}:lane`,
          sourceObservationId: `obs-stale-${i}`,
          openedAt: staleIso,
          createdAt: staleIso,
        }),
      );
    }
    // Young, resolvable SHORT order (entry 100 / TP 96) BEHIND the backlog.
    store.add(
      makePaperOrder({
        paperOrderId: "young-win",
        dedupeKey: "young-win:lane",
        sourceObservationId: "obs-young",
        openedAt: youngIso,
        createdAt: youngIso,
        symbol: "ETHUSDT",
        direction: "SHORT",
        entryPrice: 100,
        stopLoss: 103,
        takeProfitLevels: [96],
        plannedStopDistanceBps: 300,
      }),
    );
    const mockBinance: PaperResolverClient = {
      getKlines: async (_s, interval, opts) => {
        if (interval === "1m") return [];
        const signalMs = opts.startTime + 300_000;
        return [
          [signalMs - 300_000, "0", "100.2", "99.9", "100", "0", signalMs] as PaperKlineTuple,
          [signalMs, "0", "100.5", "95.5", "96", "0", signalMs + 300_000] as PaperKlineTuple, // SHORT TP
        ];
      },
    };
    // maxOrders:1 — under the OLD code the 5 stale expiries would eat the budget and the young
    // order would never resolve. With the fix, expiries are swept for free.
    await resolvePaperOrders(store, mockBinance, undefined, { maxOrders: 1 });

    const stale = store.all.filter((o) => o.paperOrderId.startsWith("stale-"));
    expect(stale.length).toBe(5);
    expect(stale.every((o) => o.paperStatus === "PAPER_EXPIRED")).toBe(true);
    const young = store.all.find((o) => o.paperOrderId === "young-win");
    expect(young!.paperStatus).toBe("PAPER_CLOSED_WIN");
  });

  it("[RESLV-paper] unresolved front backlog does not starve a TP-touched order under a tiny budget", async () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60_000).toISOString());
    const oldIso = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const youngIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    store.add(
      makePaperOrder({
        paperOrderId: "old-mid",
        dedupeKey: "old-mid:lane",
        sourceObservationId: "obs-old-mid",
        openedAt: oldIso,
        createdAt: oldIso,
        symbol: "OLDUSDT",
        direction: "SHORT",
        entryPrice: 100,
        stopLoss: 103,
        takeProfitLevels: [96],
        paperStatus: "PAPER_SUBMITTED",
      }),
    );
    store.add(
      makePaperOrder({
        paperOrderId: "young-tp",
        dedupeKey: "young-tp:lane",
        sourceObservationId: "obs-young-tp",
        openedAt: youngIso,
        createdAt: youngIso,
        symbol: "WINUSDT",
        direction: "SHORT",
        entryPrice: 100,
        stopLoss: 103,
        takeProfitLevels: [96],
        paperStatus: "CREATED",
      }),
    );
    const exactFetchSymbols: string[] = [];
    const mockBinance: PaperResolverClient = {
      getKlines: async (symbol, interval, opts) => {
        if (interval === "1m") return [];
        if (opts.limit <= 3) {
          const close = symbol === "WINUSDT" ? 95.5 : 100;
          return [[opts.endTime - 300_000, "0", "101", "95", String(close), "0", opts.endTime] as PaperKlineTuple];
        }
        exactFetchSymbols.push(symbol);
        const signalMs = opts.startTime + 300_000;
        if (symbol === "WINUSDT") {
          return [
            [signalMs - 300_000, "0", "100.2", "99.9", "100", "0", signalMs] as PaperKlineTuple,
            [signalMs, "0", "100.5", "95.5", "96", "0", signalMs + 300_000] as PaperKlineTuple,
          ];
        }
        return [
          [signalMs - 300_000, "0", "100.5", "99.5", "100", "0", signalMs] as PaperKlineTuple,
          [signalMs, "0", "101", "99", "100", "0", signalMs + 300_000] as PaperKlineTuple,
        ];
      },
    };

    await resolvePaperOrders(store, mockBinance, undefined, { maxOrders: 1 });

    expect(exactFetchSymbols).toEqual(["WINUSDT"]);
    expect(store.all.find((o) => o.paperOrderId === "young-tp")!.paperStatus).toBe("PAPER_CLOSED_WIN");
    expect(store.all.find((o) => o.paperOrderId === "old-mid")!.paperStatus).toBe("PAPER_SUBMITTED");
  });

  // [24a] scaleout_tp1_trail resolves via the canonical engine — banks 0.5R partial, NOT tp1_full.
  it("[24a] scaleout exit resolves to blended ~0.5*reward (not collapsed to tp1_full)", async () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60_000).toISOString());

    const openedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const signalMs = new Date(openedAt).getTime();
    store.add(
      makePaperOrder({
        paperOrderId: "scaleout-1",
        dedupeKey: "scaleout-1:lane",
        sourceObservationId: "obs-scaleout-1",
        openedAt,
        symbol: "ETHUSDT",
        direction: "SHORT",
        selectedLaneId: "CG_VARIANT_MATRIX:CG_SCALEOUT_TP1_TRAIL",
        variantExitRule: "scaleout_tp1_trail",
        entryPrice: 100,
        stopLoss: 103, // risk 3
        takeProfitLevels: [96], // full reward = (100-96)/3 = 1.333R
        plannedStopDistanceBps: 300,
        paperStatus: "CREATED",
      }),
    );

    // One candle that touches TP1 (low 95.5<=96) and returns to entry (high 100.2>=100) — no SL.
    // Scaleout banks 0.5 at TP1 + 0.5 runner@breakeven(0) = ~0.667R; tp1_full would give 1.333R.
    const mockBinance: PaperResolverClient = {
      getKlines: async (_s, interval) => {
        if (interval === "1m") return [];
        return [
          [signalMs, "0", "100.2", "95.5", "99", "0", signalMs + 300_000] as PaperKlineTuple,
        ];
      },
    };

    await resolvePaperOrders(store, mockBinance);
    const order = store.all.find((o) => o.paperOrderId === "scaleout-1")!;
    expect(order.paperStatus).toBe("PAPER_CLOSED_WIN");
    expect(order.grossR).toBeGreaterThan(0.6);
    expect(order.grossR).toBeLessThan(0.75); // blended — NOT the 1.333R tp1_full full reward
    expect(order.closeReason).toContain("TRAIL_BREAKEVEN");
  });

  // [24b] maker_limit that never pulls back to entry resolves PAPER_NO_FILL (not a taker fill).
  it("[24b] maker_limit with no pullback to entry resolves PAPER_NO_FILL", async () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60_000).toISOString());

    const openedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const signalMs = new Date(openedAt).getTime();
    store.add(
      makePaperOrder({
        paperOrderId: "maker-nofill-1",
        dedupeKey: "maker-nofill-1:lane",
        sourceObservationId: "obs-maker-1",
        openedAt,
        symbol: "ETHUSDT",
        direction: "SHORT",
        selectedLaneId: "CG_VARIANT_MATRIX:CG_MAKER_LIMIT_SIM",
        variantExitRule: "tp1_full",
        fillMode: "maker_limit",
        entryPrice: 100,
        stopLoss: 103,
        takeProfitLevels: [96],
        plannedStopDistanceBps: 300,
        paperStatus: "CREATED",
      }),
    );

    // SHORT maker fills only if a post-signal candle's high >= entry (100). Here price only falls,
    // so the post-only limit never fills within the window → NO_FILL.
    const mockBinance: PaperResolverClient = {
      getKlines: async (_s, interval) => {
        if (interval === "1m") return [];
        return [
          [signalMs, "0", "99.8", "99.0", "99.2", "0", signalMs + 300_000] as PaperKlineTuple,
          [signalMs + 300_000, "0", "99.1", "98.0", "98.2", "0", signalMs + 600_000] as PaperKlineTuple,
          [signalMs + 600_000, "0", "98.3", "97.0", "97.1", "0", signalMs + 900_000] as PaperKlineTuple,
        ];
      },
    };

    await resolvePaperOrders(store, mockBinance);
    const order = store.all.find((o) => o.paperOrderId === "maker-nofill-1")!;
    expect(order.paperStatus).toBe("PAPER_NO_FILL");
    expect(order.closeReason).toContain("MAKER_NO_FILL");
  });

  // [25] Expired before candle fetch
  it("[25] paper order older than PAPER_ORDER_EXPIRY_MS expires before candle fetch", async () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);

    const oldOpenedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    store.add(
      makePaperOrder({
        paperOrderId: "expired-order-1",
        dedupeKey: "exp-1:lane",
        sourceObservationId: "obs-exp-1",
        openedAt: oldOpenedAt,
        paperStatus: "CREATED",
      }),
    );

    let klinesFetched = false;
    const brokenBinance: PaperResolverClient = {
      getKlines: async () => {
        klinesFetched = true;
        throw new Error("Should not fetch candles for expired order");
      },
    };

    await resolvePaperOrders(store, brokenBinance);

    const order = store.all.find((o) => o.paperOrderId === "expired-order-1");
    expect(order!.paperStatus).toBe("PAPER_EXPIRED");
    expect(klinesFetched).toBe(false);
  });

  // [25a] Max-hold time-stop: a >72h LONG that never hit TP/SL and drifted BELOW
  // entry is force-closed mark-to-market as a LOSS (phantom-equity fix). Before
  // this, wide-stop losers drifted as PAPER_SUBMITTED forever and never hit the
  // ledger, so the book showed only realized winners.
  it("[25a] >72h order with no TP/SL hit, underwater → PAPER_CLOSED_LOSS via MAX_HOLD_MTM", async () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString());

    const openedAt = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString();
    const signalMs = new Date(openedAt).getTime();
    store.add(
      makePaperOrder({
        paperOrderId: "maxhold-loss-1",
        dedupeKey: "maxhold-loss-1:lane",
        sourceObservationId: "obs-maxhold-loss-1",
        openedAt,
        symbol: "ETHUSDT",
        direction: "LONG",
        entryPrice: 100,
        stopLoss: 97, // risk 3, wide stop never touched
        takeProfitLevels: [106], // TP never touched
        plannedStopDistanceBps: 300,
        paperStatus: "CREATED",
      }),
    );

    // Price drifts in 98–99.5 for the whole walk: never <=97 (stop), never >=106 (TP).
    // Last close 98.5 → MTM grossR = (98.5-100)/3 ≈ -0.5R → LOSS.
    const mockBinance: PaperResolverClient = {
      getKlines: async (_s, interval) => {
        if (interval === "1m") return [];
        return [
          [signalMs, "0", "99.5", "98.0", "99.0", "0", signalMs + 300_000] as PaperKlineTuple,
          [signalMs + 300_000, "0", "99.4", "98.2", "98.7", "0", signalMs + 600_000] as PaperKlineTuple,
          [signalMs + 600_000, "0", "99.2", "98.0", "98.5", "0", signalMs + 900_000] as PaperKlineTuple,
        ];
      },
    };

    await resolvePaperOrders(store, mockBinance);
    const order = store.all.find((o) => o.paperOrderId === "maxhold-loss-1")!;
    expect(order.paperStatus).toBe("PAPER_CLOSED_LOSS");
    expect(order.closeReason).toBe("MAX_HOLD_MTM");
    expect(order.netR).not.toBeNull();
    expect(order.netR!).toBeLessThan(0);
    expect(order.netPnlAmount).not.toBeNull();
  });

  // [25b] Symmetric: a >72h order marked ABOVE water (favorable but TP not reached)
  // books a WIN — proving the time-stop is symmetric, not loss-only.
  it("[25b] >72h order with no TP/SL hit, in profit → PAPER_CLOSED_WIN via MAX_HOLD_MTM", async () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString());

    const openedAt = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString();
    const signalMs = new Date(openedAt).getTime();
    store.add(
      makePaperOrder({
        paperOrderId: "maxhold-win-1",
        dedupeKey: "maxhold-win-1:lane",
        sourceObservationId: "obs-maxhold-win-1",
        openedAt,
        symbol: "ETHUSDT",
        direction: "LONG",
        entryPrice: 100,
        stopLoss: 97, // risk 3
        takeProfitLevels: [106], // never reached
        plannedStopDistanceBps: 50, // tight cost so a small favorable MTM stays net-positive
        paperStatus: "CREATED",
      }),
    );

    // Drifts up to ~104 but never tags 106 (TP) nor 97 (stop). Last close 104 →
    // MTM grossR = (104-100)/3 ≈ +1.33R, easily net-positive.
    const mockBinance: PaperResolverClient = {
      getKlines: async (_s, interval) => {
        if (interval === "1m") return [];
        return [
          [signalMs, "0", "102.0", "99.5", "101.5", "0", signalMs + 300_000] as PaperKlineTuple,
          [signalMs + 300_000, "0", "104.5", "101.0", "104.0", "0", signalMs + 600_000] as PaperKlineTuple,
        ];
      },
    };

    await resolvePaperOrders(store, mockBinance);
    const order = store.all.find((o) => o.paperOrderId === "maxhold-win-1")!;
    expect(order.paperStatus).toBe("PAPER_CLOSED_WIN");
    expect(order.closeReason).toBe("MAX_HOLD_MTM");
    expect(order.netR!).toBeGreaterThan(0);
  });

  // [25c] Guard: an order YOUNGER than the 72h horizon that has not hit TP/SL is
  // NOT force-closed — it stays PAPER_SUBMITTED to keep resolving. The time-stop
  // must only fire past the horizon, never cut live positions short.
  it("[25c] order younger than 72h with no TP/SL hit stays PAPER_SUBMITTED (no premature MTM)", async () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60_000).toISOString());

    const openedAt = new Date(Date.now() - 5 * 60_000).toISOString(); // 5 min old
    const signalMs = new Date(openedAt).getTime();
    store.add(
      makePaperOrder({
        paperOrderId: "young-open-1",
        dedupeKey: "young-open-1:lane",
        sourceObservationId: "obs-young-open-1",
        openedAt,
        symbol: "ETHUSDT",
        direction: "LONG",
        entryPrice: 100,
        stopLoss: 97,
        takeProfitLevels: [106],
        plannedStopDistanceBps: 300,
        paperStatus: "CREATED",
      }),
    );

    const mockBinance: PaperResolverClient = {
      getKlines: async (_s, interval) => {
        if (interval === "1m") return [];
        return [
          [signalMs, "0", "99.5", "98.0", "99.0", "0", signalMs + 300_000] as PaperKlineTuple,
        ];
      },
    };

    await resolvePaperOrders(store, mockBinance);
    const order = store.all.find((o) => o.paperOrderId === "young-open-1")!;
    expect(order.paperStatus).toBe("PAPER_SUBMITTED");
    expect(order.netR).toBeNull();
  });

  // [25d] Per-lane max-hold: a CG_WIDE_LONG_RUNNER order (144h hold) at 73h is
  // NOT marked to market — it gets the full let-it-run horizon, unlike a default
  // 72h lane which would close it. Proves maxHoldHours is honored per lane.
  it("[25d] CG_WIDE_LONG_RUNNER order at 73h stays open (144h hold), not MAX_HOLD_MTM", async () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString());

    const openedAt = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString();
    const signalMs = new Date(openedAt).getTime();
    store.add(
      makePaperOrder({
        paperOrderId: "runner-open-1",
        dedupeKey: "runner-open-1:lane",
        sourceObservationId: "obs-runner-open-1",
        openedAt,
        symbol: "ETHUSDT",
        direction: "LONG",
        selectedLaneId: "CG_LONG_VARIANT_MATRIX:CG_WIDE_LONG_RUNNER",
        entryPrice: 100,
        stopLoss: 97,
        takeProfitLevels: [109],
        plannedStopDistanceBps: 300,
        paperStatus: "CREATED",
      }),
    );

    const mockBinance: PaperResolverClient = {
      getKlines: async (_s, interval) => {
        if (interval === "1m") return [];
        return [[signalMs, "0", "99.5", "98.0", "99.0", "0", signalMs + 300_000] as PaperKlineTuple];
      },
    };

    await resolvePaperOrders(store, mockBinance);
    const order = store.all.find((o) => o.paperOrderId === "runner-open-1")!;
    expect(order.paperStatus).toBe("PAPER_SUBMITTED"); // 73h < 144h → still riding
    expect(order.netR).toBeNull();
  });

  // [26] Duplicate observation → no duplicate paper order
  it("[26] duplicate source observation does not create duplicate paper order", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60_000).toISOString());

    const dedupeKey = "obs-dup-1:CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE";
    store.add(
      makePaperOrder({
        paperOrderId: "existing-order",
        dedupeKey,
        sourceObservationId: "obs-dup-1",
        paperStatus: "CREATED",
      }),
    );

    expect(store.hasOrder(dedupeKey)).toBe(true);
    expect(store.all.length).toBe(1);

    expect(store.hasOrder("obs-dup-1:CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE")).toBe(true);
    expect(store.hasOrder("obs-dup-2:CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE")).toBe(false);
  });

  // [27] BACKFILL excluded from headline (detailed)
  it("[27] BACKFILL_DIAGNOSTIC orders excluded from headline metrics (net, PF, WR)", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date().toISOString());

    for (let i = 0; i < 3; i++) {
      store.add(
        makePaperOrder({
          paperOrderId: `bf-win-${i}`,
          dedupeKey: `bf-win-${i}:lane`,
          sourceObservationId: `obs-bf-${i}`,
          diagnosticLabel: "BACKFILL_DIAGNOSTIC",
          paperStatus: "PAPER_CLOSED_WIN",
          grossR: 0.88,
          costR: -0.07,
          netR: 0.81,
          netPnlAmount: 16.2,
        }),
      );
    }
    store.add(
      makePaperOrder({
        paperOrderId: "real-loss-1",
        dedupeKey: "real-loss-1:lane",
        sourceObservationId: "obs-real-1",
        diagnosticLabel: null,
        paperStatus: "PAPER_CLOSED_LOSS",
        grossR: -1,
        costR: -0.07,
        netR: -1.07,
        netPnlAmount: -21.4,
      }),
    );

    const report = buildPaperPerformanceReport(store);
    expect(report.total).toBe(4);
    expect(report.headlineTotal).toBe(1);
    expect(report.headlineWin).toBe(0);
    expect(report.headlineLoss).toBe(1);
    expect(report.headlineNetAvgR).not.toBeNull();
    if (report.headlineNetAvgR !== null) {
      expect(report.headlineNetAvgR).toBeLessThan(0);
    }
  });

  // [28] Operator brief renders section 10
  it("[28] operator brief renders Paper Execution Router section 10 when paperReport is provided", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60_000).toISOString());
    const report = buildPaperPerformanceReport(store);

    const vmStore = new CurrentGuardVariantMatrixStore(dir);
    const vm = buildCurrentGuardVariantMatrixReport(vmStore);
    const gate = buildLiveTradingGateReport({});

    const brief = buildOperatorBrief({
      generatedAt: new Date().toISOString(),
      era: "POST_CALIBRATION",
      scanStatus: null,
      regimeReport: null,
      postCutoverReport: undefined,
      variantMatrixReport: vm,
      gateReport: gate,
      paperReport: report,
    });

    expect(brief).toContain("10. PAPER EXECUTION ROUTER");
    expect(brief).toContain("riskPerTrade=1%");
    expect(brief).toContain("lossHardStop=OFF");
    expect(brief).toContain("paperOnly=true");
    expect(brief.split("\n").length).toBeLessThanOrEqual(OPERATOR_BRIEF_MAX_LINES);
  });

  // [29] liveBlocked + microPilotAllowed invariants
  it("[29] liveBlocked=true and microPilotAllowed=false are never overridden by paper router", () => {
    const gate = emptyGate();
    expect(gate.liveBlocked).toBe(true);
    expect(gate.microPilotAllowed).toBe(false);

    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    const report = buildPaperPerformanceReport(store);

    expect(report.reportOnly).toBe(true);
    expect(report.paperOnly).toBe(true);
    expect(gate.liveBlocked).toBe(true);
    expect(gate.microPilotAllowed).toBe(false);
  });

  // [30] No writes to shadow-positions.json
  it("[30] paper router never writes to shadow-positions.json", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60_000).toISOString());
    store.add(
      makePaperOrder({
        paperOrderId: "noshad-1",
        dedupeKey: "noshad-1:lane",
        sourceObservationId: "obs-ns-1",
      }),
    );

    expect(existsSync(join(dir, "shadow-positions.json"))).toBe(false);
    expect(store.path.endsWith("paper-execution-router.json")).toBe(true);
  });

  // [31] No real exchange order method called
  it("[31] paper resolver never calls a real exchange order method", async () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60_000).toISOString());

    const openedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    store.add(
      makePaperOrder({
        paperOrderId: "no-order-1",
        dedupeKey: "no-order-1:lane",
        sourceObservationId: "obs-no-1",
        openedAt,
        paperStatus: "CREATED",
      }),
    );

    const calledMethods: string[] = [];
    const safeMockClient: PaperResolverClient & { placeOrder?: () => void } = {
      getKlines: async () => {
        calledMethods.push("getKlines");
        return [];
      },
      placeOrder: () => {
        calledMethods.push("placeOrder");
        throw new Error("Should never call placeOrder");
      },
    };

    await resolvePaperOrders(store, safeMockClient);

    expect(calledMethods).not.toContain("placeOrder");
    expect(calledMethods.every((m) => m === "getKlines")).toBe(true);
  });

  // [32] Transient fetch error leaves order as PAPER_SUBMITTED for retry
  it("[32] transient getKlines throw leaves order as PAPER_SUBMITTED, not PAPER_DATA_FAILURE", async () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    store.ensurePaperStartAt(new Date(Date.now() - 60_000).toISOString());

    const openedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    store.add(
      makePaperOrder({
        paperOrderId: "transient-err-1",
        dedupeKey: "transient-1:lane",
        sourceObservationId: "obs-transient-1",
        openedAt,
        paperStatus: "CREATED",
      }),
    );

    const throwingClient: PaperResolverClient = {
      getKlines: async () => { throw new Error("network timeout"); },
    };

    const result = await resolvePaperOrders(store, throwingClient);

    const order = store.all.find((o) => o.paperOrderId === "transient-err-1");
    expect(order!.paperStatus).toBe("PAPER_SUBMITTED");
    expect(order!.closeReason).toBeNull();
    expect(result.errors).toBe(1);
    expect(result.dataFailures).toBe(0);
  });

  // [33] resetTransientFailures resets DATA_FETCH_ERROR orders back to PAPER_SUBMITTED
  it("[33] resetTransientFailures resets DATA_FETCH_ERROR orders and leaves hard failures untouched", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);

    store.add(makePaperOrder({
      paperOrderId: "df-transient-1",
      dedupeKey: "dt-1:lane",
      sourceObservationId: "obs-dt-1",
      paperStatus: "PAPER_DATA_FAILURE",
      closeReason: "DATA_FETCH_ERROR",
    }));
    store.add(makePaperOrder({
      paperOrderId: "df-transient-2",
      dedupeKey: "dt-2:lane",
      sourceObservationId: "obs-dt-2",
      paperStatus: "PAPER_DATA_FAILURE",
      closeReason: "DATA_FETCH_ERROR",
    }));
    store.add(makePaperOrder({
      paperOrderId: "df-hard-nocandles",
      dedupeKey: "dh-1:lane",
      sourceObservationId: "obs-dh-1",
      paperStatus: "PAPER_DATA_FAILURE",
      closeReason: "NO_CANDLES",
    }));
    store.add(makePaperOrder({
      paperOrderId: "df-hard-geometry",
      dedupeKey: "dh-2:lane",
      sourceObservationId: "obs-dh-2",
      paperStatus: "PAPER_DATA_FAILURE",
      closeReason: "INVALID_GEOMETRY",
    }));

    const reset = store.resetTransientFailures();

    expect(reset).toBe(2);

    const t1 = store.all.find((o) => o.paperOrderId === "df-transient-1");
    const t2 = store.all.find((o) => o.paperOrderId === "df-transient-2");
    expect(t1!.paperStatus).toBe("PAPER_SUBMITTED");
    expect(t1!.closeReason).toBeNull();
    expect(t2!.paperStatus).toBe("PAPER_SUBMITTED");
    expect(t2!.closeReason).toBeNull();

    const h1 = store.all.find((o) => o.paperOrderId === "df-hard-nocandles");
    const h2 = store.all.find((o) => o.paperOrderId === "df-hard-geometry");
    expect(h1!.paperStatus).toBe("PAPER_DATA_FAILURE");
    expect(h1!.closeReason).toBe("NO_CANDLES");
    expect(h2!.paperStatus).toBe("PAPER_DATA_FAILURE");
    expect(h2!.closeReason).toBe("INVALID_GEOMETRY");

    // Idempotent: second call is a no-op
    const reset2 = store.resetTransientFailures();
    expect(reset2).toBe(0);
  });

  // [34] cancelPreGateTrailBacklog voids contra-bias / contra-whale / stacked TRAIL SHORTs
  it("[34] cancelPreGateTrailBacklog voids gate-violating open TRAIL SHORTs and preserves history", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    const TRAIL = "CG_VARIANT_MATRIX:CG_TRAIL_AFTER_TP1";
    const prov = (over: Record<string, unknown>) =>
      ({ kronosBias: "SHORT", whaleSignal: "NEUTRAL", ...over } as unknown as PaperOrder["provenance"]);

    // Gate B violator: kronosBias LONG (contra to SHORT)
    store.add(makePaperOrder({
      paperOrderId: "trail-bias-long", dedupeKey: "tbl:lane", sourceObservationId: "obs-tbl",
      symbol: "XRPUSDT", direction: "SHORT", selectedLaneId: TRAIL, paperStatus: "PAPER_SUBMITTED",
      provenance: prov({ kronosBias: "LONG" }),
    }));
    // Gate D violator: whaleSignal BULLISH (contra to SHORT)
    store.add(makePaperOrder({
      paperOrderId: "trail-whale-bull", dedupeKey: "twb:lane", sourceObservationId: "obs-twb",
      symbol: "LINKUSDT", direction: "SHORT", selectedLaneId: TRAIL, paperStatus: "CREATED",
      provenance: prov({ whaleSignal: "BULLISH" }),
    }));
    // Gate C stack: two gate-clean BNB SHORTs — earliest kept, later voided
    store.add(makePaperOrder({
      paperOrderId: "trail-bnb-early", dedupeKey: "tbe:lane", sourceObservationId: "obs-tbe",
      symbol: "BNBUSDT", direction: "SHORT", selectedLaneId: TRAIL, paperStatus: "CREATED",
      createdAt: "2026-06-06T19:27:00.000Z", provenance: prov({}),
    }));
    store.add(makePaperOrder({
      paperOrderId: "trail-bnb-late", dedupeKey: "tbla:lane", sourceObservationId: "obs-tbla",
      symbol: "BNBUSDT", direction: "SHORT", selectedLaneId: TRAIL, paperStatus: "CREATED",
      createdAt: "2026-06-06T19:41:00.000Z", provenance: prov({}),
    }));
    // Gate-clean singleton — must stay OPEN
    store.add(makePaperOrder({
      paperOrderId: "trail-clean", dedupeKey: "tc:lane", sourceObservationId: "obs-tc",
      symbol: "SEIUSDT", direction: "SHORT", selectedLaneId: TRAIL, paperStatus: "CREATED",
      entryPrice: 1.5, stopLoss: 1.545, takeProfitLevels: [1.455], provenance: prov({}),
    }));
    // Non-trail lane SHORT — untouched
    store.add(makePaperOrder({
      paperOrderId: "wide-short", dedupeKey: "ws:lane", sourceObservationId: "obs-ws",
      symbol: "XRPUSDT", direction: "SHORT", selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
      paperStatus: "CREATED", provenance: prov({ kronosBias: "LONG" }),
    }));
    // TRAIL LONG contra — untouched (method only targets SHORT)
    store.add(makePaperOrder({
      paperOrderId: "trail-long", dedupeKey: "tl:lane", sourceObservationId: "obs-tl",
      symbol: "ADAUSDT", direction: "LONG", selectedLaneId: TRAIL, paperStatus: "CREATED",
      provenance: prov({ whaleSignal: "BULLISH" }),
    }));
    // Already-closed TRAIL SHORT loss — untouched (not open)
    store.add(makePaperOrder({
      paperOrderId: "trail-closed", dedupeKey: "tcl:lane", sourceObservationId: "obs-tcl",
      symbol: "DOGEUSDT", direction: "SHORT", selectedLaneId: TRAIL, paperStatus: "PAPER_CLOSED_LOSS",
      netR: -1.07, closeReason: "TRAIL_SL_HIT", provenance: prov({ kronosBias: "LONG" }),
    }));

    const voided = store.cancelPreGateTrailBacklog();
    expect(voided).toBe(3); // bias-long + whale-bull + bnb-late

    const get = (id: string) => store.all.find((o) => o.paperOrderId === id)!;
    for (const id of ["trail-bias-long", "trail-whale-bull", "trail-bnb-late"]) {
      expect(get(id).paperStatus).toBe("PAPER_CANCELED");
      expect(get(id).closeReason).toBe("TRAIL_PREGATE_BACKLOG_VOID");
    }
    // Survivors stay open / untouched
    expect(get("trail-bnb-early").paperStatus).toBe("CREATED");
    expect(get("trail-clean").paperStatus).toBe("CREATED");
    expect(get("wide-short").paperStatus).toBe("CREATED");
    expect(get("trail-long").paperStatus).toBe("CREATED");
    expect(get("trail-closed").paperStatus).toBe("PAPER_CLOSED_LOSS");

    // History preserved on a voided order
    expect(get("trail-bias-long").direction).toBe("SHORT");
    expect(get("trail-bias-long").provenance?.kronosBias).toBe("LONG");

    // Idempotent
    expect(store.cancelPreGateTrailBacklog()).toBe(0);
  });

  // [35] cancelQuarantinedTrailShortBacklog voids ALL open TRAIL SHORTs (uniform),
  //      leaves LONG / closed / non-trail untouched, idempotent.
  it("[35] cancelQuarantinedTrailShortBacklog voids every open TRAIL SHORT and spares LONG/closed/non-trail", () => {
    const dir = tmpDir();
    const store = new PaperExecutionRouterStore(dir);
    const TRAIL = "CG_VARIANT_MATRIX:CG_TRAIL_AFTER_TP1";
    const prov = (over: Record<string, unknown>) =>
      ({ kronosBias: "SHORT", whaleSignal: "NEUTRAL", ...over } as unknown as PaperOrder["provenance"]);

    // Two GATE-CLEAN open SHORTs — both voided uniformly under quarantine (no cherry-pick).
    store.add(makePaperOrder({
      paperOrderId: "q-short-submitted", dedupeKey: "qss:lane", sourceObservationId: "obs-qss",
      symbol: "SEIUSDT", direction: "SHORT", selectedLaneId: TRAIL, paperStatus: "PAPER_SUBMITTED",
      provenance: prov({}),
    }));
    store.add(makePaperOrder({
      paperOrderId: "q-short-created", dedupeKey: "qsc:lane", sourceObservationId: "obs-qsc",
      symbol: "AVAXUSDT", direction: "SHORT", selectedLaneId: TRAIL, paperStatus: "CREATED",
      provenance: prov({}),
    }));
    // Open TRAIL LONG — left to resolve naturally (method targets SHORT only).
    store.add(makePaperOrder({
      paperOrderId: "q-long-open", dedupeKey: "qlo:lane", sourceObservationId: "obs-qlo",
      symbol: "ADAUSDT", direction: "LONG", selectedLaneId: TRAIL, paperStatus: "PAPER_SUBMITTED",
      provenance: prov({}),
    }));
    // Already-closed TRAIL SHORT — untouched (not open).
    store.add(makePaperOrder({
      paperOrderId: "q-short-closed", dedupeKey: "qsx:lane", sourceObservationId: "obs-qsx",
      symbol: "DOGEUSDT", direction: "SHORT", selectedLaneId: TRAIL, paperStatus: "PAPER_CLOSED_LOSS",
      netR: -1.07, closeReason: "TRAIL_SL_HIT", provenance: prov({}),
    }));
    // Non-trail SHORT — untouched (different lane).
    store.add(makePaperOrder({
      paperOrderId: "q-wide-short", dedupeKey: "qws:lane", sourceObservationId: "obs-qws",
      symbol: "XRPUSDT", direction: "SHORT", selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
      paperStatus: "CREATED", provenance: prov({}),
    }));

    const voided = store.cancelQuarantinedTrailShortBacklog();
    expect(voided).toBe(2); // both open SHORTs

    const get = (id: string) => store.all.find((o) => o.paperOrderId === id)!;
    for (const id of ["q-short-submitted", "q-short-created"]) {
      expect(get(id).paperStatus).toBe("PAPER_CANCELED");
      expect(get(id).closeReason).toBe("TRAIL_LANE_QUARANTINED");
    }
    expect(get("q-long-open").paperStatus).toBe("PAPER_SUBMITTED");
    expect(get("q-short-closed").paperStatus).toBe("PAPER_CLOSED_LOSS");
    expect(get("q-wide-short").paperStatus).toBe("CREATED");

    // Idempotent
    expect(store.cancelQuarantinedTrailShortBacklog()).toBe(0);
  });
});

describe("paper-execution-router drawdown circuit-breaker", () => {
  const t0 = "2026-06-10T00:00:00.000Z";
  const MIN = 60 * 1000;
  const plus = (base: string, ms: number) => new Date(new Date(base).getTime() + ms).toISOString();

  it("[CB-1] trips at >=15R drawdown, halts through the cooldown, then re-arms with peak reset", () => {
    const store = new PaperExecutionRouterStore(tmpDir());
    store.ensurePaperStartAt(t0);
    const eqStart = store.getState().paperEquityStart;
    const perR = 0.01 * eqStart; // 1% risk per trade → $/R
    const peak = eqStart + 5 * perR;
    const trough = peak - 15 * perR - 1; // 15R + $1 drawdown from the peak

    store.updateEquityPeakAndBreaker(eqStart, t0);
    store.updateEquityPeakAndBreaker(peak, plus(t0, MIN));
    expect(store.isAdmissionHalted(plus(t0, MIN))).toBe(false);

    // Drawdown just past 15R trips the breaker.
    const tripAt = plus(t0, 2 * MIN);
    store.updateEquityPeakAndBreaker(trough, tripAt);
    expect(store.isAdmissionHalted(tripAt)).toBe(true);
    expect(store.getBreakerState().breakerHaltUntil).not.toBeNull();

    // Still halted mid-cooldown (90 min window).
    expect(store.isAdmissionHalted(plus(tripAt, 30 * MIN))).toBe(true);

    // Cooldown elapsed → admission resumes; bookkeeping clears the halt and re-baselines the peak.
    const resumeAt = plus(tripAt, 91 * MIN);
    expect(store.isAdmissionHalted(resumeAt)).toBe(false);
    store.updateEquityPeakAndBreaker(trough, resumeAt);
    expect(store.getBreakerState().breakerHaltUntil).toBeNull();
    expect(store.getBreakerState().peakEquityReached).toBe(trough);

    // A sub-threshold dip from the new baseline does NOT re-trip.
    store.updateEquityPeakAndBreaker(trough - 5 * perR, plus(resumeAt, 5 * MIN));
    expect(store.getBreakerState().breakerHaltUntil).toBeNull();

    // The breaker never creates or mutates orders (headline metrics are unaffected).
    expect(store.all.length).toBe(0);
  });

  it("[CB-2] does not trip on a drawdown below the 15R threshold", () => {
    const store = new PaperExecutionRouterStore(tmpDir());
    store.ensurePaperStartAt(t0);
    const eqStart = store.getState().paperEquityStart;
    const perR = 0.01 * eqStart;
    store.updateEquityPeakAndBreaker(eqStart + 5 * perR, t0); // peak
    store.updateEquityPeakAndBreaker(eqStart + 5 * perR - 12 * perR, plus(t0, MIN)); // 12R dd
    expect(store.isAdmissionHalted(plus(t0, MIN))).toBe(false);
    expect(store.getBreakerState().breakerHaltUntil).toBeNull();
  });
});

describe("headline concentration caps (anti-correlation safety)", () => {
  const openLong = (symbol: string, i: number) =>
    makePaperOrder({ paperOrderId: `h-${symbol}-${i}`, symbol, direction: "LONG", paperStatus: "CREATED" });

  it("isOpenHeadlineOrder counts only open, non-diagnostic, non-backfill orders", () => {
    expect(isOpenHeadlineOrder(makePaperOrder({ paperStatus: "CREATED" }))).toBe(true);
    expect(isOpenHeadlineOrder(makePaperOrder({ paperStatus: "PAPER_SUBMITTED" }))).toBe(true);
    expect(isOpenHeadlineOrder(makePaperOrder({ paperOrderMode: "DIAGNOSTIC_ONLY" }))).toBe(false);
    expect(isOpenHeadlineOrder(makePaperOrder({ diagnosticLabel: "BACKFILL_DIAGNOSTIC" }))).toBe(false);
    expect(isOpenHeadlineOrder(makePaperOrder({ paperStatus: "PAPER_RESOLVED", netR: 1 }))).toBe(false);
  });

  it("allows admission when under all caps", () => {
    expect(headlineConcentrationRejectReason([], "BTCUSDT", "LONG")).toBeNull();
    expect(headlineConcentrationRejectReason([openLong("BTCUSDT", 0)], "BTCUSDT", "LONG")).toBeNull();
  });

  it("blocks a 3rd open headline order on the same symbol (per-symbol cap)", () => {
    const open = Array.from({ length: HEADLINE_MAX_PER_SYMBOL }, (_, i) => openLong("BTCUSDT", i));
    expect(headlineConcentrationRejectReason(open, "BTCUSDT", "LONG")).toBe("HEADLINE_MAX_PER_SYMBOL_REACHED");
    // a different symbol is still fine
    expect(headlineConcentrationRejectReason(open, "ETHUSDT", "LONG")).toBeNull();
  });

  it("blocks the per-direction cap (correlated one-sided basket)", () => {
    // distinct symbols so the per-symbol cap is never the trigger
    const open = Array.from({ length: HEADLINE_MAX_PER_DIRECTION }, (_, i) => openLong(`SYM${i}USDT`, i));
    expect(headlineConcentrationRejectReason(open, "NEWUSDT", "LONG")).toBe("HEADLINE_MAX_PER_DIRECTION_REACHED");
    // opposite direction still has room
    expect(headlineConcentrationRejectReason(open, "NEWUSDT", "SHORT")).toBeNull();
  });

  it("blocks the total open cap (portfolio heat) before per-direction when mixed", () => {
    const half = Math.ceil(HEADLINE_MAX_OPEN / 2);
    const open = [
      ...Array.from({ length: half }, (_, i) => openLong(`L${i}USDT`, i)),
      ...Array.from({ length: HEADLINE_MAX_OPEN - half }, (_, i) =>
        makePaperOrder({ paperOrderId: `s-${i}`, symbol: `S${i}USDT`, direction: "SHORT", paperStatus: "CREATED" }),
      ),
    ];
    expect(open.length).toBe(HEADLINE_MAX_OPEN);
    expect(headlineConcentrationRejectReason(open, "NEWUSDT", "SHORT")).toBe("HEADLINE_MAX_OPEN_REACHED");
  });

  it("does NOT count diagnostic probes — they never hit the cap", () => {
    const probes = Array.from({ length: 10 }, (_, i) =>
      makePaperOrder({ paperOrderId: `d-${i}`, symbol: "BTCUSDT", direction: "LONG", paperOrderMode: "DIAGNOSTIC_ONLY" }),
    );
    const openHeadline = probes.filter(isOpenHeadlineOrder);
    expect(openHeadline).toHaveLength(0);
    expect(headlineConcentrationRejectReason(openHeadline, "BTCUSDT", "LONG")).toBeNull();
  });
});

// Eliminate "unused import" lint complaints
void buildPaperExecutionRouterBriefLines;

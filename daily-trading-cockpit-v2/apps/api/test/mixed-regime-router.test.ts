import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import Fastify from "fastify";

import {
  buildMixedRegimeState,
  buildMixedRegimeReport,
  decideMixedRegimeRouting,
  computeMixedBacklog,
  buildOpenOrderStaleAudit,
  buildMixedLaneComparison,
  buildMixedRegimeBriefLines,
  buildStalePassCohortDiagnostic,
  classifyStalePassHealth,
  computeMixedOccupancySnapshot,
  buildMixedAdmissionDecisionLedger,
  renderMixedAdmissionDecisionLedger,
  buildMixedCapacityOpportunityReplay,
  renderMixedCapacityOpportunityReplay,
  buildMixedCapacityBudgetSimulation,
  renderMixedCapacityBudgetSimulation,
  buildMixedBudgetForwardValidation,
  renderMixedBudgetForwardValidation,
  getActiveMixedPaperBudgetProfileConfig,
  MIXED_LONG_WIDE_LANE,
  renderStalePassCohortDiagnostic,
  type MixedCandidateInput,
  type MixedBacklog,
  type MixedAdmissionLedgerEntry,
  type MixedAdmissionLedgerReport,
  type StalePassSummary,
} from "../src/lib/mixed-regime-router.js";
import {
  buildOperatorBrief,
  OPERATOR_BRIEF_MAX_LINES,
} from "../src/lib/operator-brief.js";
import {
  PaperExecutionRouterStore,
  getPaperExecutionRouterStore,
  _resetPaperExecutionRouterStoreForTests,
  buildPaperPerformanceReport,
  type PaperOrder,
  type PaperOrderStatus,
} from "../src/lib/paper-execution-router.js";
import { buildLiveTradingGateReport } from "../src/lib/live-trading-gate.js";
import { buildRegimeDirectionControllerReport } from "../src/lib/regime-direction-controller.js";
import { registerShadowRoutes } from "../src/routes/shadow.js";

const CG_WIDE = "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE";
const CG_TRAIL = "CG_VARIANT_MATRIX:CG_TRAIL_AFTER_TP1";
const HOUR = 3_600_000;
const tmpDir = () => mkdtempSync(join(os.tmpdir(), "mixed-router-test-"));

const cand = (over: Partial<MixedCandidateInput> = {}): MixedCandidateInput => ({
  symbol: "BTCUSDT",
  direction: "SHORT",
  regime: "Mixed rotation",
  laneId: CG_WIDE,
  atrPercent: 0.8,
  volatilityScore: 0.5,
  liquidityScore: 0.9,
  ...over,
});

const FRESH_BACKLOG: MixedBacklog = {
  openOrderCount: 4,
  staleWideHoldCount: 0,
  criticalCount: 0,
  staleRatio: 0,
  oldestOpenHoldHours: 2,
};

function order(args: {
  symbol?: string;
  direction?: "LONG" | "SHORT";
  regime?: string | null;
  laneId?: string;
  status?: PaperOrderStatus;
  netR?: number | null;
  openedHoursAgo?: number;
  holdHours?: number;
  id?: string;
  paperOrderMode?: "HEADLINE" | "DIAGNOSTIC_ONLY";
  mixedBudgetProfile?: string;
  budgetActivationScope?: "PAPER_ONLY";
}): PaperOrder {
  const now = Date.now();
  const openedMs = now - (args.openedHoursAgo ?? 1) * HOUR;
  return {
    paperOrderId: args.id ?? `m-${Math.random().toString(36).slice(2)}`,
    sourceObservationId: "obs",
    sourceSignalId: null,
    dedupeKey: "obs:lane",
    createdAt: new Date(openedMs).toISOString(),
    updatedAt: new Date(openedMs + (args.holdHours ?? 1) * HOUR).toISOString(),
    openedAt: new Date(openedMs).toISOString(),
    symbol: args.symbol ?? "BTCUSDT",
    direction: args.direction ?? "SHORT",
    regime: args.regime ?? "Bearish pressure",
    controllerMode: "SHORT_ONLY",
    selectedLaneId: args.laneId ?? CG_WIDE,
    routerPermission: "SHADOW_ONLY",
    entryPrice: 100,
    stopLoss: 103,
    takeProfitLevels: [96],
    plannedStopDistanceBps: 800,
    riskPctOfEquity: 1,
    paperEquity: 2000,
    plannedRiskAmount: 20,
    plannedPositionNotional: 666.67,
    plannedRiskR: 1,
    oosUnconfirmed: true,
    infraNotReady: true,
    paperRiskLabel: "EXPERIMENTAL",
    operationalSafetyStatus: "OK",
    diagnosticLabel: null,
    paperOrderMode: args.paperOrderMode,
    mixedBudgetProfile: args.mixedBudgetProfile,
    budgetActivationScope: args.budgetActivationScope,
    paperStatus: args.status ?? "PAPER_CLOSED_WIN",
    grossR: null,
    costR: null,
    netR: args.netR ?? null,
    netPnlAmount: null,
    closeReason: null,
    reportOnly: true,
    paperOnly: true,
  };
}

const waitLedgerEntry = (over: Partial<MixedAdmissionLedgerEntry> = {}): MixedAdmissionLedgerEntry => ({
  timestamp: "2026-06-05T00:00:00.000Z",
  symbol: "BTCUSDT",
  direction: "SHORT",
  regime: "Mixed rotation",
  rawForwardGateDecision: "REJECT",
  forwardGateDecision: "REJECT",
  mixedRouteDecision: "ROUTE_CG_WIDE",
  mixedQualificationDecision: "QUALIFIED",
  stalePassHealth: "UNKNOWN",
  admissionResult: "WAIT_FOR_CAPACITY",
  finalAdmissionResult: "WAIT_FOR_CAPACITY",
  capacityDecision: "WAIT_FOR_CAPACITY",
  occupancyMode: "WAIT_FOR_CAPACITY",
  riskMultiplierAfterOccupancy: 0,
  finalRiskDecision: "ZERO_CAPACITY_WAIT",
  occupancyReason: "OCCUPANCY_MAX_WIDE_OPEN",
  budgetUsed: {
    wideOpen: { used: 20, max: 20 },
    wideStale: { used: 0, max: 12 },
    perSymbolOpen: { used: 0, max: 2 },
    perDirectionOpen: { used: 18, max: 18 },
    passStaleShare: { used: 0, max: 0.7 },
  },
  reasonCategories: ["RAW_GATE_REJECTED", "MIXED_ROUTER_QUALIFIED", "CAPACITY_WAIT"],
  routeReasons: ["OCCUPANCY_MAX_WIDE_OPEN"],
  ...over,
});

const ledgerFixture = (entries: MixedAdmissionLedgerEntry[]): MixedAdmissionLedgerReport => ({
  reportOnly: true,
  diagnosticOnly: true,
  activeGateChange: false,
  liveBlocked: true,
  microPilotAllowed: false,
  generatedAt: "2026-06-05T00:00:00.000Z",
  source: "CURRENT_SCAN_RECONSTRUCTION",
  entries,
  summary: {
    countByAdmissionResult: {},
    countByOccupancyMode: {},
    topSymbolsByWaitForCapacity: [],
    topRejectReasons: [],
    passCandidatesLostToCapacity: 0,
    estimatedOpportunityPressure: 0,
    interpretation: {
      ALLOW: "good signal with available occupancy budget",
      ALLOW_REDUCED: "good signal admitted only at reduced diagnostic risk",
      WAIT_FOR_CAPACITY: "good signal but no slot",
      REJECT: "bad signal",
      INSUFFICIENT_CONTEXT: "missing metadata",
    },
  },
});

const closedWideOrder = (id: string, netR: number, over: Partial<PaperOrder> = {}): PaperOrder => {
  const opened = Date.parse("2026-06-05T01:00:00.000Z") + Number(id.replace(/\D/g, "") || 0) * 60_000;
  return {
    ...order({
      id,
      symbol: "BTCUSDT",
      direction: "SHORT",
      regime: "Mixed rotation",
      status: netR >= 0 ? "PAPER_CLOSED_WIN" : "PAPER_CLOSED_LOSS",
      netR,
    }),
    createdAt: new Date(opened).toISOString(),
    openedAt: new Date(opened).toISOString(),
    updatedAt: new Date(opened + 2 * HOUR).toISOString(),
    selectedLaneId: CG_WIDE,
    ...over,
  };
};

describe("mixed-regime adaptive router (DIAGNOSTIC)", () => {
  // [1] Mixed regime no longer blindly blocks: a qualified PASS short → SELECTIVE_PAPER + CG_WIDE
  it("[1] qualified non-toxic bearish short in mixed → SELECTIVE_PAPER, activeMixedLane CG_WIDE", () => {
    const r = buildMixedRegimeReport({
      regime: "Mixed rotation",
      candidates: [cand({ symbol: "BTCUSDT" }), cand({ symbol: "ETHUSDT" })],
      orders: [order({ status: "PAPER_SUBMITTED", openedHoursAgo: 2 })],
      nowMs: Date.now(),
      trailLaneAvailable: true,
    });
    expect(r.regimeIsMixed).toBe(true);
    expect(r.mixedTradingMode).toBe("SELECTIVE_PAPER");
    expect(r.activeMixedLane).toBe(CG_WIDE);
    expect(r.passCount).toBe(2);
    expect(r.states[0]!.mixedRouteDecision).toBe("ROUTE_CG_WIDE");
    expect(r.states[0]!.risk.riskMultiplier).toBeGreaterThan(0);
  });

  // [2] toxic symbol rejected + zero-sized
  it("[2] toxic symbol → REJECT + riskMultiplier 0", () => {
    const s = buildMixedRegimeState(cand({ symbol: "SEIUSDT" }), FRESH_BACKLOG);
    expect(s.toxicSymbolFlag).toBe(true);
    expect(s.mixedRouteDecision).toBe("REJECT");
    expect(s.mixedRouteReasons).toContain("TOXIC_SYMBOL");
    expect(s.risk.riskMultiplier).toBe(0);
  });

  // [3] non-short → REJECT (challenger-only / off, never production long)
  it("[3] LONG → REJECT challenger-only", () => {
    const s = buildMixedRegimeState(
      cand({ symbol: "BTCUSDT", direction: "LONG", laneId: MIXED_LONG_WIDE_LANE }),
      FRESH_BACKLOG,
    );
    expect(s.mixedRouteDecision).toBe("ROUTE_LONG_CG_WIDE");
    expect(s.mixedRouteReasons).toContain("MIXED_BULLISH_LONG_PROXY");
    expect(s.mixedRouteReasons).toContain("LONG_DIAGNOSTIC_ONLY");
    expect(s.admissionResult).toBe("ALLOW");
    expect(s.risk.riskMultiplier).toBeGreaterThan(0);
  });

  it("[3b] LONG presented on the SHORT lane is rejected", () => {
    const s = buildMixedRegimeState(cand({ symbol: "BTCUSDT", direction: "LONG" }), FRESH_BACKLOG);
    expect(s.mixedRouteDecision).toBe("REJECT");
    expect(s.mixedRouteReasons).toContain("DIRECTION_LANE_MISMATCH");
    expect(s.risk.riskMultiplier).toBe(0);
  });

  it("[3c] toxic LONG remains rejected", () => {
    const s = buildMixedRegimeState(
      cand({ symbol: "SEIUSDT", direction: "LONG", laneId: MIXED_LONG_WIDE_LANE }),
      FRESH_BACKLOG,
    );
    expect(s.mixedRouteDecision).toBe("REJECT");
    expect(s.mixedRouteReasons).toContain("TOXIC_SYMBOL");
    expect(s.risk.riskMultiplier).toBe(0);
  });

  it("[3d] Mixed LONG occupancy is isolated from the existing SHORT book", () => {
    const now = Date.now();
    const shortBook = Array.from({ length: 26 }, (_, i) =>
      order({
        id: `short-only-${i}`,
        symbol: `SHORT${i}USDT`,
        direction: "SHORT",
        laneId: CG_WIDE,
        status: "PAPER_SUBMITTED",
        openedHoursAgo: 2,
      }),
    );
    const r = buildMixedRegimeReport({
      regime: "Mixed rotation",
      candidates: [cand({
        symbol: "BTCUSDT",
        direction: "LONG",
        laneId: MIXED_LONG_WIDE_LANE,
      })],
      orders: shortBook,
      nowMs: now,
    });
    expect(r.states[0]!.occupancy.laneId).toBe(MIXED_LONG_WIDE_LANE);
    expect(r.states[0]!.occupancy.wideOpenCount).toBe(0);
    expect(r.states[0]!.admissionResult).toBe("ALLOW");
    expect(r.activeMixedLanes).toEqual([MIXED_LONG_WIDE_LANE]);
  });

  it("[3e] Mixed SHORT and LONG can be active together without merging lane ids", () => {
    const r = buildMixedRegimeReport({
      regime: "Mixed rotation",
      candidates: [
        cand({ symbol: "BTCUSDT", direction: "SHORT", laneId: CG_WIDE }),
        cand({ symbol: "ETHUSDT", direction: "LONG", laneId: MIXED_LONG_WIDE_LANE }),
      ],
      orders: [],
      nowMs: Date.now(),
    });
    expect(r.activeMixedLanes).toEqual([CG_WIDE, MIXED_LONG_WIDE_LANE]);
    expect(r.states[0]!.mixedRouteDecision).toBe("ROUTE_CG_WIDE");
    expect(r.states[1]!.mixedRouteDecision).toBe("ROUTE_LONG_CG_WIDE");
    expect(r.states[0]!.occupancy.laneId).toBe(CG_WIDE);
    expect(r.states[1]!.occupancy.laneId).toBe(MIXED_LONG_WIDE_LANE);
  });

  // [4] missing metadata → INSUFFICIENT_CONTEXT (not an unsafe PASS)
  it("[4] missing symbol/direction → INSUFFICIENT_CONTEXT, zero size", () => {
    const s = buildMixedRegimeState(cand({ symbol: null }), FRESH_BACKLOG);
    expect(s.mixedRouteDecision).toBe("INSUFFICIENT_CONTEXT");
    expect(s.mixedRouteReasons).toContain("MISSING_METADATA");
    expect(s.risk.riskMultiplier).toBe(0);
  });

  // [5] staleRatio >= 0.40 with UNKNOWN stale-pass health waits for capacity, not CG_TRAIL admission.
  it("[5] staleRatio >= 0.40 + UNKNOWN stale-pass health → WAIT_FOR_CAPACITY", () => {
    const backlog: MixedBacklog = { openOrderCount: 10, staleWideHoldCount: 5, criticalCount: 0, staleRatio: 0.5, oldestOpenHoldHours: 40 };
    const states = [buildMixedRegimeState(cand(), backlog)];
    const r = decideMixedRegimeRouting({ regime: "Mixed rotation", states, backlog, trailLaneAvailable: true });
    expect(r.admissionResult).toBe("WAIT_FOR_CAPACITY");
    expect(r.occupancyMode).toBe("WAIT_FOR_CAPACITY");
    expect(r.mixedTradingMode).toBe("DIAGNOSTIC_ONLY");
    expect(r.activeMixedLane).toBeNull();
    expect(states[0]!.risk.mBacklog).toBe(0); // no new wide size
    expect(states[0]!.risk.riskMultiplier).toBe(0);
  });

  // [6] staleRatio 0.25–0.40 reduces WIDE but does not route to CG_TRAIL.
  it("[6] staleRatio in [0.25,0.40) → ALLOW_REDUCED on CG_WIDE, no CG_TRAIL admission", () => {
    const backlog: MixedBacklog = { openOrderCount: 10, staleWideHoldCount: 3, criticalCount: 0, staleRatio: 0.3, oldestOpenHoldHours: 35 };
    const states = [buildMixedRegimeState(cand(), backlog)];
    const r = decideMixedRegimeRouting({ regime: "Mixed rotation", states, backlog, trailLaneAvailable: true });
    expect(r.admissionResult).toBe("ALLOW_REDUCED");
    expect(r.occupancyMode).toBe("REDUCED_RISK");
    expect(r.mixedTradingMode).toBe("REDUCE_WIDE");
    expect(r.activeMixedLane).toBe(CG_WIDE);
    expect(states[0]!.risk.mBacklog).toBe(0.5); // reduced, not zero
    expect(states[0]!.risk.riskMultiplier).toBeGreaterThan(0);
  });

  it("[6b] latest stale-pass diagnostic shape classifies DIRECTIONALLY_BENIGN", () => {
    const summary: StalePassSummary = {
      verdict: "INSUFFICIENT",
      freshPassN: 95,
      stalePassN: 14,
      freshPassNetAvgR: 0.9003,
      stalePassNetAvgR: 0.9714,
      stalePassPF: Infinity,
      conversionRatio: 1.08,
    };
    expect(classifyStalePassHealth(summary)).toBe("DIRECTIONALLY_BENIGN");
  });

  it("[6c] DIRECTIONALLY_BENIGN high staleRatio uses occupancy budget and allows reduced when not exceeded", () => {
    const backlog: MixedBacklog = { openOrderCount: 10, staleWideHoldCount: 5, criticalCount: 0, staleRatio: 0.5, oldestOpenHoldHours: 40 };
    const occupancy = computeMixedOccupancySnapshot({ orders: [], nowMs: Date.now(), symbol: "BTCUSDT", direction: "SHORT" });
    const states = [buildMixedRegimeState(cand(), backlog, { stalePassHealth: "DIRECTIONALLY_BENIGN", occupancy })];
    const r = decideMixedRegimeRouting({
      regime: "Mixed rotation",
      states,
      backlog,
      trailLaneAvailable: true,
      stalePassHealth: "DIRECTIONALLY_BENIGN",
      occupancy,
    });
    expect(r.admissionResult).toBe("ALLOW_REDUCED");
    expect(r.occupancyMode).toBe("REDUCED_RISK");
    expect(r.activeMixedLane).toBe(CG_WIDE);
    expect(r.activeMixedLane).not.toBe(CG_TRAIL);
  });

  it("[6d] DETERIORATING stale-pass health keeps strict staleRatio block", () => {
    const backlog: MixedBacklog = { openOrderCount: 10, staleWideHoldCount: 5, criticalCount: 0, staleRatio: 0.5, oldestOpenHoldHours: 40 };
    const occupancy = computeMixedOccupancySnapshot({ orders: [], nowMs: Date.now(), symbol: "BTCUSDT", direction: "SHORT" });
    const states = [buildMixedRegimeState(cand(), backlog, { stalePassHealth: "DETERIORATING", occupancy })];
    const r = decideMixedRegimeRouting({
      regime: "Mixed rotation",
      states,
      backlog,
      trailLaneAvailable: true,
      stalePassHealth: "DETERIORATING",
      occupancy,
    });
    expect(r.admissionResult).toBe("REJECT");
    expect(r.occupancyMode).toBe("STRICT_BLOCK");
    expect(r.activeMixedLane).toBeNull();
  });

  it("[6e] benign signal waits for capacity when occupancy budget is exceeded", () => {
    const now = Date.now();
    const open = Array.from({ length: 26 }, (_, i) =>
      order({
        id: `open-${i}`,
        symbol: `SYM${i}USDT`,
        status: "PAPER_SUBMITTED",
        openedHoursAgo: i < 8 ? 40 : 2,
      }),
    );
    const r = buildMixedRegimeReport({
      regime: "Mixed rotation",
      candidates: [cand({ symbol: "BTCUSDT" })],
      orders: [
        ...Array.from({ length: 95 }, (_, i) => order({ id: `fresh-pass-${i}`, netR: 0.9003, holdHours: 10 })),
        ...Array.from({ length: 14 }, (_, i) => order({ id: `stale-pass-${i}`, netR: 0.9714, holdHours: 45 })),
        ...open,
      ],
      nowMs: now,
      trailLaneAvailable: true,
    });
    expect(r.stalePassHealth).toBe("DIRECTIONALLY_BENIGN");
    expect(r.admissionResult).toBe("WAIT_FOR_CAPACITY");
    expect(r.occupancyMode).toBe("WAIT_FOR_CAPACITY");
    expect(r.occupancy.exceeded).toContain("MAX_WIDE_OPEN");
    expect(r.activeMixedLane).toBeNull();
  });

  it("[6f] unrelated diagnostic collection does not consume Mixed occupancy capacity", () => {
    const now = Date.now();
    const unrelatedDiagnostics = Array.from({ length: 35 }, (_, i) =>
      order({
        id: `diag-${i}`,
        status: "PAPER_SUBMITTED",
        paperOrderMode: "DIAGNOSTIC_ONLY",
        regime: "Bearish pressure",
        openedHoursAgo: 2,
      }),
    );
    const occupancy = computeMixedOccupancySnapshot({
      orders: unrelatedDiagnostics,
      nowMs: now,
      symbol: "BTCUSDT",
      direction: "SHORT",
      budget: getActiveMixedPaperBudgetProfileConfig().budget,
    });
    expect(occupancy.rawWideOpenCount).toBe(35);
    expect(occupancy.excludedDiagnosticOpenCount).toBe(35);
    expect(occupancy.wideOpenCount).toBe(0);
    expect(occupancy.exceeded).not.toContain("MAX_WIDE_OPEN");
  });

  it("[6g] active Mixed-profile diagnostics still consume Mixed occupancy capacity", () => {
    const now = Date.now();
    const profileDiagnostics = Array.from({ length: 26 }, (_, i) =>
      order({
        id: `mixed-diag-${i}`,
        status: "PAPER_SUBMITTED",
        paperOrderMode: "DIAGNOSTIC_ONLY",
        mixedBudgetProfile: "SYMBOL_SAFE_RELAXED",
        budgetActivationScope: "PAPER_ONLY",
        regime: "Mixed rotation",
        openedHoursAgo: 2,
      }),
    );
    const occupancy = computeMixedOccupancySnapshot({
      orders: profileDiagnostics,
      nowMs: now,
      symbol: "NEWUSDT",
      direction: "SHORT",
      budget: getActiveMixedPaperBudgetProfileConfig().budget,
    });
    expect(occupancy.rawWideOpenCount).toBe(26);
    expect(occupancy.excludedDiagnosticOpenCount).toBe(0);
    expect(occupancy.wideOpenCount).toBe(26);
    expect(occupancy.exceeded).toContain("MAX_WIDE_OPEN");
  });

  it("[6h] benign per-symbol pressure soft-bypasses capacity wait into ALLOW_REDUCED", () => {
    const now = Date.now();
    const occupancy = computeMixedOccupancySnapshot({
      orders: [
        order({
          id: "btc-1",
          symbol: "BTCUSDT",
          direction: "SHORT",
          status: "PAPER_SUBMITTED",
          regime: "Mixed rotation",
          openedHoursAgo: 2,
          mixedBudgetProfile: "SYMBOL_SAFE_RELAXED",
          budgetActivationScope: "PAPER_ONLY",
        }),
        order({
          id: "btc-2",
          symbol: "BTCUSDT",
          direction: "SHORT",
          status: "PAPER_SUBMITTED",
          regime: "Mixed rotation",
          openedHoursAgo: 3,
          mixedBudgetProfile: "SYMBOL_SAFE_RELAXED",
          budgetActivationScope: "PAPER_ONLY",
        }),
      ],
      nowMs: now,
      symbol: "BTCUSDT",
      direction: "SHORT",
      budget: getActiveMixedPaperBudgetProfileConfig().budget,
    });
    const r = buildMixedRegimeReport({
      regime: "Mixed rotation",
      candidates: [cand({ symbol: "BTCUSDT" })],
      orders: [
        ...Array.from({ length: 95 }, (_, i) => order({ id: `fresh-benign-${i}`, netR: 0.9003, holdHours: 10 })),
        ...Array.from({ length: 14 }, (_, i) => order({ id: `stale-benign-${i}`, netR: 0.9714, holdHours: 45 })),
        ...Array.from({ length: 2 }, (_, i) =>
          order({
            id: `open-btc-${i}`,
            status: "PAPER_SUBMITTED",
            symbol: "BTCUSDT",
            direction: "SHORT",
            regime: "Mixed rotation",
            mixedBudgetProfile: "SYMBOL_SAFE_RELAXED",
            budgetActivationScope: "PAPER_ONLY",
            openedHoursAgo: 2,
          }),
        ),
      ],
      nowMs: now,
      trailLaneAvailable: true,
      occupancyBudget: occupancy.budget,
      activeMixedBudgetProfile: "SYMBOL_SAFE_RELAXED",
    });
    expect(occupancy.exceeded).toEqual(["MAX_PER_SYMBOL_OPEN"]);
    expect(r.stalePassHealth).toBe("DIRECTIONALLY_BENIGN");
    expect(r.admissionResult).toBe("ALLOW_REDUCED");
    expect(r.occupancyMode).toBe("REDUCED_RISK");
    expect(r.states[0]!.mixedRouteReasons).toContain("OCCUPANCY_SOFT_MAX_PER_SYMBOL_OPEN");
  });

  it("[6i] unhealthy or broader pressure still keeps WAIT_FOR_CAPACITY", () => {
    const now = Date.now();
    const r = buildMixedRegimeReport({
      regime: "Mixed rotation",
      candidates: [cand({ symbol: "BTCUSDT" })],
      orders: [
        ...Array.from({ length: 10 }, (_, i) =>
          order({
            id: `btc-over-${i}`,
            status: "PAPER_SUBMITTED",
            symbol: i < 3 ? "BTCUSDT" : `ALT${i}USDT`,
            direction: "SHORT",
            regime: "Mixed rotation",
            mixedBudgetProfile: "SYMBOL_SAFE_RELAXED",
            budgetActivationScope: "PAPER_ONLY",
            openedHoursAgo: 2,
          }),
        ),
      ],
      nowMs: now,
      trailLaneAvailable: true,
      stalePassSummary: {
        freshPassCount: 0,
        stalePassCount: 0,
        freshPassNetAvgR: null,
        stalePassNetAvgR: null,
        freshPassProfitFactor: null,
        stalePassProfitFactor: null,
        freshPassWinRate: null,
        stalePassWinRate: null,
        stalePassConversion: null,
        verdict: "INSUFFICIENT",
      },
      activeMixedBudgetProfile: "SYMBOL_SAFE_RELAXED",
    });
    expect(r.admissionResult).toBe("WAIT_FOR_CAPACITY");
    expect(r.occupancyMode).toBe("WAIT_FOR_CAPACITY");
  });

  // [7] backlog computation from open orders
  it("[7] computeMixedBacklog buckets open holds into stale/critical", () => {
    const now = Date.now();
    const b = computeMixedBacklog(
      [
        order({ status: "PAPER_SUBMITTED", openedHoursAgo: 2 }), // fresh
        order({ status: "PAPER_SUBMITTED", openedHoursAgo: 40 }), // stale
        order({ status: "PAPER_SUBMITTED", openedHoursAgo: 80 }), // critical
        order({ status: "PAPER_CLOSED_WIN", netR: 1, openedHoursAgo: 50 }), // closed → not open
      ],
      now,
    );
    expect(b.openOrderCount).toBe(3);
    expect(b.staleWideHoldCount).toBe(2); // stale + critical
    expect(b.criticalCount).toBe(1);
    expect(b.staleRatio).toBeCloseTo(2 / 3, 4);
  });

  // [8] regime not mixed → router OFF
  it("[8] non-mixed regime → mixedTradingMode OFF", () => {
    const r = buildMixedRegimeReport({ regime: "Bearish pressure", candidates: [cand()], orders: [], nowMs: Date.now() });
    expect(r.mixedTradingMode).toBe("OFF");
  });

  // [9] stale audit returns summary + per-order rows safely with missing fields → UNKNOWN
  it("[9] stale audit: summary + rows with UNKNOWN for untracked fields", () => {
    const audit = buildOpenOrderStaleAudit(
      [
        order({ symbol: "SEIUSDT", status: "PAPER_SUBMITTED", openedHoursAgo: 80 }),
        order({ symbol: "BTCUSDT", status: "PAPER_SUBMITTED", openedHoursAgo: 5 }),
      ],
      Date.now(),
    );
    expect(audit.openOrderCount).toBe(2);
    expect(audit.criticalCount).toBe(1);
    expect(audit.recommendation).toBe("AUDIT_REQUIRED"); // a CRITICAL open order
    const row = audit.rows[0]!; // sorted oldest first
    expect(row.currentR).toBe("UNKNOWN");
    expect(row.mfeR).toBe("UNKNOWN");
    expect(row.distanceToTpR).toBe("UNKNOWN");
    expect(row.regimeNow).toBe("UNKNOWN");
    expect(["FRESH", "STALE", "CRITICAL"]).toContain(row.staleBucket);
  });

  // [10] lane comparison: CG_TRAIL with no history → NEED_MORE_DATA
  it("[10] mixed-lane comparison flags NEED_MORE_DATA when CG_TRAIL has no closed orders", () => {
    const orders = Array.from({ length: 25 }, (_, i) =>
      order({ symbol: "BTCUSDT", status: "PAPER_CLOSED_WIN", netR: 1, id: `w${i}` }),
    );
    const c = buildMixedLaneComparison(orders, { scope: "ALL" });
    expect(c.wide.closed).toBe(25);
    expect(c.trail.closed).toBe(0);
    expect(c.recommendation).toBe("NEED_MORE_DATA");
  });

  // [11] operator brief includes the Mixed Regime section + stays under the line cap
  it("[11] operator brief renders the Mixed Regime section", () => {
    const mixed = buildMixedRegimeReport({
      regime: "Mixed rotation",
      candidates: [cand()],
      orders: [order({ status: "PAPER_SUBMITTED", openedHoursAgo: 2 })],
      nowMs: Date.now(),
      trailLaneAvailable: true,
    });
    const paperReport = buildPaperPerformanceReport(new PaperExecutionRouterStore(tmpDir()));
    const brief = buildOperatorBrief({
      generatedAt: new Date().toISOString(),
      era: "POST_CALIBRATION",
      scanStatus: null,
      regimeReport: buildRegimeDirectionControllerReport({ currentRegime: "Mixed rotation", adaptiveDirectionBias: null, primaryValidationLane: null }),
      postCutoverReport: undefined,
      variantMatrixReport: undefined,
      gateReport: buildLiveTradingGateReport({}),
      paperReport,
      mixedRegimeReport: mixed,
      mixedBudgetForwardValidation: buildMixedBudgetForwardValidation([], "2026-06-05T00:00:00.000Z"),
    });
    expect(brief).toContain("MIXED REGIME ROUTER");
    expect(brief).toContain("mixedTradingMode=");
    expect(brief).toContain("staleRecommendation=");
    expect(brief).toContain("activeMixedBudgetProfile=SYMBOL_SAFE_RELAXED");
    expect(brief).toContain("budgetSource=SIMULATION_RECOMMENDED");
    expect(brief).toContain("budgetActivationScope=PAPER_ONLY");
    expect(brief).toContain("mixedBudgetForwardGuardrail=COLLECTING_OOS");
    expect(brief).toContain("recommendedAction=KEEP_COLLECTING");
    expect(brief).toContain("liveBlocked=TRUE");
    expect(brief.split("\n").length).toBeLessThanOrEqual(OPERATOR_BRIEF_MAX_LINES);
  });

  // [12] ISOLATION: pure — no store write, headline/liveBlocked/microPilot unchanged
  it("[12] no store write, headline/liveBlocked/microPilot unchanged", () => {
    const store = new PaperExecutionRouterStore(tmpDir());
    store.add(order({ status: "PAPER_CLOSED_WIN", netR: 1, id: "k1" }));
    store.add(order({ symbol: "SEIUSDT", status: "PAPER_CLOSED_LOSS", netR: -1, id: "k2" }));
    store.add(order({ status: "PAPER_SUBMITTED", openedHoursAgo: 80, id: "k3" }));
    store.save();
    const before = readFileSync(store.path, "utf-8");
    const perfBefore = buildPaperPerformanceReport(store);
    const gateBefore = buildLiveTradingGateReport({});

    buildMixedRegimeReport({ regime: "Mixed rotation", candidates: [cand()], orders: store.all, nowMs: Date.now(), trailLaneAvailable: true });
    buildOpenOrderStaleAudit(store.all, Date.now());
    buildMixedLaneComparison(store.all, { scope: "MIXED_ONLY" });

    expect(readFileSync(store.path, "utf-8")).toBe(before);
    const perfAfter = buildPaperPerformanceReport(store);
    expect(perfAfter.headlineNetAvgR).toBe(perfBefore.headlineNetAvgR);
    expect(perfAfter.headlinePF).toBe(perfBefore.headlinePF);
    expect(perfAfter.headlineWR).toBe(perfBefore.headlineWR);
    const gateAfter = buildLiveTradingGateReport({});
    expect(gateAfter.liveBlocked).toBe(true);
    expect(gateAfter.microPilotAllowed).toBe(false);
  });

  // [13] brief lines always assert the safety posture
  it("[13] mixed brief lines carry activeGateChange=NO and safety flags", () => {
    const text = buildMixedRegimeBriefLines(
      buildMixedRegimeReport({ regime: "Mixed rotation", candidates: [cand()], orders: [], nowMs: Date.now(), trailLaneAvailable: true }),
    ).join("\n");
    expect(text).toContain("activeGateChange=NO");
    expect(text).toContain("activeMixedBudgetProfile=SYMBOL_SAFE_RELAXED");
    expect(text).toContain("liveBlocked=TRUE");
    expect(text).toContain("microPilotAllowed=FALSE");
  });

  it("[14] ledger counts WAIT_FOR_CAPACITY separately from REJECT", () => {
    const now = Date.now();
    const open = Array.from({ length: 26 }, (_, i) =>
      order({ id: `cap-${i}`, symbol: `CAP${i}USDT`, status: "PAPER_SUBMITTED", openedHoursAgo: i < 8 ? 40 : 2 }),
    );
    const mixed = buildMixedRegimeReport({
      regime: "Mixed rotation",
      candidates: [cand({ symbol: "BTCUSDT" })],
      orders: [
        ...Array.from({ length: 95 }, (_, i) => order({ id: `lf-${i}`, netR: 0.9003, holdHours: 10 })),
        ...Array.from({ length: 14 }, (_, i) => order({ id: `ls-${i}`, netR: 0.9714, holdHours: 45 })),
        ...open,
      ],
      nowMs: now,
      trailLaneAvailable: true,
    });
    const ledger = buildMixedAdmissionDecisionLedger(mixed, "2026-06-05T00:00:00.000Z");
    expect(ledger.summary.countByAdmissionResult.WAIT_FOR_CAPACITY).toBe(1);
    expect(ledger.summary.countByAdmissionResult.REJECT ?? 0).toBe(0);
    expect(ledger.summary.passCandidatesLostToCapacity).toBe(1);
    expect(ledger.summary.topSymbolsByWaitForCapacity[0]).toEqual({ symbol: "BTCUSDT", count: 1 });
    expect(ledger.entries[0]!.rawForwardGateDecision).toBe("REJECT");
    expect(ledger.entries[0]!.mixedRouteDecision).toBe("ROUTE_CG_WIDE");
    expect(ledger.entries[0]!.mixedQualificationDecision).toBe("QUALIFIED");
    expect(ledger.entries[0]!.capacityDecision).toBe("WAIT_FOR_CAPACITY");
    expect(ledger.entries[0]!.finalRiskDecision).toBe("ZERO_CAPACITY_WAIT");
    expect(ledger.entries[0]!.reasonCategories).toEqual([
      "RAW_GATE_REJECTED",
      "MIXED_ROUTER_QUALIFIED",
      "CAPACITY_WAIT",
    ]);
    const text = renderMixedAdmissionDecisionLedger(ledger).join("\n");
    expect(text).toContain("rawGate=REJECT");
    expect(text).toContain("mixedQualified=YES");
    expect(text).toContain("admission=WAIT_FOR_CAPACITY");
    expect(text).toContain("capacity=WAIT_FOR_CAPACITY");
    expect(text).toContain("badSignal=NO");
    expect(text).toContain("rawGateExplanation=RAW_GATE_REJECTED_BUT_MIXED_ROUTER_QUALIFIED");
    expect(text).not.toContain(" gate=REJECT");
  });

  it("[15] ledger groups REJECT reasons correctly", () => {
    const mixed = buildMixedRegimeReport({
      regime: "Mixed rotation",
      candidates: [
        cand({ symbol: "SEIUSDT" }),
        cand({ symbol: "BTCUSDT", direction: "LONG" }),
      ],
      orders: [],
      nowMs: Date.now(),
      trailLaneAvailable: true,
    });
    const ledger = buildMixedAdmissionDecisionLedger(mixed);
    expect(ledger.summary.countByAdmissionResult.REJECT).toBe(2);
    expect(ledger.entries.every((entry) => entry.admissionResult === "REJECT")).toBe(true);
    expect(ledger.entries.every((entry) => entry.reasonCategories.includes("SIGNAL_REJECT"))).toBe(true);
    const reasons = Object.fromEntries(ledger.summary.topRejectReasons.map((r) => [r.reason, r.count]));
    expect(reasons.TOXIC_SYMBOL).toBe(1);
    expect(reasons.DIRECTION_LANE_MISMATCH).toBe(1);
    expect(renderMixedAdmissionDecisionLedger(ledger).join("\n")).toContain("badSignal=YES");
  });

  it("[16] ledger shows ALLOW_REDUCED with reduced risk multiplier", () => {
    const mixed = buildMixedRegimeReport({
      regime: "Mixed rotation",
      candidates: [cand()],
      orders: [
        ...Array.from({ length: 10 }, (_, i) =>
          order({
            id: `reduced-${i}`,
            symbol: `RED${i}USDT`,
            status: "PAPER_SUBMITTED",
            openedHoursAgo: i < 3 ? 40 : 2,
          }),
        ),
      ],
      nowMs: Date.now(),
      trailLaneAvailable: true,
    });
    const ledger = buildMixedAdmissionDecisionLedger(mixed);
    expect(ledger.entries[0]!.admissionResult).toBe("ALLOW_REDUCED");
    expect(ledger.entries[0]!.capacityDecision).toBe("REDUCED_RISK");
    expect(ledger.entries[0]!.finalRiskDecision).toBe("REDUCED_DIAGNOSTIC_RISK");
    expect(ledger.entries[0]!.reasonCategories).toContain("OCCUPANCY_REDUCED_RISK");
    expect(ledger.entries[0]!.riskMultiplierAfterOccupancy).toBeGreaterThan(0);
    expect(ledger.entries[0]!.riskMultiplierAfterOccupancy).toBeLessThan(0.5);
    expect(renderMixedAdmissionDecisionLedger(ledger).join("\n")).toContain("admission=ALLOW_REDUCED");
    expect(renderMixedAdmissionDecisionLedger(ledger).join("\n")).toContain("finalRisk=REDUCED_DIAGNOSTIC_RISK");
  });

  it("[17] ledger maps missing metadata to INSUFFICIENT_CONTEXT", () => {
    const mixed = buildMixedRegimeReport({
      regime: "Mixed rotation",
      candidates: [cand({ symbol: null })],
      orders: [],
      nowMs: Date.now(),
      trailLaneAvailable: true,
    });
    const ledger = buildMixedAdmissionDecisionLedger(mixed);
    expect(ledger.entries[0]!.admissionResult).toBe("INSUFFICIENT_CONTEXT");
    expect(ledger.entries[0]!.mixedQualificationDecision).toBe("INSUFFICIENT_CONTEXT");
    expect(ledger.entries[0]!.capacityDecision).toBe("NOT_APPLICABLE");
    expect(ledger.entries[0]!.finalRiskDecision).toBe("ZERO_METADATA_INSUFFICIENT");
    expect(ledger.entries[0]!.reasonCategories).toContain("METADATA_INSUFFICIENT");
    expect(ledger.entries[0]!.occupancyReason).toBe("MISSING_METADATA");
  });

  it("[18] mixed admission ledger endpoint does not throw on empty book", async () => {
    _resetPaperExecutionRouterStoreForTests();
    getPaperExecutionRouterStore(tmpDir());
    const app = Fastify({ logger: false });
    await registerShadowRoutes(app, null);
    const res = await app.inject({ method: "GET", url: "/api/shadow/mixed-admission-ledger?format=text" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("MIXED ADMISSION DECISION LEDGER");
    expect(res.body).toContain("entries=0");
    await app.close();
    _resetPaperExecutionRouterStoreForTests();
  });

  it("[19] capacity replay selects WAIT_FOR_CAPACITY qualified entries only", () => {
    const ledger = ledgerFixture([
      waitLedgerEntry({ symbol: "BTCUSDT" }),
      waitLedgerEntry({
        symbol: "SEIUSDT",
        mixedRouteDecision: "REJECT",
        mixedQualificationDecision: "NOT_QUALIFIED",
        admissionResult: "REJECT",
        finalAdmissionResult: "REJECT",
        capacityDecision: "NOT_APPLICABLE",
        finalRiskDecision: "ZERO_SIGNAL_REJECT",
        reasonCategories: ["SIGNAL_REJECT"],
      }),
      waitLedgerEntry({
        symbol: null,
        mixedRouteDecision: "INSUFFICIENT_CONTEXT",
        mixedQualificationDecision: "INSUFFICIENT_CONTEXT",
        admissionResult: "INSUFFICIENT_CONTEXT",
        finalAdmissionResult: "INSUFFICIENT_CONTEXT",
        capacityDecision: "NOT_APPLICABLE",
        finalRiskDecision: "ZERO_METADATA_INSUFFICIENT",
        reasonCategories: ["METADATA_INSUFFICIENT"],
      }),
    ]);
    const replay = buildMixedCapacityOpportunityReplay({ ledger, orders: [] });
    expect(replay.waitCapacityCount).toBe(1);
    expect(replay.selectedWaitSymbols).toEqual([{ symbol: "BTCUSDT", direction: "SHORT" }]);
  });

  it("[20] capacity replay excludes REJECT and INSUFFICIENT_CONTEXT entries", () => {
    const ledger = ledgerFixture([
      waitLedgerEntry({
        admissionResult: "REJECT",
        finalAdmissionResult: "REJECT",
        mixedRouteDecision: "REJECT",
        mixedQualificationDecision: "NOT_QUALIFIED",
      }),
      waitLedgerEntry({
        admissionResult: "INSUFFICIENT_CONTEXT",
        finalAdmissionResult: "INSUFFICIENT_CONTEXT",
        mixedRouteDecision: "INSUFFICIENT_CONTEXT",
        mixedQualificationDecision: "INSUFFICIENT_CONTEXT",
      }),
    ]);
    const replay = buildMixedCapacityOpportunityReplay({ ledger, orders: [closedWideOrder("x-1", 1)] });
    expect(replay.waitCapacityCount).toBe(0);
    expect(replay.matchedReplayCount).toBe(0);
    expect(replay.opportunityCostVerdict).toBe("INSUFFICIENT_REPLAY");
  });

  it("[21] exact match capacity replay computes net, PF, WR, and hold metrics", () => {
    const entries = Array.from({ length: 20 }, (_, i) => waitLedgerEntry({ symbol: `EX${i}USDT` }));
    const orders = entries.map((entry, i) =>
      closedWideOrder(`exact-${i}`, i < 10 ? 1 : -0.5, { symbol: entry.symbol!, direction: entry.direction!, regime: entry.regime! }),
    );
    const replay = buildMixedCapacityOpportunityReplay({ ledger: ledgerFixture(entries), orders });
    expect(replay.replayMode).toBe("EXACT_MATCH");
    expect(replay.matchedReplayCount).toBe(20);
    expect(replay.exactMatchedCount).toBe(20);
    expect(replay.unmatchedCount).toBe(0);
    expect(replay.replayNetAvgR).toBeCloseTo(0.25, 6);
    expect(replay.replayPF).toBeCloseTo(2, 6);
    expect(replay.replayWR).toBeCloseTo(0.5, 6);
    expect(replay.avgHoldHours).toBeCloseTo(2, 6);
  });

  it("[22] proxy replay is clearly labeled when exact replay is unavailable", () => {
    const ledger = ledgerFixture([waitLedgerEntry({ symbol: "NOEXACTUSDT" })]);
    const proxyOrders = Array.from({ length: 20 }, (_, i) =>
      closedWideOrder(`proxy-${i}`, 0.4, { symbol: `PX${i}USDT`, direction: "SHORT", regime: "Bearish pressure" }),
    );
    const replay = buildMixedCapacityOpportunityReplay({ ledger, orders: proxyOrders });
    expect(replay.replayMode).toBe("PROXY_COHORT");
    expect(replay.proxyCohortCount).toBe(20);
    expect(replay.matchMethod).toContain("proxy cohort");
    expect(renderMixedCapacityOpportunityReplay(replay).join("\n")).toContain("replayMode=PROXY_COHORT");
  });

  it("[23] matchedReplayCount below 20 yields INSUFFICIENT_REPLAY", () => {
    const ledger = ledgerFixture([waitLedgerEntry()]);
    const replay = buildMixedCapacityOpportunityReplay({ ledger, orders: [closedWideOrder("one-1", 2)] });
    expect(replay.replayMode).toBe("EXACT_MATCH");
    expect(replay.matchedReplayCount).toBe(1);
    expect(replay.opportunityCostVerdict).toBe("INSUFFICIENT_REPLAY");
  });

  it("[24] profitable replay yields CAPACITY_TOO_STRICT", () => {
    const entries = Array.from({ length: 20 }, (_, i) => waitLedgerEntry({ symbol: `GOOD${i}USDT` }));
    const orders = entries.map((entry, i) =>
      closedWideOrder(`good-${i}`, 0.75, { symbol: entry.symbol!, direction: entry.direction!, regime: entry.regime! }),
    );
    const replay = buildMixedCapacityOpportunityReplay({ ledger: ledgerFixture(entries), orders });
    expect(replay.matchedReplayCount).toBe(20);
    expect(replay.replayNetAvgR).toBeGreaterThan(0);
    expect(replay.replayPF).toBe(Infinity);
    expect(replay.opportunityCostVerdict).toBe("CAPACITY_TOO_STRICT");
  });

  it("[25] losing replay yields CAPACITY_PROTECTIVE", () => {
    const entries = Array.from({ length: 20 }, (_, i) => waitLedgerEntry({ symbol: `BAD${i}USDT` }));
    const orders = entries.map((entry, i) =>
      closedWideOrder(`bad-${i}`, -0.25, { symbol: entry.symbol!, direction: entry.direction!, regime: entry.regime! }),
    );
    const replay = buildMixedCapacityOpportunityReplay({ ledger: ledgerFixture(entries), orders });
    expect(replay.matchedReplayCount).toBe(20);
    expect(replay.replayNetAvgR).toBeLessThan(0);
    expect(replay.opportunityCostVerdict).toBe("CAPACITY_PROTECTIVE");
  });

  it("[26] mixed admission ledger compact line includes capacityReplay", () => {
    const ledger = ledgerFixture([waitLedgerEntry()]);
    const replay = buildMixedCapacityOpportunityReplay({ ledger, orders: [closedWideOrder("compact-1", 1)] });
    const text = renderMixedAdmissionDecisionLedger(ledger, replay).join("\n");
    expect(text).toContain("capacityReplay: verdict=INSUFFICIENT_REPLAY");
    expect(text).toContain("matched=1");
    expect(text).toContain("PF=inf");
  });

  it("[27] capacity opportunity replay endpoint does not throw on empty ledger", async () => {
    _resetPaperExecutionRouterStoreForTests();
    getPaperExecutionRouterStore(tmpDir());
    const app = Fastify({ logger: false });
    await registerShadowRoutes(app, null);
    const res = await app.inject({ method: "GET", url: "/api/shadow/mixed-capacity-opportunity-replay?format=text" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("MIXED WAIT-FOR-CAPACITY OPPORTUNITY REPLAY");
    expect(res.body).toContain("waitCapacityCount=0");
    await app.close();
    _resetPaperExecutionRouterStoreForTests();
  });

  it("[28] capacity replay keeps report-only safety constraints unchanged", () => {
    const replay = buildMixedCapacityOpportunityReplay({ ledger: ledgerFixture([waitLedgerEntry()]), orders: [] });
    expect(replay.reportOnly).toBe(true);
    expect(replay.diagnosticOnly).toBe(true);
    expect(replay.activeGateChange).toBe(false);
    expect(replay.liveBlocked).toBe(true);
    expect(replay.microPilotAllowed).toBe(false);
  });

  const capacitySimFixture = (over: { netR?: number; candidates?: MixedCandidateInput[]; orders?: PaperOrder[] } = {}) => {
    const candidates =
      over.candidates ??
      Array.from({ length: 20 }, (_, i) => cand({ symbol: `SIM${i}USDT`, direction: "SHORT" }));
    const open = Array.from({ length: 20 }, (_, i) =>
      order({ id: `sim-open-${i}`, symbol: `OPEN${i}USDT`, status: "PAPER_SUBMITTED", openedHoursAgo: i < 8 ? 40 : 2 }),
    );
    const exact = candidates.map((c, i) =>
      closedWideOrder(`sim-exact-${i}`, over.netR ?? 0.75, {
        symbol: c.symbol!,
        direction: c.direction as "SHORT",
        regime: null,
      }),
    );
    const benignFresh = Array.from({ length: 95 }, (_, i) =>
      order({ id: `benign-fresh-${i}`, symbol: `BF${i}USDT`, regime: "Bearish pressure", netR: 0.9, holdHours: 10 }),
    );
    const benignStale = Array.from({ length: 20 }, (_, i) =>
      order({ id: `benign-stale-${i}`, symbol: `BS${i}USDT`, regime: "Bearish pressure", netR: 0.95, holdHours: 45 }),
    );
    return buildMixedCapacityBudgetSimulation({
      regime: "Mixed rotation",
      candidates,
      orders: [...open, ...benignFresh, ...benignStale, ...exact, ...(over.orders ?? [])],
      nowMs: Date.now(),
      generatedAt: "2026-06-05T00:00:00.000Z",
      trailLaneAvailable: true,
    });
  };

  it("[29] capacity budget simulation current profile reproduces existing wait behavior", () => {
    const sim = capacitySimFixture();
    const current = sim.profiles.find((p) => p.profile === "CONSERVATIVE_CURRENT")!;
    expect(sim.baselineWaitCapacityCount).toBe(20);
    expect(current.waitCapacityCount).toBe(20);
    expect(current.verdict).toBe("TOO_CONSERVATIVE");
  });

  it("[30] relaxed budget reduces waitCapacityCount", () => {
    const sim = capacitySimFixture();
    const current = sim.profiles.find((p) => p.profile === "CONSERVATIVE_CURRENT")!;
    const moderate = sim.profiles.find((p) => p.profile === "MODERATE_RELAXED")!;
    expect(moderate.waitCapacityCount).toBeLessThan(current.waitCapacityCount);
    expect(moderate.reducedCount + moderate.allowedCount).toBeGreaterThan(0);
  });

  it("[31] recovered opportunities use replay outcomes", () => {
    const sim = capacitySimFixture({ netR: 0.75 });
    const moderate = sim.profiles.find((p) => p.profile === "MODERATE_RELAXED")!;
    expect(moderate.estimatedRecoveredOpportunities).toBe(20);
    expect(moderate.estimatedRecoveredNetR).toBeCloseTo(15, 6);
    expect(moderate.estimatedPF).toBe(Infinity);
    expect(moderate.estimatedWR).toBe(1);
  });

  it("[32] high per-symbol concentration is penalized", () => {
    const candidates = Array.from({ length: 20 }, () => cand({ symbol: "BTCUSDT", direction: "SHORT" }));
    const symbolCrowd = Array.from({ length: 3 }, (_, i) =>
      order({ id: `same-symbol-${i}`, symbol: "BTCUSDT", status: "PAPER_SUBMITTED", openedHoursAgo: 2 }),
    );
    const sim = capacitySimFixture({ candidates, orders: symbolCrowd });
    const symbolSafe = sim.profiles.find((p) => p.profile === "SYMBOL_SAFE_RELAXED")!;
    expect(symbolSafe.symbolConcentrationRisk).toBeGreaterThanOrEqual(1);
    expect(symbolSafe.risk).toBe("HIGH");
    expect(symbolSafe.recommendationScore).toBeLessThan(0);
  });

  it("[33] aggressive profile is not recommended unless materially better", () => {
    const sim = capacitySimFixture();
    expect(sim.recommendedProfile).not.toBe("AGGRESSIVE_PAPER_ONLY");
    expect(["MODERATE_RELAXED", "SYMBOL_SAFE_RELAXED"]).toContain(sim.recommendedProfile);
  });

  it("[34] insufficient replay returns INSUFFICIENT", () => {
    const sim = buildMixedCapacityBudgetSimulation({
      regime: "Mixed rotation",
      candidates: [cand({ symbol: "ONEUSDT" })],
      orders: [
        ...Array.from({ length: 20 }, (_, i) =>
          order({ id: `one-open-${i}`, symbol: `ONEOPEN${i}USDT`, status: "PAPER_SUBMITTED", openedHoursAgo: 2 }),
        ),
        closedWideOrder("one-exact-1", 1, { symbol: "ONEUSDT", regime: null }),
      ],
      nowMs: Date.now(),
      generatedAt: "2026-06-05T00:00:00.000Z",
      trailLaneAvailable: true,
    });
    expect(sim.replayMatchedCount).toBeLessThan(20);
    expect(sim.profiles.every((p) => p.verdict === "INSUFFICIENT")).toBe(true);
    expect(sim.recommendedProfile).toBe("NONE");
  });

  it("[35] capacity budget simulation endpoint does not throw on empty data", async () => {
    _resetPaperExecutionRouterStoreForTests();
    getPaperExecutionRouterStore(tmpDir());
    const app = Fastify({ logger: false });
    await registerShadowRoutes(app, null);
    const res = await app.inject({ method: "GET", url: "/api/shadow/mixed-capacity-budget-simulation?format=text" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("MIXED CAPACITY BUDGET SIMULATION");
    expect(res.body).toContain("recommendedProfile=");
    await app.close();
    _resetPaperExecutionRouterStoreForTests();
  });

  it("[36] capacity budget simulation keeps safety constraints unchanged", () => {
    const sim = capacitySimFixture();
    expect(sim.reportOnly).toBe(true);
    expect(sim.diagnosticOnly).toBe(true);
    expect(sim.activeGateChange).toBe(false);
    expect(sim.liveBlocked).toBe(true);
    expect(sim.microPilotAllowed).toBe(false);
    expect(renderMixedCapacityBudgetSimulation(sim).join("\n")).toContain("liveBlocked=TRUE");
    const ledger = ledgerFixture([waitLedgerEntry()]);
    const text = renderMixedAdmissionDecisionLedger(
      ledger,
      buildMixedCapacityOpportunityReplay({ ledger, orders: [] }),
      sim,
    ).join("\n");
    expect(text).toContain("capacityBudgetSim:");
  });

  it("[37] active mixed paper budget defaults to SYMBOL_SAFE_RELAXED and can roll back explicitly", () => {
    const active = getActiveMixedPaperBudgetProfileConfig();
    expect(active.activeMixedBudgetProfile).toBe("SYMBOL_SAFE_RELAXED");
    expect(active.budgetSource).toBe("SIMULATION_RECOMMENDED");
    expect(active.budgetActivationScope).toBe("PAPER_ONLY");
    expect(active.budget.maxWideOpen).toBe(26);
    expect(active.budget.maxWideStale).toBe(16);
    expect(active.budget.maxPerSymbolOpen).toBe(2);
    expect(active.budget.maxPerDirectionOpen).toBe(24);
    expect(active.budget.maxPassStaleShare).toBe(0.8);

    const rollback = getActiveMixedPaperBudgetProfileConfig("CONSERVATIVE_CURRENT");
    expect(rollback.activeMixedBudgetProfile).toBe("CONSERVATIVE_CURRENT");
    expect(rollback.budgetSource).toBe("ROLLBACK_CONFIG");
    expect(rollback.budget.maxWideOpen).toBe(20);
  });

  it("[38] budget forward validation returns NEED_MORE_OOS below 30 closed profile outcomes", () => {
    const orders = Array.from({ length: 3 }, (_, i) =>
      closedWideOrder(`fv-small-${i}`, 0.75, {
        mixedBudgetProfile: "SYMBOL_SAFE_RELAXED",
        mixedBudgetVersion: 1,
        budgetActivationScope: "PAPER_ONLY",
        admissionResult: "ALLOW",
      }),
    );
    const validation = buildMixedBudgetForwardValidation(orders, "2026-06-05T00:00:00.000Z");
    expect(validation.activeMixedBudgetProfile).toBe("SYMBOL_SAFE_RELAXED");
    expect(validation.newDecisionsCount).toBe(3);
    expect(validation.closedUnderProfileCount).toBe(3);
    expect(validation.verdict).toBe("NEED_MORE_OOS");
    expect(validation.guardrail.status).toBe("COLLECTING_OOS");
    expect(validation.guardrail.recommendedAction).toBe("KEEP_COLLECTING");
    expect(validation.guardrail.reasons).toContain("OOS_TOO_SMALL");
    expect(renderMixedBudgetForwardValidation(validation).join("\n")).toContain("verdict=NEED_MORE_OOS");
  });

  it("[39] budget forward validation rolls back bad OOS profile evidence", () => {
    const orders = Array.from({ length: 30 }, (_, i) =>
      closedWideOrder(`fv-bad-${i}`, -0.25, {
        mixedBudgetProfile: "SYMBOL_SAFE_RELAXED",
        mixedBudgetVersion: 1,
        budgetActivationScope: "PAPER_ONLY",
        admissionResult: "ALLOW",
      }),
    );
    const validation = buildMixedBudgetForwardValidation(orders, "2026-06-05T00:00:00.000Z");
    expect(validation.closedUnderProfileCount).toBe(30);
    expect(validation.profileNetAvgR).toBeLessThan(0);
    expect(validation.verdict).toBe("ROLL_BACK_TO_CONSERVATIVE");
    expect(validation.guardrail.status).toBe("ROLLBACK_RECOMMENDED");
    expect(validation.guardrail.recommendedAction).toBe("ROLLBACK_TO_CONSERVATIVE");
    expect(validation.guardrail.reasons).toContain("NETAVG_NEGATIVE");
  });

  it("[40] budget forward validation keeps good OOS profile evidence", () => {
    const orders = Array.from({ length: 30 }, (_, i) =>
      closedWideOrder(`fv-good-${i}`, 0.75, {
        mixedBudgetProfile: "SYMBOL_SAFE_RELAXED",
        mixedBudgetVersion: 1,
        budgetActivationScope: "PAPER_ONLY",
        admissionResult: "ALLOW",
      }),
    );
    const validation = buildMixedBudgetForwardValidation(orders, "2026-06-05T00:00:00.000Z");
    expect(validation.closedUnderProfileCount).toBe(30);
    expect(validation.profileNetAvgR).toBeGreaterThan(0);
    expect(validation.profilePF).toBe(Infinity);
    expect(validation.verdict).toBe("KEEP_PROFILE");
    expect(validation.guardrail.status).toBe("HEALTHY");
    expect(validation.guardrail.recommendedAction).toBe("KEEP_PROFILE");
    expect(validation.guardrail.reasons).toContain("PROFILE_HEALTHY");
  });

  it("[41] budget forward validation warns when PF is between 1.0 and 1.5", () => {
    const winners = Array.from({ length: 20 }, (_, i) =>
      closedWideOrder(`fv-marginal-win-${i}`, 0.3, {
        mixedBudgetProfile: "SYMBOL_SAFE_RELAXED",
        mixedBudgetVersion: 1,
        budgetActivationScope: "PAPER_ONLY",
        admissionResult: "ALLOW",
      }),
    );
    const losers = Array.from({ length: 10 }, (_, i) =>
      closedWideOrder(`fv-marginal-loss-${i}`, -0.5, {
        mixedBudgetProfile: "SYMBOL_SAFE_RELAXED",
        mixedBudgetVersion: 1,
        budgetActivationScope: "PAPER_ONLY",
        admissionResult: "ALLOW",
      }),
    );
    const validation = buildMixedBudgetForwardValidation([...winners, ...losers], "2026-06-05T00:00:00.000Z");
    expect(validation.closedUnderProfileCount).toBe(30);
    expect(validation.profileNetAvgR).toBeGreaterThan(0);
    expect(validation.profilePF).toBeGreaterThanOrEqual(1);
    expect(validation.profilePF).toBeLessThanOrEqual(1.5);
    expect(validation.guardrail.status).toBe("WARNING");
    expect(validation.guardrail.recommendedAction).toBe("REVIEW_PROFILE");
  });

  it("[42] budget forward validation warns when wait capacity spikes", () => {
    const allowed = closedWideOrder("fv-spike-allow", 0.75, {
      mixedBudgetProfile: "SYMBOL_SAFE_RELAXED",
      mixedBudgetVersion: 1,
      budgetActivationScope: "PAPER_ONLY",
      admissionResult: "ALLOW",
    });
    const waiters = Array.from({ length: 29 }, (_, i) =>
      closedWideOrder(`fv-spike-wait-${i}`, 0.75, {
        mixedBudgetProfile: "SYMBOL_SAFE_RELAXED",
        mixedBudgetVersion: 1,
        budgetActivationScope: "PAPER_ONLY",
        admissionResult: "WAIT_FOR_CAPACITY",
      }),
    );
    const validation = buildMixedBudgetForwardValidation([allowed, ...waiters], "2026-06-05T00:00:00.000Z");
    expect(validation.closedUnderProfileCount).toBe(30);
    expect(validation.guardrail.waitCapacitySpike).toBe(true);
    expect(validation.guardrail.status).toBe("WARNING");
    expect(validation.guardrail.recommendedAction).toBe("REVIEW_PROFILE");
    expect(validation.guardrail.reasons).toContain("WAIT_CAPACITY_SPIKE");
  });

  it("[43] mixed budget forward validation endpoint renders guardrail fields", async () => {
    _resetPaperExecutionRouterStoreForTests();
    getPaperExecutionRouterStore(tmpDir());
    const app = Fastify({ logger: false });
    await registerShadowRoutes(app, null);
    const res = await app.inject({ method: "GET", url: "/api/shadow/mixed-budget-forward-validation?format=text" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("MIXED BUDGET FORWARD VALIDATION");
    expect(res.body).toContain("activeMixedBudgetProfile=SYMBOL_SAFE_RELAXED");
    expect(res.body).toContain("verdict=NEED_MORE_OOS");
    expect(res.body).toContain("guardrailStatus=COLLECTING_OOS");
    expect(res.body).toContain("recommendedAction=KEEP_COLLECTING");
    expect(res.body).toContain("reasons=OOS_TOO_SMALL");
    expect(res.body).toContain("activeGateChange=NO");
    expect(res.body).toContain("liveBlocked=TRUE");
    expect(res.body).toContain("microPilotAllowed=FALSE");
    await app.close();
    _resetPaperExecutionRouterStoreForTests();
  });
});

describe("stale-PASS cohort diagnostic (DIAGNOSTIC — closed CG_WIDE)", () => {
  // non-toxic bearish SHORT CG_WIDE → evaluates PASS; closed with netR.
  const pass = (netR: number, holdHours: number, id: string, symbol = "BTCUSDT") =>
    order({ symbol, status: netR >= 0 ? "PAPER_CLOSED_WIN" : "PAPER_CLOSED_LOSS", netR, holdHours, id });
  const many = (n: number, netR: number, holdHours: number, tag: string) =>
    Array.from({ length: n }, (_, i) => pass(netR, holdHours, `${tag}${i}`));

  // [S1/S2] hold-time boundary: 29.9h → FRESH, 30h → STALE
  it("[S1/S2] hold-time buckets at the 30h boundary", () => {
    const d = buildStalePassCohortDiagnostic([
      pass(1, 29.9, "fresh1"),
      pass(1, 30, "stale1"),
      pass(1, 72, "stale2"),
    ]);
    expect(d.cohorts.FRESH_PASS!.n).toBe(1);
    expect(d.cohorts.STALE_PASS!.n).toBe(2);
  });

  // [S3] cohort economics computed correctly
  it("[S3] FRESH_PASS / STALE_PASS economics", () => {
    const d = buildStalePassCohortDiagnostic([
      pass(2, 10, "f1"),
      pass(-1, 12, "f2"),
      pass(1, 40, "s1"),
      pass(1, 50, "s2"),
    ]);
    const fp = d.cohorts.FRESH_PASS!;
    expect(fp.n).toBe(2);
    expect(fp.netR).toBeCloseTo(1, 6); // 2 + -1
    expect(fp.netAvgR).toBeCloseTo(0.5, 6);
    expect(fp.avgWinR).toBeCloseTo(2, 6);
    expect(fp.avgLossR).toBeCloseTo(-1, 6);
    expect(fp.grossProfitR).toBeCloseTo(2, 6);
    expect(fp.grossLossR).toBeCloseTo(-1, 6);
    expect(d.cohorts.STALE_PASS!.netAvgR).toBeCloseTo(1, 6);
  });

  // [S4] STALE ≈ FRESH and positive → BENIGN_OCCUPANCY
  it("[S4] STALE comparable to FRESH → BENIGN_OCCUPANCY", () => {
    const d = buildStalePassCohortDiagnostic([
      ...many(20, 1, 10, "f"),
      ...many(20, 0.9, 45, "s"),
    ]);
    expect(d.verdict).toBe("BENIGN_OCCUPANCY");
    expect(d.summary.conversionRatio!).toBeCloseTo(0.9, 2);
  });

  // [S5] STALE materially worse (all losers → PF<1) → TAIL_DETERIORATION
  it("[S5] STALE materially worse → TAIL_DETERIORATION", () => {
    const d = buildStalePassCohortDiagnostic([
      ...many(20, 1, 10, "f"),
      ...many(20, -0.5, 45, "s"),
    ]);
    expect(d.verdict).toBe("TAIL_DETERIORATION");
  });

  // [S6] sample too small → INSUFFICIENT
  it("[S6] n < 20 in either cohort → INSUFFICIENT", () => {
    const d = buildStalePassCohortDiagnostic([...many(5, 1, 10, "f"), ...many(25, 1, 45, "s")]);
    expect(d.verdict).toBe("INSUFFICIENT");
  });

  // [S7] REJECT / toxic do not contaminate the PASS cohort
  it("[S7] toxic + reject excluded from PASS buckets", () => {
    const d = buildStalePassCohortDiagnostic([
      pass(1, 40, "p1", "BTCUSDT"), // PASS
      pass(-1, 40, "t1", "SEIUSDT"), // toxic → REJECT bucket
      order({ symbol: "BTCUSDT", direction: "LONG", status: "PAPER_CLOSED_WIN", netR: 1, holdHours: 40, id: "l1" }), // non-short → REJECT
    ]);
    expect(d.cohorts.STALE_PASS!.n).toBe(1); // only the BTC short
    expect(d.cohorts.STALE_REJECT!.n).toBe(2); // toxic + long
  });

  // [S8] missing/invalid fields do not throw
  it("[S8] partial/invalid data does not throw", () => {
    const bad: PaperOrder = { ...pass(1, 40, "bad"), updatedAt: "not-a-date" };
    const nullNet: PaperOrder = { ...pass(1, 40, "n1"), netR: null };
    expect(() => buildStalePassCohortDiagnostic([bad, nullNet])).not.toThrow();
    const d = buildStalePassCohortDiagnostic([]);
    expect(d.verdict).toBe("INSUFFICIENT");
    expect(d.summary.stalePassNetAvgR).toBeNull();
  });

  // [S9] endpoint renderer is safe + carries the safety posture
  it("[S9] renderer renders verdict + safety flags", () => {
    const text = renderStalePassCohortDiagnostic(
      buildStalePassCohortDiagnostic([...many(20, 1, 10, "f"), ...many(20, 0.9, 45, "s")]),
    ).join("\n");
    expect(text).toContain("STALE-PASS COHORT DIAGNOSTIC");
    expect(text).toContain("verdict=BENIGN_OCCUPANCY");
    expect(text).toContain("FRESH_PASS:");
    expect(text).toContain("STALE_PASS:");
    expect(text).toContain("activeGateChange=NO");
    expect(text).toContain("liveBlocked=TRUE");
    expect(text).toContain("microPilotAllowed=FALSE");
  });

  // [S10] ISOLATION: pure — no store write, headline/live/micro unchanged
  it("[S10] no store write, headline/liveBlocked/microPilot unchanged", () => {
    const store = new PaperExecutionRouterStore(tmpDir());
    for (const o of [...many(3, 1, 10, "f"), ...many(3, -0.5, 45, "s")]) store.add(o);
    store.save();
    const before = readFileSync(store.path, "utf-8");
    const perfBefore = buildPaperPerformanceReport(store);

    buildStalePassCohortDiagnostic(store.all);
    renderStalePassCohortDiagnostic(buildStalePassCohortDiagnostic(store.all));

    expect(readFileSync(store.path, "utf-8")).toBe(before);
    const perfAfter = buildPaperPerformanceReport(store);
    expect(perfAfter.headlineNetAvgR).toBe(perfBefore.headlineNetAvgR);
    expect(perfAfter.headlinePF).toBe(perfBefore.headlinePF);
    expect(perfAfter.headlineWR).toBe(perfBefore.headlineWR);
    const gate = buildLiveTradingGateReport({});
    expect(gate.liveBlocked).toBe(true);
    expect(gate.microPilotAllowed).toBe(false);
  });
});

describe("mixed router OFF semantics (hypothetical vs active admission)", () => {
  const nowMs = Date.now();
  const openOrders = [order({ status: "PAPER_SUBMITTED", openedHoursAgo: 2 })];

  // [OFF1] regimeIsMixed=false → hypothetical labels, NOT active admission labels
  it("[OFF1] non-mixed regime renders hypotheticalIfMixed, not active admission", () => {
    const report = buildMixedRegimeReport({
      regime: "Bearish pressure",
      candidates: [cand()],
      orders: openOrders,
      nowMs,
      trailLaneAvailable: true,
    });
    expect(report.regimeIsMixed).toBe(false);
    const lines = buildMixedRegimeBriefLines(report);
    const text = lines.join("\n");
    expect(text).toContain("mixedTradingMode=OFF");
    expect(text).toContain("hypotheticalIfMixed:");
    expect(text).toContain("mixed router OFF");
    // no ACTIVE admission line (a line that starts with "admissionResult=")
    expect(lines.some((l) => l.trim().startsWith("admissionResult="))).toBe(false);
  });

  // [OFF2] regimeIsMixed=true → active admission labels (no hypothetical wrapper)
  it("[OFF2] mixed regime renders active admission labels", () => {
    const report = buildMixedRegimeReport({
      regime: "Mixed rotation",
      candidates: [cand()],
      orders: openOrders,
      nowMs,
      trailLaneAvailable: true,
    });
    expect(report.regimeIsMixed).toBe(true);
    const lines = buildMixedRegimeBriefLines(report);
    expect(lines.some((l) => l.trim().startsWith("admissionResult="))).toBe(true);
    expect(lines.join("\n")).not.toContain("hypotheticalIfMixed");
  });

  // [OFF3] WAIT_FOR_CAPACITY is counted separately from REJECT
  it("[OFF3] WAIT_FOR_CAPACITY is not counted as REJECT", () => {
    const orders = Array.from({ length: 4 }, (_, i) =>
      closedWideOrder(`wait-${i}`, 0.5, {
        mixedBudgetProfile: "SYMBOL_SAFE_RELAXED",
        mixedBudgetVersion: 1,
        budgetActivationScope: "PAPER_ONLY",
        admissionResult: "WAIT_FOR_CAPACITY",
      }),
    );
    const v = buildMixedBudgetForwardValidation(orders, "2026-06-05T00:00:00.000Z");
    expect(v.newWaitCapacityCount).toBe(4);
    expect(v.newRejectCount).toBe(0);
    expect(v.guardrail.waitCapacityCount).toBe(4);
    expect(v.guardrail.recommendedAction).not.toBe("ROLLBACK_TO_CONSERVATIVE"); // wait != bad signal
  });

  // [OFF4] safety posture preserved in the rendered brief
  it("[OFF4] OFF brief keeps liveBlocked/microPilot/activeGateChange safety flags", () => {
    const report = buildMixedRegimeReport({
      regime: "Bearish pressure",
      candidates: [cand()],
      orders: openOrders,
      nowMs,
      trailLaneAvailable: true,
    });
    const text = buildMixedRegimeBriefLines(report).join("\n");
    expect(text).toContain("activeGateChange=NO");
    expect(text).toContain("liveBlocked=TRUE");
    expect(text).toContain("microPilotAllowed=FALSE");
  });

  // [OFF5] admission ledger distinguishes ACTUAL vs HYPOTHETICAL by current regime
  it("[OFF5] ledger marks HYPOTHETICAL_IF_MIXED when regime is not Mixed, ACTUAL when Mixed", () => {
    const offReport = buildMixedRegimeReport({ regime: "Bearish pressure", candidates: [cand()], orders: openOrders, nowMs, trailLaneAvailable: true });
    const offLedger = buildMixedAdmissionDecisionLedger(offReport, "2026-06-05T00:00:00.000Z");
    expect(offLedger.mixedAdmissionMode).toBe("HYPOTHETICAL_IF_MIXED");
    expect(offLedger.regimeIsMixed).toBe(false);
    const offText = renderMixedAdmissionDecisionLedger(offLedger).join("\n");
    expect(offText).toContain("HYPOTHETICAL_IF_MIXED");
    expect(offText).toContain("NOTE: current regime is NOT Mixed");
    expect(offText).toContain("hypotheticalByAdmissionResult");

    const onReport = buildMixedRegimeReport({ regime: "Mixed rotation", candidates: [cand()], orders: openOrders, nowMs, trailLaneAvailable: true });
    const onLedger = buildMixedAdmissionDecisionLedger(onReport, "2026-06-05T00:00:00.000Z");
    expect(onLedger.mixedAdmissionMode).toBe("ACTUAL_MIXED_ADMISSION");
    const onText = renderMixedAdmissionDecisionLedger(onLedger).join("\n");
    expect(onText).toContain("ACTUAL_MIXED_ADMISSION");
    expect(onText).not.toContain("NOTE: current regime is NOT Mixed");
  });
});

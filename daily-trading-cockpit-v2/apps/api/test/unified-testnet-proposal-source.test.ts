import { describe, expect, it } from "vitest";

import type { Candidate } from "@dtc/shared";
import type { CachedScanCandidates } from "../src/lib/latest-scan-candidates-cache.js";
import {
  buildUnifiedTestnetProposals,
  UnifiedTestnetProposalStore,
} from "../src/lib/unified-testnet-proposal-source.js";
import type { UnifiedOrchestratorStatus } from "../src/lib/unified-testnet-orchestrator.js";

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    rank: 1,
    symbol: "FETUSDT",
    direction: "SHORT",
    finalDirection: "SHORT",
    status: "TRADE_NOW",
    finalStatus: "TRADE_NOW",
    opportunityScore: 80,
    confidence: 75,
    sourceConflict: false,
    directionConflict: false,
    currentPrice: 1,
    stopLoss: 1.02,
    takeProfits: { tp1: 0.98, tp2: null, tp3: null },
    selectedExecutionPlan: null,
    ...overrides,
  } as Candidate;
}

function scan(candidates: Candidate[]): CachedScanCandidates {
  return {
    scanBatchId: "2026-07-12T03:00:00.000Z",
    scanFinishedAt: "2026-07-12T03:00:00.000Z",
    marketRegime: "Bearish pressure",
    candidates,
  };
}

function orchestrator(direction: "LONG" | "SHORT" | null): UnifiedOrchestratorStatus {
  return {
    version: 1,
    enabled: true,
    mode: "UNIFIED_TESTNET",
    legacyExecutorEntryMode: "MANAGE_ONLY",
    brainState: direction ?? "FLAT",
    activeDirection: direction,
    candidateDirection: direction ?? "NEUTRAL",
    candidateStreak: 2,
    lastSampleId: "sample",
    updatedAt: "2026-07-12T03:00:00.000Z",
    neutralProposalAllowed: false,
    neutralProposalReason: null,
    recentCandidates: direction ? [direction, direction] : [],
    lastTrace: null,
    allowedDirectionalLaneIds: direction === "SHORT"
      ? ["CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT", "CG_VARIANT_MATRIX:CG_EXP_SHORT_MFE_GIVEBACK_10X"]
      : direction === "LONG"
        ? ["CG_VARIANT_MATRIX:CG_WIDE_FAST_LONG", "CG_VARIANT_MATRIX:CG_EXP_LONG_MFE_GIVEBACK_10X"]
        : [],
    featureRegistry: [],
  };
}

describe("unified testnet proposal source", () => {
  it("builds fresh fast geometry from a matching tactical scanner candidate", () => {
    const result = buildUnifiedTestnetProposals({
      scan: scan([candidate()]),
      orchestrator: orchestrator("SHORT"),
      posture: "TACTICAL_OR_MIXED",
    });

    expect(result.status.selectedRecipe).toBe("CG_WIDE_FAST_SHORT");
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]).toMatchObject({
      symbol: "FETUSDT",
      direction: "SHORT",
      selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT",
      paperOrderMode: "DIAGNOSTIC_ONLY",
      diagnosticLabel: null,
      paperStatus: "CREATED",
    });
    expect(result.orders[0]!.plannedStopDistanceBps).toBeCloseTo(300);
    expect(result.orders[0]!.takeProfitLevels[0]).toBeCloseTo(0.985);
  });

  it("uses the MFE recipe in an extended trend but keeps execution leverage capped at 3x", () => {
    const result = buildUnifiedTestnetProposals({
      scan: scan([candidate()]),
      orchestrator: orchestrator("SHORT"),
      posture: "EXTENDED_TREND",
    });

    expect(result.status.selectedRecipe).toBe("CG_EXP_SHORT_MFE_GIVEBACK_10X");
    expect(result.orders[0]).toMatchObject({
      variantExitRule: "mfe_giveback",
      experimentalLeverage: 3,
      paperRiskMultiplier: 1,
    });
  });

  it("rejects excluded symbols, conflicts, stale-quality statuses, and opposite directions", () => {
    const result = buildUnifiedTestnetProposals({
      scan: scan([
        candidate({ symbol: "SEIUSDT" }),
        candidate({ symbol: "FETUSDT", directionConflict: true }),
        candidate({ symbol: "WLDUSDT", finalStatus: "WAIT" }),
        candidate({ symbol: "ETHUSDT", direction: "LONG", finalDirection: "LONG", stopLoss: 0.98, takeProfits: { tp1: 1.02, tp2: null, tp3: null } }),
      ]),
      orchestrator: orchestrator("SHORT"),
      posture: "TACTICAL_OR_MIXED",
    });

    expect(result.orders).toEqual([]);
    expect(result.status.reason).toContain("no fresh SHORT candidate");
  });

  it("appends proposals dynamically without contaminating or halting the base paper store", () => {
    const store = new UnifiedTestnetProposalStore({
      baseStore: { all: [], isAdmissionHalted: () => true },
      getOrchestratorStatus: () => orchestrator("SHORT"),
      getScan: () => scan([candidate()]),
      getPosture: () => "TACTICAL_OR_MIXED",
    });

    expect(store.all).toHaveLength(1);
    expect(store.isAdmissionHalted("2026-07-12T03:01:00.000Z")).toBe(false);
    expect(store.getStatus().symbols).toEqual(["FETUSDT"]);
  });

  it("keeps the Binance client-id suffix unique across simultaneous symbols", () => {
    const result = buildUnifiedTestnetProposals({
      scan: scan([
        candidate({ rank: 1, symbol: "FETUSDT" }),
        candidate({ rank: 2, symbol: "DOGEUSDT" }),
      ]),
      orchestrator: orchestrator("SHORT"),
      posture: "EXTENDED_TREND",
    });

    expect(result.orders).toHaveLength(2);
    expect(new Set(result.orders.map((order) => order.paperOrderId.slice(-18))).size).toBe(2);
  });
});

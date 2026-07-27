import type { Candidate } from "@dtc/shared";

import {
  VARIANT_MATRIX_DEFINITIONS,
  deriveVariantGeometry,
  type VariantMatrixSignal,
  type VariantMatrixVariantId,
} from "./current-guard-variant-matrix.js";
import type { CachedScanCandidates } from "./latest-scan-candidates-cache.js";
import type { PaperStoreReader } from "./live-execution-engine.js";
import type { PaperOrder } from "./paper-execution-router.js";
import type { UnifiedOrchestratorStatus } from "./unified-testnet-orchestrator.js";

type ProposalPosture = "EXTENDED_TREND" | "TACTICAL_OR_MIXED";

export interface UnifiedProposalSourceStatus {
  active: boolean;
  scanBatchId: string | null;
  direction: "LONG" | "SHORT" | null;
  posture: ProposalPosture;
  selectedRecipe: string | null;
  proposalCount: number;
  symbols: string[];
  reason: string;
}

interface UnifiedProposalSourceOptions {
  baseStore: PaperStoreReader;
  getOrchestratorStatus: () => UnifiedOrchestratorStatus | null;
  getScan: () => CachedScanCandidates | null;
  getPosture?: () => ProposalPosture | null;
  maxCandidates?: number;
  minConfidence?: number;
}

/**
 * Exported ONLY so paper-subfloor-exclusion.test.ts can assert the safety property this file relies
 * on without knowing it: every recipe here must carry a BINDING `stopFloorBps` (> the non-binding
 * sentinel). These proposals stamp `sourceType: "SCAN_CANDIDATE_LANE_ALLOCATOR"` and a real
 * `plannedStopDistanceBps` WITHOUT ever running `paperOpportunityStopFloorRejection`, so a recipe
 * with a sentinel/absent floor could emit rows the sub-admission-floor predicate would delete from
 * every aggregate even though the gate never applied to them. See the SCOPE note in
 * paper-subfloor-exclusion.ts.
 */
export const RECIPE_BY_DIRECTION = {
  LONG: {
    EXTENDED_TREND: "CG_EXP_LONG_MFE_GIVEBACK_10X",
    TACTICAL_OR_MIXED: "CG_WIDE_FAST_LONG",
  },
  SHORT: {
    EXTENDED_TREND: "CG_EXP_SHORT_MFE_GIVEBACK_10X",
    TACTICAL_OR_MIXED: "CG_WIDE_FAST_SHORT",
  },
} as const satisfies Record<"LONG" | "SHORT", Record<ProposalPosture, VariantMatrixVariantId>>;

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function candidateDirection(candidate: Candidate): "LONG" | "SHORT" | null {
  const direction = candidate.finalDirection ?? candidate.direction;
  return direction === "LONG" || direction === "SHORT" ? direction : null;
}

function candidateSourceId(scan: CachedScanCandidates, candidate: Candidate): string {
  return `${scan.scanBatchId}:${candidate.rank}:${candidate.symbol}:${candidateDirection(candidate) ?? "UNKNOWN"}`;
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-").slice(-120);
}

function proposalForCandidate(
  scan: CachedScanCandidates,
  candidate: Candidate,
  direction: "LONG" | "SHORT",
  recipe: VariantMatrixVariantId,
): PaperOrder | null {
  const def = VARIANT_MATRIX_DEFINITIONS.find((row) => row.id === recipe);
  if (!def || def.excludedSymbols?.includes(candidate.symbol.toUpperCase())) return null;

  const entryPrice = candidate.currentPrice;
  const rawStop = candidate.stopLoss;
  if (!finitePositive(entryPrice) || !finitePositive(rawStop)) return null;
  const stopRightSide = direction === "LONG" ? rawStop < entryPrice : rawStop > entryPrice;
  if (!stopRightSide) return null;

  const rawRisk = Math.abs(entryPrice - rawStop);
  const fallbackTp = direction === "LONG" ? entryPrice + rawRisk : entryPrice - rawRisk;
  const rawTp = finitePositive(candidate.takeProfits.tp1) ? candidate.takeProfits.tp1 : fallbackTp;
  if (!finitePositive(rawTp)) return null;

  const sourceId = candidateSourceId(scan, candidate);
  const signal: VariantMatrixSignal = {
    sourceSignalId: sourceId,
    symbol: candidate.symbol.toUpperCase(),
    direction,
    entryPrice,
    stopLoss: rawStop,
    tp1: rawTp,
    tp2: candidate.takeProfits.tp2,
    tp3: candidate.takeProfits.tp3,
    stopDistanceBps: Math.abs(entryPrice - rawStop) / entryPrice * 10_000,
    regime: scan.marketRegime,
    entryVariant: candidate.selectedExecutionPlan?.selectedEntryVariant ?? null,
    openedAt: scan.scanFinishedAt,
    closedAt: null,
  };
  const geometry = deriveVariantGeometry(signal, def);
  if (geometry.kind !== "ok") return null;

  const laneId = `CG_VARIANT_MATRIX:${recipe}`;
  // LiveExecutionEngine derives Binance client ids from the LAST 18 characters of paperOrderId.
  // Keep rank+symbol at the tail; ending every id with the recipe name makes simultaneous symbols
  // collide at Binance (-4116 duplicate ClientOrderId).
  const paperOrderId = `unified-${recipe}-${safeId(`${scan.scanBatchId}-${candidate.rank}-${candidate.symbol}`)}`;
  const plannedRiskAmount = 50;
  const plannedNotional = plannedRiskAmount / (geometry.stopDistanceBps / 10_000);
  const axisRegimeFamily = direction === "LONG" ? "BULLISH" : "BEARISH";

  return {
    paperOrderId,
    sourceType: "SCAN_CANDIDATE_LANE_ALLOCATOR",
    sourceCandidateId: sourceId,
    scanBatchId: scan.scanBatchId,
    sourceObservationId: sourceId,
    sourceSignalId: sourceId,
    dedupeKey: `${sourceId}:${laneId}`,
    createdAt: scan.scanFinishedAt,
    updatedAt: scan.scanFinishedAt,
    openedAt: scan.scanFinishedAt,
    symbol: candidate.symbol.toUpperCase(),
    direction,
    regime: scan.marketRegime,
    axisVersion: 1,
    axisDirection: direction,
    axisRegimeFamily,
    axisKey: `${axisRegimeFamily}:${direction}`,
    controllerMode: direction === "LONG" ? "LONG_ONLY" : "SHORT_ONLY",
    controllerConfidence: candidate.confidence >= 80 ? "HIGH" : candidate.confidence >= 65 ? "MEDIUM" : "LOW",
    selectedLaneId: laneId,
    routerPermission: "UNIFIED_TESTNET_FRESH_PROPOSAL",
    entryPrice: geometry.entryPrice,
    stopLoss: geometry.stopLoss,
    takeProfitLevels: geometry.takeProfitLevels,
    variantExitRule: def.exitRule,
    fillMode: def.fillMode,
    plannedStopDistanceBps: geometry.stopDistanceBps,
    riskPctOfEquity: 1,
    paperEquity: 5_000,
    plannedRiskAmount,
    plannedPositionNotional: plannedNotional,
    plannedRiskR: 1,
    oosUnconfirmed: true,
    infraNotReady: false,
    paperRiskLabel: def.experimentalOnly ? "EXPERIMENTAL" : "NORMAL",
    paperOrderMode: "DIAGNOSTIC_ONLY",
    operationalSafetyStatus: "OK",
    diagnosticLabel: null,
    paperStatus: "CREATED",
    grossR: null,
    costR: geometry.costR,
    netR: null,
    netPnlAmount: null,
    closeReason: null,
    provenance: null,
    experimentalLeverage: def.experimentalOnly ? 3 : undefined,
    paperRiskMultiplier: 1,
    reportOnly: true,
    paperOnly: true,
  };
}

export function buildUnifiedTestnetProposals(input: {
  scan: CachedScanCandidates | null;
  orchestrator: UnifiedOrchestratorStatus | null;
  posture?: ProposalPosture | null;
  maxCandidates?: number;
  minConfidence?: number;
}): { orders: PaperOrder[]; status: UnifiedProposalSourceStatus } {
  const posture = input.posture ?? "TACTICAL_OR_MIXED";
  const direction = input.orchestrator?.activeDirection ?? null;
  const inactive = (reason: string): { orders: PaperOrder[]; status: UnifiedProposalSourceStatus } => ({
    orders: [],
    status: {
      active: false,
      scanBatchId: input.scan?.scanBatchId ?? null,
      direction,
      posture,
      selectedRecipe: null,
      proposalCount: 0,
      symbols: [],
      reason,
    },
  });
  if (!input.orchestrator?.enabled) return inactive("unified orchestrator disabled");
  if (!input.orchestrator.activeDirection || !input.orchestrator.allowedDirectionalLaneIds.length) {
    return inactive(`brain ${input.orchestrator.brainState} does not allow directional entries`);
  }
  if (!input.scan) return inactive("no cached scanner snapshot");

  const recipe = RECIPE_BY_DIRECTION[input.orchestrator.activeDirection][posture];
  const allowed = input.orchestrator.allowedDirectionalLaneIds.some((laneId) => laneId.endsWith(recipe));
  if (!allowed) return inactive(`recipe ${recipe} not allowed by orchestrator`);

  const minConfidence = Math.max(0, input.minConfidence ?? 60);
  const maxCandidates = Math.max(1, Math.floor(input.maxCandidates ?? 3));
  const orders = input.scan.candidates
    .filter((candidate) => candidateDirection(candidate) === input.orchestrator!.activeDirection)
    .filter((candidate) => candidate.finalStatus === "TRADE_NOW" || candidate.finalStatus === "READY")
    .filter((candidate) => candidate.confidence >= minConfidence)
    .filter((candidate) => !candidate.directionConflict && !candidate.sourceConflict)
    .sort((a, b) => b.opportunityScore - a.opportunityScore || b.confidence - a.confidence || a.rank - b.rank)
    .flatMap((candidate) => {
      const proposal = proposalForCandidate(input.scan!, candidate, input.orchestrator!.activeDirection!, recipe);
      return proposal ? [proposal] : [];
    })
    .slice(0, maxCandidates);

  return {
    orders,
    status: {
      active: true,
      scanBatchId: input.scan.scanBatchId,
      direction: input.orchestrator.activeDirection,
      posture,
      selectedRecipe: recipe,
      proposalCount: orders.length,
      symbols: orders.map((order) => order.symbol),
      reason: orders.length > 0
        ? `${orders.length} fresh ${input.orchestrator.activeDirection} proposal(s) from current scanner snapshot`
        : `no fresh ${input.orchestrator.activeDirection} candidate passed scanner status, confidence, conflict, symbol, and geometry checks`,
    },
  };
}

/** Dynamic read-only overlay: existing paper history remains intact, while current scanner
 * proposals are appended only for the unified testnet engine. Nothing is persisted into the
 * research/promotion store, so this cannot contaminate lane maturity metrics. */
export class UnifiedTestnetProposalStore implements PaperStoreReader {
  private readonly opts: UnifiedProposalSourceOptions;
  private lastStatus: UnifiedProposalSourceStatus;

  constructor(opts: UnifiedProposalSourceOptions) {
    this.opts = opts;
    this.lastStatus = {
      active: false,
      scanBatchId: null,
      direction: null,
      posture: "TACTICAL_OR_MIXED",
      selectedRecipe: null,
      proposalCount: 0,
      symbols: [],
      reason: "not evaluated",
    };
  }

  get all(): PaperOrder[] {
    const built = buildUnifiedTestnetProposals({
      scan: this.opts.getScan(),
      orchestrator: this.opts.getOrchestratorStatus(),
      posture: this.opts.getPosture?.(),
      maxCandidates: this.opts.maxCandidates,
      minConfidence: this.opts.minConfidence,
    });
    this.lastStatus = built.status;
    return [...this.opts.baseStore.all, ...built.orders];
  }

  isAdmissionHalted(now: string): boolean {
    if (this.opts.getOrchestratorStatus()?.enabled) return false;
    return this.opts.baseStore.isAdmissionHalted(now);
  }

  getStatus(): UnifiedProposalSourceStatus {
    void this.all;
    return this.lastStatus;
  }
}

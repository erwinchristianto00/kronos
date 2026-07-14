import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { SingleSymbolExitContext, SingleSymbolExitDecision } from "./single-symbol-lane-executor.js";

export type UnifiedDirection = "LONG" | "SHORT" | "NEUTRAL";
export type UnifiedBrainState =
  | "LONG"
  | "LONG_WARNING"
  | "FLAT"
  | "SHORT_WARNING"
  | "SHORT"
  | "CHOPPY_LOCK";

export type UnifiedFeatureRole =
  | "SENSOR"
  | "VOTER"
  | "PROPOSAL"
  | "GEOMETRY"
  | "RISK"
  | "EXECUTION"
  | "TELEMETRY";

export interface UnifiedFeatureRegistration {
  id: string;
  role: UnifiedFeatureRole;
  consumers: string[];
  purpose: string;
}

export interface UnifiedFeatureVote {
  source: string;
  direction: UnifiedDirection;
  confidence: number;
  veto?: boolean;
  reason: string;
}

export interface UnifiedOrchestratorInput {
  sampleId: string;
  capturedAt: string;
  primaryDirection: UnifiedDirection;
  primaryConfidence: "LOW" | "MEDIUM" | "HIGH" | null;
  primaryReason: string;
  votes: UnifiedFeatureVote[];
  neutralProposalAllowed: boolean;
  neutralProposalReason: string | null;
}

export interface UnifiedDecisionTrace {
  sampleId: string;
  capturedAt: string;
  previousState: UnifiedBrainState;
  nextState: UnifiedBrainState;
  candidateDirection: UnifiedDirection;
  candidateStreak: number;
  reason: string;
  votes: UnifiedFeatureVote[];
}

interface PersistedUnifiedState {
  version: 1;
  brainState: UnifiedBrainState;
  activeDirection: "LONG" | "SHORT" | null;
  candidateDirection: UnifiedDirection;
  candidateStreak: number;
  lastSampleId: string | null;
  updatedAt: string | null;
  neutralProposalAllowed: boolean;
  neutralProposalReason: string | null;
  recentCandidates: UnifiedDirection[];
  lastTrace: UnifiedDecisionTrace | null;
}

export interface UnifiedOrchestratorStatus extends PersistedUnifiedState {
  enabled: boolean;
  mode: "UNIFIED_TESTNET" | "DISABLED";
  legacyExecutorEntryMode: "MANAGE_ONLY" | "UNCHANGED";
  allowedDirectionalLaneIds: string[];
  featureRegistry: UnifiedFeatureRegistration[];
}

const EMPTY_STATE: PersistedUnifiedState = {
  version: 1,
  brainState: "FLAT",
  activeDirection: null,
  candidateDirection: "NEUTRAL",
  candidateStreak: 0,
  lastSampleId: null,
  updatedAt: null,
  neutralProposalAllowed: false,
  neutralProposalReason: null,
  recentCandidates: [],
  lastTrace: null,
};

export const UNIFIED_FEATURE_REGISTRY: readonly UnifiedFeatureRegistration[] = [
  {
    id: "REGIME_DIRECTION_CONTROLLER",
    role: "VOTER",
    consumers: ["UNIFIED_DIRECTIONAL_BRAIN"],
    purpose: "Primary LONG/SHORT/NO_TRADE posture and confidence.",
  },
  {
    id: "REGIME_COMPOSITE_CONFIRMATION",
    role: "VOTER",
    consumers: ["UNIFIED_DIRECTIONAL_BRAIN", "DECISION_TRACE"],
    purpose: "LONG-side axis breadth plus derivatives-crowding confirmation.",
  },
  {
    id: "REGIME_COMPOSITE_SHORT_CONFIRMATION",
    role: "VOTER",
    consumers: ["UNIFIED_DIRECTIONAL_BRAIN", "DECISION_TRACE"],
    purpose: "SHORT-side bearish-breadth plus crowding-stability confirmation (mirror of the LONG lane).",
  },
  {
    id: "COMPOSITE_ESTIMATOR_BIDI",
    role: "VOTER",
    consumers: ["UNIFIED_DIRECTIONAL_BRAIN", "DECISION_TRACE"],
    purpose: "Directional forecast vote; it no longer owns new exchange exposure.",
  },
  {
    id: "CURRENT_GUARD_VARIANT_MATRIX",
    role: "PROPOSAL",
    consumers: ["UNIFIED_PROPOSAL_ROUTER"],
    purpose: "Produces the existing fast and MFE entry/stop geometry candidates.",
  },
  {
    id: "CG_WIDE_FAST",
    role: "GEOMETRY",
    consumers: ["LIVE_EXECUTION_ENGINE"],
    purpose: "Fast full-TP geometry for the active direction.",
  },
  {
    id: "CG_EXP_MFE_GIVEBACK",
    role: "GEOMETRY",
    consumers: ["LIVE_EXECUTION_ENGINE"],
    purpose: "Wide-stop MFE-giveback policy; execution leverage remains account-capped.",
  },
  {
    id: "CROSS_SECTIONAL",
    role: "PROPOSAL",
    consumers: ["UNIFIED_DIRECTIONAL_BRAIN", "PORTFOLIO_RISK_COORDINATOR"],
    purpose: "Neutral basket proposal used only when its rolling after-cost health is positive.",
  },
  {
    id: "REGIME_EDGE_MEMORY",
    role: "VOTER",
    consumers: ["UNIFIED_DIRECTIONAL_BRAIN"],
    purpose: "Hard-vetoes a primary direction proven net-negative (n≥30, avgNetR≤0) in the current regime.",
  },
  {
    id: "LIVE_RISK_GUARDS",
    role: "RISK",
    consumers: ["LIVE_EXECUTION_ENGINE", "SINGLE_SYMBOL_MANAGE_ONLY"],
    purpose: "Stops, correlated-alt caps, hard cuts, drawdown and kill-switch.",
  },
  {
    id: "LIVE_EXECUTION_ENGINE",
    role: "EXECUTION",
    consumers: ["BINANCE_TESTNET"],
    purpose: "The sole owner of all new unified directional entries.",
  },
  {
    id: "LANE_PERFORMANCE_AND_NEURAL_MAP",
    role: "TELEMETRY",
    consumers: ["OPERATOR_DASHBOARD", "DECISION_TRACE"],
    purpose: "Preserves lane evidence and explains every accepted or rejected contribution.",
  },
] as const;

const LONG_RECIPES = ["CG_WIDE_FAST_LONG", "CG_EXP_LONG_MFE_GIVEBACK_10X"] as const;
const SHORT_RECIPES = ["CG_WIDE_FAST_SHORT", "CG_EXP_SHORT_MFE_GIVEBACK_10X"] as const;
const NEUTRAL_RECIPES = new Set(["CROSS_SECTIONAL_MARKET_NEUTRAL"]);

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function confidenceWeight(value: UnifiedOrchestratorInput["primaryConfidence"]): number {
  if (value === "HIGH") return 3;
  if (value === "MEDIUM") return 2;
  if (value === "LOW") return 1;
  return 0;
}

function laneVariantId(laneId: string): string {
  return laneId.split(":").pop()?.trim().toUpperCase() ?? laneId.trim().toUpperCase();
}

function laneMatches(variantId: string, recipes: readonly string[]): boolean {
  return recipes.some((recipe) => variantId === recipe || variantId.endsWith(`:${recipe}`));
}

function isDirectionalState(state: UnifiedBrainState): state is "LONG" | "SHORT" {
  return state === "LONG" || state === "SHORT";
}

function candidateFrom(input: UnifiedOrchestratorInput): { direction: UnifiedDirection; reason: string } {
  const votes = input.votes.map((vote) => ({ ...vote, confidence: clampConfidence(vote.confidence) }));
  if (votes.some((vote) => vote.veto)) {
    return {
      direction: "NEUTRAL",
      reason: votes.filter((vote) => vote.veto).map((vote) => `${vote.source}: ${vote.reason}`).join("; "),
    };
  }
  if (input.primaryDirection === "NEUTRAL") {
    return { direction: "NEUTRAL", reason: input.primaryReason };
  }

  let longSupport = input.primaryDirection === "LONG" ? confidenceWeight(input.primaryConfidence) : 0;
  let shortSupport = input.primaryDirection === "SHORT" ? confidenceWeight(input.primaryConfidence) : 0;
  for (const vote of votes) {
    if (vote.direction === "LONG") longSupport += vote.confidence;
    if (vote.direction === "SHORT") shortSupport += vote.confidence;
  }
  const own = input.primaryDirection === "LONG" ? longSupport : shortSupport;
  const opposing = input.primaryDirection === "LONG" ? shortSupport : longSupport;
  if (own <= opposing) {
    return {
      direction: "NEUTRAL",
      reason: `primary ${input.primaryDirection} lacks confirmation (${own.toFixed(2)} vs ${opposing.toFixed(2)})`,
    };
  }
  return {
    direction: input.primaryDirection,
    reason: `${input.primaryReason}; support ${own.toFixed(2)} vs ${opposing.toFixed(2)}`,
  };
}

export function isUnifiedTestnetOrchestratorEnabled(
  env: NodeJS.ProcessEnv = process.env,
  executionEnv: "testnet" | "mainnet" | null = null,
): boolean {
  return executionEnv === "testnet" && env.UNIFIED_ORCHESTRATOR_ENABLED === "1";
}

export class UnifiedTestnetOrchestratorStore {
  private readonly file: string;
  private state: PersistedUnifiedState;

  constructor(dataDir = "data", fileName = "unified-testnet-orchestrator.json") {
    this.file = resolve(dataDir, fileName);
    mkdirSync(dirname(this.file), { recursive: true });
    this.state = this.load();
  }

  get(): PersistedUnifiedState {
    return this.state;
  }

  update(next: PersistedUnifiedState): void {
    this.state = next;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(tmp, this.file);
  }

  private load(): PersistedUnifiedState {
    if (!existsSync(this.file)) return structuredClone(EMPTY_STATE);
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<PersistedUnifiedState>;
      return {
        ...structuredClone(EMPTY_STATE),
        ...parsed,
        version: 1,
        recentCandidates: Array.isArray(parsed.recentCandidates) ? parsed.recentCandidates.slice(-6) : [],
      };
    } catch {
      return structuredClone(EMPTY_STATE);
    }
  }
}

export class UnifiedTestnetOrchestrator {
  private readonly enabled: boolean;
  private readonly store: UnifiedTestnetOrchestratorStore;
  private readonly confirmSamples: number;
  private readonly choppySamples: number;
  private readonly estimatedCloseCostPct: number;

  constructor(opts: {
    enabled: boolean;
    store: UnifiedTestnetOrchestratorStore;
    confirmSamples?: number;
    choppySamples?: number;
    estimatedCloseCostPct?: number;
  }) {
    this.enabled = opts.enabled;
    this.store = opts.store;
    this.confirmSamples = Math.max(2, Math.floor(opts.confirmSamples ?? 2));
    this.choppySamples = Math.max(2, Math.floor(opts.choppySamples ?? 2));
    this.estimatedCloseCostPct = Math.max(0, opts.estimatedCloseCostPct ?? 0.0022);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  update(input: UnifiedOrchestratorInput): UnifiedOrchestratorStatus {
    const current = this.store.get();
    if (!this.enabled || current.lastSampleId === input.sampleId) return this.getStatus();

    const decision = candidateFrom(input);
    const previousState = current.brainState;
    const recentCandidates = [...current.recentCandidates, decision.direction].slice(-6);
    const nonNeutral = recentCandidates.filter((direction) => direction !== "NEUTRAL");
    let flips = 0;
    for (let index = 1; index < nonNeutral.length; index += 1) {
      if (nonNeutral[index] !== nonNeutral[index - 1]) flips += 1;
    }

    const sameCandidate = current.candidateDirection === decision.direction;
    const candidateStreak = sameCandidate ? current.candidateStreak + 1 : 1;
    let nextState: UnifiedBrainState = current.brainState;
    let activeDirection = current.activeDirection;
    let reason = decision.reason;

    if (decision.direction === "NEUTRAL") {
      activeDirection = null;
      nextState = candidateStreak >= this.choppySamples || flips >= 2
        ? "CHOPPY_LOCK"
        : current.activeDirection === "LONG"
          ? "LONG_WARNING"
          : current.activeDirection === "SHORT"
            ? "SHORT_WARNING"
            : "FLAT";
      reason = `${reason}; directional entries paused`;
    } else if (current.activeDirection === decision.direction && isDirectionalState(current.brainState)) {
      nextState = decision.direction;
      activeDirection = decision.direction;
    } else if (current.activeDirection && current.activeDirection !== decision.direction) {
      activeDirection = null;
      nextState = current.activeDirection === "LONG" ? "LONG_WARNING" : "SHORT_WARNING";
      reason = `${reason}; opposing candidate detected, risk-off before reversal`;
    } else if (candidateStreak >= this.confirmSamples) {
      // A warning state must spend one distinct snapshot FLAT before the opposite side can arm.
      if (previousState === "LONG_WARNING" || previousState === "SHORT_WARNING") {
        nextState = "FLAT";
        activeDirection = null;
        reason = `${reason}; confirmation reached, one-snapshot flat handoff`;
      } else {
        nextState = decision.direction;
        activeDirection = decision.direction;
      }
    } else {
      nextState = "FLAT";
      activeDirection = null;
      reason = `${reason}; confirming ${candidateStreak}/${this.confirmSamples}`;
    }

    const trace: UnifiedDecisionTrace = {
      sampleId: input.sampleId,
      capturedAt: input.capturedAt,
      previousState,
      nextState,
      candidateDirection: decision.direction,
      candidateStreak,
      reason,
      votes: input.votes.map((vote) => ({ ...vote, confidence: clampConfidence(vote.confidence) })),
    };
    this.store.update({
      version: 1,
      brainState: nextState,
      activeDirection,
      candidateDirection: decision.direction,
      candidateStreak,
      lastSampleId: input.sampleId,
      updatedAt: input.capturedAt,
      neutralProposalAllowed: input.neutralProposalAllowed,
      neutralProposalReason: input.neutralProposalReason,
      recentCandidates,
      lastTrace: trace,
    });
    return this.getStatus();
  }

  canOpenNewEntries(): boolean {
    if (!this.enabled) return true;
    const state = this.store.get();
    return state.brainState === "LONG" || state.brainState === "SHORT" ||
      (state.brainState === "CHOPPY_LOCK" && state.neutralProposalAllowed);
  }

  allowsPaperOrder(order: { selectedLaneId: string; direction: "LONG" | "SHORT" }): boolean {
    if (!this.enabled) return true;
    const state = this.store.get();
    const variantId = laneVariantId(order.selectedLaneId);
    if (state.brainState === "LONG") {
      return order.direction === "LONG" && laneMatches(variantId, LONG_RECIPES);
    }
    if (state.brainState === "SHORT") {
      return order.direction === "SHORT" && laneMatches(variantId, SHORT_RECIPES);
    }
    return false;
  }

  allowsCrossSectionalLane(laneId: string): boolean {
    if (!this.enabled) return true;
    const state = this.store.get();
    return state.brainState === "CHOPPY_LOCK" && state.neutralProposalAllowed &&
      NEUTRAL_RECIPES.has(laneVariantId(laneId));
  }

  allowsLegacySingleSymbolEntry(_laneId: string, _direction: "LONG" | "SHORT"): boolean {
    return !this.enabled;
  }

  legacyExitDecision(ctx: SingleSymbolExitContext): SingleSymbolExitDecision {
    const r = (() => {
      const risk = Math.abs(ctx.entryPrice - ctx.stopPrice);
      if (!(risk > 0)) return 0;
      return ctx.direction === "LONG"
        ? (ctx.currentPrice - ctx.entryPrice) / risk
        : (ctx.entryPrice - ctx.currentPrice) / risk;
    })();
    const nextPeakFavorableR = Math.max(ctx.peakFavorableR, r);
    if (!this.enabled) return { shouldExit: false, reason: null, nextPeakFavorableR };

    const state = this.store.get();
    const targetDirection = state.candidateDirection === "NEUTRAL" ? state.activeDirection : state.candidateDirection;
    if (!targetDirection || targetDirection === ctx.direction) {
      return { shouldExit: false, reason: null, nextPeakFavorableR };
    }

    const stopDistancePct = Math.abs(ctx.entryPrice - ctx.stopPrice) / ctx.entryPrice;
    const estimatedCostR = stopDistancePct > 0 ? this.estimatedCloseCostPct / stopDistancePct : Number.POSITIVE_INFINITY;
    if (r >= estimatedCostR) {
      return { shouldExit: true, reason: "UNIFIED_REGIME_FLIP_BANK", nextPeakFavorableR };
    }
    if (r <= -0.5) {
      return { shouldExit: true, reason: "UNIFIED_REGIME_FLIP_HARD_CUT", nextPeakFavorableR };
    }
    return { shouldExit: false, reason: null, nextPeakFavorableR };
  }

  getStatus(): UnifiedOrchestratorStatus {
    const state = this.store.get();
    const allowedDirectionalLaneIds = state.brainState === "LONG"
      ? [...LONG_RECIPES]
      : state.brainState === "SHORT"
        ? [...SHORT_RECIPES]
        : [];
    return {
      ...state,
      enabled: this.enabled,
      mode: this.enabled ? "UNIFIED_TESTNET" : "DISABLED",
      legacyExecutorEntryMode: this.enabled ? "MANAGE_ONLY" : "UNCHANGED",
      allowedDirectionalLaneIds,
      featureRegistry: [...UNIFIED_FEATURE_REGISTRY],
    };
  }
}

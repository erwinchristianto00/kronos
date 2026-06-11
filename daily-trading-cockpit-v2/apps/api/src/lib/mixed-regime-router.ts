/**
 * MIXED-REGIME ADAPTIVE PAPER ROUTER (DIAGNOSTIC / ROUTING-EVIDENCE — NOT a live gate)
 *
 * During "Mixed rotation" regime the bot currently returns validation-only /
 * activeLane=none (see regime-direction-controller mapRegimeToMode + allocator
 * regimeAllowsPaperLane). This module DECOMPOSES Mixed regime into a selective
 * adaptive routing DECISION (pressure/direction, volatility, liquidity, backlog)
 * and reports what it WOULD route — as evidence — WITHOUT changing live admission,
 * headline metrics, the CG_WIDE exit, or any live/micro-pilot posture.
 *
 * HARD SAFETY: pure functions only. No store writes, no order creation, no
 * shadow-positions.json, no paperStartAt reset, no headline mutation. Every
 * decision carries explicit reasons; missing metrics return UNKNOWN /
 * INSUFFICIENT_CONTEXT rather than a guessed PASS.
 */

import {
  evaluateForwardGate,
  FORWARD_GATE_ID,
  type PaperOrder,
  type ForwardGateDecision,
} from "./paper-execution-router.js";
import { LONG_WIDE_PAPER_LANE_ID } from "./adaptive-lane-router.js";

export const MIXED_REGIME_ROUTER_VERSION = 1;
const CG_WIDE_LANE = "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE";
export const MIXED_LONG_WIDE_LANE = LONG_WIDE_PAPER_LANE_ID;
const CG_TRAIL_LANE = "CG_VARIANT_MATRIX:CG_TRAIL_AFTER_TP1";

// ── stale / backlog buckets (hold-hours; aligned with the latency hold buckets) ──
const STALE_HOURS = 30; // FRESH < 30h ≤ STALE
const CRITICAL_HOURS = 72; // STALE < 72h ≤ CRITICAL
const STALE_RATIO_REDUCE = 0.25;
const STALE_RATIO_NO_WIDE = 0.4;

const OPEN_STATUSES: ReadonlySet<string> = new Set([
  "CREATED",
  "PAPER_SUBMITTED",
  "PAPER_FILLED",
  "PAPER_PARTIAL",
]);
const CLOSED_STATUSES: ReadonlySet<string> = new Set(["PAPER_CLOSED_WIN", "PAPER_CLOSED_LOSS"]);

export type MixedTradingMode =
  | "OFF"
  | "DIAGNOSTIC_ONLY"
  | "SELECTIVE_PAPER"
  | "REDUCE_WIDE"
  | "TRAIL_ONLY";
export type StaleBucket = "FRESH" | "STALE" | "CRITICAL";
export type StaleRecommendation =
  | "NORMAL_ADMISSION"
  | "REDUCE_WIDE"
  | "NO_NEW_WIDE"
  | "AUDIT_REQUIRED";
export type MixedRouteDecision =
  | "ROUTE_CG_WIDE"
  | "ROUTE_LONG_CG_WIDE"
  | "ROUTE_CG_TRAIL"
  | "DIAGNOSTIC_ONLY"
  | "REJECT"
  | "INSUFFICIENT_CONTEXT";
export type Bucket = "LOW" | "MID" | "HIGH" | "UNKNOWN";
export type StalePassHealth =
  | "CONFIRMED_BENIGN"
  | "DIRECTIONALLY_BENIGN"
  | "DETERIORATING"
  | "UNKNOWN";
export type MixedAdmissionResult =
  | "ALLOW"
  | "ALLOW_REDUCED"
  | "WAIT_FOR_CAPACITY"
  | "REJECT"
  | "INSUFFICIENT_CONTEXT";
export type MixedOccupancyMode =
  | "NORMAL"
  | "REDUCED_RISK"
  | "WAIT_FOR_CAPACITY"
  | "STRICT_BLOCK";

export interface MixedOccupancyBudget {
  maxWideOpen: number;
  maxWideStale: number;
  maxPerSymbolOpen: number;
  maxPerDirectionOpen: number;
  maxPassStaleShare: number;
}

export const MIXED_OCCUPANCY_BUDGET: MixedOccupancyBudget = {
  maxWideOpen: 20,
  maxWideStale: 12,
  maxPerSymbolOpen: 2,
  maxPerDirectionOpen: 18,
  maxPassStaleShare: 0.70,
};

export type MixedCapacityBudgetProfileName =
  | "CONSERVATIVE_CURRENT"
  | "MODERATE_RELAXED"
  | "AGGRESSIVE_PAPER_ONLY"
  | "SYMBOL_SAFE_RELAXED";
export type MixedBudgetActivationScope = "PAPER_ONLY";
export type MixedBudgetSource = "SIMULATION_RECOMMENDED" | "ROLLBACK_CONFIG";

export interface MixedCapacityBudgetProfile {
  name: MixedCapacityBudgetProfileName;
  budget: MixedOccupancyBudget;
  paperOnlyAggressive: boolean;
}

export const MIXED_CAPACITY_BUDGET_PROFILES: readonly MixedCapacityBudgetProfile[] = [
  {
    name: "CONSERVATIVE_CURRENT",
    budget: MIXED_OCCUPANCY_BUDGET,
    paperOnlyAggressive: false,
  },
  {
    name: "MODERATE_RELAXED",
    budget: {
      maxWideOpen: 24,
      maxWideStale: 15,
      maxPerSymbolOpen: 2,
      maxPerDirectionOpen: 22,
      maxPassStaleShare: 0.75,
    },
    paperOnlyAggressive: false,
  },
  {
    name: "AGGRESSIVE_PAPER_ONLY",
    budget: {
      maxWideOpen: 28,
      maxWideStale: 18,
      maxPerSymbolOpen: 3,
      maxPerDirectionOpen: 26,
      maxPassStaleShare: 0.80,
    },
    paperOnlyAggressive: true,
  },
  {
    name: "SYMBOL_SAFE_RELAXED",
    budget: {
      maxWideOpen: 26,
      maxWideStale: 16,
      maxPerSymbolOpen: 2,
      maxPerDirectionOpen: 24,
      maxPassStaleShare: 0.80,
    },
    paperOnlyAggressive: false,
  },
] as const;

export const MIXED_BUDGET_PROFILE_VERSION = 1;
export const MIXED_BUDGET_ACTIVATION_SCOPE: MixedBudgetActivationScope = "PAPER_ONLY";
export const MIXED_PAPER_BUDGET_PROFILE_ENV = "MIXED_PAPER_BUDGET_PROFILE";

export interface ActiveMixedPaperBudgetProfileConfig {
  activeMixedBudgetProfile: Extract<MixedCapacityBudgetProfileName, "CONSERVATIVE_CURRENT" | "SYMBOL_SAFE_RELAXED">;
  budget: MixedOccupancyBudget;
  budgetSource: MixedBudgetSource;
  budgetActivationScope: MixedBudgetActivationScope;
  mixedBudgetVersion: number;
}

export function getMixedCapacityBudgetProfile(name: MixedCapacityBudgetProfileName): MixedCapacityBudgetProfile {
  return MIXED_CAPACITY_BUDGET_PROFILES.find((p) => p.name === name) ?? MIXED_CAPACITY_BUDGET_PROFILES[0]!;
}

export function getActiveMixedPaperBudgetProfileConfig(
  rawProfile = process.env[MIXED_PAPER_BUDGET_PROFILE_ENV],
): ActiveMixedPaperBudgetProfileConfig {
  const requested = rawProfile === "CONSERVATIVE_CURRENT" ? "CONSERVATIVE_CURRENT" : "SYMBOL_SAFE_RELAXED";
  const profile = getMixedCapacityBudgetProfile(requested);
  return {
    activeMixedBudgetProfile: requested,
    budget: profile.budget,
    budgetSource: requested === "CONSERVATIVE_CURRENT" ? "ROLLBACK_CONFIG" : "SIMULATION_RECOMMENDED",
    budgetActivationScope: MIXED_BUDGET_ACTIVATION_SCOPE,
    mixedBudgetVersion: MIXED_BUDGET_PROFILE_VERSION,
  };
}

export interface MixedOccupancySnapshot {
  laneId: string;
  budget: MixedOccupancyBudget;
  /** All open orders in the lane, including unrelated diagnostic collection. */
  rawWideOpenCount?: number;
  /** Open orders that consume Mixed admission capacity. */
  wideOpenCount: number;
  /** Diagnostic orders excluded because they are not part of the active Mixed profile. */
  excludedDiagnosticOpenCount?: number;
  wideStaleCount: number;
  perSymbolOpenCount: number;
  perDirectionOpenCount: number;
  passOpenCount: number;
  passStaleCount: number;
  passStaleShare: number;
  exceeded: string[];
  elevated: string[];
}

// ── small local economics helpers (kept self-contained / reversible) ──
function _econ(nets: number[]): { n: number; netAvgR: number | null; pf: number | null; wr: number | null; sumR: number } {
  if (nets.length === 0) return { n: 0, netAvgR: null, pf: null, wr: null, sumR: 0 };
  const sumR = nets.reduce((s, v) => s + v, 0);
  const winSum = nets.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const lossSum = nets.filter((v) => v < 0).reduce((s, v) => s + Math.abs(v), 0);
  return {
    n: nets.length,
    netAvgR: sumR / nets.length,
    pf: lossSum > 0 ? winSum / lossSum : winSum > 0 ? Infinity : null,
    wr: nets.filter((v) => v > 0).length / nets.length,
    sumR,
  };
}
function _pct(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
}
const _isMixed = (regime: string | null | undefined): boolean => /mix|rotation/i.test(regime ?? "");
const _holdHours = (o: PaperOrder, nowMs: number): number =>
  (nowMs - new Date(o.openedAt).getTime()) / 3_600_000;
const _closedHoldHours = (o: PaperOrder): number =>
  (new Date(o.updatedAt).getTime() - new Date(o.openedAt).getTime()) / 3_600_000;

// ════════════════════════════════════════════════════════════════════════════
// 1. STATE VECTOR + RISK MULTIPLIER + PER-CANDIDATE ROUTING
// ════════════════════════════════════════════════════════════════════════════

export interface MixedCandidateInput {
  symbol: string | null | undefined;
  direction: string | null | undefined;
  regime: string | null | undefined;
  laneId: string | null | undefined;
  /** 5m ATR percent (well-defined scale) — used for the volatility bucket. */
  atrPercent?: number | null;
  /** Raw scores surfaced for transparency; scale is provider-specific. */
  volatilityScore?: number | null;
  liquidityScore?: number | null;
}

export interface MixedBacklog {
  openOrderCount: number;
  staleWideHoldCount: number; // STALE + CRITICAL
  criticalCount: number;
  staleRatio: number;
  oldestOpenHoldHours: number | null;
}

export interface MixedRiskMultiplier {
  base: number;
  mRegime: number;
  mEdge: number;
  mVol: number;
  mLiquidity: number;
  mBacklog: number;
  mCorr: number;
  /** product, clamped to [0,1]. DIAGNOSTIC — never applied to real trading risk. */
  riskMultiplier: number;
}

export interface MixedRegimeState {
  symbol: string | null;
  regimeLabel: string | null;
  pressureLabel: "Bearish" | "Bullish" | "Neutral" | "Unknown";
  direction: string | null;
  toxicSymbolFlag: boolean;
  capTier: string | null;
  volatilityBucket: Bucket;
  liquidityBucket: Bucket;
  rotationBucket: Bucket; // always UNKNOWN — no breadth/dispersion metric in repo
  atrPercent: number | null;
  volatilityScore: number | null;
  liquidityScore: number | null;
  /** Canonical forward-gate decision (market-regime based; for OOS consistency). */
  forwardGateId: string;
  forwardGateDecision: ForwardGateDecision;
  forwardGateReasons: string[];
  /** Mixed-router decision (direction-derived pressure; the decomposition layer). */
  mixedRouteDecision: MixedRouteDecision;
  mixedRouteReasons: string[];
  /** Occupancy-aware admission posture (diagnostic only; never mutates paper/live state). */
  admissionResult: MixedAdmissionResult;
  occupancyMode: MixedOccupancyMode;
  stalePassHealth: StalePassHealth;
  occupancy: MixedOccupancySnapshot;
  risk: MixedRiskMultiplier;
}

/** Pressure proxy within Mixed regime: a SHORT bet is bearish-leaning on the symbol. */
function _pressureFromDirection(direction: string | null | undefined): MixedRegimeState["pressureLabel"] {
  if (direction === "SHORT") return "Bearish";
  if (direction === "LONG") return "Bullish";
  return "Unknown";
}

function _volBucket(atrPercent: number | null | undefined): Bucket {
  if (atrPercent == null || !Number.isFinite(atrPercent)) return "UNKNOWN";
  if (atrPercent < 0.5) return "LOW";
  if (atrPercent < 1.5) return "MID";
  return "HIGH";
}

function _emptyOccupancySnapshot(
  budget: MixedOccupancyBudget = MIXED_OCCUPANCY_BUDGET,
  laneId = CG_WIDE_LANE,
): MixedOccupancySnapshot {
  return {
    laneId,
    budget,
    rawWideOpenCount: 0,
    wideOpenCount: 0,
    excludedDiagnosticOpenCount: 0,
    wideStaleCount: 0,
    perSymbolOpenCount: 0,
    perDirectionOpenCount: 0,
    passOpenCount: 0,
    passStaleCount: 0,
    passStaleShare: 0,
    exceeded: [],
    elevated: [],
  };
}

function _directionallyBenign(summary: StalePassSummary): boolean {
  const staleNetPositive = summary.stalePassNetAvgR !== null && summary.stalePassNetAvgR > 0;
  const conversionBenign =
    summary.conversionRatio !== null &&
    Number.isFinite(summary.conversionRatio) &&
    summary.conversionRatio >= 0.75;
  const pfBenign =
    summary.stalePassPF === null ||
    !Number.isFinite(summary.stalePassPF) ||
    summary.stalePassPF >= 1;
  return summary.freshPassN > 0 && summary.stalePassN > 0 && staleNetPositive && conversionBenign && pfBenign;
}

export function classifyStalePassHealth(summary: StalePassSummary): StalePassHealth {
  if (summary.verdict === "BENIGN_OCCUPANCY") return "CONFIRMED_BENIGN";
  if (summary.verdict === "TAIL_DETERIORATION") return "DETERIORATING";
  if (
    summary.stalePassNetAvgR !== null &&
    summary.stalePassNetAvgR < 0
  ) {
    return "DETERIORATING";
  }
  if (
    summary.stalePassPF !== null &&
    Number.isFinite(summary.stalePassPF) &&
    summary.stalePassPF < 1
  ) {
    return "DETERIORATING";
  }
  if (
    summary.conversionRatio !== null &&
    Number.isFinite(summary.conversionRatio) &&
    summary.conversionRatio < 0.5
  ) {
    return "DETERIORATING";
  }
  if (_directionallyBenign(summary)) return "DIRECTIONALLY_BENIGN";
  return "UNKNOWN";
}

export function computeMixedOccupancySnapshot(args: {
  orders: PaperOrder[];
  nowMs: number;
  symbol?: string | null;
  direction?: string | null;
  budget?: MixedOccupancyBudget;
  laneId?: string | null;
}): MixedOccupancySnapshot {
  const budget = args.budget ?? MIXED_OCCUPANCY_BUDGET;
  const laneId = args.laneId ?? CG_WIDE_LANE;
  const activeProfile = getActiveMixedPaperBudgetProfileConfig().activeMixedBudgetProfile;
  const rawOpenWide = args.orders.filter((o) => OPEN_STATUSES.has(o.paperStatus) && o.selectedLaneId === laneId);
  // Mixed occupancy is a capacity budget for Mixed admission, not a global
  // diagnostic-workload counter. Headline orders always consume book capacity.
  // Diagnostic-only orders consume it only when they belong to the active
  // Mixed paper-budget experiment. Generic bearish/bullish samplers and
  // challenger diagnostics remain visible in raw counts but cannot starve a
  // qualified Mixed candidate of a slot.
  const openWide = rawOpenWide.filter(
    (o) =>
      o.paperOrderMode !== "DIAGNOSTIC_ONLY" ||
      (
        o.mixedBudgetProfile === activeProfile &&
        o.budgetActivationScope === MIXED_BUDGET_ACTIVATION_SCOPE
      ),
  );
  const staleWide = openWide.filter((o) => {
    const h = _holdHours(o, args.nowMs);
    return Number.isFinite(h) && h >= STALE_HOURS;
  });
  const passOpen = laneId === MIXED_LONG_WIDE_LANE ? openWide : openWide.filter((o) => {
    const decision =
      o.forwardGateDecision ??
      evaluateForwardGate({ laneId: o.selectedLaneId, regime: o.regime, direction: o.direction, symbol: o.symbol })
        .forwardGateDecision;
    return decision === "PASS";
  });
  const passStale = passOpen.filter((o) => {
    const h = _holdHours(o, args.nowMs);
    return Number.isFinite(h) && h >= STALE_HOURS;
  });
  const perSymbolOpenCount = args.symbol
    ? openWide.filter((o) => o.symbol === args.symbol).length
    : 0;
  const perDirectionOpenCount = args.direction
    ? openWide.filter((o) => o.direction === args.direction).length
    : 0;
  const passStaleShare = passOpen.length > 0 ? passStale.length / passOpen.length : 0;

  const exceeded: string[] = [];
  if (openWide.length >= budget.maxWideOpen) exceeded.push("MAX_WIDE_OPEN");
  if (staleWide.length >= budget.maxWideStale) exceeded.push("MAX_WIDE_STALE");
  if (perSymbolOpenCount >= budget.maxPerSymbolOpen) exceeded.push("MAX_PER_SYMBOL_OPEN");
  if (perDirectionOpenCount >= budget.maxPerDirectionOpen) exceeded.push("MAX_PER_DIRECTION_OPEN");
  if (passStaleShare >= budget.maxPassStaleShare) exceeded.push("MAX_PASS_STALE_SHARE");

  const elevated: string[] = [];
  if (openWide.length >= Math.floor(budget.maxWideOpen * 0.75)) elevated.push("ELEVATED_WIDE_OPEN");
  if (staleWide.length >= Math.floor(budget.maxWideStale * 0.75)) elevated.push("ELEVATED_WIDE_STALE");
  if (perSymbolOpenCount >= Math.max(1, budget.maxPerSymbolOpen - 1)) elevated.push("ELEVATED_PER_SYMBOL_OPEN");
  if (perDirectionOpenCount >= Math.floor(budget.maxPerDirectionOpen * 0.75)) elevated.push("ELEVATED_PER_DIRECTION_OPEN");
  if (passStaleShare >= 0.5) elevated.push("ELEVATED_PASS_STALE_SHARE");

  return {
    laneId,
    budget,
    rawWideOpenCount: rawOpenWide.length,
    wideOpenCount: openWide.length,
    excludedDiagnosticOpenCount: rawOpenWide.length - openWide.length,
    wideStaleCount: staleWide.length,
    perSymbolOpenCount,
    perDirectionOpenCount,
    passOpenCount: passOpen.length,
    passStaleCount: passStale.length,
    passStaleShare,
    exceeded,
    elevated,
  };
}

function canSoftBypassPerSymbolCapacity(args: {
  stalePassHealth: StalePassHealth;
  occupancy: MixedOccupancySnapshot;
}): boolean {
  const benign =
    args.stalePassHealth === "CONFIRMED_BENIGN" ||
    args.stalePassHealth === "DIRECTIONALLY_BENIGN";
  if (!benign) return false;
  if (args.occupancy.exceeded.length !== 1 || args.occupancy.exceeded[0] !== "MAX_PER_SYMBOL_OPEN") return false;
  if (args.occupancy.perSymbolOpenCount !== args.occupancy.budget.maxPerSymbolOpen) return false;
  if (args.occupancy.wideOpenCount >= Math.floor(args.occupancy.budget.maxWideOpen * 0.75)) return false;
  if (args.occupancy.wideStaleCount >= Math.floor(args.occupancy.budget.maxWideStale * 0.5)) return false;
  if (args.occupancy.perDirectionOpenCount >= Math.floor(args.occupancy.budget.maxPerDirectionOpen * 0.75)) return false;
  if (args.occupancy.passStaleShare >= Math.min(args.occupancy.budget.maxPassStaleShare, 0.5)) return false;
  return true;
}

function decideOccupancyAwareAdmission(args: {
  mixedRouteDecision: MixedRouteDecision;
  stalePassHealth: StalePassHealth;
  backlog: MixedBacklog;
  occupancy: MixedOccupancySnapshot;
}): { admissionResult: MixedAdmissionResult; occupancyMode: MixedOccupancyMode; reasons: string[] } {
  const softPerSymbolBypass = canSoftBypassPerSymbolCapacity({
    stalePassHealth: args.stalePassHealth,
    occupancy: args.occupancy,
  });
  if (args.mixedRouteDecision === "INSUFFICIENT_CONTEXT") {
    return { admissionResult: "INSUFFICIENT_CONTEXT", occupancyMode: "STRICT_BLOCK", reasons: [] };
  }
  if (
    args.mixedRouteDecision !== "ROUTE_CG_WIDE" &&
    args.mixedRouteDecision !== "ROUTE_LONG_CG_WIDE"
  ) {
    return { admissionResult: "REJECT", occupancyMode: "STRICT_BLOCK", reasons: [] };
  }

  if (args.mixedRouteDecision === "ROUTE_LONG_CG_WIDE") {
    if (args.occupancy.exceeded.length > 0) {
      if (softPerSymbolBypass) {
        return {
          admissionResult: "ALLOW_REDUCED",
          occupancyMode: "REDUCED_RISK",
          reasons: ["LONG_OCCUPANCY_SOFT_MAX_PER_SYMBOL_OPEN"],
        };
      }
      return {
        admissionResult: "WAIT_FOR_CAPACITY",
        occupancyMode: "WAIT_FOR_CAPACITY",
        reasons: args.occupancy.exceeded.map((r) => `LONG_OCCUPANCY_${r}`),
      };
    }
    if (args.occupancy.elevated.length > 0) {
      return {
        admissionResult: "ALLOW_REDUCED",
        occupancyMode: "REDUCED_RISK",
        reasons: args.occupancy.elevated.map((r) => `LONG_OCCUPANCY_${r}`),
      };
    }
    return {
      admissionResult: "ALLOW",
      occupancyMode: "NORMAL",
      reasons: ["LONG_OCCUPANCY_HEALTHY"],
    };
  }

  const benign =
    args.stalePassHealth === "CONFIRMED_BENIGN" ||
    args.stalePassHealth === "DIRECTIONALLY_BENIGN";

  if (!benign) {
    if (args.stalePassHealth === "DETERIORATING" && args.backlog.staleRatio >= STALE_RATIO_NO_WIDE) {
      return {
        admissionResult: "REJECT",
        occupancyMode: "STRICT_BLOCK",
        reasons: ["STALE_PASS_DETERIORATING_STRICT_STALE_RATIO_BLOCK"],
      };
    }
    if (args.backlog.staleRatio >= STALE_RATIO_NO_WIDE) {
      return {
        admissionResult: "WAIT_FOR_CAPACITY",
        occupancyMode: "WAIT_FOR_CAPACITY",
        reasons: ["STALE_PASS_HEALTH_UNKNOWN_WAIT_FOR_CAPACITY"],
      };
    }
    if (args.backlog.staleRatio >= STALE_RATIO_REDUCE) {
      return {
        admissionResult: "ALLOW_REDUCED",
        occupancyMode: "REDUCED_RISK",
        reasons: ["STALE_PASS_HEALTH_UNKNOWN_REDUCED_RISK"],
      };
    }
  }

  if (args.occupancy.exceeded.length > 0) {
    if (softPerSymbolBypass) {
      return {
        admissionResult: "ALLOW_REDUCED",
        occupancyMode: "REDUCED_RISK",
        reasons: ["OCCUPANCY_SOFT_MAX_PER_SYMBOL_OPEN"],
      };
    }
    return {
      admissionResult: "WAIT_FOR_CAPACITY",
      occupancyMode: "WAIT_FOR_CAPACITY",
      reasons: args.occupancy.exceeded.map((r) => `OCCUPANCY_${r}`),
    };
  }
  const elevated = args.occupancy.elevated.length > 0 || (benign && args.backlog.staleRatio >= STALE_RATIO_REDUCE);
  if (elevated) {
    return {
      admissionResult: "ALLOW_REDUCED",
      occupancyMode: "REDUCED_RISK",
      reasons: [
        ...args.occupancy.elevated.map((r) => `OCCUPANCY_${r}`),
        ...(benign && args.backlog.staleRatio >= STALE_RATIO_REDUCE
          ? ["BENIGN_STALE_RATIO_REDUCED_RISK"]
          : []),
      ],
    };
  }
  return { admissionResult: "ALLOW", occupancyMode: "NORMAL", reasons: ["OCCUPANCY_HEALTHY"] };
}

export function computeMixedRiskMultiplier(args: {
  edgePass: boolean;
  volatilityBucket: Bucket;
  backlog: MixedBacklog;
  occupancyMode?: MixedOccupancyMode;
}): MixedRiskMultiplier {
  const base = 1;
  const mRegime = 0.5; // mixed regime is structurally lower-conviction than a clean regime
  const mEdge = args.edgePass ? 1 : 0; // REJECT / INSUFFICIENT → 0
  const mVol = args.volatilityBucket === "HIGH" ? 0.7 : 1; // only penalise on a known-high ATR%
  const mLiquidity = 1; // UNKNOWN scale → no guess (rule: UNKNOWN, not guessed penalty)
  const occupancyMode = args.occupancyMode;
  const mBacklog =
    occupancyMode === "STRICT_BLOCK" || occupancyMode === "WAIT_FOR_CAPACITY"
      ? 0
      : occupancyMode === "REDUCED_RISK"
        ? 0.5
        : args.backlog.staleRatio >= STALE_RATIO_NO_WIDE
          ? 0
          : args.backlog.staleRatio >= STALE_RATIO_REDUCE
            ? 0.5
            : 1;
  const mCorr = 1; // no correlation/concentration metric in repo → UNKNOWN
  const raw = base * mRegime * mEdge * mVol * mLiquidity * mBacklog * mCorr;
  return {
    base,
    mRegime,
    mEdge,
    mVol,
    mLiquidity,
    mBacklog,
    mCorr,
    riskMultiplier: Math.max(0, Math.min(1, raw)),
  };
}

/** Build the per-candidate mixed-regime state vector (pure). */
export function buildMixedRegimeState(
  input: MixedCandidateInput,
  backlog: MixedBacklog,
  opts: {
    stalePassHealth?: StalePassHealth;
    occupancy?: MixedOccupancySnapshot;
  } = {},
): MixedRegimeState {
  const symbol = input.symbol ?? null;
  const direction = input.direction ?? null;
  const regimeLabel = input.regime ?? null;
  const laneId = input.laneId ?? null;

  const fg = evaluateForwardGate({ laneId, regime: regimeLabel, direction, symbol });
  const volatilityBucket = _volBucket(input.atrPercent);
  const liquidityBucket: Bucket = "UNKNOWN"; // liquidityScore scale unknown → not bucketed

  // Mixed decomposition uses candidate direction, not the flat "Mixed" label.
  // SHORT keeps the existing production path; LONG is isolated paper-diagnostic.
  const reasons: string[] = [];
  let mixedRouteDecision: MixedRouteDecision;
  if (!symbol || !direction || !laneId || !regimeLabel) {
    mixedRouteDecision = "INSUFFICIENT_CONTEXT";
    reasons.push("MISSING_METADATA");
  } else if (laneId !== CG_WIDE_LANE && laneId !== MIXED_LONG_WIDE_LANE) {
    mixedRouteDecision = "REJECT";
    reasons.push("LANE_NOT_MIXED_WIDE");
  } else if (fg.forwardGateIsToxicSymbol) {
    mixedRouteDecision = "REJECT";
    reasons.push("TOXIC_SYMBOL");
  } else if (direction === "SHORT" && laneId === CG_WIDE_LANE) {
    mixedRouteDecision = "ROUTE_CG_WIDE";
    reasons.push("MIXED_BEARISH_SHORT_PROXY", "PRESSURE_FROM_DIRECTION");
  } else if (direction === "LONG" && laneId === MIXED_LONG_WIDE_LANE) {
    mixedRouteDecision = "ROUTE_LONG_CG_WIDE";
    reasons.push("MIXED_BULLISH_LONG_PROXY", "PRESSURE_FROM_DIRECTION", "LONG_DIAGNOSTIC_ONLY");
  } else {
    mixedRouteDecision = "REJECT";
    reasons.push("DIRECTION_LANE_MISMATCH");
  }

  const edgePass =
    mixedRouteDecision === "ROUTE_CG_WIDE" ||
    mixedRouteDecision === "ROUTE_LONG_CG_WIDE";
  const stalePassHealth =
    mixedRouteDecision === "ROUTE_LONG_CG_WIDE"
      ? "UNKNOWN"
      : opts.stalePassHealth ?? "UNKNOWN";
  const occupancy = opts.occupancy ?? _emptyOccupancySnapshot();
  const occupancyDecision = decideOccupancyAwareAdmission({
    mixedRouteDecision,
    stalePassHealth,
    backlog,
    occupancy,
  });
  reasons.push(...occupancyDecision.reasons);
  const risk = computeMixedRiskMultiplier({
    edgePass: edgePass && (
      occupancyDecision.admissionResult === "ALLOW" ||
      occupancyDecision.admissionResult === "ALLOW_REDUCED"
    ),
    volatilityBucket,
    backlog:
      mixedRouteDecision === "ROUTE_LONG_CG_WIDE"
        ? { ...backlog, staleRatio: 0 }
        : backlog,
    occupancyMode: occupancyDecision.occupancyMode,
  });

  return {
    symbol,
    regimeLabel,
    pressureLabel: _pressureFromDirection(direction),
    direction,
    toxicSymbolFlag: fg.forwardGateIsToxicSymbol,
    capTier: fg.forwardGateCapTier,
    volatilityBucket,
    liquidityBucket,
    rotationBucket: "UNKNOWN",
    atrPercent: input.atrPercent ?? null,
    volatilityScore: input.volatilityScore ?? null,
    liquidityScore: input.liquidityScore ?? null,
    forwardGateId: FORWARD_GATE_ID,
    forwardGateDecision: fg.forwardGateDecision,
    forwardGateReasons: fg.forwardGateReasons,
    mixedRouteDecision,
    mixedRouteReasons: reasons,
    admissionResult: occupancyDecision.admissionResult,
    occupancyMode: occupancyDecision.occupancyMode,
    stalePassHealth,
    occupancy,
    risk,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 2. BACKLOG + TOP-LEVEL ROUTING DECISION
// ════════════════════════════════════════════════════════════════════════════

export function computeMixedBacklog(orders: PaperOrder[], nowMs: number): MixedBacklog {
  const open = orders.filter((o) => OPEN_STATUSES.has(o.paperStatus));
  let stale = 0;
  let critical = 0;
  let oldest: number | null = null;
  for (const o of open) {
    const h = _holdHours(o, nowMs);
    if (!Number.isFinite(h)) continue;
    if (oldest == null || h > oldest) oldest = h;
    if (h >= CRITICAL_HOURS) critical += 1;
    else if (h >= STALE_HOURS) stale += 1;
  }
  const staleWideHoldCount = stale + critical;
  return {
    openOrderCount: open.length,
    staleWideHoldCount,
    criticalCount: critical,
    staleRatio: staleWideHoldCount / Math.max(open.length, 1),
    oldestOpenHoldHours: oldest,
  };
}

function _staleRecommendation(b: MixedBacklog): StaleRecommendation {
  if (b.criticalCount > 0) return "AUDIT_REQUIRED";
  if (b.staleRatio >= STALE_RATIO_NO_WIDE) return "NO_NEW_WIDE";
  if (b.staleRatio >= STALE_RATIO_REDUCE) return "REDUCE_WIDE";
  return "NORMAL_ADMISSION";
}

export interface MixedRegimeReport {
  reportOnly: true;
  diagnosticOnly: true;
  /** ALWAYS true — this router never blocks/admits or changes live behavior. */
  activeGateChange: false;
  version: number;
  regimeIsMixed: boolean;
  mixedTradingMode: MixedTradingMode;
  activeMixedLane: string | null;
  activeMixedLanes: string[];
  activeMixedLaneReason: string;
  backlog: MixedBacklog;
  staleRecommendation: StaleRecommendation;
  stalePassHealth: StalePassHealth;
  admissionResult: MixedAdmissionResult;
  occupancyMode: MixedOccupancyMode;
  occupancy: MixedOccupancySnapshot;
  activeMixedBudgetProfile: MixedCapacityBudgetProfileName;
  budgetSource: MixedBudgetSource;
  budgetActivationScope: MixedBudgetActivationScope;
  mixedBudgetVersion: number;
  trailLaneAvailable: boolean;
  passCount: number;
  rejectCount: number;
  insufficientCount: number;
  allowCount: number;
  allowReducedCount: number;
  waitForCapacityCount: number;
  states: MixedRegimeState[];
  /** Compact closed-order stale-PASS conversion summary (read-only). */
  stalePassSummary: StalePassSummary;
}

function _aggregateAdmissionResult(states: MixedRegimeState[]): MixedAdmissionResult {
  if (states.some((s) => s.admissionResult === "ALLOW")) return "ALLOW";
  if (states.some((s) => s.admissionResult === "ALLOW_REDUCED")) return "ALLOW_REDUCED";
  if (states.some((s) => s.admissionResult === "WAIT_FOR_CAPACITY")) return "WAIT_FOR_CAPACITY";
  if (states.some((s) => s.admissionResult === "INSUFFICIENT_CONTEXT")) return "INSUFFICIENT_CONTEXT";
  return "REJECT";
}

function _modeFromAdmission(admissionResult: MixedAdmissionResult): MixedOccupancyMode {
  if (admissionResult === "ALLOW") return "NORMAL";
  if (admissionResult === "ALLOW_REDUCED") return "REDUCED_RISK";
  if (admissionResult === "WAIT_FOR_CAPACITY") return "WAIT_FOR_CAPACITY";
  return "STRICT_BLOCK";
}

/**
 * Decide the mixed-regime routing posture from the candidate states + backlog.
 * Pure decision/evidence — never mutates admission. trailLaneAvailable lets the
 * router prefer the CG_TRAIL challenger sleeve when backlog is elevated.
 */
export function decideMixedRegimeRouting(args: {
  regime: string | null | undefined;
  states: MixedRegimeState[];
  backlog: MixedBacklog;
  trailLaneAvailable: boolean;
  stalePassSummary?: StalePassSummary;
  stalePassHealth?: StalePassHealth;
  occupancy?: MixedOccupancySnapshot;
  activeMixedBudgetProfile?: MixedCapacityBudgetProfileName;
  budgetSource?: MixedBudgetSource;
  budgetActivationScope?: MixedBudgetActivationScope;
  mixedBudgetVersion?: number;
}): MixedRegimeReport {
  const regimeIsMixed = _isMixed(args.regime);
  const qualifiedStates = args.states.filter(
    (s) =>
      s.mixedRouteDecision === "ROUTE_CG_WIDE" ||
      s.mixedRouteDecision === "ROUTE_LONG_CG_WIDE",
  );
  const passCount = qualifiedStates.length;
  const rejectCount = args.states.filter((s) => s.mixedRouteDecision === "REJECT").length;
  const insufficientCount = args.states.filter((s) => s.mixedRouteDecision === "INSUFFICIENT_CONTEXT").length;
  const allowCount = args.states.filter((s) => s.admissionResult === "ALLOW").length;
  const allowReducedCount = args.states.filter((s) => s.admissionResult === "ALLOW_REDUCED").length;
  const waitForCapacityCount = args.states.filter((s) => s.admissionResult === "WAIT_FOR_CAPACITY").length;
  const staleRecommendation = _staleRecommendation(args.backlog);
  const stalePassSummary = args.stalePassSummary ?? _emptyStalePassSummary();
  const stalePassHealth = args.stalePassHealth ?? classifyStalePassHealth(stalePassSummary);
  const admissionResult = _aggregateAdmissionResult(args.states);
  const occupancyMode = _modeFromAdmission(admissionResult);
  const occupancy = args.occupancy ?? args.states[0]?.occupancy ?? _emptyOccupancySnapshot();

  let mixedTradingMode: MixedTradingMode;
  let activeMixedLane: string | null = null;
  let activeMixedLanes: string[] = [];
  let activeMixedLaneReason: string;

  if (!regimeIsMixed) {
    mixedTradingMode = "OFF";
    activeMixedLaneReason = "regime is not Mixed — mixed router inactive";
  } else if (passCount === 0) {
    mixedTradingMode = "DIAGNOSTIC_ONLY";
    activeMixedLaneReason = "no qualified non-toxic Mixed SHORT or LONG candidate this cycle";
  } else if (admissionResult === "WAIT_FOR_CAPACITY") {
    // No new CG_WIDE entries; only challenger/diagnostic.
    mixedTradingMode = "DIAGNOSTIC_ONLY";
    activeMixedLane = null;
    activeMixedLaneReason =
      `qualified CG_WIDE signal but occupancy budget is full: ${occupancy.exceeded.join(", ") || "capacity wait"}`;
    /*
      ? `staleRatio ${args.backlog.staleRatio.toFixed(2)} ≥ ${STALE_RATIO_NO_WIDE}: no new CG_WIDE; CG_TRAIL challenger only`
      : `staleRatio ${args.backlog.staleRatio.toFixed(2)} ≥ ${STALE_RATIO_NO_WIDE}: no new CG_WIDE; no trail lane → no production entry`;
    */
  } else if (admissionResult === "REJECT") {
    mixedTradingMode = "DIAGNOSTIC_ONLY";
    activeMixedLaneReason =
      stalePassHealth === "DETERIORATING" && args.backlog.staleRatio >= STALE_RATIO_NO_WIDE
        ? `stalePassHealth=DETERIORATING and staleRatio ${args.backlog.staleRatio.toFixed(2)} >= ${STALE_RATIO_NO_WIDE}: strict CG_WIDE block`
        : "qualified edge rejected by mixed-router safety checks";
  } else if (admissionResult === "ALLOW_REDUCED") {
    mixedTradingMode = "REDUCE_WIDE";
    activeMixedLanes = Array.from(new Set(
      qualifiedStates
        .filter((s) => s.admissionResult === "ALLOW" || s.admissionResult === "ALLOW_REDUCED")
        .map((s) => s.mixedRouteDecision === "ROUTE_LONG_CG_WIDE" ? MIXED_LONG_WIDE_LANE : CG_WIDE_LANE),
    ));
    activeMixedLane = activeMixedLanes[0] ?? null;
    activeMixedLaneReason =
      `occupancyMode=REDUCED_RISK, stalePassHealth=${stalePassHealth}: allow qualified Mixed lanes at reduced diagnostic risk`;
    /*
      ? `staleRatio ${args.backlog.staleRatio.toFixed(2)} in [${STALE_RATIO_REDUCE},${STALE_RATIO_NO_WIDE}): reduce CG_WIDE, prefer CG_TRAIL challenger`
      : `staleRatio ${args.backlog.staleRatio.toFixed(2)} in [${STALE_RATIO_REDUCE},${STALE_RATIO_NO_WIDE}): reduce CG_WIDE (no trail lane)`;
    */
  } else {
    mixedTradingMode = "SELECTIVE_PAPER";
    activeMixedLanes = Array.from(new Set(
      qualifiedStates
        .filter((s) => s.admissionResult === "ALLOW" || s.admissionResult === "ALLOW_REDUCED")
        .map((s) => s.mixedRouteDecision === "ROUTE_LONG_CG_WIDE" ? MIXED_LONG_WIDE_LANE : CG_WIDE_LANE),
    ));
    activeMixedLane = activeMixedLanes[0] ?? null;
    activeMixedLaneReason =
      `occupancyMode=NORMAL, stalePassHealth=${stalePassHealth}: selective Mixed SHORT plus LONG diagnostic admission`;
  }

  return {
    reportOnly: true,
    diagnosticOnly: true,
    activeGateChange: false,
    version: MIXED_REGIME_ROUTER_VERSION,
    regimeIsMixed,
    mixedTradingMode,
    activeMixedLane,
    activeMixedLanes,
    activeMixedLaneReason,
    backlog: args.backlog,
    staleRecommendation,
    stalePassHealth,
    admissionResult,
    occupancyMode,
    occupancy,
    activeMixedBudgetProfile: args.activeMixedBudgetProfile ?? getActiveMixedPaperBudgetProfileConfig().activeMixedBudgetProfile,
    budgetSource: args.budgetSource ?? getActiveMixedPaperBudgetProfileConfig().budgetSource,
    budgetActivationScope: args.budgetActivationScope ?? MIXED_BUDGET_ACTIVATION_SCOPE,
    mixedBudgetVersion: args.mixedBudgetVersion ?? MIXED_BUDGET_PROFILE_VERSION,
    trailLaneAvailable: args.trailLaneAvailable,
    passCount,
    rejectCount,
    insufficientCount,
    allowCount,
    allowReducedCount,
    waitForCapacityCount,
    states: args.states,
    stalePassSummary,
  };
}

/** Convenience: build the full mixed-regime report from candidates + the paper book. */
export function buildMixedRegimeReport(args: {
  regime: string | null | undefined;
  candidates: MixedCandidateInput[];
  orders: PaperOrder[];
  nowMs: number;
  trailLaneAvailable?: boolean;
  occupancyBudget?: MixedOccupancyBudget;
  activeMixedBudgetProfile?: MixedCapacityBudgetProfileName;
  budgetSource?: MixedBudgetSource;
  budgetActivationScope?: MixedBudgetActivationScope;
  mixedBudgetVersion?: number;
}): MixedRegimeReport {
  const activeConfig = getActiveMixedPaperBudgetProfileConfig();
  const occupancyBudget = args.occupancyBudget ?? activeConfig.budget;
  const backlog = computeMixedBacklog(args.orders, args.nowMs);
  const stalePassSummary = buildStalePassCohortDiagnostic(args.orders).summary;
  const stalePassHealth = classifyStalePassHealth(stalePassSummary);
  const states = args.candidates.map((c) =>
    buildMixedRegimeState(c, backlog, {
      stalePassHealth,
      occupancy: computeMixedOccupancySnapshot({
        orders: args.orders,
        nowMs: args.nowMs,
        symbol: c.symbol ?? null,
        direction: c.direction ?? null,
        budget: occupancyBudget,
        laneId: c.laneId ?? null,
      }),
    }),
  );
  return decideMixedRegimeRouting({
    regime: args.regime,
    states,
    backlog,
    trailLaneAvailable: args.trailLaneAvailable ?? false,
    stalePassSummary,
    stalePassHealth,
    occupancy: states[0]?.occupancy ?? computeMixedOccupancySnapshot({ orders: args.orders, nowMs: args.nowMs, budget: occupancyBudget }),
    activeMixedBudgetProfile: args.activeMixedBudgetProfile ?? activeConfig.activeMixedBudgetProfile,
    budgetSource: args.budgetSource ?? activeConfig.budgetSource,
    budgetActivationScope: args.budgetActivationScope ?? activeConfig.budgetActivationScope,
    mixedBudgetVersion: args.mixedBudgetVersion ?? activeConfig.mixedBudgetVersion,
  });
}

export function buildMixedRegimeBriefLines(
  report: MixedRegimeReport,
  forwardValidation?: MixedBudgetForwardValidationReport | null,
): string[] {
  const b = report.backlog;
  const L: string[] = [];
  L.push("   ── MIXED REGIME ROUTER (DIAGNOSTIC — routing evidence, not a live gate) ──");
  L.push(
    `   mixedTradingMode=${report.mixedTradingMode}  activeMixedLane=${report.activeMixedLane ?? "none"}` +
      `  regimeIsMixed=${report.regimeIsMixed ? "true" : "false"}`,
  );
  L.push(`   activeMixedLanes=${report.activeMixedLanes.join(",") || "none"} longMixedMode=DIAGNOSTIC_ONLY`);
  L.push(
    `   mixedLaneDecisions: shortQualified=${report.states.filter((s) => s.mixedRouteDecision === "ROUTE_CG_WIDE").length}` +
      ` longQualified=${report.states.filter((s) => s.mixedRouteDecision === "ROUTE_LONG_CG_WIDE").length}` +
      ` longHeadlineEligible=0`,
  );
  L.push(`   why: ${report.activeMixedLaneReason}`);
  L.push(
    `   gate[${FORWARD_GATE_ID}] PASS=${report.passCount} REJECT=${report.rejectCount} INSUFFICIENT=${report.insufficientCount}`,
  );
  if (report.regimeIsMixed) {
    L.push(
      `   admissionResult=${report.admissionResult} occupancyMode=${report.occupancyMode} stalePassHealth=${report.stalePassHealth}` +
        ` allow=${report.allowCount} reduced=${report.allowReducedCount} wait=${report.waitForCapacityCount}`,
    );
  } else {
    // Mixed router is OFF — admission/occupancy counts are a hypothetical "what the
    // mixed router WOULD decide if regime were Mixed", NOT active paper admissions.
    L.push(
      `   hypotheticalIfMixed: admissionResult=${report.admissionResult} occupancyMode=${report.occupancyMode}` +
        ` allow=${report.allowCount} reduced=${report.allowReducedCount} wait=${report.waitForCapacityCount}` +
        ` stalePassHealth=${report.stalePassHealth}` +
        `  (mixed router OFF — hypothetical only, no paper admission active)`,
    );
  }
  L.push(
    `   activeMixedBudgetProfile=${report.activeMixedBudgetProfile}` +
      ` budgetSource=${report.budgetSource}` +
      ` budgetActivationScope=${report.budgetActivationScope}` +
      ` liveBlocked=TRUE microPilotAllowed=FALSE`,
  );
  if (forwardValidation) {
    const g = forwardValidation.guardrail;
    L.push(
      `   mixedBudgetForwardGuardrail=${g.status}` +
        ` recommendedAction=${g.recommendedAction}` +
        ` reasons=${g.reasons.length ? g.reasons.join(",") : "none"}` +
        ` closed=${forwardValidation.closedUnderProfileCount}` +
        ` PF=${_fmtMetric(forwardValidation.profilePF, 2)}` +
        ` netAvgR=${_fmtMetric(forwardValidation.profileNetAvgR, 4)}` +
        ` wait=${forwardValidation.newWaitCapacityCount}`,
    );
  }
  L.push(
    `   backlog: openOrderCount=${b.openOrderCount} staleWideHold=${b.staleWideHoldCount} critical=${b.criticalCount}` +
      ` staleRatio=${b.staleRatio.toFixed(2)} oldestOpenHold=${b.oldestOpenHoldHours == null ? "n/a" : b.oldestOpenHoldHours.toFixed(1) + "h"}` +
      `  staleRecommendation=${report.staleRecommendation}`,
  );
  const occ = report.occupancy;
  L.push(
    `   occupancy[${occ.laneId}]: wideOpen=${occ.wideOpenCount}/${occ.budget.maxWideOpen}` +
      ` wideStale=${occ.wideStaleCount}/${occ.budget.maxWideStale}` +
      ` symbolOpen=${occ.perSymbolOpenCount}/${occ.budget.maxPerSymbolOpen}` +
      ` dirOpen=${occ.perDirectionOpenCount}/${occ.budget.maxPerDirectionOpen}` +
      ` passStaleShare=${occ.passStaleShare.toFixed(2)}/${occ.budget.maxPassStaleShare.toFixed(2)}`,
  );
  const sp = report.stalePassSummary;
  L.push(
    `   stalePassCohort: verdict=${sp.verdict} freshPassN=${sp.freshPassN} stalePassN=${sp.stalePassN}` +
      ` freshPassNetAvgR=${sp.freshPassNetAvgR == null ? "n/a" : sp.freshPassNetAvgR.toFixed(4)}` +
      ` stalePassNetAvgR=${sp.stalePassNetAvgR == null ? "n/a" : sp.stalePassNetAvgR.toFixed(4)}` +
      ` stalePassPF=${sp.stalePassPF == null ? "n/a" : Number.isFinite(sp.stalePassPF) ? sp.stalePassPF.toFixed(2) : "inf"}`,
  );
  L.push(`   trailLaneAvailable=${report.trailLaneAvailable ? "true" : "false"}  activeGateChange=NO  liveBlocked=TRUE  microPilotAllowed=FALSE`);
  return L;
}

// ════════════════════════════════════════════════════════════════════════════
export interface MixedAdmissionBudgetUsed {
  wideOpen: { used: number; max: number };
  wideStale: { used: number; max: number };
  perSymbolOpen: { used: number; max: number };
  perDirectionOpen: { used: number; max: number };
  passStaleShare: { used: number; max: number };
}

export type MixedQualificationDecision = "QUALIFIED" | "NOT_QUALIFIED" | "INSUFFICIENT_CONTEXT";
export type MixedCapacityDecision = "AVAILABLE" | "REDUCED_RISK" | "WAIT_FOR_CAPACITY" | "NOT_APPLICABLE";
export type MixedFinalRiskDecision =
  | "NORMAL_DIAGNOSTIC_RISK"
  | "REDUCED_DIAGNOSTIC_RISK"
  | "ZERO_CAPACITY_WAIT"
  | "ZERO_SIGNAL_REJECT"
  | "ZERO_METADATA_INSUFFICIENT";
export type MixedAdmissionReasonCategory =
  | "RAW_GATE_REJECTED"
  | "MIXED_ROUTER_QUALIFIED"
  | "CAPACITY_WAIT"
  | "SIGNAL_REJECT"
  | "METADATA_INSUFFICIENT"
  | "OCCUPANCY_REDUCED_RISK";
export type MixedCapacityReplayMode = "EXACT_MATCH" | "PROXY_COHORT" | "INSUFFICIENT_DATA";
export type MixedCapacityOpportunityVerdict =
  | "CAPACITY_TOO_STRICT"
  | "CAPACITY_PROTECTIVE"
  | "INSUFFICIENT_REPLAY"
  | "MIXED_SIGNAL";
export type MixedCapacityBudgetProfileVerdict = "TOO_CONSERVATIVE" | "BALANCED" | "TOO_AGGRESSIVE" | "INSUFFICIENT";
export type MixedCapacityBudgetRisk = "LOW" | "MEDIUM" | "HIGH" | "INSUFFICIENT";

export interface MixedAdmissionLedgerEntry {
  timestamp: string;
  symbol: string | null;
  direction: string | null;
  regime: string | null;
  rawForwardGateDecision: ForwardGateDecision;
  forwardGateDecision: ForwardGateDecision;
  mixedRouteDecision: MixedRouteDecision;
  mixedQualificationDecision: MixedQualificationDecision;
  stalePassHealth: StalePassHealth;
  admissionResult: MixedAdmissionResult;
  finalAdmissionResult: MixedAdmissionResult;
  capacityDecision: MixedCapacityDecision;
  occupancyMode: MixedOccupancyMode;
  riskMultiplierAfterOccupancy: number;
  finalRiskDecision: MixedFinalRiskDecision;
  occupancyReason: string;
  budgetUsed: MixedAdmissionBudgetUsed;
  reasonCategories: MixedAdmissionReasonCategory[];
  routeReasons: string[];
}

export interface MixedAdmissionLedgerReport {
  reportOnly: true;
  diagnosticOnly: true;
  activeGateChange: false;
  liveBlocked: true;
  microPilotAllowed: false;
  generatedAt: string;
  source: "CURRENT_SCAN_RECONSTRUCTION";
  /** Whether the current regime is Mixed. When false, entries are hypothetical. */
  regimeIsMixed?: boolean;
  /** ACTUAL when regime is Mixed; HYPOTHETICAL_IF_MIXED when the mixed router is OFF. */
  mixedAdmissionMode?: "ACTUAL_MIXED_ADMISSION" | "HYPOTHETICAL_IF_MIXED";
  entries: MixedAdmissionLedgerEntry[];
  summary: {
    countByAdmissionResult: Record<string, number>;
    countByOccupancyMode: Record<string, number>;
    topSymbolsByWaitForCapacity: Array<{ symbol: string; count: number }>;
    topRejectReasons: Array<{ reason: string; count: number }>;
    passCandidatesLostToCapacity: number;
    estimatedOpportunityPressure: number;
    interpretation: Record<MixedAdmissionResult, string>;
  };
}

export interface MixedCapacityOpportunityReplayReport {
  reportOnly: true;
  diagnosticOnly: true;
  activeGateChange: false;
  liveBlocked: true;
  microPilotAllowed: false;
  generatedAt: string;
  replayMode: MixedCapacityReplayMode;
  matchMethod: string;
  waitCapacityCount: number;
  matchedReplayCount: number;
  exactMatchedCount: number;
  proxyCohortCount: number;
  unmatchedCount: number;
  replayNetAvgR: number | null;
  replayPF: number | null;
  replayWR: number | null;
  avgHoldHours: number | null;
  opportunityCostVerdict: MixedCapacityOpportunityVerdict;
  selectedWaitSymbols: Array<{ symbol: string; direction: string }>;
}

export interface MixedCapacityBudgetSimulationProfileResult {
  profile: MixedCapacityBudgetProfileName;
  budget: MixedOccupancyBudget;
  verdict: MixedCapacityBudgetProfileVerdict;
  allowedCount: number;
  reducedCount: number;
  waitCapacityCount: number;
  waitReduction: number;
  estimatedRecoveredOpportunities: number;
  estimatedRecoveredNetR: number | null;
  estimatedPF: number | null;
  estimatedWR: number | null;
  maxBookPressure: number;
  symbolConcentrationRisk: number;
  directionConcentrationRisk: number;
  stalePressure: number;
  risk: MixedCapacityBudgetRisk;
  recommendationScore: number;
}

export interface MixedCapacityBudgetSimulationReport {
  reportOnly: true;
  diagnosticOnly: true;
  activeGateChange: false;
  liveBlocked: true;
  microPilotAllowed: false;
  generatedAt: string;
  replayMode: MixedCapacityReplayMode;
  replayMatchedCount: number;
  opportunityCostVerdict: MixedCapacityOpportunityVerdict;
  baselineWaitCapacityCount: number;
  recommendedProfile: MixedCapacityBudgetProfileName | "NONE";
  recommendedProfileReason: string;
  profiles: MixedCapacityBudgetSimulationProfileResult[];
}

export type MixedBudgetForwardValidationVerdict =
  | "KEEP_PROFILE"
  | "ROLL_BACK_TO_CONSERVATIVE"
  | "NEED_MORE_OOS"
  | "MIXED_SIGNAL";

export interface MixedBudgetForwardValidationReport {
  reportOnly: true;
  diagnosticOnly: true;
  activeGateChange: false;
  liveBlocked: true;
  microPilotAllowed: false;
  generatedAt: string;
  activeMixedBudgetProfile: MixedCapacityBudgetProfileName;
  budgetSource: MixedBudgetSource;
  budgetActivationScope: MixedBudgetActivationScope;
  mixedBudgetVersion: number;
  newDecisionsCount: number;
  newAllowCount: number;
  newAllowReducedCount: number;
  newWaitCapacityCount: number;
  newRejectCount: number;
  closedUnderProfileCount: number;
  profileNetAvgR: number | null;
  profilePF: number | null;
  profileWR: number | null;
  profileAvgHoldHours: number | null;
  verdict: MixedBudgetForwardValidationVerdict;
  /** Warning-level forward-monitoring guardrail (report-only; never auto-rolls-back). */
  guardrail: MixedBudgetGuardrail;
}

function _inc(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function _topCounts(map: Record<string, number>, limit = 5): Array<{ symbol: string; count: number }> {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([symbol, count]) => ({ symbol, count }));
}

function _topReasons(map: Record<string, number>, limit = 8): Array<{ reason: string; count: number }> {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}

function _fmtMetric(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) {
    if (value === Infinity) return "inf";
    return "n/a";
  }
  return value.toFixed(digits);
}

function _budgetUsed(occupancy: MixedOccupancySnapshot): MixedAdmissionBudgetUsed {
  return {
    wideOpen: { used: occupancy.wideOpenCount, max: occupancy.budget.maxWideOpen },
    wideStale: { used: occupancy.wideStaleCount, max: occupancy.budget.maxWideStale },
    perSymbolOpen: { used: occupancy.perSymbolOpenCount, max: occupancy.budget.maxPerSymbolOpen },
    perDirectionOpen: { used: occupancy.perDirectionOpenCount, max: occupancy.budget.maxPerDirectionOpen },
    passStaleShare: { used: occupancy.passStaleShare, max: occupancy.budget.maxPassStaleShare },
  };
}

function _occupancyReason(state: MixedRegimeState): string {
  const reasons = state.mixedRouteReasons.filter(
    (reason) =>
      reason.startsWith("OCCUPANCY_") ||
      reason.startsWith("LONG_OCCUPANCY_") ||
      reason.startsWith("BENIGN_") ||
      reason.startsWith("STALE_PASS_"),
  );
  if (reasons.length > 0) return reasons.join("|");
  if (state.admissionResult === "WAIT_FOR_CAPACITY") return "GOOD_SIGNAL_BUT_NO_SLOT";
  if (state.admissionResult === "ALLOW_REDUCED") return "GOOD_SIGNAL_REDUCED_RISK";
  if (state.admissionResult === "ALLOW") return "GOOD_SIGNAL_CAPACITY_AVAILABLE";
  if (state.admissionResult === "INSUFFICIENT_CONTEXT") return "MISSING_METADATA";
  return state.mixedRouteReasons[0] ?? "REJECTED_SIGNAL";
}

function _mixedQualificationDecision(decision: MixedRouteDecision): MixedQualificationDecision {
  if (decision === "ROUTE_CG_WIDE" || decision === "ROUTE_LONG_CG_WIDE") return "QUALIFIED";
  if (decision === "INSUFFICIENT_CONTEXT") return "INSUFFICIENT_CONTEXT";
  return "NOT_QUALIFIED";
}

function _capacityDecision(admissionResult: MixedAdmissionResult): MixedCapacityDecision {
  if (admissionResult === "ALLOW") return "AVAILABLE";
  if (admissionResult === "ALLOW_REDUCED") return "REDUCED_RISK";
  if (admissionResult === "WAIT_FOR_CAPACITY") return "WAIT_FOR_CAPACITY";
  return "NOT_APPLICABLE";
}

function _finalRiskDecision(entry: {
  admissionResult: MixedAdmissionResult;
  riskMultiplierAfterOccupancy: number;
}): MixedFinalRiskDecision {
  if (entry.admissionResult === "WAIT_FOR_CAPACITY") return "ZERO_CAPACITY_WAIT";
  if (entry.admissionResult === "REJECT") return "ZERO_SIGNAL_REJECT";
  if (entry.admissionResult === "INSUFFICIENT_CONTEXT") return "ZERO_METADATA_INSUFFICIENT";
  if (entry.admissionResult === "ALLOW_REDUCED") return "REDUCED_DIAGNOSTIC_RISK";
  return "NORMAL_DIAGNOSTIC_RISK";
}

function _reasonCategories(entry: {
  forwardGateDecision: ForwardGateDecision;
  mixedRouteDecision: MixedRouteDecision;
  admissionResult: MixedAdmissionResult;
}): MixedAdmissionReasonCategory[] {
  const categories: MixedAdmissionReasonCategory[] = [];
  if (entry.forwardGateDecision === "REJECT") categories.push("RAW_GATE_REJECTED");
  if (
    entry.mixedRouteDecision === "ROUTE_CG_WIDE" ||
    entry.mixedRouteDecision === "ROUTE_LONG_CG_WIDE"
  ) categories.push("MIXED_ROUTER_QUALIFIED");
  if (entry.admissionResult === "WAIT_FOR_CAPACITY") categories.push("CAPACITY_WAIT");
  if (entry.admissionResult === "REJECT") categories.push("SIGNAL_REJECT");
  if (entry.admissionResult === "INSUFFICIENT_CONTEXT") categories.push("METADATA_INSUFFICIENT");
  if (entry.admissionResult === "ALLOW_REDUCED") categories.push("OCCUPANCY_REDUCED_RISK");
  return categories;
}

export function buildMixedAdmissionDecisionLedger(
  report: MixedRegimeReport,
  generatedAt = new Date().toISOString(),
): MixedAdmissionLedgerReport {
  const entries: MixedAdmissionLedgerEntry[] = report.states.map((state) => {
    const base = {
      timestamp: generatedAt,
      symbol: state.symbol,
      direction: state.direction,
      regime: state.regimeLabel,
      rawForwardGateDecision: state.forwardGateDecision,
      forwardGateDecision: state.forwardGateDecision,
      mixedRouteDecision: state.mixedRouteDecision,
      mixedQualificationDecision: _mixedQualificationDecision(state.mixedRouteDecision),
      stalePassHealth: state.stalePassHealth,
      admissionResult: state.admissionResult,
      finalAdmissionResult: state.admissionResult,
      capacityDecision: _capacityDecision(state.admissionResult),
      occupancyMode: state.occupancyMode,
      riskMultiplierAfterOccupancy: state.risk.riskMultiplier,
      occupancyReason: _occupancyReason(state),
      budgetUsed: _budgetUsed(state.occupancy),
      routeReasons: Array.from(new Set([...state.forwardGateReasons, ...state.mixedRouteReasons])),
    };
    return {
      ...base,
      finalRiskDecision: _finalRiskDecision(base),
      reasonCategories: _reasonCategories(base),
    };
  });

  const countByAdmissionResult: Record<string, number> = {};
  const countByOccupancyMode: Record<string, number> = {};
  const waitSymbols: Record<string, number> = {};
  const rejectReasons: Record<string, number> = {};
  let passCandidatesLostToCapacity = 0;

  for (const entry of entries) {
    _inc(countByAdmissionResult, entry.admissionResult);
    _inc(countByOccupancyMode, entry.occupancyMode);
    if (entry.admissionResult === "WAIT_FOR_CAPACITY") {
      _inc(waitSymbols, entry.symbol ?? "UNKNOWN");
      if (
        entry.mixedRouteDecision === "ROUTE_CG_WIDE" ||
        entry.mixedRouteDecision === "ROUTE_LONG_CG_WIDE"
      ) passCandidatesLostToCapacity += 1;
    }
    if (entry.admissionResult === "REJECT") {
      for (const reason of entry.routeReasons) _inc(rejectReasons, reason);
    }
  }

  const total = entries.length;
  const pressureNumerator = passCandidatesLostToCapacity + (countByAdmissionResult.ALLOW_REDUCED ?? 0) * 0.5;

  return {
    reportOnly: true,
    diagnosticOnly: true,
    activeGateChange: false,
    liveBlocked: true,
    microPilotAllowed: false,
    generatedAt,
    source: "CURRENT_SCAN_RECONSTRUCTION",
    regimeIsMixed: report.regimeIsMixed,
    mixedAdmissionMode: report.regimeIsMixed ? "ACTUAL_MIXED_ADMISSION" : "HYPOTHETICAL_IF_MIXED",
    entries,
    summary: {
      countByAdmissionResult,
      countByOccupancyMode,
      topSymbolsByWaitForCapacity: _topCounts(waitSymbols),
      topRejectReasons: _topReasons(rejectReasons),
      passCandidatesLostToCapacity,
      estimatedOpportunityPressure: total > 0 ? pressureNumerator / total : 0,
      interpretation: {
        ALLOW: "good signal with available occupancy budget",
        ALLOW_REDUCED: "good signal admitted only at reduced diagnostic risk",
        WAIT_FOR_CAPACITY: "good signal but no slot",
        REJECT: "bad signal",
        INSUFFICIENT_CONTEXT: "missing metadata",
      },
    },
  };
}

function _isClosedWideOutcome(order: PaperOrder): boolean {
  return (
    CLOSED_STATUSES.has(order.paperStatus) &&
    (order.selectedLaneId === CG_WIDE_LANE || order.selectedLaneId === MIXED_LONG_WIDE_LANE) &&
    Number.isFinite(order.netR)
  );
}

function _orderOpenMs(order: PaperOrder): number {
  const ms = Date.parse(order.openedAt ?? order.createdAt);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function _netMetrics(orders: PaperOrder[]): Pick<
  MixedCapacityOpportunityReplayReport,
  "replayNetAvgR" | "replayPF" | "replayWR" | "avgHoldHours"
> {
  const net = orders.map((o) => o.netR).filter((r): r is number => r !== null && Number.isFinite(r));
  if (net.length === 0) {
    return { replayNetAvgR: null, replayPF: null, replayWR: null, avgHoldHours: null };
  }
  const wins = net.filter((r) => r > 0);
  const losses = net.filter((r) => r < 0);
  const grossWin = wins.reduce((sum, r) => sum + r, 0);
  const grossLoss = Math.abs(losses.reduce((sum, r) => sum + r, 0));
  const holdHours = orders.map(_closedHoldHours).filter((h) => Number.isFinite(h));
  return {
    replayNetAvgR: net.reduce((sum, r) => sum + r, 0) / net.length,
    replayPF: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    replayWR: wins.length / net.length,
    avgHoldHours: holdHours.length > 0 ? holdHours.reduce((sum, h) => sum + h, 0) / holdHours.length : null,
  };
}

function _opportunityVerdict(args: {
  matchedReplayCount: number;
  replayNetAvgR: number | null;
  replayPF: number | null;
  minReplayCount: number;
}): MixedCapacityOpportunityVerdict {
  if (args.matchedReplayCount < args.minReplayCount) return "INSUFFICIENT_REPLAY";
  const pf = args.replayPF ?? 0;
  const net = args.replayNetAvgR ?? 0;
  if (net > 0 && pf > 1.5) return "CAPACITY_TOO_STRICT";
  if (net <= 0 || pf < 1.0) return "CAPACITY_PROTECTIVE";
  return "MIXED_SIGNAL";
}

function _selectWaitCapacityEntries(
  ledger: MixedAdmissionLedgerReport,
): Array<{ entry: MixedAdmissionLedgerEntry; index: number }> {
  return ledger.entries
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        entry.admissionResult === "WAIT_FOR_CAPACITY" &&
        entry.mixedQualificationDecision === "QUALIFIED" &&
        (
          entry.mixedRouteDecision === "ROUTE_CG_WIDE" ||
          entry.mixedRouteDecision === "ROUTE_LONG_CG_WIDE"
        ),
    );
}

function _exactReplayMatchesByWaitIndex(args: {
  waits: Array<{ entry: MixedAdmissionLedgerEntry; index: number }>;
  orders: PaperOrder[];
  exactWindowMs: number;
}): Map<number, PaperOrder> {
  const closedWide = args.orders.filter(_isClosedWideOutcome);
  const used = new Set<string>();
  const matches = new Map<number, PaperOrder>();
  for (const wait of args.waits) {
    const ts = Date.parse(wait.entry.timestamp);
    if (!wait.entry.symbol || !wait.entry.direction || !Number.isFinite(ts)) continue;
    const candidates = closedWide
      .filter((o) => {
        if (used.has(o.paperOrderId)) return false;
        if (o.symbol !== wait.entry.symbol || o.direction !== wait.entry.direction) return false;
        if (wait.entry.regime && o.regime && o.regime !== wait.entry.regime) return false;
        const openMs = _orderOpenMs(o);
        return Number.isFinite(openMs) && openMs >= ts && openMs - ts <= args.exactWindowMs;
      })
      .sort((a, b) => _orderOpenMs(a) - _orderOpenMs(b));
    const match = candidates[0];
    if (match) {
      matches.set(wait.index, match);
      used.add(match.paperOrderId);
    }
  }
  return matches;
}

export function buildMixedCapacityOpportunityReplay(args: {
  ledger: MixedAdmissionLedgerReport;
  orders: PaperOrder[];
  generatedAt?: string;
  exactWindowHours?: number;
  minReplayCount?: number;
}): MixedCapacityOpportunityReplayReport {
  const generatedAt = args.generatedAt ?? new Date().toISOString();
  const exactWindowMs = (args.exactWindowHours ?? 48) * 3_600_000;
  const minReplayCount = args.minReplayCount ?? 20;
  const waitEntriesWithIndex = _selectWaitCapacityEntries(args.ledger);
  const waitEntries = waitEntriesWithIndex.map((wait) => wait.entry);
  const closedWide = args.orders.filter(_isClosedWideOutcome);
  const exactMatches = Array.from(
    _exactReplayMatchesByWaitIndex({ waits: waitEntriesWithIndex, orders: args.orders, exactWindowMs }).values(),
  );

  let replayMode: MixedCapacityReplayMode = "INSUFFICIENT_DATA";
  let replayOrders: PaperOrder[] = [];
  let matchMethod = "No exact or proxy CG_WIDE closed outcomes available.";

  if (exactMatches.length > 0) {
    replayMode = "EXACT_MATCH";
    replayOrders = exactMatches;
    matchMethod = "Exact closed CG_WIDE outcomes matched by same symbol, direction, optional regime, and later nearby openedAt.";
  } else if (waitEntries.length > 0) {
    const waitDirections = new Set(waitEntries.map((entry) => entry.direction).filter(Boolean));
    const waitSymbols = new Set(waitEntries.map((entry) => entry.symbol).filter(Boolean));
    const proxy = closedWide.filter((o) => {
      if (waitDirections.size > 0 && !waitDirections.has(o.direction)) return false;
      return waitSymbols.size === 0 || waitSymbols.has(o.symbol) || closedWide.length >= minReplayCount;
    });
    if (proxy.length > 0) {
      replayMode = "PROXY_COHORT";
      replayOrders = proxy;
      matchMethod = "Exact replay unavailable; using comparable closed CG_WIDE proxy cohort with matching direction when possible.";
    }
  }

  const metrics = _netMetrics(replayOrders);
  const matchedReplayCount = replayOrders.length;
  return {
    reportOnly: true,
    diagnosticOnly: true,
    activeGateChange: false,
    liveBlocked: true,
    microPilotAllowed: false,
    generatedAt,
    replayMode,
    matchMethod,
    waitCapacityCount: waitEntries.length,
    matchedReplayCount,
    exactMatchedCount: exactMatches.length,
    proxyCohortCount: replayMode === "PROXY_COHORT" ? replayOrders.length : 0,
    unmatchedCount: Math.max(0, waitEntries.length - exactMatches.length),
    ...metrics,
    opportunityCostVerdict: _opportunityVerdict({ matchedReplayCount, ...metrics, minReplayCount }),
    selectedWaitSymbols: waitEntries.map((entry) => ({
      symbol: entry.symbol ?? "UNKNOWN",
      direction: entry.direction ?? "UNKNOWN",
    })),
  };
}

function _netValueMetrics(values: number[]): {
  netAvg: number | null;
  pf: number | null;
  wr: number | null;
  netSum: number | null;
} {
  const net = values.filter((r) => Number.isFinite(r));
  if (net.length === 0) return { netAvg: null, pf: null, wr: null, netSum: null };
  const wins = net.filter((r) => r > 0);
  const losses = net.filter((r) => r < 0);
  const grossWin = wins.reduce((sum, r) => sum + r, 0);
  const grossLoss = Math.abs(losses.reduce((sum, r) => sum + r, 0));
  const netSum = net.reduce((sum, r) => sum + r, 0);
  return {
    netAvg: netSum / net.length,
    netSum,
    pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    wr: wins.length / net.length,
  };
}

function _profilePressure(states: MixedRegimeState[]): Pick<
  MixedCapacityBudgetSimulationProfileResult,
  "maxBookPressure" | "symbolConcentrationRisk" | "directionConcentrationRisk" | "stalePressure"
> {
  let maxBookPressure = 0;
  let symbolConcentrationRisk = 0;
  let directionConcentrationRisk = 0;
  let stalePressure = 0;
  for (const state of states) {
    const o = state.occupancy;
    const widePressure = o.budget.maxWideOpen > 0 ? o.wideOpenCount / o.budget.maxWideOpen : 0;
    const staleWidePressure = o.budget.maxWideStale > 0 ? o.wideStaleCount / o.budget.maxWideStale : 0;
    const stalePassPressure = o.budget.maxPassStaleShare > 0 ? o.passStaleShare / o.budget.maxPassStaleShare : 0;
    const symbolPressure = o.budget.maxPerSymbolOpen > 0 ? o.perSymbolOpenCount / o.budget.maxPerSymbolOpen : 0;
    const directionPressure = o.budget.maxPerDirectionOpen > 0 ? o.perDirectionOpenCount / o.budget.maxPerDirectionOpen : 0;
    maxBookPressure = Math.max(maxBookPressure, widePressure);
    stalePressure = Math.max(stalePressure, staleWidePressure, stalePassPressure);
    symbolConcentrationRisk = Math.max(symbolConcentrationRisk, symbolPressure);
    directionConcentrationRisk = Math.max(directionConcentrationRisk, directionPressure);
  }
  return { maxBookPressure, symbolConcentrationRisk, directionConcentrationRisk, stalePressure };
}

function _budgetRisk(args: {
  symbolConcentrationRisk: number;
  directionConcentrationRisk: number;
  stalePressure: number;
  maxBookPressure: number;
  insufficient: boolean;
}): MixedCapacityBudgetRisk {
  if (args.insufficient) return "INSUFFICIENT";
  if (
    args.symbolConcentrationRisk >= 1 ||
    args.directionConcentrationRisk >= 1 ||
    args.stalePressure >= 1 ||
    args.maxBookPressure >= 1
  ) {
    return "HIGH";
  }
  if (
    args.symbolConcentrationRisk >= 0.75 ||
    args.directionConcentrationRisk >= 0.85 ||
    args.stalePressure >= 0.85 ||
    args.maxBookPressure >= 0.85
  ) {
    return "MEDIUM";
  }
  return "LOW";
}

function _profileVerdict(args: {
  replayMatchedCount: number;
  minReplayCount: number;
  replayVerdict: MixedCapacityOpportunityVerdict;
  waitReduction: number;
  risk: MixedCapacityBudgetRisk;
  estimatedRecoveredNetR: number | null;
}): MixedCapacityBudgetProfileVerdict {
  if (args.replayMatchedCount < args.minReplayCount) return "INSUFFICIENT";
  if (args.waitReduction <= 0 && args.replayVerdict === "CAPACITY_TOO_STRICT") return "TOO_CONSERVATIVE";
  if (args.risk === "HIGH") return "TOO_AGGRESSIVE";
  if ((args.estimatedRecoveredNetR ?? 0) > 0 && args.waitReduction > 0) return "BALANCED";
  return args.risk === "MEDIUM" ? "BALANCED" : "TOO_CONSERVATIVE";
}

function _recommendProfile(profiles: MixedCapacityBudgetSimulationProfileResult[]): {
  recommendedProfile: MixedCapacityBudgetSimulationReport["recommendedProfile"];
  reason: string;
} {
  const eligible = profiles.filter((p) => p.verdict === "BALANCED" && p.estimatedRecoveredOpportunities > 0);
  if (eligible.length === 0) {
    return { recommendedProfile: "NONE", reason: "No balanced profile recovered replay-positive capacity opportunities." };
  }
  const nonAggressive = eligible.filter((p) => p.profile !== "AGGRESSIVE_PAPER_ONLY");
  const bestNonAggressive = [...nonAggressive].sort((a, b) => b.recommendationScore - a.recommendationScore)[0] ?? null;
  const aggressive = eligible.find((p) => p.profile === "AGGRESSIVE_PAPER_ONLY") ?? null;
  if (
    aggressive &&
    (!bestNonAggressive || aggressive.recommendationScore >= bestNonAggressive.recommendationScore + 5) &&
    aggressive.risk === "LOW"
  ) {
    return {
      recommendedProfile: aggressive.profile,
      reason: "Aggressive paper-only budget is materially superior and still low risk in replay simulation.",
    };
  }
  if (bestNonAggressive) {
    return {
      recommendedProfile: bestNonAggressive.profile,
      reason: "Best non-aggressive balanced budget after concentration and stale-pressure penalties.",
    };
  }
  return { recommendedProfile: "NONE", reason: "Aggressive paper-only profile was not clearly superior and safe." };
}

export function buildMixedCapacityBudgetSimulation(args: {
  regime: string | null | undefined;
  candidates: MixedCandidateInput[];
  orders: PaperOrder[];
  nowMs: number;
  generatedAt?: string;
  trailLaneAvailable?: boolean;
  exactWindowHours?: number;
  minReplayCount?: number;
}): MixedCapacityBudgetSimulationReport {
  const generatedAt = args.generatedAt ?? new Date().toISOString();
  const minReplayCount = args.minReplayCount ?? 20;
  const exactWindowMs = (args.exactWindowHours ?? 48) * 3_600_000;
  const baselineReport = buildMixedRegimeReport({
    regime: args.regime,
    candidates: args.candidates,
    orders: args.orders,
    nowMs: args.nowMs,
    trailLaneAvailable: args.trailLaneAvailable,
    occupancyBudget: MIXED_OCCUPANCY_BUDGET,
    activeMixedBudgetProfile: "CONSERVATIVE_CURRENT",
    budgetSource: "ROLLBACK_CONFIG",
    budgetActivationScope: MIXED_BUDGET_ACTIVATION_SCOPE,
    mixedBudgetVersion: MIXED_BUDGET_PROFILE_VERSION,
  });
  const baselineLedger = buildMixedAdmissionDecisionLedger(baselineReport, generatedAt);
  const replay = buildMixedCapacityOpportunityReplay({
    ledger: baselineLedger,
    orders: args.orders,
    generatedAt,
    exactWindowHours: args.exactWindowHours,
    minReplayCount,
  });
  const baselineWaits = _selectWaitCapacityEntries(baselineLedger);
  const baselineWaitCount = baselineLedger.summary.countByAdmissionResult.WAIT_FOR_CAPACITY ?? 0;
  const exactMatches = _exactReplayMatchesByWaitIndex({ waits: baselineWaits, orders: args.orders, exactWindowMs });
  const useProxyRecovery = replay.replayMode === "PROXY_COHORT" && replay.replayNetAvgR !== null;

  const profiles = MIXED_CAPACITY_BUDGET_PROFILES.map((profile): MixedCapacityBudgetSimulationProfileResult => {
    const report = buildMixedRegimeReport({
      regime: args.regime,
      candidates: args.candidates,
      orders: args.orders,
      nowMs: args.nowMs,
      trailLaneAvailable: args.trailLaneAvailable,
      occupancyBudget: profile.budget,
      activeMixedBudgetProfile: profile.name,
      budgetSource: profile.name === "CONSERVATIVE_CURRENT" ? "ROLLBACK_CONFIG" : "SIMULATION_RECOMMENDED",
      budgetActivationScope: MIXED_BUDGET_ACTIVATION_SCOPE,
      mixedBudgetVersion: MIXED_BUDGET_PROFILE_VERSION,
    });
    const recoveredIndexes = baselineWaits
      .filter((wait) => {
        const next = report.states[wait.index];
        return next?.admissionResult === "ALLOW" || next?.admissionResult === "ALLOW_REDUCED";
      })
      .map((wait) => wait.index);
    const recoveredNetValues = recoveredIndexes
      .map((index) => exactMatches.get(index)?.netR)
      .filter((r): r is number => r !== null && r !== undefined && Number.isFinite(r));
    const estimatedNetValues =
      recoveredNetValues.length > 0
        ? recoveredNetValues
        : useProxyRecovery
          ? recoveredIndexes.map(() => replay.replayNetAvgR!)
          : [];
    const recoveredMetrics = _netValueMetrics(estimatedNetValues);
    const pressure = _profilePressure(report.states);
    const insufficient = replay.matchedReplayCount < minReplayCount;
    const risk = _budgetRisk({ ...pressure, insufficient });
    const waitReduction = Math.max(0, baselineWaitCount - report.waitForCapacityCount);
    const verdict = _profileVerdict({
      replayMatchedCount: replay.matchedReplayCount,
      minReplayCount,
      replayVerdict: replay.opportunityCostVerdict,
      waitReduction,
      risk,
      estimatedRecoveredNetR: recoveredMetrics.netSum,
    });
    const riskPenalty =
      pressure.symbolConcentrationRisk * 1.25 +
      pressure.stalePressure +
      Math.max(0, pressure.directionConcentrationRisk - 0.85) * 2 +
      (profile.paperOnlyAggressive ? 0.75 : 0);
    const recommendationScore =
      insufficient || verdict === "TOO_AGGRESSIVE"
        ? -100
        : (recoveredMetrics.netSum ?? 0) + waitReduction * 0.25 - riskPenalty;
    return {
      profile: profile.name,
      budget: profile.budget,
      verdict,
      allowedCount: report.allowCount,
      reducedCount: report.allowReducedCount,
      waitCapacityCount: report.waitForCapacityCount,
      waitReduction,
      estimatedRecoveredOpportunities: recoveredIndexes.length,
      estimatedRecoveredNetR: recoveredMetrics.netSum,
      estimatedPF: recoveredMetrics.pf,
      estimatedWR: recoveredMetrics.wr,
      ...pressure,
      risk,
      recommendationScore,
    };
  });
  const recommendation = _recommendProfile(profiles);
  return {
    reportOnly: true,
    diagnosticOnly: true,
    activeGateChange: false,
    liveBlocked: true,
    microPilotAllowed: false,
    generatedAt,
    replayMode: replay.replayMode,
    replayMatchedCount: replay.matchedReplayCount,
    opportunityCostVerdict: replay.opportunityCostVerdict,
    baselineWaitCapacityCount: baselineWaitCount,
    recommendedProfile: recommendation.recommendedProfile,
    recommendedProfileReason: recommendation.reason,
    profiles,
  };
}

export function renderMixedCapacityBudgetSimulation(report: MixedCapacityBudgetSimulationReport): string[] {
  const L: string[] = [];
  L.push("   -- MIXED CAPACITY BUDGET SIMULATION (READ-ONLY / REPORT-ONLY) --");
  L.push(
    `   generatedAt=${report.generatedAt} replayMode=${report.replayMode}` +
      ` replayMatched=${report.replayMatchedCount} replayVerdict=${report.opportunityCostVerdict}`,
  );
  L.push(`   recommendedProfile=${report.recommendedProfile} reason=${report.recommendedProfileReason}`);
  L.push(`   baselineWaitCapacityCount=${report.baselineWaitCapacityCount}`);
  for (const p of report.profiles) {
    L.push(
      `      ${p.profile} verdict=${p.verdict}` +
        ` allowed=${p.allowedCount} reduced=${p.reducedCount} wait=${p.waitCapacityCount}` +
        ` recoveredOpp=${p.estimatedRecoveredOpportunities}` +
        ` recoveredNetR=${_fmtMetric(p.estimatedRecoveredNetR, 4)}` +
        ` PF=${_fmtMetric(p.estimatedPF, 2)}` +
        ` WR=${_fmtMetric(p.estimatedWR === null ? null : p.estimatedWR * 100, 1)}%` +
        ` pressure=${_fmtMetric(p.maxBookPressure, 2)}` +
        ` symbolRisk=${_fmtMetric(p.symbolConcentrationRisk, 2)}` +
        ` directionRisk=${_fmtMetric(p.directionConcentrationRisk, 2)}` +
        ` stalePressure=${_fmtMetric(p.stalePressure, 2)}` +
        ` risk=${p.risk}` +
        ` score=${_fmtMetric(p.recommendationScore, 2)}`,
    );
  }
  L.push("   activeGateChange=NO  liveBlocked=TRUE  microPilotAllowed=FALSE");
  return L;
}

// ── forward-monitoring guardrail (WARNING-level; report-only; never auto-rolls-back) ──
const GUARDRAIL_MIN_OOS = 30;
const GUARDRAIL_PF_HEALTHY = 1.5;
const GUARDRAIL_PF_FLOOR = 1.0;
const GUARDRAIL_WR_COLLAPSE = 0.4; // 40% WR floor (informational contributor)
const GUARDRAIL_WAIT_SPIKE_MULT = 2;

export type MixedGuardrailStatus =
  | "COLLECTING_OOS"
  | "HEALTHY"
  | "WARNING"
  | "ROLLBACK_RECOMMENDED"
  | "INSUFFICIENT_DATA";

export type MixedGuardrailReason =
  | "OOS_TOO_SMALL"
  | "PF_BELOW_1"
  | "NETAVG_NEGATIVE"
  | "WR_COLLAPSE"
  | "DRAWDOWN_WARNING"
  | "WAIT_CAPACITY_SPIKE"
  | "PROFILE_HEALTHY";

export type MixedGuardrailRecommendedAction =
  | "KEEP_COLLECTING"
  | "KEEP_PROFILE"
  | "REVIEW_PROFILE"
  | "ROLLBACK_TO_CONSERVATIVE";

export interface MixedBudgetGuardrail {
  status: MixedGuardrailStatus;
  reasons: MixedGuardrailReason[];
  recommendedAction: MixedGuardrailRecommendedAction;
  closedUnderProfileCount: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
  waitCapacityCount: number;
  allowPlusReduced: number;
  waitCapacitySpike: boolean;
  oosThreshold: number;
}

/**
 * Warning-level forward-monitoring guardrail for the active mixed budget profile.
 * Pure / report-only — classifies OOS health and a recommended action but NEVER
 * auto-rolls-back, changes the budget, admission, or any live/headline behavior.
 * DRAWDOWN_WARNING is reserved for when a drawdown field exists (not available yet).
 */
export function buildMixedBudgetGuardrail(input: {
  closedUnderProfileCount: number;
  profileNetAvgR: number | null;
  profilePF: number | null;
  profileWR: number | null;
  newAllowCount: number;
  newAllowReducedCount: number;
  newWaitCapacityCount: number;
}): MixedBudgetGuardrail {
  const n = input.closedUnderProfileCount;
  const net = input.profileNetAvgR;
  const pf = input.profilePF;
  const wr = input.profileWR;
  const allowPlusReduced = (input.newAllowCount ?? 0) + (input.newAllowReducedCount ?? 0);
  const wait = input.newWaitCapacityCount ?? 0;
  const waitCapacitySpike = wait > 0 && wait > GUARDRAIL_WAIT_SPIKE_MULT * allowPlusReduced;

  const reasons: MixedGuardrailReason[] = [];
  let status: MixedGuardrailStatus;
  let recommendedAction: MixedGuardrailRecommendedAction;

  if (n < GUARDRAIL_MIN_OOS) {
    status = "COLLECTING_OOS";
    recommendedAction = "KEEP_COLLECTING";
    reasons.push("OOS_TOO_SMALL");
  } else if (net === null || !Number.isFinite(net) || pf === null) {
    status = "INSUFFICIENT_DATA";
    recommendedAction = "KEEP_COLLECTING";
  } else if (net <= 0 || pf < GUARDRAIL_PF_FLOOR) {
    status = "ROLLBACK_RECOMMENDED";
    recommendedAction = "ROLLBACK_TO_CONSERVATIVE";
    if (net <= 0) reasons.push("NETAVG_NEGATIVE");
    if (pf < GUARDRAIL_PF_FLOOR) reasons.push("PF_BELOW_1");
  } else if (pf <= GUARDRAIL_PF_HEALTHY) {
    status = "WARNING";
    recommendedAction = "REVIEW_PROFILE";
  } else {
    status = "HEALTHY";
    recommendedAction = "KEEP_PROFILE";
    reasons.push("PROFILE_HEALTHY");
  }

  // Informational WR-collapse flag (only meaningful with a matured OOS sample).
  if (n >= GUARDRAIL_MIN_OOS && wr !== null && Number.isFinite(wr) && wr < GUARDRAIL_WR_COLLAPSE) {
    reasons.push("WR_COLLAPSE");
  }

  // Wait-capacity spike elevates non-rollback states to WARNING (never downgrades rollback).
  if (waitCapacitySpike) {
    reasons.push("WAIT_CAPACITY_SPIKE");
    if (status === "HEALTHY" || status === "COLLECTING_OOS" || status === "INSUFFICIENT_DATA") {
      status = "WARNING";
      recommendedAction = "REVIEW_PROFILE";
    }
  }

  return {
    status,
    reasons,
    recommendedAction,
    closedUnderProfileCount: n,
    netAvgR: net,
    pf,
    wr,
    waitCapacityCount: wait,
    allowPlusReduced,
    waitCapacitySpike,
    oosThreshold: GUARDRAIL_MIN_OOS,
  };
}

function _forwardValidationVerdict(args: {
  closedUnderProfileCount: number;
  profileNetAvgR: number | null;
  profilePF: number | null;
}): MixedBudgetForwardValidationVerdict {
  if (args.closedUnderProfileCount < 30) return "NEED_MORE_OOS";
  const pf = args.profilePF ?? 0;
  const net = args.profileNetAvgR ?? 0;
  if (net > 0 && pf > 1.5) return "KEEP_PROFILE";
  if (net <= 0 || pf < 1.0) return "ROLL_BACK_TO_CONSERVATIVE";
  return "MIXED_SIGNAL";
}

export function buildMixedBudgetForwardValidation(
  orders: PaperOrder[],
  generatedAt = new Date().toISOString(),
  activeConfig = getActiveMixedPaperBudgetProfileConfig(),
): MixedBudgetForwardValidationReport {
  const scoped = orders.filter(
    (o) =>
      o.mixedBudgetProfile === activeConfig.activeMixedBudgetProfile &&
      o.budgetActivationScope === MIXED_BUDGET_ACTIVATION_SCOPE,
  );
  const closed = scoped.filter(_isClosedWideOutcome);
  const metrics = _netMetrics(closed);
  const countAdmission = (admission: MixedAdmissionResult) =>
    scoped.filter((o) => o.admissionResult === admission).length;
  const newAllowCount = countAdmission("ALLOW");
  const newAllowReducedCount = countAdmission("ALLOW_REDUCED");
  const newWaitCapacityCount = countAdmission("WAIT_FOR_CAPACITY");
  const guardrail = buildMixedBudgetGuardrail({
    closedUnderProfileCount: closed.length,
    profileNetAvgR: metrics.replayNetAvgR,
    profilePF: metrics.replayPF,
    profileWR: metrics.replayWR,
    newAllowCount,
    newAllowReducedCount,
    newWaitCapacityCount,
  });
  return {
    reportOnly: true,
    diagnosticOnly: true,
    activeGateChange: false,
    liveBlocked: true,
    microPilotAllowed: false,
    generatedAt,
    activeMixedBudgetProfile: activeConfig.activeMixedBudgetProfile,
    budgetSource: activeConfig.budgetSource,
    budgetActivationScope: activeConfig.budgetActivationScope,
    mixedBudgetVersion: activeConfig.mixedBudgetVersion,
    newDecisionsCount: scoped.length,
    newAllowCount,
    newAllowReducedCount,
    newWaitCapacityCount,
    newRejectCount: countAdmission("REJECT"),
    closedUnderProfileCount: closed.length,
    profileNetAvgR: metrics.replayNetAvgR,
    profilePF: metrics.replayPF,
    profileWR: metrics.replayWR,
    profileAvgHoldHours: metrics.avgHoldHours,
    verdict: _forwardValidationVerdict({
      closedUnderProfileCount: closed.length,
      profileNetAvgR: metrics.replayNetAvgR,
      profilePF: metrics.replayPF,
    }),
    guardrail,
  };
}

export function renderMixedBudgetForwardValidation(report: MixedBudgetForwardValidationReport): string[] {
  const L: string[] = [];
  L.push("   -- MIXED BUDGET FORWARD VALIDATION (PAPER-ONLY / READ-ONLY) --");
  L.push(
    `   activeMixedBudgetProfile=${report.activeMixedBudgetProfile}` +
      ` budgetSource=${report.budgetSource}` +
      ` budgetActivationScope=${report.budgetActivationScope}` +
      ` mixedBudgetVersion=${report.mixedBudgetVersion}`,
  );
  L.push(
    `   newDecisionsCount=${report.newDecisionsCount}` +
      ` allow=${report.newAllowCount}` +
      ` allowReduced=${report.newAllowReducedCount}` +
      ` waitCapacity=${report.newWaitCapacityCount}` +
      ` reject=${report.newRejectCount}`,
  );
  L.push(
    `   closedUnderProfileCount=${report.closedUnderProfileCount}` +
      ` profileNetAvgR=${_fmtMetric(report.profileNetAvgR, 4)}` +
      ` profilePF=${_fmtMetric(report.profilePF, 2)}` +
      ` profileWR=${_fmtMetric(report.profileWR === null ? null : report.profileWR * 100, 1)}%` +
      ` profileAvgHoldHours=${_fmtMetric(report.profileAvgHoldHours, 1)}`,
  );
  L.push(`   verdict=${report.verdict}`);
  const g = report.guardrail;
  L.push(
    `   guardrailStatus=${g.status}` +
      ` recommendedAction=${g.recommendedAction}` +
      ` reasons=${g.reasons.length ? g.reasons.join(",") : "none"}`,
  );
  L.push(
    `   guardrail: oosThreshold=${g.oosThreshold}` +
      ` waitCapacitySpike=${g.waitCapacitySpike ? "true" : "false"}` +
      ` waitCapacity=${g.waitCapacityCount} allow+reduced=${g.allowPlusReduced}`,
  );
  L.push("   activeGateChange=NO  liveBlocked=TRUE  microPilotAllowed=FALSE");
  return L;
}

export function renderMixedCapacityOpportunityReplay(report: MixedCapacityOpportunityReplayReport): string[] {
  const L: string[] = [];
  L.push("   -- MIXED WAIT-FOR-CAPACITY OPPORTUNITY REPLAY (READ-ONLY / REPORT-ONLY) --");
  L.push(`   generatedAt=${report.generatedAt} replayMode=${report.replayMode}`);
  L.push(`   matchMethod=${report.matchMethod}`);
  L.push(
    `   waitCapacityCount=${report.waitCapacityCount} matchedReplayCount=${report.matchedReplayCount}` +
      ` exactMatched=${report.exactMatchedCount} proxyCohort=${report.proxyCohortCount} unmatched=${report.unmatchedCount}`,
  );
  L.push(
    `   replayNetAvgR=${_fmtMetric(report.replayNetAvgR, 4)}` +
      ` replayPF=${_fmtMetric(report.replayPF, 2)}` +
      ` replayWR=${_fmtMetric(report.replayWR === null ? null : report.replayWR * 100, 1)}%` +
      ` avgHoldHours=${_fmtMetric(report.avgHoldHours, 1)}`,
  );
  L.push(`   opportunityCostVerdict=${report.opportunityCostVerdict}`);
  L.push(`   selectedWaitSymbols=${report.selectedWaitSymbols.map((s) => `${s.symbol}/${s.direction}`).join(" ") || "none"}`);
  L.push("   activeGateChange=NO  liveBlocked=TRUE  microPilotAllowed=FALSE");
  return L;
}

export function renderMixedAdmissionDecisionLedger(
  report: MixedAdmissionLedgerReport,
  capacityReplay = buildMixedCapacityOpportunityReplay({ ledger: report, orders: [], generatedAt: report.generatedAt }),
  capacityBudgetSimulation?: MixedCapacityBudgetSimulationReport,
): string[] {
  const fmtCounts = (counts: Record<string, number>) =>
    Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v}`).join(" ") || "none";
  const L: string[] = [];
  L.push("   -- MIXED ADMISSION DECISION LEDGER (READ-ONLY / REPORT-ONLY) --");
  L.push(`   generatedAt=${report.generatedAt} source=${report.source} entries=${report.entries.length}`);
  const hypothetical = report.regimeIsMixed === false;
  const admissionMode =
    report.mixedAdmissionMode ?? (hypothetical ? "HYPOTHETICAL_IF_MIXED" : "ACTUAL_MIXED_ADMISSION");
  L.push(
    `   mixedAdmissionMode=${admissionMode}` +
      ` regimeIsMixed=${report.regimeIsMixed === undefined ? "n/a" : report.regimeIsMixed}`,
  );
  if (hypothetical) {
    L.push(
      "   NOTE: current regime is NOT Mixed — these are HYPOTHETICAL admission decisions" +
        " (what the mixed router WOULD decide if regime were Mixed), not active paper admissions.",
    );
  }
  const countLabel = hypothetical ? "hypotheticalByAdmissionResult" : "byAdmissionResult";
  L.push(`   ${countLabel}: ${fmtCounts(report.summary.countByAdmissionResult)}`);
  L.push(`   byOccupancyMode: ${fmtCounts(report.summary.countByOccupancyMode)}`);
  L.push(
    `   passCandidatesLostToCapacity=${report.summary.passCandidatesLostToCapacity}` +
      ` estimatedOpportunityPressure=${report.summary.estimatedOpportunityPressure.toFixed(2)}`,
  );
  L.push(`   topWaitSymbols: ${report.summary.topSymbolsByWaitForCapacity.map((r) => `${r.symbol}=${r.count}`).join(" ") || "none"}`);
  L.push(`   topRejectReasons: ${report.summary.topRejectReasons.map((r) => `${r.reason}=${r.count}`).join(" ") || "none"}`);
  L.push(
    `   capacityReplay: verdict=${capacityReplay.opportunityCostVerdict}` +
      ` mode=${capacityReplay.replayMode}` +
      ` matched=${capacityReplay.matchedReplayCount}` +
      ` netAvgR=${_fmtMetric(capacityReplay.replayNetAvgR, 4)}` +
      ` PF=${_fmtMetric(capacityReplay.replayPF, 2)}` +
      ` WR=${_fmtMetric(capacityReplay.replayWR === null ? null : capacityReplay.replayWR * 100, 1)}%`,
  );
  const recommended = capacityBudgetSimulation?.profiles.find((p) => p.profile === capacityBudgetSimulation.recommendedProfile);
  const current = capacityBudgetSimulation?.profiles.find((p) => p.profile === "CONSERVATIVE_CURRENT");
  L.push(
    `   capacityBudgetSim: recommendedProfile=${capacityBudgetSimulation?.recommendedProfile ?? "n/a"}` +
      ` recoveredNetR=${_fmtMetric(recommended?.estimatedRecoveredNetR ?? null, 4)}` +
      ` waitReduction=${recommended && current ? Math.max(0, current.waitCapacityCount - recommended.waitCapacityCount) : "n/a"}` +
      ` risk=${recommended?.risk ?? "n/a"}`,
  );
  for (const entry of report.entries.slice(0, 20)) {
    const rawGateExplanation =
      entry.rawForwardGateDecision === "REJECT" &&
      (
        entry.mixedRouteDecision === "ROUTE_CG_WIDE" ||
        entry.mixedRouteDecision === "ROUTE_LONG_CG_WIDE"
      )
        ? "RAW_GATE_REJECTED_BUT_MIXED_ROUTER_QUALIFIED"
        : "none";
    const badSignal = entry.admissionResult === "REJECT" ? "YES" : "NO";
    L.push(
      `      ${entry.symbol ?? "UNKNOWN"}/${entry.direction ?? "UNKNOWN"}` +
        ` rawGate=${entry.rawForwardGateDecision}` +
        ` mixedQualified=${entry.mixedQualificationDecision === "QUALIFIED" ? "YES" : "NO"}` +
        ` route=${entry.mixedRouteDecision}` +
        ` admission=${entry.finalAdmissionResult}` +
        ` capacity=${entry.capacityDecision}` +
        ` finalRisk=${entry.finalRiskDecision}:${entry.riskMultiplierAfterOccupancy.toFixed(2)}` +
        ` badSignal=${badSignal}` +
        ` rawGateExplanation=${rawGateExplanation}` +
        ` staleHealth=${entry.stalePassHealth}` +
        ` categories=${entry.reasonCategories.join("|") || "none"}` +
        ` reason=${entry.occupancyReason}`,
    );
  }
  if (report.entries.length > 20) L.push(`      ... +${report.entries.length - 20} more candidates ...`);
  L.push("   activeGateChange=NO  liveBlocked=TRUE  microPilotAllowed=FALSE");
  return L;
}

// 3. OPEN-ORDER STALE AUDIT
// ════════════════════════════════════════════════════════════════════════════

export interface OpenOrderStaleRow {
  symbol: string;
  direction: string;
  openedAt: string;
  holdHours: number | null;
  lane: string;
  currentR: "UNKNOWN"; // not tracked on paper orders
  mfeR: "UNKNOWN";
  maeR: "UNKNOWN";
  distanceToTpR: "UNKNOWN";
  distanceToSlR: "UNKNOWN";
  toxicSymbolFlag: boolean;
  forwardGateDecision: ForwardGateDecision;
  regimeAtEntry: string | null;
  regimeNow: "UNKNOWN";
  mode: string; // HEADLINE / DIAGNOSTIC_ONLY
  staleBucket: StaleBucket;
  routeReasons: string[];
}

export interface OpenOrderStaleAudit {
  reportOnly: true;
  diagnosticOnly: true;
  openOrderCount: number;
  staleWideHoldCount: number;
  criticalCount: number;
  staleRatio: number;
  oldestOpenHoldHours: number | null;
  bySymbol: Record<string, number>;
  byDirection: Record<string, number>;
  byToxicFlag: Record<string, number>;
  byGateDecision: Record<string, number>;
  byLane: Record<string, number>;
  recommendation: StaleRecommendation;
  stalePassHealth: StalePassHealth;
  admissionResult: MixedAdmissionResult;
  occupancyMode: MixedOccupancyMode;
  occupancy: MixedOccupancySnapshot;
  /** Compact closed-order stale-PASS conversion summary (read-only). */
  stalePassSummary: StalePassSummary;
  rows: OpenOrderStaleRow[];
}

function _staleBucket(h: number | null): StaleBucket {
  if (h == null || h < STALE_HOURS) return "FRESH";
  if (h < CRITICAL_HOURS) return "STALE";
  return "CRITICAL";
}
const _bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};

export function buildOpenOrderStaleAudit(orders: PaperOrder[], nowMs: number): OpenOrderStaleAudit {
  const open = orders.filter((o) => OPEN_STATUSES.has(o.paperStatus));
  const backlog = computeMixedBacklog(orders, nowMs);
  const stalePassSummary = buildStalePassCohortDiagnostic(orders).summary;
  const stalePassHealth = classifyStalePassHealth(stalePassSummary);
  const activeBudget = getActiveMixedPaperBudgetProfileConfig().budget;
  const occupancy = computeMixedOccupancySnapshot({ orders, nowMs, budget: activeBudget });
  const occupancyDecision = decideOccupancyAwareAdmission({
    mixedRouteDecision: "ROUTE_CG_WIDE",
    stalePassHealth,
    backlog,
    occupancy,
  });
  const bySymbol: Record<string, number> = {};
  const byDirection: Record<string, number> = {};
  const byToxicFlag: Record<string, number> = {};
  const byGateDecision: Record<string, number> = {};
  const byLane: Record<string, number> = {};

  const rows: OpenOrderStaleRow[] = open.map((o) => {
    const h = Number.isFinite(_holdHours(o, nowMs)) ? _holdHours(o, nowMs) : null;
    const bucket = _staleBucket(h);
    const fg = evaluateForwardGate({ laneId: o.selectedLaneId, regime: o.regime, direction: o.direction, symbol: o.symbol });
    const decision = o.forwardGateDecision ?? fg.forwardGateDecision; // persisted label if present
    if (bucket !== "FRESH") {
      _bump(bySymbol, o.symbol);
      _bump(byDirection, o.direction);
      _bump(byToxicFlag, fg.forwardGateIsToxicSymbol ? "TOXIC" : "NON_TOXIC");
      _bump(byGateDecision, decision);
      _bump(byLane, o.selectedLaneId);
    }
    return {
      symbol: o.symbol,
      direction: o.direction,
      openedAt: o.openedAt,
      holdHours: h == null ? null : Math.round(h * 10) / 10,
      lane: o.selectedLaneId,
      currentR: "UNKNOWN",
      mfeR: "UNKNOWN",
      maeR: "UNKNOWN",
      distanceToTpR: "UNKNOWN",
      distanceToSlR: "UNKNOWN",
      toxicSymbolFlag: fg.forwardGateIsToxicSymbol,
      forwardGateDecision: decision,
      regimeAtEntry: o.regime ?? null,
      regimeNow: "UNKNOWN",
      mode: o.paperOrderMode ?? "HEADLINE",
      staleBucket: bucket,
      routeReasons: o.forwardGateReasons ?? fg.forwardGateReasons,
    };
  });
  rows.sort((a, b) => (b.holdHours ?? 0) - (a.holdHours ?? 0));

  return {
    reportOnly: true,
    diagnosticOnly: true,
    openOrderCount: backlog.openOrderCount,
    staleWideHoldCount: backlog.staleWideHoldCount,
    criticalCount: backlog.criticalCount,
    staleRatio: backlog.staleRatio,
    oldestOpenHoldHours: backlog.oldestOpenHoldHours,
    bySymbol,
    byDirection,
    byToxicFlag,
    byGateDecision,
    byLane,
    recommendation: _staleRecommendation(backlog),
    stalePassHealth,
    admissionResult: occupancyDecision.admissionResult,
    occupancyMode: occupancyDecision.occupancyMode,
    occupancy,
    stalePassSummary,
    rows,
  };
}

export function buildOpenOrderStaleAuditBriefLines(a: OpenOrderStaleAudit): string[] {
  const L: string[] = [];
  L.push("   ── OPEN-ORDER STALE AUDIT (DIAGNOSTIC — report-only) ──");
  L.push(
    `   openOrderCount=${a.openOrderCount} staleWideHold=${a.staleWideHoldCount} critical=${a.criticalCount}` +
      ` staleRatio=${a.staleRatio.toFixed(2)} oldestOpenHold=${a.oldestOpenHoldHours == null ? "n/a" : a.oldestOpenHoldHours.toFixed(1) + "h"}` +
      `  recommendation=${a.recommendation}`,
  );
  L.push(
    `   stalePassHealth=${a.stalePassHealth} admissionResult=${a.admissionResult} occupancyMode=${a.occupancyMode}` +
      ` exceeded=${a.occupancy.exceeded.join(",") || "none"} elevated=${a.occupancy.elevated.join(",") || "none"}`,
  );
  L.push(
    `   occupancyBudget: scopedWideOpen=${a.occupancy.wideOpenCount}/${a.occupancy.budget.maxWideOpen}` +
      ` rawWideOpen=${a.occupancy.rawWideOpenCount ?? a.occupancy.wideOpenCount}` +
      ` excludedDiagnostic=${a.occupancy.excludedDiagnosticOpenCount ?? 0}` +
      ` wideStale=${a.occupancy.wideStaleCount}/${a.occupancy.budget.maxWideStale}` +
      ` passStaleShare=${a.occupancy.passStaleShare.toFixed(2)}/${a.occupancy.budget.maxPassStaleShare.toFixed(2)}` +
      ` perSymbol=${a.occupancy.budget.maxPerSymbolOpen} perDirection=${a.occupancy.budget.maxPerDirectionOpen}`,
  );
  const top = (m: Record<string, number>) =>
    Object.entries(m).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}=${v}`).join(" ") || "none";
  L.push(`   stale byLane: ${top(a.byLane)}`);
  L.push(`   stale byDirection: ${top(a.byDirection)}  byToxic: ${top(a.byToxicFlag)}  byGate: ${top(a.byGateDecision)}`);
  L.push(`   stale bySymbol: ${top(a.bySymbol)}`);
  for (const r of a.rows.slice(0, 12)) {
    L.push(
      `      ${r.symbol}/${r.direction}/${r.lane.replace("CG_VARIANT_MATRIX:", "")} hold=${r.holdHours == null ? "n/a" : r.holdHours + "h"}` +
        ` ${r.staleBucket} gate=${r.forwardGateDecision} toxic=${r.toxicSymbolFlag} mode=${r.mode} regime@entry=${r.regimeAtEntry ?? "n/a"}` +
        ` currentR=${r.currentR} MFE=${r.mfeR} dToTP=${r.distanceToTpR}`,
    );
  }
  if (a.rows.length > 12) L.push(`      … +${a.rows.length - 12} more open orders …`);
  const sp = a.stalePassSummary;
  L.push(
    `   stalePassCohort(closed): verdict=${sp.verdict} freshPassN=${sp.freshPassN} stalePassN=${sp.stalePassN}` +
      ` freshPassNetAvgR=${sp.freshPassNetAvgR == null ? "n/a" : sp.freshPassNetAvgR.toFixed(4)}` +
      ` stalePassNetAvgR=${sp.stalePassNetAvgR == null ? "n/a" : sp.stalePassNetAvgR.toFixed(4)}` +
      ` stalePassPF=${sp.stalePassPF == null ? "n/a" : Number.isFinite(sp.stalePassPF) ? sp.stalePassPF.toFixed(2) : "inf"}`,
  );
  return L;
}

// ════════════════════════════════════════════════════════════════════════════
// 4. CG_WIDE vs CG_TRAIL MIXED-LANE COMPARISON
// ════════════════════════════════════════════════════════════════════════════

export type MixedLaneRecommendation =
  | "KEEP_WIDE_CORE"
  | "TRAIL_AS_THROUGHPUT_CHALLENGER"
  | "NEED_MORE_DATA"
  | "DO_NOT_PROMOTE_TRAIL";

export interface LaneCohortStats {
  laneId: string;
  closed: number;
  netAvgR: number | null;
  sumR: number;
  pf: number | null;
  wr: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  medianHoldHours: number | null;
  p90HoldHours: number | null;
  p95HoldHours: number | null;
  toxicExposureShare: number | null;
  passShare: number | null; // share whose forward gate would PASS
  staleContribution: number; // closed orders that ran ≥ STALE_HOURS
}

export interface MixedLaneComparison {
  reportOnly: true;
  diagnosticOnly: true;
  scope: "MIXED_ONLY" | "ALL";
  wide: LaneCohortStats;
  trail: LaneCohortStats;
  recommendation: MixedLaneRecommendation;
  recommendationReason: string;
}

function _laneStats(orders: PaperOrder[], laneId: string): LaneCohortStats {
  const closed = orders.filter(
    (o) => o.selectedLaneId === laneId && CLOSED_STATUSES.has(o.paperStatus) && typeof o.netR === "number" && Number.isFinite(o.netR),
  );
  const nets = closed.map((o) => o.netR!);
  const e = _econ(nets);
  const wins = nets.filter((v) => v > 0);
  const losses = nets.filter((v) => v < 0);
  const holds = closed.map((o) => _closedHoldHours(o)).filter((v) => Number.isFinite(v));
  const toxic = closed.filter(
    (o) => evaluateForwardGate({ laneId: o.selectedLaneId, regime: o.regime, direction: o.direction, symbol: o.symbol }).forwardGateIsToxicSymbol,
  ).length;
  const pass = closed.filter(
    (o) => evaluateForwardGate({ laneId: o.selectedLaneId, regime: o.regime, direction: o.direction, symbol: o.symbol }).forwardGateDecision === "PASS",
  ).length;
  return {
    laneId,
    closed: e.n,
    netAvgR: e.netAvgR,
    sumR: e.sumR,
    pf: e.pf,
    wr: e.wr,
    avgWinR: wins.length ? wins.reduce((s, v) => s + v, 0) / wins.length : null,
    avgLossR: losses.length ? losses.reduce((s, v) => s + v, 0) / losses.length : null,
    medianHoldHours: _pct(holds, 0.5),
    p90HoldHours: _pct(holds, 0.9),
    p95HoldHours: _pct(holds, 0.95),
    toxicExposureShare: e.n ? toxic / e.n : null,
    passShare: e.n ? pass / e.n : null,
    staleContribution: holds.filter((h) => h >= STALE_HOURS).length,
  };
}

export function buildMixedLaneComparison(orders: PaperOrder[], opts: { scope?: "MIXED_ONLY" | "ALL" } = {}): MixedLaneComparison {
  const scope = opts.scope ?? "ALL";
  const scoped = scope === "MIXED_ONLY" ? orders.filter((o) => _isMixed(o.regime)) : orders;
  const wide = _laneStats(scoped, CG_WIDE_LANE);
  const trail = _laneStats(scoped, CG_TRAIL_LANE);

  let recommendation: MixedLaneRecommendation;
  let recommendationReason: string;
  const MIN = 20;
  if (trail.closed < MIN) {
    recommendation = "NEED_MORE_DATA";
    recommendationReason = `CG_TRAIL closed=${trail.closed} < ${MIN}: no admissible trail history to compare yet`;
  } else if (wide.closed < MIN) {
    recommendation = "NEED_MORE_DATA";
    recommendationReason = `CG_WIDE closed=${wide.closed} < ${MIN} in scope`;
  } else if ((trail.netAvgR ?? -Infinity) >= (wide.netAvgR ?? -Infinity) - 0.05 && (trail.medianHoldHours ?? Infinity) < (wide.medianHoldHours ?? Infinity)) {
    recommendation = "TRAIL_AS_THROUGHPUT_CHALLENGER";
    recommendationReason = "CG_TRAIL preserves ~expectancy with shorter holds — viable throughput challenger (not a replacement)";
  } else if ((trail.netAvgR ?? -Infinity) < (wide.netAvgR ?? -Infinity) - 0.2) {
    recommendation = "DO_NOT_PROMOTE_TRAIL";
    recommendationReason = "CG_TRAIL expectancy materially below CG_WIDE";
  } else {
    recommendation = "KEEP_WIDE_CORE";
    recommendationReason = "CG_WIDE remains the core; CG_TRAIL not clearly better";
  }

  return { reportOnly: true, diagnosticOnly: true, scope, wide, trail, recommendation, recommendationReason };
}

export function buildMixedLaneComparisonBriefLines(c: MixedLaneComparison): string[] {
  const fmt = (s: LaneCohortStats) =>
    `closed=${s.closed} net=${s.netAvgR == null ? "n/a" : s.netAvgR.toFixed(4)} PF=${s.pf == null ? "n/a" : Number.isFinite(s.pf) ? s.pf.toFixed(2) : "inf"}` +
    ` WR=${s.wr == null ? "n/a" : (s.wr * 100).toFixed(1) + "%"} medHold=${s.medianHoldHours == null ? "n/a" : s.medianHoldHours.toFixed(1) + "h"}` +
    ` p90=${s.p90HoldHours == null ? "n/a" : s.p90HoldHours.toFixed(1) + "h"} toxicShare=${s.toxicExposureShare == null ? "n/a" : (s.toxicExposureShare * 100).toFixed(0) + "%"}`;
  return [
    `   ── MIXED LANE COMPARISON: CG_WIDE vs CG_TRAIL_AFTER_TP1 (scope=${c.scope}, DIAGNOSTIC) ──`,
    `   CG_WIDE : ${fmt(c.wide)}`,
    `   CG_TRAIL: ${fmt(c.trail)}`,
    `   recommendation=${c.recommendation}  (${c.recommendationReason})`,
  ];
}

// ════════════════════════════════════════════════════════════════════════════
// 5. STALE-PASS COHORT DIAGNOSTIC (closed CG_WIDE; benign occupancy vs deterioration)
// ════════════════════════════════════════════════════════════════════════════
//
// Resolves the open risk question from the stale audit: are STALE (≥30h) PASS-gated
// CG_WIDE trades benign swing occupancy, or do they deteriorate after holding long?
// Pure read over CLOSED orders only — never mutates, never gates, never goes live.

const STALE_PASS_MIN_SAMPLE = 20;

export type StalePassVerdict =
  | "INSUFFICIENT"
  | "BENIGN_OCCUPANCY"
  | "TAIL_DETERIORATION"
  | "MIXED_SIGNAL";

export interface StalePassCohortStats {
  bucket: string;
  n: number;
  netR: number; // sum
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
  avgHoldHours: number | null;
  medianHoldHours: number | null;
  p90HoldHours: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  grossProfitR: number;
  grossLossR: number;
}

export interface StalePassSummary {
  verdict: StalePassVerdict;
  freshPassN: number;
  stalePassN: number;
  freshPassNetAvgR: number | null;
  stalePassNetAvgR: number | null;
  stalePassPF: number | null;
  conversionRatio: number | null; // stalePassNetAvgR / freshPassNetAvgR
}

export interface StalePassCohortDiagnostic {
  reportOnly: true;
  diagnosticOnly: true;
  activeGateChange: false;
  sourceLane: string;
  staleThresholdHours: number;
  cohorts: Record<string, StalePassCohortStats>; // FRESH_PASS, STALE_PASS, FRESH_REJECT, …
  stalePassConversionRatio: number | null;
  verdict: StalePassVerdict;
  summary: StalePassSummary;
}

function _emptyStalePassSummary(): StalePassSummary {
  return {
    verdict: "INSUFFICIENT",
    freshPassN: 0,
    stalePassN: 0,
    freshPassNetAvgR: null,
    stalePassNetAvgR: null,
    stalePassPF: null,
    conversionRatio: null,
  };
}

function _stalePassCohortStats(bucket: string, orders: PaperOrder[]): StalePassCohortStats {
  const nets = orders.map((o) => o.netR!).filter((v) => Number.isFinite(v));
  const e = _econ(nets);
  const wins = nets.filter((v) => v > 0);
  const losses = nets.filter((v) => v < 0);
  const holds = orders.map((o) => _closedHoldHours(o)).filter((v) => Number.isFinite(v));
  return {
    bucket,
    n: e.n,
    netR: e.sumR,
    netAvgR: e.netAvgR,
    pf: e.pf,
    wr: e.wr,
    avgHoldHours: holds.length ? holds.reduce((s, v) => s + v, 0) / holds.length : null,
    medianHoldHours: _pct(holds, 0.5),
    p90HoldHours: _pct(holds, 0.9),
    avgWinR: wins.length ? wins.reduce((s, v) => s + v, 0) / wins.length : null,
    avgLossR: losses.length ? losses.reduce((s, v) => s + v, 0) / losses.length : null,
    grossProfitR: wins.reduce((s, v) => s + v, 0),
    grossLossR: losses.reduce((s, v) => s + v, 0),
  };
}

/**
 * Pure read-only stale-PASS cohort diagnostic over CLOSED CG_WIDE paper orders.
 * Buckets by forward-gate decision × hold-time (FRESH <30h / STALE ≥30h).
 */
export function buildStalePassCohortDiagnostic(orders: PaperOrder[]): StalePassCohortDiagnostic {
  const closed = orders.filter(
    (o) =>
      o.selectedLaneId === CG_WIDE_LANE &&
      CLOSED_STATUSES.has(o.paperStatus) &&
      typeof o.netR === "number" &&
      Number.isFinite(o.netR),
  );

  const groups: Record<string, PaperOrder[]> = {
    FRESH_PASS: [],
    STALE_PASS: [],
    FRESH_REJECT: [],
    STALE_REJECT: [],
    FRESH_OTHER: [],
    STALE_OTHER: [],
  };
  for (const o of closed) {
    const decision =
      o.forwardGateDecision ??
      evaluateForwardGate({ laneId: o.selectedLaneId, regime: o.regime, direction: o.direction, symbol: o.symbol })
        .forwardGateDecision;
    const hold = _closedHoldHours(o);
    const ageTag = Number.isFinite(hold) && hold >= STALE_HOURS ? "STALE" : "FRESH";
    const decTag = decision === "PASS" ? "PASS" : decision === "REJECT" ? "REJECT" : "OTHER";
    groups[`${ageTag}_${decTag}`]!.push(o);
  }

  const cohorts: Record<string, StalePassCohortStats> = {};
  for (const [k, arr] of Object.entries(groups)) cohorts[k] = _stalePassCohortStats(k, arr);

  const fp = cohorts.FRESH_PASS!;
  const sp = cohorts.STALE_PASS!;
  const conversionRatio =
    fp.netAvgR != null && fp.netAvgR !== 0 && sp.netAvgR != null ? sp.netAvgR / fp.netAvgR : null;

  let verdict: StalePassVerdict;
  if (sp.n < STALE_PASS_MIN_SAMPLE || fp.n < STALE_PASS_MIN_SAMPLE) {
    verdict = "INSUFFICIENT";
  } else {
    const detPF = sp.pf != null && Number.isFinite(sp.pf) && sp.pf < 1.0;
    const detNet = fp.netAvgR != null && fp.netAvgR > 0 && sp.netAvgR != null && sp.netAvgR < 0.5 * fp.netAvgR;
    const detWR = fp.wr != null && sp.wr != null && fp.wr - sp.wr >= 0.2;
    if (detPF || detNet) verdict = "TAIL_DETERIORATION";
    else if (sp.netAvgR != null && sp.netAvgR > 0 && !detWR) verdict = "BENIGN_OCCUPANCY";
    else verdict = "MIXED_SIGNAL";
  }

  return {
    reportOnly: true,
    diagnosticOnly: true,
    activeGateChange: false,
    sourceLane: CG_WIDE_LANE,
    staleThresholdHours: STALE_HOURS,
    cohorts,
    stalePassConversionRatio: conversionRatio,
    verdict,
    summary: {
      verdict,
      freshPassN: fp.n,
      stalePassN: sp.n,
      freshPassNetAvgR: fp.netAvgR,
      stalePassNetAvgR: sp.netAvgR,
      stalePassPF: sp.pf,
      conversionRatio,
    },
  };
}

export function renderStalePassCohortDiagnostic(d: StalePassCohortDiagnostic): string[] {
  const fmtPf = (v: number | null) => (v == null ? "n/a" : Number.isFinite(v) ? v.toFixed(2) : "inf");
  const fmtN = (v: number | null) => (v == null ? "n/a" : v.toFixed(4));
  const fmtH = (v: number | null) => (v == null ? "n/a" : v.toFixed(1) + "h");
  const row = (c: StalePassCohortStats) =>
    `${c.bucket}: n=${c.n} netAvgR=${fmtN(c.netAvgR)} sumR=${fmtN(c.netR)} PF=${fmtPf(c.pf)} WR=${c.wr == null ? "n/a" : (c.wr * 100).toFixed(1) + "%"}` +
    ` avgHold=${fmtH(c.avgHoldHours)} medHold=${fmtH(c.medianHoldHours)} p90=${fmtH(c.p90HoldHours)}` +
    ` avgWin=${fmtN(c.avgWinR)} avgLoss=${fmtN(c.avgLossR)} gProfit=${fmtN(c.grossProfitR)} gLoss=${fmtN(c.grossLossR)}`;
  const L: string[] = [];
  L.push("   ── STALE-PASS COHORT DIAGNOSTIC (DIAGNOSTIC — closed CG_WIDE only, report-only) ──");
  L.push(`   verdict=${d.verdict}  stalePassConversion=${d.stalePassConversionRatio == null ? "n/a" : d.stalePassConversionRatio.toFixed(2)}  staleThreshold=${d.staleThresholdHours}h`);
  // headline cohorts first
  for (const k of ["FRESH_PASS", "STALE_PASS", "FRESH_REJECT", "STALE_REJECT", "FRESH_OTHER", "STALE_OTHER"]) {
    L.push(`      ${row(d.cohorts[k]!)}`);
  }
  L.push(`   activeGateChange=NO  liveBlocked=TRUE  microPilotAllowed=FALSE`);
  return L;
}

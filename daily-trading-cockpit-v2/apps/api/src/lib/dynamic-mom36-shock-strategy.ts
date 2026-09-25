import type { ThreeLegAudit } from "./dynamic-three-leg-fallback.js";
/**
 * Dynamic MOM36 Shock 36h policy.
 *
 * This module deliberately owns only deterministic strategy mechanics:
 *
 * - MOM36 sign breadth chooses the base 6L0S ... 0L6S allocation;
 * - MOM36 ranking chooses the symbols;
 * - a frozen shock mapping may move at most one allocation rung or veto;
 * - when no frozen runtime mapping exists, the overlay is explicitly NO_EDGE.
 *
 * It does not fetch data, train a model, or inspect historical outcomes.  Keeping it pure is what
 * lets TESTNET and LIVE make the exact same decision from the same snapshot.
 */
import { clusterOf, isMajorCluster } from "./correlation-clusters.js";
import type { DynamicMom36ContinuationRuntimeResult } from "./dynamic-mom36-continuation-runtime.js";
import {
  DYNAMIC_MOM36_SLOW_FAST_FAST_BARS,
  DYNAMIC_MOM36_SLOW_FAST_IMPLEMENTATION_VERSION,
  DYNAMIC_MOM36_SLOW_FAST_INTERVAL,
  DYNAMIC_MOM36_SLOW_FAST_POLICY_ID,
  DYNAMIC_MOM36_SLOW_FAST_SLOW_BARS,
  evaluateDynamicMom36SlowFast,
  type DynamicMom36SlowFastDirection,
} from "./dynamic-mom36-slowfast.js";

export const DYNAMIC_MOM36_SHOCK_36H_V1 = "dynamic-mom36-shock-36h-v1" as const;
export const DYNAMIC_MOM36_CONTINUATION_SL2_MFE30_36H_V3 =
  "dynamic-mom36-continuation-sl2-mfe30-36h-v3" as const;
export const DYNAMIC_MOM36_CONTINUATION_SLOWFAST_SL2_MFE30_36H_V4 =
  "dynamic-mom36-cont-slowfast-sl2-mfe30-36h-v4" as const;
/**
 * V5 keeps the same continuation, score-gap, cluster, and exit contract as V4, but treats the
 * recovered SLOW_AND_FAST predicate as a selection preference.  A complete raw V3 selection from
 * the exact same frozen snapshot is used only when the strict selection cannot fill all six legs.
 */
export const DYNAMIC_MOM36_CONTINUATION_SLOWFAST_PREFERRED_SL2_MFE30_36H_V5 =
  "dynamic-mom36-cont-slowfast-prefer-sl2-mfe30-36h-v5" as const;
/**
 * V6 preserves V4's strict SLOW_AND_FAST leg gate. When the requested breadth allocation cannot
 * fill, it may move only farther toward the already-established directional prior and only when a
 * complete six-leg, strict-and-executable allocation exists on the same frozen snapshot.
 */
export const DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_SL2_MFE30_36H_V6 =
  "dynamic-mom36-cont-slowfast-feasibility-sl2-mfe30-36h-v6" as const;
/**
 * V6.1 keeps V6's strict directional-feasibility resolver unchanged, but freezes the repair
 * that makes admission evaluate the exact resolved final allocation rather than a synthetic
 * 3L/3S probe.  It is a new strategy identity because a valid one-sided 6L0S/0L6S formation may
 * now be admitted when every other guard passes.
 */
export const DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1 =
  "dynamic-mom36-cont-slowfast-feasibility-final-admission-sl2-mfe30-36h-v6.1" as const;
/**
 * V6.2 preserves V6.1's final-plan admission semantics, then adds a policy-scoped quality check
 * ONLY to final 6L0S/0L6S directional baskets. Two-sided V6 allocations remain byte-for-byte on
 * their established admission path.
 */
export const DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_ONE_SIDED_DIRECTIONAL_QUALITY_SL2_MFE30_36H_V6_2 =
  "dynamic-mom36-cont-slowfast-feasibility-one-sided-directional-quality-sl2-mfe30-36h-v6.2" as const;
/**
 * V6.3 keeps V6.2's one-sided directional-quality admission unchanged.  It only corrects
 * MOM36 zero handling: zero is neutral telemetry, so observed positive/negative breadth retains
 * its Dynamic allocation instead of being replaced by a synthetic 3L3S basket.
 */
export const DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_ZERO_NEUTRAL_BREADTH_ONE_SIDED_DIRECTIONAL_QUALITY_SL2_MFE30_36H_V6_3 =
  "dynamic-mom36-cont-slowfast-feasibility-zero-neutral-breadth-one-sided-directional-quality-sl2-mfe30-36h-v6.3" as const;
/**
 * V6.4 retains the exact MOM36/Slow+Fast/score-gap contract, but makes the permitted final
 * allocation geometry an explicit runtime policy.  A constrained policy may cap skew at 4L2S or
 * 2L4S; when strict opposite-side legs are unavailable, it holds rather than borrowing an
 * unaligned leg or escalating to 5L1S/6L0S.
 */
export const DYNAMIC_MOM36_CONTINUATION_SLOWFAST_BOUNDED_SKEW_SL2_MFE30_36H_V6_4 =
  "dynamic-mom36-cont-slowfast-bounded-skew-sl2-mfe30-36h-v6.4" as const;
/**
 * V6.5 preserves V6.4's exact MOM36, strict Slow+Fast, final-plan admission,
 * hard-cut, MFE trail, and 36h contract. Testnet alone may widen its explicit
 * two-sided geometry fence to 1L5S..5L1S; it still cannot form 0L6S/6L0S.
 */
export const DYNAMIC_MOM36_CONTINUATION_SLOWFAST_TESTNET_WIDE_SKEW_SL2_MFE30_36H_V6_5 =
  "dynamic-mom36-cont-slowfast-testnet-wide-skew-sl2-mfe30-36h-v6.5" as const;
export const DYNAMIC_MOM36_SHOCK_SIGNAL = "DYNAMIC_MOM36_SHOCK_36H" as const;
export const DYNAMIC_MOM36_SHOCK_VARIANT = "DYNAMIC_MOM36_SHOCK" as const;
export const DYNAMIC_MOM36_LOOKBACK_BARS = 36 as const;
export const DYNAMIC_MOM36_HORIZON_HOURS = 36 as const;
export const DYNAMIC_MOM36_HORIZON_MS = DYNAMIC_MOM36_HORIZON_HOURS * 3_600_000;
export const DYNAMIC_MOM36_DIRECTION_DEADBAND = 0.05 as const;
export const DYNAMIC_MOM36_PERSISTENCE_DEADBAND = 0.05 as const;
export const DYNAMIC_MOM36_CONFIRM_MIN_VOTES = 3 as const;
export const DYNAMIC_MOM36_LOW_REVERSAL_RISK = 0.25 as const;
export const DYNAMIC_MOM36_HIGH_REVERSAL_RISK = 0.50 as const;
export const DYNAMIC_MOM36_HARD_CUT_LOSS = -0.02 as const;
export const DYNAMIC_MOM36_MFE_ARM_THRESHOLD = 0.03 as const;
export const DYNAMIC_MOM36_MFE_GIVEBACK_FRACTION = 0.30 as const;
export const DYNAMIC_MOM36_MFE_TRAILING_FRACTION = 1 - DYNAMIC_MOM36_MFE_GIVEBACK_FRACTION;

export type DynamicMom36StrategyVersion =
  | typeof DYNAMIC_MOM36_SHOCK_36H_V1
  | typeof DYNAMIC_MOM36_CONTINUATION_SL2_MFE30_36H_V3
  | typeof DYNAMIC_MOM36_CONTINUATION_SLOWFAST_SL2_MFE30_36H_V4
  | typeof DYNAMIC_MOM36_CONTINUATION_SLOWFAST_PREFERRED_SL2_MFE30_36H_V5
  | typeof DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_SL2_MFE30_36H_V6
  | typeof DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1
  | typeof DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_ONE_SIDED_DIRECTIONAL_QUALITY_SL2_MFE30_36H_V6_2
  | typeof DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_ZERO_NEUTRAL_BREADTH_ONE_SIDED_DIRECTIONAL_QUALITY_SL2_MFE30_36H_V6_3
  | typeof DYNAMIC_MOM36_CONTINUATION_SLOWFAST_BOUNDED_SKEW_SL2_MFE30_36H_V6_4
  | typeof DYNAMIC_MOM36_CONTINUATION_SLOWFAST_TESTNET_WIDE_SKEW_SL2_MFE30_36H_V6_5;

/** There is intentionally no synthetic or trainable fallback model. */
export const NO_FROZEN_RUNTIME_SHOCK_ARTIFACT = "NO_FROZEN_RUNTIME_SHOCK_MAPPING" as const;

export type DynamicMom36ShockState =
  | "NO_EDGE"
  | "CONFIRM_LONG"
  | "CONFIRM_SHORT"
  | "CONFLICT_LONG"
  | "CONFLICT_SHORT"
  | "VETO";

export const DYNAMIC_MOM36_ALLOCATION_LABELS = ["0L6S", "1L5S", "2L4S", "3L3S", "4L2S", "5L1S", "6L0S"] as const;
export type DynamicMom36AllocationLabel = typeof DYNAMIC_MOM36_ALLOCATION_LABELS[number];
export const DYNAMIC_MOM36_ALL_ALLOWED_LONG_COUNTS = [0, 1, 2, 3, 4, 5, 6] as const;

export type DynamicMom36Allocation = {
  longCount: number;
  shortCount: number;
  label: DynamicMom36AllocationLabel | "3L0S" | "0L3S";
};

export type DynamicMom36AllocationPolicy = {
  configured: string | null;
  allowedLongCounts: number[];
  allowedAllocations: DynamicMom36AllocationLabel[];
  valid: boolean;
  reason: string | null;
};

/**
 * Parses a closed six-leg geometry policy without inventing a numeric signal threshold.  Omitted
 * configuration retains the historical 0L6S..6L0S behaviour; a malformed configured value is
 * explicitly invalid so the caller can fail closed instead of silently widening allocation.
 */
export function dynamicMom36AllocationPolicy(raw: string | undefined): DynamicMom36AllocationPolicy {
  const configured = raw?.trim() || null;
  if (!configured) {
    return {
      configured: null,
      allowedLongCounts: [...DYNAMIC_MOM36_ALL_ALLOWED_LONG_COUNTS],
      allowedAllocations: [...DYNAMIC_MOM36_ALLOCATION_LABELS],
      valid: true,
      reason: null,
    };
  }
  const longCounts = new Set<number>();
  for (const token of configured.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean)) {
    const match = /^(\d)L(\d)S$/.exec(token);
    if (!match) {
      return { configured, allowedLongCounts: [], allowedAllocations: [], valid: false, reason: `invalid allocation token: ${token}` };
    }
    const longCount = Number(match[1]);
    const shortCount = Number(match[2]);
    if (!Number.isInteger(longCount) || !Number.isInteger(shortCount) || longCount < 0 || shortCount < 0 || longCount + shortCount !== 6) {
      return { configured, allowedLongCounts: [], allowedAllocations: [], valid: false, reason: `allocation must total six legs: ${token}` };
    }
    longCounts.add(longCount);
  }
  const allowedLongCounts = [...longCounts].sort((a, b) => a - b);
  if (!allowedLongCounts.length) {
    return { configured, allowedLongCounts: [], allowedAllocations: [], valid: false, reason: "at least one allocation is required" };
  }
  return {
    configured,
    allowedLongCounts,
    allowedAllocations: allowedLongCounts.map((longCount) => DYNAMIC_MOM36_ALLOCATION_LABELS[longCount]!),
    valid: true,
    reason: null,
  };
}

export type DynamicMom36RankedSymbol = {
  symbol: string;
  mom36: number;
  price: number;
  volatility: number | null;
  fastReturn: number | null;
  /** 1h price return, same numerator and cutoff as fastReturn. Recent-strength preference only. */
  oneHourReturn?: number | null;
  oneHourStartTimestampMs?: number | null;
  extensionVol: number | null;
  /** Existing production pool / long eligibility, not an alpha score. */
  longEligible: boolean;
  /** Existing execution eligibility after the short blocklist and current guards. */
  shortEligible: boolean;
  /** Kept separate so a blocked name remains visible in breadth and ranking audit. */
  shortBlocked: boolean;
  /** Explicit current-guard reason for audit; selection still relies on the existing booleans. */
  longExecutionBlockReason?: DynamicMom36ExecutionBlockReason | null;
  /** Explicit current-guard reason for audit; selection still relies on the existing booleans. */
  shortExecutionBlockReason?: DynamicMom36ExecutionBlockReason | null;
  /** Fully closed source-bar timestamps for the strict slow/fast audit trail. */
  slowSourceTimestampMs?: number | null;
  slowStartTimestampMs?: number | null;
  fastSourceTimestampMs?: number | null;
  fastStartTimestampMs?: number | null;
  /** Caller marks false when a source is stale/future for its decision cut; undefined preserves old v1/v3 fixtures. */
  slowFastDataValid?: boolean | null;
};

export type DynamicMom36ExecutionBlockReason =
  | "SHORT_BLOCKED"
  | "LOSS_REENTRY_GUARD"
  /** A testnet-only isolated lane has a durable one-way-netting lease on this symbol. */
  | "SYMBOL_OWNED_BY_DAILY_RANGE"
  | "SYMBOL_RELIABILITY_GUARD"
  | "EXECUTION_GUARD_UNAVAILABLE"
  | "EXECUTION_INELIGIBLE";

export type FrozenShockOverlay = {
  modelArtifactId: string;
  available: boolean;
  state: DynamicMom36ShockState;
  /** Preserved verbatim as JSON-safe data for the formation snapshot. */
  rawOutput: Record<string, unknown>;
  reason: string | null;
  /** VETO is legal only when the frozen mapping explicitly marks it as such. */
  vetoAllowed: boolean;
};

export type DynamicMom36ContinuationVote = "BULLISH" | "BEARISH" | "NEUTRAL";
export type DynamicMom36PersistenceDirection = "PERSIST_UP" | "PERSIST_DOWN" | "PERSIST_NEUTRAL";
export type DynamicMom36ContinuationDecision = "NO_EDGE" | "CONFIRM_LONG" | "CONFIRM_SHORT" | "CONFLICT_LONG" | "CONFLICT_SHORT";
export type DynamicMom36ReversalRiskBand = "LOW" | "MODERATE" | "HIGH";

export type FrozenContinuationOverlay = {
  continuationArtifactId: string;
  artifactSha256: string | null;
  schemaVersion: number | null;
  featureVersion: string | null;
  calibrationVersion: string | null;
  runtimeFunction: string | null;
  available: boolean;
  reason: string | null;
  featureAtMs: number | null;
  horizons: Array<{
    horizon: 6 | 12 | 24 | 36;
    pUp: number;
    pNeutral: number;
    pDown: number;
    directionMargin: number;
    vote: DynamicMom36ContinuationVote;
  }>;
  bullVotes: number;
  bearVotes: number;
  neutralVotes: number;
  agreementScore: number | null;
  persistenceScore: number | null;
  persistenceDirection: DynamicMom36PersistenceDirection;
  topPath: string | null;
  pathProbabilities: Record<string, number>;
  reversalRisk: number | null;
  reversalRiskBand: DynamicMom36ReversalRiskBand | null;
  decision: DynamicMom36ContinuationDecision;
  rawOutput: Record<string, unknown>;
};

const SHOCK_STATES = new Set<DynamicMom36ShockState>([
  "NO_EDGE",
  "CONFIRM_LONG",
  "CONFIRM_SHORT",
  "CONFLICT_LONG",
  "CONFLICT_SHORT",
  "VETO",
]);

function jsonSafeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value };
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number" && !Number.isFinite(item)) result[key] = String(item);
    else if (item && typeof item === "object" && !Array.isArray(item)) result[key] = jsonSafeRecord(item);
    else result[key] = item;
  }
  return result;
}

function noEdgeShockOverlay(reason: string, raw: unknown, modelArtifactId: string = NO_FROZEN_RUNTIME_SHOCK_ARTIFACT): FrozenShockOverlay {
  return {
    modelArtifactId,
    available: false,
    state: "NO_EDGE",
    rawOutput: jsonSafeRecord(raw),
    reason,
    vetoAllowed: false,
  };
}

const CONTINUATION_HORIZONS = [6, 12, 24, 36] as const;
const BULLISH_PERSISTENT_PATHS = new Set(["PERSISTENT_UP", "EARLY_UP_THEN_FLAT"]);
const BEARISH_PERSISTENT_PATHS = new Set(["PERSISTENT_DOWN", "EARLY_DOWN_THEN_FLAT"]);
const NO_FROZEN_RUNTIME_CONTINUATION_ARTIFACT = "NO_FROZEN_RUNTIME_CONTINUATION_ARTIFACT" as const;

function noEdgeContinuationOverlay(
  reason: string,
  raw: unknown,
  artifactId: string = NO_FROZEN_RUNTIME_CONTINUATION_ARTIFACT,
): FrozenContinuationOverlay {
  return {
    continuationArtifactId: artifactId,
    artifactSha256: null,
    schemaVersion: null,
    featureVersion: null,
    calibrationVersion: null,
    runtimeFunction: null,
    available: false,
    reason,
    featureAtMs: null,
    horizons: [],
    bullVotes: 0,
    bearVotes: 0,
    neutralVotes: 0,
    agreementScore: null,
    persistenceScore: null,
    persistenceDirection: "PERSIST_NEUTRAL",
    topPath: null,
    pathProbabilities: {},
    reversalRisk: null,
    reversalRiskBand: null,
    decision: "NO_EDGE",
    rawOutput: jsonSafeRecord(raw),
  };
}

function continuationVote(margin: number): DynamicMom36ContinuationVote {
  if (margin >= DYNAMIC_MOM36_DIRECTION_DEADBAND) return "BULLISH";
  if (margin <= -DYNAMIC_MOM36_DIRECTION_DEADBAND) return "BEARISH";
  return "NEUTRAL";
}

function persistenceDirection(score: number): DynamicMom36PersistenceDirection {
  if (score >= DYNAMIC_MOM36_PERSISTENCE_DEADBAND) return "PERSIST_UP";
  if (score <= -DYNAMIC_MOM36_PERSISTENCE_DEADBAND) return "PERSIST_DOWN";
  return "PERSIST_NEUTRAL";
}

function reversalRiskBand(risk: number): DynamicMom36ReversalRiskBand {
  if (risk < DYNAMIC_MOM36_LOW_REVERSAL_RISK) return "LOW";
  if (risk < DYNAMIC_MOM36_HIGH_REVERSAL_RISK) return "MODERATE";
  return "HIGH";
}

function finiteProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Strictly normalize the actual V4 trajectory service result.  The decision below deliberately
 * ignores the V4 allocation ladder: V4 supplies continuation evidence only, while this strategy's
 * fixed, one-rung mapping remains the sole allocator.
 */
export function normalizeFrozenV4ContinuationOverlay(
  raw: unknown,
  baseAllocation: DynamicMom36Allocation,
): FrozenContinuationOverlay {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return noEdgeContinuationOverlay("frozen continuation runtime unavailable", raw);
  }
  const candidate = raw as DynamicMom36ContinuationRuntimeResult;
  const artifactId = typeof candidate.artifactId === "string" && candidate.artifactId
    ? candidate.artifactId
    : NO_FROZEN_RUNTIME_CONTINUATION_ARTIFACT;
  if (candidate.available !== true || !candidate.trajectory) {
    return noEdgeContinuationOverlay(candidate.fallbackReason ?? "frozen continuation runtime unavailable", raw, artifactId);
  }
  if (candidate.schemaVersion !== 4 || candidate.trajectory.schemaVersion !== 4) {
    return noEdgeContinuationOverlay("frozen continuation schema mismatch", raw, artifactId);
  }
  const trajectory = candidate.trajectory;
  if (
    !Number.isFinite(trajectory.persistenceScore) ||
    !finiteProbability(trajectory.reversalRisk) ||
    typeof trajectory.topPath !== "string" ||
    !trajectory.topPath ||
    !(typeof candidate.featureAtMs === "number" && Number.isFinite(candidate.featureAtMs) && candidate.featureAtMs > 0)
  ) {
    return noEdgeContinuationOverlay("frozen continuation output is missing persistence/path/risk", raw, artifactId);
  }
  const pathProbabilities: Record<string, number> = {};
  for (const [path, probability] of Object.entries(trajectory.pathProbabilities ?? {})) {
    if (!finiteProbability(probability)) {
      return noEdgeContinuationOverlay("frozen continuation path probabilities are invalid", raw, artifactId);
    }
    pathProbabilities[path] = probability;
  }
  if (!Object.keys(pathProbabilities).length || !Object.hasOwn(pathProbabilities, trajectory.topPath)) {
    return noEdgeContinuationOverlay("frozen continuation output is missing its top-path probability", raw, artifactId);
  }
  const rows = new Map(trajectory.horizons.map((row) => [row.horizon, row]));
  const horizons: FrozenContinuationOverlay["horizons"] = [];
  for (const horizon of CONTINUATION_HORIZONS) {
    const row = rows.get(horizon);
    if (!row || !finiteProbability(row.pStrongUp) || !finiteProbability(row.pNeutral) || !finiteProbability(row.pStrongDown)) {
      return noEdgeContinuationOverlay("frozen continuation is missing a valid 6/12/24/36h probability row", raw, artifactId);
    }
    const directionMargin = row.pStrongUp - row.pStrongDown;
    if (!Number.isFinite(directionMargin)) {
      return noEdgeContinuationOverlay("frozen continuation direction margin is non-finite", raw, artifactId);
    }
    horizons.push({
      horizon,
      pUp: row.pStrongUp,
      pNeutral: row.pNeutral,
      pDown: row.pStrongDown,
      directionMargin,
      vote: continuationVote(directionMargin),
    });
  }
  const bullVotes = horizons.filter((row) => row.vote === "BULLISH").length;
  const bearVotes = horizons.filter((row) => row.vote === "BEARISH").length;
  const neutralVotes = horizons.filter((row) => row.vote === "NEUTRAL").length;
  const persistence = persistenceDirection(trajectory.persistenceScore);
  const riskBand = reversalRiskBand(trajectory.reversalRisk);
  const strictBullish =
    bullVotes >= DYNAMIC_MOM36_CONFIRM_MIN_VOTES &&
    bearVotes <= 1 &&
    persistence === "PERSIST_UP" &&
    BULLISH_PERSISTENT_PATHS.has(trajectory.topPath) &&
    trajectory.reversalRisk < DYNAMIC_MOM36_LOW_REVERSAL_RISK;
  const strictBearish =
    bearVotes >= DYNAMIC_MOM36_CONFIRM_MIN_VOTES &&
    bullVotes <= 1 &&
    persistence === "PERSIST_DOWN" &&
    BEARISH_PERSISTENT_PATHS.has(trajectory.topPath) &&
    trajectory.reversalRisk < DYNAMIC_MOM36_LOW_REVERSAL_RISK;
  let decision: DynamicMom36ContinuationDecision = "NO_EDGE";
  if (baseAllocation.longCount > 3) {
    if (strictBullish) decision = "CONFIRM_LONG";
    else if (
      (bearVotes >= DYNAMIC_MOM36_CONFIRM_MIN_VOTES && persistence === "PERSIST_DOWN") ||
      (trajectory.topPath === "UP_THEN_REVERSAL" && trajectory.reversalRisk >= DYNAMIC_MOM36_HIGH_REVERSAL_RISK && bearVotes >= 2)
    ) decision = "CONFLICT_LONG";
  } else if (baseAllocation.longCount < 3) {
    if (strictBearish) decision = "CONFIRM_SHORT";
    else if (
      (bullVotes >= DYNAMIC_MOM36_CONFIRM_MIN_VOTES && persistence === "PERSIST_UP") ||
      (trajectory.topPath === "DOWN_THEN_REVERSAL" && trajectory.reversalRisk >= DYNAMIC_MOM36_HIGH_REVERSAL_RISK && bullVotes >= 2)
    ) decision = "CONFLICT_SHORT";
  } else if (strictBullish) {
    decision = "CONFIRM_LONG";
  } else if (strictBearish) {
    decision = "CONFIRM_SHORT";
  }
  return {
    continuationArtifactId: artifactId,
    artifactSha256: typeof candidate.artifactSha256 === "string" ? candidate.artifactSha256 : null,
    schemaVersion: candidate.schemaVersion,
    featureVersion: typeof candidate.featureVersion === "string" ? candidate.featureVersion : null,
    calibrationVersion: typeof candidate.calibrationVersion === "string" ? candidate.calibrationVersion : null,
    runtimeFunction: typeof candidate.runtimeFunction === "string" ? candidate.runtimeFunction : null,
    available: true,
    reason: null,
    featureAtMs: typeof candidate.featureAtMs === "number" && Number.isFinite(candidate.featureAtMs) ? candidate.featureAtMs : null,
    horizons,
    bullVotes,
    bearVotes,
    neutralVotes,
    agreementScore: (bullVotes - bearVotes) / CONTINUATION_HORIZONS.length,
    persistenceScore: trajectory.persistenceScore,
    persistenceDirection: persistence,
    topPath: trajectory.topPath,
    pathProbabilities,
    reversalRisk: trajectory.reversalRisk,
    reversalRiskBand: riskBand,
    decision,
    rawOutput: jsonSafeRecord(candidate.rawOutput),
  };
}

/** One adjacent allocation rung only. Continuation never vetoes and never crosses neutral. */
export function applyBoundedContinuationOverlay(
  base: DynamicMom36Allocation,
  continuation: Pick<FrozenContinuationOverlay, "decision">,
): DynamicMom36Allocation {
  let longCount = base.longCount;
  if (base.longCount > 3) {
    if (continuation.decision === "CONFIRM_LONG") longCount = Math.min(6, longCount + 1);
    else if (continuation.decision === "CONFLICT_LONG") longCount = Math.max(3, longCount - 1);
  } else if (base.longCount < 3) {
    if (continuation.decision === "CONFIRM_SHORT") longCount = Math.max(0, longCount - 1);
    else if (continuation.decision === "CONFLICT_SHORT") longCount = Math.min(3, longCount + 1);
  } else if (continuation.decision === "CONFIRM_LONG") {
    longCount = 4;
  } else if (continuation.decision === "CONFIRM_SHORT") {
    longCount = 2;
  }
  return allocation(longCount);
}

/**
 * Strict adapter for a future *already frozen* runtime shock artifact.  It does not infer a state
 * or use a threshold: a malformed, stale, missing, timeout, or non-finite output simply means
 * NO_EDGE.  Keeping this boundary pure makes the optional overlay testable without creating a
 * second model or silently training/tuning one in the execution path.
 */
export function normalizeFrozenRuntimeShockOverlay(raw: unknown): FrozenShockOverlay {
  const record = jsonSafeRecord(raw);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return noEdgeShockOverlay("frozen shock artifact unavailable", raw);
  }
  const candidate = raw as Record<string, unknown>;
  const modelArtifactId = typeof candidate.modelArtifactId === "string" && candidate.modelArtifactId.trim()
    ? candidate.modelArtifactId.trim()
    : NO_FROZEN_RUNTIME_SHOCK_ARTIFACT;
  if (candidate.available !== true || candidate.artifactPresent !== true) {
    return noEdgeShockOverlay("frozen shock artifact unavailable", raw, modelArtifactId);
  }
  if (candidate.timedOut === true || candidate.featuresAvailable === false || candidate.schemaValid === false) {
    return noEdgeShockOverlay("frozen shock inference is unavailable or incompatible", raw, modelArtifactId);
  }
  const state = candidate.state;
  if (typeof state !== "string" || !SHOCK_STATES.has(state as DynamicMom36ShockState)) {
    return noEdgeShockOverlay("frozen shock output has no valid normalized state", raw, modelArtifactId);
  }
  const probabilities = candidate.probabilities;
  if (probabilities !== undefined) {
    if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities) ||
      Object.values(probabilities as Record<string, unknown>).some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      return noEdgeShockOverlay("frozen shock output has non-finite probabilities", raw, modelArtifactId);
    }
  }
  // VETO is never inferred from a raw state name alone.  The frozen model's published mapping has
  // to state explicitly that this result is a legal veto.
  if (state === "VETO" && candidate.vetoAllowed !== true) {
    return noEdgeShockOverlay("frozen shock VETO is not explicitly authorized by its mapping", raw, modelArtifactId);
  }
  return {
    modelArtifactId,
    available: true,
    state: state as DynamicMom36ShockState,
    rawOutput: record,
    reason: typeof candidate.reason === "string" ? candidate.reason : null,
    vetoAllowed: candidate.vetoAllowed === true,
  };
}

export type DynamicMom36Selection = {
  selectedLongs: DynamicMom36RankedSymbol[];
  selectedShorts: DynamicMom36RankedSymbol[];
  blockedShortsSkipped: string[];
  insufficientReason: string | null;
  /** Full ordered side walks, including safety/alignment rejection provenance. */
  candidateAudit: {
    long: DynamicMom36CandidateSelectionAudit[];
    short: DynamicMom36CandidateSelectionAudit[];
  };
  requiredLongs: number;
  requiredShorts: number;
  /** Sign-aligned candidates before execution eligibility and cluster selection. */
  availableAlignedLongs: number;
  availableAlignedShorts: number;
  /** Alignment plus current execution eligibility, before the per-side cluster cap. */
  availableExecutionEligibleAlignedLongs: number;
  availableExecutionEligibleAlignedShorts: number;
  slowFastApplied: boolean;
};

export type DynamicMom36CandidateSkipReason =
  | "SELECTED"
  | "NOT_REQUIRED_AFTER_QUOTA"
  | "OPPOSITE_SIDE_SELECTED"
  | DynamicMom36ExecutionBlockReason
  | "CLUSTER_GUARD"
  | "SLOW_FAST_NOT_ALIGNED"
  | "SLOW_FAST_DATA_MISSING";

export type DynamicMom36CandidateSelectionAudit = {
  symbol: string;
  side: "LONG" | "SHORT";
  mom36Rank: number;
  mom36: number;
  fastReturn: number | null;
  slowDirection: DynamicMom36SlowFastDirection;
  fastDirection: DynamicMom36SlowFastDirection;
  slowSourceTimestampMs: number | null;
  slowStartTimestampMs: number | null;
  fastSourceTimestampMs: number | null;
  fastStartTimestampMs: number | null;
  /** All four closes used by MOM36/FAST4h were present, closed, and no later than the decision cut. */
  slowFastDataAvailable: boolean;
  slowFastAligned: boolean;
  executionEligible: boolean;
  shortBlocked: boolean;
  lossReentryBlocked: boolean;
  clusterBlocked: boolean;
  selected: boolean;
  skipReason: DynamicMom36CandidateSkipReason;
};

export type DynamicMom36SlowFastPolicy = {
  active: boolean;
  /** V4 is a hard gate; V5 retains the exact gate as a preference with a same-snapshot raw V3 fallback. */
  mode: DynamicMom36SlowFastMode;
  policyId: string | null;
  implementationVersion: string | null;
  interval: string | null;
  slowBars: number | null;
  fastBars: number | null;
};

export type DynamicMom36SlowFastMode =
  | "OFF"
  | "STRICT"
  | "PREFER"
  | "STRICT_DIRECTIONAL_FEASIBILITY";

export type DynamicMom36DirectionalFeasibilityDirection = "LONG" | "SHORT";
export type DynamicMom36DirectionalFeasibilityOutcome =
  | "DISABLED"
  | "VETOED"
  | "REQUESTED_STRICT_FEASIBLE"
  | "NO_DIRECTIONAL_PRIOR"
  | "FALLBACK_APPLIED"
  | "NO_FULL_STRICT_ALLOCATION";

/**
 * Immutable audit of V6's same-snapshot feasibility search. It records allocation attempts only;
 * the full requested and final side walks remain in the existing strict/final candidate audits.
 */
export type DynamicMom36DirectionalFeasibility = {
  active: boolean;
  requestedAllocation: DynamicMom36Allocation;
  directionalPrior: DynamicMom36DirectionalFeasibilityDirection | null;
  outcome: DynamicMom36DirectionalFeasibilityOutcome;
  attempts: Array<{
    allocation: DynamicMom36Allocation;
    selectedLongs: string[];
    selectedShorts: string[];
    selectionInsufficientReason: string | null;
    complete: boolean;
  }>;
  effectiveAllocation: DynamicMom36Allocation | null;
};

/** Identifies which fully-audited selection supplied the actual basket legs. */
export type DynamicMom36SelectionSource =
  | "RAW_V3"
  | "STRICT_SLOW_FAST"
  | "STRICT_SLOW_FAST_DIRECTIONAL_FEASIBILITY"
  | "RAW_V3_FALLBACK"
  | "VETOED";

export type DynamicMom36Formation = {
  threeLegFallback?: ThreeLegAudit;
  /** Recent-strength preference outcome; null when the baseline was not valid to begin with. */
  preference: DynamicMom36PreferenceOutcome | null;
  activeUniverse: DynamicMom36RankedSymbol[];
  positiveCount: number;
  negativeCount: number;
  zeroCount: number;
  baseAllocation: DynamicMom36Allocation;
  /**
   * The exact unmodified Dynamic MOM36 selection. This is immutable audit evidence only: it
   * lets later forward research compare a bounded shock action against the base portfolio without
   * recomputing ranks from changed code, pool membership, or market data.
  */
  baseSelection: DynamicMom36Selection;
  /** Exact current V3 selection after the frozen continuation allocation, with no SLOW_AND_FAST filtering. */
  rawV3Selection: DynamicMom36Selection;
  /** Strict SLOW_AND_FAST selection retained as audit evidence for V4/V5; null when that policy is off. */
  slowFastStrictSelection: DynamicMom36Selection | null;
  /** v1 has its historic shock snapshot; v3 records formation-only V4 continuation instead. */
  shock: FrozenShockOverlay;
  continuation: FrozenContinuationOverlay | null;
  slowFast: DynamicMom36SlowFastPolicy;
  /** Allocation requested by MOM36 breadth plus the bounded continuation overlay, before V6 feasibility. */
  requestedAllocation: DynamicMom36Allocation;
  /** V6 records why it retained the requested mix, resolved a directional mix, or abstained. */
  directionalFeasibility: DynamicMom36DirectionalFeasibility;
  /** Actual allocation used for the final six-leg selection and basket sizing. */
  finalAllocation: DynamicMom36Allocation;
  vetoed: boolean;
  selectionSource: DynamicMom36SelectionSource;
  selection: DynamicMom36Selection;
};

const allocation = (longCount: number): DynamicMom36Allocation => {
  const safeLong = Math.max(0, Math.min(6, Math.floor(longCount)));
  return { longCount: safeLong, shortCount: 6 - safeLong, label: DYNAMIC_MOM36_ALLOCATION_LABELS[safeLong]! };
};

function normalizedAllowedLongCounts(values: readonly number[] | undefined): number[] {
  if (values === undefined) return [...DYNAMIC_MOM36_ALL_ALLOWED_LONG_COUNTS];
  return [...new Set(values.filter((value) => Number.isInteger(value) && value >= 0 && value <= 6))].sort((a, b) => a - b);
}

function allocationIsAllowed(longCount: number, allowedLongCounts: readonly number[] | undefined): boolean {
  return normalizedAllowedLongCounts(allowedLongCounts).includes(longCount);
}

/**
 * Projects a breadth/continuation request onto the configured executable geometry.  The direction
 * is retained and no candidate is substituted here: strict Slow+Fast selection still has to find
 * every opposite-side leg, otherwise formation abstains.
 */
export function constrainDynamicMom36Allocation(
  requested: DynamicMom36Allocation,
  allowedLongCounts: readonly number[] | undefined,
): DynamicMom36Allocation {
  const allowed = normalizedAllowedLongCounts(allowedLongCounts);
  if (!allowed.length || allowed.includes(requested.longCount)) return requested;
  const nearest = allowed.reduce((best, candidate) => {
    const candidateDistance = Math.abs(candidate - requested.longCount);
    const bestDistance = Math.abs(best - requested.longCount);
    if (candidateDistance !== bestDistance) return candidateDistance < bestDistance ? candidate : best;
    // A tie can only happen around neutral. Preserve the requested directional sign if present.
    if (requested.longCount > 3) return candidate > best ? candidate : best;
    if (requested.longCount < 3) return candidate < best ? candidate : best;
    return candidate < best ? candidate : best;
  });
  return allocation(nearest);
}

/**
 * Treat only machine-noise around exactly zero as zero.  This is a numerical normalisation,
 * deliberately not a tuned epsilon or an additional momentum threshold.
 */
export function dynamicMom36Sign(value: number): -1 | 0 | 1 | null {
  if (!Number.isFinite(value)) return null;
  if (Math.abs(value) <= Number.EPSILON * 16) return 0;
  return value > 0 ? 1 : -1;
}

export function baseDynamicMom36Allocation(rows: readonly Pick<DynamicMom36RankedSymbol, "mom36">[]): {
  positiveCount: number;
  negativeCount: number;
  zeroCount: number;
  allocation: DynamicMom36Allocation;
} {
  let positiveCount = 0;
  let negativeCount = 0;
  let zeroCount = 0;
  for (const row of rows) {
    const sign = dynamicMom36Sign(row.mom36);
    if (sign === 1) positiveCount += 1;
    else if (sign === -1) negativeCount += 1;
    else if (sign === 0) zeroCount += 1;
  }

  // A zero is neutral telemetry, not a directional vote.  Preserve observed positive/negative
  // breadth: 16 positive / 2 negative / 1 zero is still 4L2S.  Only a fully neutral universe
  // retains the deterministic 3L3S fallback.
  if (positiveCount === 0 && negativeCount === 0) {
    return { positiveCount, negativeCount, zeroCount, allocation: allocation(3) };
  }
  if (negativeCount === 0) return { positiveCount, negativeCount, zeroCount, allocation: allocation(6) };
  if (negativeCount === 1) return { positiveCount, negativeCount, zeroCount, allocation: allocation(5) };
  if (negativeCount === 2) return { positiveCount, negativeCount, zeroCount, allocation: allocation(4) };
  if (positiveCount === 0) return { positiveCount, negativeCount, zeroCount, allocation: allocation(0) };
  if (positiveCount === 1) return { positiveCount, negativeCount, zeroCount, allocation: allocation(1) };
  if (positiveCount === 2) return { positiveCount, negativeCount, zeroCount, allocation: allocation(2) };
  return { positiveCount, negativeCount, zeroCount, allocation: allocation(3) };
}

/**
 * The bounded overlay is intentionally a one-rung operation.  CONFIRM_* names the frozen model's
 * directional evidence.  CONFLICT_LONG means evidence against a net-long base; CONFLICT_SHORT is
 * the mirror.  Neither path can cross neutral in a single decision.
 */
export function applyBoundedShockOverlay(
  base: DynamicMom36Allocation,
  shock: Pick<FrozenShockOverlay, "state" | "vetoAllowed">,
): { allocation: DynamicMom36Allocation; vetoed: boolean } {
  if (shock.state === "VETO") {
    return { allocation: base, vetoed: shock.vetoAllowed };
  }
  let longCount = base.longCount;
  if (shock.state === "CONFIRM_LONG") longCount = Math.min(6, longCount + 1);
  else if (shock.state === "CONFIRM_SHORT") longCount = Math.max(0, longCount - 1);
  else if (shock.state === "CONFLICT_LONG" && longCount > 3) longCount -= 1;
  else if (shock.state === "CONFLICT_SHORT" && longCount < 3) longCount += 1;
  return { allocation: allocation(longCount), vetoed: false };
}

/**
 * Current runtime inspection found no frozen model artifact plus deterministic shock/trajectory
 * mapping wired into the production execution path.  Per policy, absence degrades to base MOM36;
 * it must never block entry, guess a probability, or become an unreviewed new alpha layer.
 */
export function resolveFrozenRuntimeShockOverlay(): FrozenShockOverlay {
  return noEdgeShockOverlay(
    "no frozen runtime shock/trajectory mapping is registered for execution",
    { artifactPresent: false, mappingPresent: false, fallback: "NO_EDGE" },
  );
}

export function dynamicMom36ClusterAllowed(symbol: string, selected: readonly DynamicMom36RankedSymbol[], maxPerCluster: number): boolean {
  if (!(maxPerCluster > 0)) return true;
  const cluster = clusterOf(symbol);
  if (isMajorCluster(cluster)) return true;
  return selected.filter((row) => clusterOf(row.symbol) === cluster).length < maxPerCluster;
}

function rank(rows: readonly DynamicMom36RankedSymbol[], side: "LONG" | "SHORT"): DynamicMom36RankedSymbol[] {
  return [...rows].sort((a, b) => {
    const scoreDelta = side === "LONG" ? b.mom36 - a.mom36 : a.mom36 - b.mom36;
    return scoreDelta || a.symbol.localeCompare(b.symbol);
  });
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function executionSkipReason(
  row: DynamicMom36RankedSymbol,
  side: "LONG" | "SHORT",
): DynamicMom36ExecutionBlockReason {
  const explicit = side === "LONG" ? row.longExecutionBlockReason : row.shortExecutionBlockReason;
  if (explicit) return explicit;
  if (side === "SHORT" && row.shortBlocked) return "SHORT_BLOCKED";
  return "EXECUTION_INELIGIBLE";
}

function validSourceTimestamp(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * The recovered predicate itself is deliberately only a strict sign test.  Dynamic v4 adds this
 * separate data-availability guard because its persisted formation snapshot must prove that both
 * endpoints of MOM36 and FAST4h were closed at the decision point.  Missing provenance is never
 * treated as an aligned signal.
 */
function slowFastDataAvailable(row: DynamicMom36RankedSymbol): boolean {
  return row.slowFastDataValid !== false &&
    Number.isFinite(row.mom36) &&
    typeof row.fastReturn === "number" && Number.isFinite(row.fastReturn) &&
    validSourceTimestamp(row.slowSourceTimestampMs) &&
    validSourceTimestamp(row.slowStartTimestampMs) &&
    validSourceTimestamp(row.fastSourceTimestampMs) &&
    validSourceTimestamp(row.fastStartTimestampMs);
}

/**
 * Canonical MOM36 ranking for one side. This is the ONLY source of `mom36Rank`.
 *
 * Previously the rank was the traversal index, which meant any change to visit order silently
 * renumbered the audit. Rank and traversal are now separate concerns: this map is computed once
 * from the MOM36 order and every selector — baseline or preference — reports from it.
 */
export function canonicalMom36Ranks(
  rows: readonly DynamicMom36RankedSymbol[],
  side: "LONG" | "SHORT",
): Map<string, number> {
  const ordered = rank(rows, side);
  const ranks = new Map<string, number>();
  ordered.forEach((row, index) => ranks.set(row.symbol, index + 1));
  return ranks;
}

export interface DynamicMom36GuardVerdict {
  admissible: boolean;
  skipReason: DynamicMom36CandidateSkipReason;
  clusterBlocked: boolean;
  sourceAvailable: boolean;
  slowFastAligned: boolean;
  strictSignAligned: boolean;
  executionEligible: boolean;
  aligned: ReturnType<typeof evaluateDynamicMom36SlowFast>;
}

/**
 * The ONE admission check. Baseline traversal and preference enumeration both call this; there is
 * deliberately no second copy of these rules anywhere.
 *
 * Order is part of the contract and is unchanged from the original walk:
 *   opposite-side exclusion -> execution eligibility -> quota -> cluster cap -> slow/fast data ->
 *   slow/fast sign.
 * `selected` is the set already admitted ahead of this candidate, because cluster capacity is
 * consumed in selection order — which is why a combination must be validated by replaying its
 * members in canonical order rather than judged member-by-member in isolation.
 */
export function evaluateDynamicMom36Candidate(input: {
  row: DynamicMom36RankedSymbol;
  side: "LONG" | "SHORT";
  selected: readonly DynamicMom36RankedSymbol[];
  excluded: ReadonlySet<string>;
  count: number;
  maxPerCluster: number;
  slowFastApplied: boolean;
}): DynamicMom36GuardVerdict {
  const { row, side, selected, excluded, count, maxPerCluster, slowFastApplied } = input;
  const aligned = evaluateDynamicMom36SlowFast(row.mom36, row.fastReturn);
  const strictSignAligned = side === "LONG" ? aligned.longAligned : aligned.shortAligned;
  const sourceAvailable = slowFastDataAvailable(row);
  const slowFastAligned = sourceAvailable && strictSignAligned;
  const executionEligible = side === "LONG" ? row.longEligible : row.shortEligible;
  const base = { clusterBlocked: false, sourceAvailable, slowFastAligned, strictSignAligned, executionEligible, aligned };

  if (excluded.has(row.symbol)) {
    return { ...base, admissible: false, skipReason: "OPPOSITE_SIDE_SELECTED" };
  }
  if (!executionEligible) {
    return { ...base, admissible: false, skipReason: executionSkipReason(row, side) };
  }
  if (selected.length >= count) {
    return { ...base, admissible: false, skipReason: "NOT_REQUIRED_AFTER_QUOTA" };
  }
  const clusterBlocked = !dynamicMom36ClusterAllowed(row.symbol, selected, maxPerCluster);
  if (clusterBlocked) {
    return { ...base, admissible: false, clusterBlocked: true, skipReason: "CLUSTER_GUARD" };
  }
  if (slowFastApplied && !sourceAvailable) {
    return { ...base, admissible: false, skipReason: "SLOW_FAST_DATA_MISSING" };
  }
  if (slowFastApplied && !strictSignAligned) {
    // A hard per-leg gate: it consumes no cluster capacity and has no authority over ranking or
    // allocation; the walk simply continues in the same MOM36 order.
    return { ...base, admissible: false, skipReason: "SLOW_FAST_NOT_ALIGNED" };
  }
  return { ...base, admissible: true, skipReason: "SELECTED" };
}

/**
 * Replay a proposed side selection through the shared guard, in canonical order.
 *
 * Returns null when any member is inadmissible given the members admitted before it, so a
 * preference combination can never enter on weaker rules than the baseline walk.
 */
export function validateDynamicMom36SideCombination(input: {
  members: readonly DynamicMom36RankedSymbol[];
  side: "LONG" | "SHORT";
  excluded: ReadonlySet<string>;
  maxPerCluster: number;
  slowFastApplied: boolean;
  requiredCount?: number;
}): DynamicMom36RankedSymbol[] | null {
  if (input.requiredCount !== undefined && input.members.length !== input.requiredCount) return null;
  if (new Set(input.members.map((row) => row.symbol)).size !== input.members.length) return null;
  const ordered = rank(input.members, input.side);
  const selected: DynamicMom36RankedSymbol[] = [];
  for (const row of ordered) {
    const verdict = evaluateDynamicMom36Candidate({
      row,
      side: input.side,
      selected,
      excluded: input.excluded,
      count: ordered.length,
      maxPerCluster: input.maxPerCluster,
      slowFastApplied: input.slowFastApplied,
    });
    if (!verdict.admissible) return null;
    selected.push(row);
  }
  return selected;
}

function selectSide(
  rows: readonly DynamicMom36RankedSymbol[],
  side: "LONG" | "SHORT",
  count: number,
  excluded: ReadonlySet<string>,
  maxPerCluster: number,
  slowFastApplied: boolean,
): {
  selected: DynamicMom36RankedSymbol[];
  blockedSkipped: string[];
  audit: DynamicMom36CandidateSelectionAudit[];
} {
  const selected: DynamicMom36RankedSymbol[] = [];
  const blockedSkipped: string[] = [];
  const audit: DynamicMom36CandidateSelectionAudit[] = [];
  const canonicalRanks = canonicalMom36Ranks(rows, side);
  for (const row of rank(rows, side)) {
    const verdict = evaluateDynamicMom36Candidate({
      row, side, selected, excluded, count, maxPerCluster, slowFastApplied,
    });
    // Exactly the original condition: only a candidate that REACHED the eligibility check (i.e. was
    // not already excluded by the opposite side) and failed it is recorded as blocked.
    if (verdict.skipReason !== "OPPOSITE_SIDE_SELECTED"
        && !verdict.executionEligible
        && side === "SHORT"
        && row.shortBlocked) {
      blockedSkipped.push(row.symbol);
    }
    if (verdict.admissible) selected.push(row);
    audit.push({
      symbol: row.symbol,
      side,
      // Canonical rank, never the traversal index.
      mom36Rank: canonicalRanks.get(row.symbol) ?? 0,
      mom36: row.mom36,
      fastReturn: finiteOrNull(row.fastReturn),
      slowDirection: verdict.aligned.slowDirection,
      fastDirection: verdict.aligned.fastDirection,
      slowSourceTimestampMs: finiteOrNull(row.slowSourceTimestampMs),
      slowStartTimestampMs: finiteOrNull(row.slowStartTimestampMs),
      fastSourceTimestampMs: finiteOrNull(row.fastSourceTimestampMs),
      fastStartTimestampMs: finiteOrNull(row.fastStartTimestampMs),
      slowFastDataAvailable: verdict.sourceAvailable,
      slowFastAligned: verdict.slowFastAligned,
      executionEligible: verdict.executionEligible,
      shortBlocked: side === "SHORT" && row.shortBlocked,
      lossReentryBlocked: executionSkipReason(row, side) === "LOSS_REENTRY_GUARD",
      clusterBlocked: verdict.clusterBlocked,
      selected: verdict.admissible,
      skipReason: verdict.skipReason,
    });
  }
  return { selected, blockedSkipped, audit };
}

/** Effective search pool per side: canonical order, capped, only candidates that could be picked. */
export const DYNAMIC_MOM36_PREFERENCE_POOL_DEPTH = 5;
/** Bounded search. Beyond this the preference abstains rather than spending unbounded time. */
export const DYNAMIC_MOM36_PREFERENCE_MAX_COMBINATIONS = 400;

export type DynamicMom36PreferenceReason =
  | "PREFERRED_RECENT_STRENGTH_ALIGNED"
  | "BASELINE_ALREADY_BEST"
  | "RECENT_STRENGTH_MIXED"
  | "RECENT_STRENGTH_UNAVAILABLE"
  | "SEARCH_EXHAUSTED";

export interface DynamicMom36PreferenceOutcome {
  selection: "BASELINE" | "PREFERRED";
  reason: DynamicMom36PreferenceReason;
  longs: DynamicMom36RankedSymbol[];
  shorts: DynamicMom36RankedSymbol[];
  baselineLongs: DynamicMom36RankedSymbol[];
  baselineShorts: DynamicMom36RankedSymbol[];
  s1h: number | null;
  s4h: number | null;
  baselineS1h: number | null;
  baselineS4h: number | null;
  /** Signed return using the six actual equal-notional capital weights. */
  basketReturn1h: number | null;
  basketReturn4h: number | null;
  consideredCombinations: number;
  qualifyingCombinations: number;
  searchExhausted: boolean;
  poolLongs: string[];
  poolShorts: string[];
}

function combinations<T>(items: readonly T[], choose: number): T[][] {
  if (choose <= 0 || choose > items.length) return [];
  const out: T[][] = [];
  const pick: T[] = [];
  const walk = (start: number) => {
    if (pick.length === choose) { out.push([...pick]); return; }
    for (let i = start; i < items.length; i++) {
      pick.push(items[i]!);
      walk(i + 1);
      pick.pop();
    }
  };
  walk(0);
  return out;
}

/**
 * Weighted price return of one side, weights normalised across exactly these legs.
 *
 * Production sizes every leg to the same notional (weight 1/6 in every allocation), so the
 * normalised weights are equal within a side; the weighted form is kept so a future sizing change
 * flows through here instead of silently invalidating this measure. Returns null if any leg lacks
 * the horizon, so a partially observed side is never compared against a fully observed one.
 */
function sideReturn(
  legs: readonly DynamicMom36RankedSymbol[],
  horizon: "1h" | "4h",
): number | null {
  if (legs.length === 0) return null;
  let acc = 0;
  for (const leg of legs) {
    const value = horizon === "1h" ? finiteOrNull(leg.oneHourReturn) : finiteOrNull(leg.fastReturn);
    if (value === null) return null;
    acc += value;
  }
  return acc / legs.length;
}

/** S_h = weighted LONG price return - weighted SHORT price return. Both are PRICE returns. */
function combinationSpread(
  longs: readonly DynamicMom36RankedSymbol[],
  shorts: readonly DynamicMom36RankedSymbol[],
  horizon: "1h" | "4h",
): number | null {
  const longSide = sideReturn(longs, horizon);
  const shortSide = sideReturn(shorts, horizon);
  if (longSide === null || shortSide === null) return null;
  return longSide - shortSide;
}

/** Comparable across 2/4, 3/3 and 4/2: every leg has exactly 1/6 of capital. */
export function dynamicMom36BasketReturn(
  longs: readonly DynamicMom36RankedSymbol[], shorts: readonly DynamicMom36RankedSymbol[],
  horizon: "1h" | "4h",
): number | null {
  const l = sideReturn(longs, horizon), s = sideReturn(shorts, horizon);
  return l === null || s === null ? null : (l * longs.length - s * shorts.length) / 6;
}

export function dynamicMom36CombinationRank(
  rows: readonly DynamicMom36RankedSymbol[],
  longs: readonly DynamicMom36RankedSymbol[], shorts: readonly DynamicMom36RankedSymbol[],
): number {
  return aggregateRank(longs, shorts, canonicalMom36Ranks(rows, "LONG"), canonicalMom36Ranks(rows, "SHORT")) / 6;
}

function aggregateRank(
  longs: readonly DynamicMom36RankedSymbol[],
  shorts: readonly DynamicMom36RankedSymbol[],
  longRanks: ReadonlyMap<string, number>,
  shortRanks: ReadonlyMap<string, number>,
): number {
  let total = 0;
  for (const row of longs) total += longRanks.get(row.symbol) ?? Number.MAX_SAFE_INTEGER;
  for (const row of shorts) total += shortRanks.get(row.symbol) ?? Number.MAX_SAFE_INTEGER;
  return total;
}

function comboKey(
  longs: readonly DynamicMom36RankedSymbol[],
  shorts: readonly DynamicMom36RankedSymbol[],
): string {
  const l = longs.map((r) => r.symbol).slice().sort().join(",");
  const s = shorts.map((r) => r.symbol).slice().sort().join(",");
  return `L:${l}|S:${s}`;
}

/**
 * Recent-strength PREFERENCE over whole baskets. It can only ever re-order what the existing rules
 * already allow — every candidate combination is replayed through the SAME shared guard the
 * baseline walk uses, so cluster capacity, quota, eligibility and side overlap are enforced once,
 * in one implementation.
 *
 * It cannot create a NO_TRADE: an invalid baseline never reaches here, and no qualifying
 * alternative simply returns the baseline unchanged.
 */
export function selectPreferredDynamicMom36Combination(input: {
  rows: readonly DynamicMom36RankedSymbol[];
  baselineLongs: readonly DynamicMom36RankedSymbol[];
  baselineShorts: readonly DynamicMom36RankedSymbol[];
  finalAllocation: DynamicMom36Allocation;
  maxPerCluster: number;
  slowFastApplied: boolean;
  poolDepth?: number;
  maxCombinations?: number;
  /** Production supplies the SAME full admission check used for its baseline. */
  admitCombination?: (longs: DynamicMom36RankedSymbol[], shorts: DynamicMom36RankedSymbol[]) => boolean;
}): DynamicMom36PreferenceOutcome {
  const poolDepth = input.poolDepth ?? DYNAMIC_MOM36_PREFERENCE_POOL_DEPTH;
  const maxCombinations = input.maxCombinations ?? DYNAMIC_MOM36_PREFERENCE_MAX_COMBINATIONS;
  const longRanks = canonicalMom36Ranks(input.rows, "LONG");
  const shortRanks = canonicalMom36Ranks(input.rows, "SHORT");
  const baselineLongs = [...input.baselineLongs];
  const baselineShorts = [...input.baselineShorts];
  const baselineS1h = combinationSpread(baselineLongs, baselineShorts, "1h");
  const baselineS4h = combinationSpread(baselineLongs, baselineShorts, "4h");
  const baselineKey = comboKey(baselineLongs, baselineShorts);

  const keep = (side: "LONG" | "SHORT") => {
    const count = side === "LONG" ? input.finalAllocation.longCount : input.finalAllocation.shortCount;
    // Eligibility uses the baseline guard. Cluster capacity is consumed by the walk below,
    // not by removing all but the first member of a cluster from the search pool.
    const eligible = rank(input.rows, side).filter((row) => evaluateDynamicMom36Candidate({
      row, side, selected: [], excluded: new Set(), count,
      maxPerCluster: input.maxPerCluster, slowFastApplied: input.slowFastApplied,
    }).admissible);
    const pool = eligible.slice(0, Math.max(count, poolDepth));
    // Same pool-deepening semantics as selectSmartWithClusterCap: extend only until the
    // canonical walk can fill the quota, retaining earlier cluster alternatives in the pool.
    for (let index = pool.length; index < eligible.length
      && selectSide(pool, side, count, new Set(), input.maxPerCluster, input.slowFastApplied).selected.length < count; index++) {
      pool.push(eligible[index]!);
    }
    return pool;
  };

  const poolLongs = keep("LONG");
  const poolShorts = keep("SHORT");

  const fallback = (reason: DynamicMom36PreferenceReason, considered: number, qualifying: number, exhausted = false): DynamicMom36PreferenceOutcome => ({
    selection: "BASELINE",
    reason,
    longs: baselineLongs,
    shorts: baselineShorts,
    baselineLongs,
    baselineShorts,
    s1h: baselineS1h,
    s4h: baselineS4h,
    baselineS1h,
    baselineS4h,
    basketReturn1h: dynamicMom36BasketReturn(baselineLongs, baselineShorts, "1h"),
    basketReturn4h: dynamicMom36BasketReturn(baselineLongs, baselineShorts, "4h"),
    consideredCombinations: considered,
    qualifyingCombinations: qualifying,
    searchExhausted: exhausted,
    poolLongs: poolLongs.map((r) => r.symbol),
    poolShorts: poolShorts.map((r) => r.symbol),
  });

  if (baselineS1h === null || baselineS4h === null) return fallback("RECENT_STRENGTH_UNAVAILABLE", 0, 0);

  const chooseCount = (n: number, k: number) => {
    if (k <= 0 || k > n) return 0;
    let result = 1;
    for (let i = 1; i <= k; i++) result = result * (n - i + 1) / i;
    return Math.round(result);
  };
  const combinationsCount = chooseCount(poolLongs.length, input.finalAllocation.longCount)
    * chooseCount(poolShorts.length, input.finalAllocation.shortCount);
  if (combinationsCount === 0) return fallback("RECENT_STRENGTH_UNAVAILABLE", 0, 0);
  // Bound the search BEFORE allocating combinations, including a deepened pool.
  if (combinationsCount > maxCombinations) {
    return fallback("SEARCH_EXHAUSTED", 0, 0, true);
  }
  const longSets = combinations(poolLongs, input.finalAllocation.longCount);
  const shortSets = combinations(poolShorts, input.finalAllocation.shortCount);

  let considered = 0;
  let anyStrengthKnown = false;
  const qualifying: Array<{ longs: DynamicMom36RankedSymbol[]; shorts: DynamicMom36RankedSymbol[]; rank: number; key: string }> = [];

  for (const longs of longSets) {
    for (const shorts of shortSets) {
      considered += 1;
      const longSymbols = new Set(longs.map((r) => r.symbol));
      if (shorts.some((r) => longSymbols.has(r.symbol))) continue; // no LONG/SHORT overlap
      const validLongs = validateDynamicMom36SideCombination({
        members: longs, side: "LONG", excluded: new Set(), maxPerCluster: input.maxPerCluster, slowFastApplied: input.slowFastApplied,
        requiredCount: input.finalAllocation.longCount,
      });
      if (!validLongs) continue;
      const validShorts = validateDynamicMom36SideCombination({
        members: shorts, side: "SHORT", excluded: longSymbols, maxPerCluster: input.maxPerCluster, slowFastApplied: input.slowFastApplied,
        requiredCount: input.finalAllocation.shortCount,
      });
      if (!validShorts) continue;
      if (input.admitCombination && !input.admitCombination(validLongs, validShorts)) continue;
      const s1h = combinationSpread(validLongs, validShorts, "1h");
      const s4h = combinationSpread(validLongs, validShorts, "4h");
      if (s1h === null || s4h === null) continue;
      anyStrengthKnown = true;
      const basket1h = dynamicMom36BasketReturn(validLongs, validShorts, "1h");
      const basket4h = dynamicMom36BasketReturn(validLongs, validShorts, "4h");
      if (s1h > 0 && s4h > 0 && basket1h !== null && basket1h > 0 && basket4h !== null && basket4h > 0) {
        qualifying.push({
          longs: validLongs,
          shorts: validShorts,
          rank: aggregateRank(validLongs, validShorts, longRanks, shortRanks),
          key: comboKey(validLongs, validShorts),
        });
      }
    }
  }

  if (!anyStrengthKnown) return fallback("RECENT_STRENGTH_UNAVAILABLE", considered, 0);
  if (qualifying.length === 0) return fallback("RECENT_STRENGTH_MIXED", considered, 0);

  qualifying.sort((a, b) => (a.rank - b.rank) || a.key.localeCompare(b.key));
  const best = qualifying[0]!;
  if (best.key === baselineKey) return fallback("BASELINE_ALREADY_BEST", considered, qualifying.length);

  const baselineBasket1h = dynamicMom36BasketReturn(baselineLongs, baselineShorts, "1h");
  const baselineBasket4h = dynamicMom36BasketReturn(baselineLongs, baselineShorts, "4h");
  const baselineQualifies = baselineS1h !== null && baselineS4h !== null && baselineS1h > 0 && baselineS4h > 0
    && baselineBasket1h !== null && baselineBasket1h > 0 && baselineBasket4h !== null && baselineBasket4h > 0;
  if (baselineQualifies
      && aggregateRank(baselineLongs, baselineShorts, longRanks, shortRanks) <= best.rank) {
    return fallback("BASELINE_ALREADY_BEST", considered, qualifying.length);
  }

  return {
    selection: "PREFERRED",
    reason: "PREFERRED_RECENT_STRENGTH_ALIGNED",
    longs: best.longs,
    shorts: best.shorts,
    baselineLongs,
    baselineShorts,
    s1h: combinationSpread(best.longs, best.shorts, "1h"),
    s4h: combinationSpread(best.longs, best.shorts, "4h"),
    baselineS1h,
    baselineS4h,
    basketReturn1h: dynamicMom36BasketReturn(best.longs, best.shorts, "1h"),
    basketReturn4h: dynamicMom36BasketReturn(best.longs, best.shorts, "4h"),
    consideredCombinations: considered,
    qualifyingCombinations: qualifying.length,
    searchExhausted: false,
    poolLongs: poolLongs.map((r) => r.symbol),
    poolShorts: poolShorts.map((r) => r.symbol),
  };
}

/**
 * Selects final legs only after breadth and the bounded overlay are frozen.  The larger side is
 * chosen first solely to prevent a shared candidate from starving the required side; each side
 * remains a strict MOM36 rank walk and no symbol is reranked by the shock layer.
 */
export function selectDynamicMom36Legs(
  rows: readonly DynamicMom36RankedSymbol[],
  finalAllocation: DynamicMom36Allocation,
  maxPerCluster: number,
  opts: { slowFastApplied?: boolean } = {},
): DynamicMom36Selection {
  const slowFastApplied = opts.slowFastApplied === true;
  const longFirst = finalAllocation.longCount >= finalAllocation.shortCount;
  const firstSide: "LONG" | "SHORT" = longFirst ? "LONG" : "SHORT";
  const secondSide: "LONG" | "SHORT" = longFirst ? "SHORT" : "LONG";
  const countFor = (side: "LONG" | "SHORT") => side === "LONG" ? finalAllocation.longCount : finalAllocation.shortCount;
  const first = selectSide(rows, firstSide, countFor(firstSide), new Set(), maxPerCluster, slowFastApplied);
  const second = selectSide(
    rows,
    secondSide,
    countFor(secondSide),
    new Set(first.selected.map((row) => row.symbol)),
    maxPerCluster,
    slowFastApplied,
  );
  const selectedLongs = firstSide === "LONG" ? first.selected : second.selected;
  const selectedShorts = firstSide === "SHORT" ? first.selected : second.selected;
  const longAudit = firstSide === "LONG" ? first.audit : second.audit;
  const shortAudit = firstSide === "SHORT" ? first.audit : second.audit;
  const blockedShortsSkipped = [...new Set([...first.blockedSkipped, ...second.blockedSkipped])];
  const enough = selectedLongs.length === finalAllocation.longCount && selectedShorts.length === finalAllocation.shortCount;
  const availability = (audit: DynamicMom36CandidateSelectionAudit[]) => ({
    aligned: audit.filter((candidate) => candidate.slowFastAligned && candidate.skipReason !== "OPPOSITE_SIDE_SELECTED").length,
    executionEligibleAligned: audit.filter((candidate) =>
      candidate.slowFastAligned && candidate.executionEligible && candidate.skipReason !== "OPPOSITE_SIDE_SELECTED",
    ).length,
  });
  const longAvailability = availability(longAudit);
  const shortAvailability = availability(shortAudit);
  return {
    selectedLongs,
    selectedShorts,
    blockedShortsSkipped,
    insufficientReason: enough
      ? null
      : rows.length < 6
        ? "active inference universe has fewer than six symbols"
        : "insufficient ranked execution-eligible symbols after current pool, blocklist, and cluster guards",
    candidateAudit: { long: longAudit, short: shortAudit },
    requiredLongs: finalAllocation.longCount,
    requiredShorts: finalAllocation.shortCount,
    availableAlignedLongs: longAvailability.aligned,
    availableAlignedShorts: shortAvailability.aligned,
    availableExecutionEligibleAlignedLongs: longAvailability.executionEligibleAligned,
    availableExecutionEligibleAlignedShorts: shortAvailability.executionEligibleAligned,
    slowFastApplied,
  };
}

function isStrictSlowFastMode(mode: DynamicMom36SlowFastMode): boolean {
  return mode === "STRICT" || mode === "STRICT_DIRECTIONAL_FEASIBILITY";
}

function isDirectionalFeasibilityMode(mode: DynamicMom36SlowFastMode): boolean {
  return mode === "STRICT_DIRECTIONAL_FEASIBILITY";
}

function directionalPriorFor(
  requestedAllocation: DynamicMom36Allocation,
  baseAllocation: DynamicMom36Allocation,
): DynamicMom36DirectionalFeasibilityDirection | null {
  const directionFor = (allocationValue: DynamicMom36Allocation): DynamicMom36DirectionalFeasibilityDirection | null => {
    if (allocationValue.longCount > allocationValue.shortCount) return "LONG";
    if (allocationValue.shortCount > allocationValue.longCount) return "SHORT";
    return null;
  };
  // The bounded final allocation owns the prior. A neutral final allocation may inherit only the
  // original breadth direction; neutral breadth never manufactures a directional fallback.
  return directionFor(requestedAllocation) ?? directionFor(baseAllocation);
}

function directionalFeasibilityLongCounts(
  requestedAllocation: DynamicMom36Allocation,
  directionalPrior: DynamicMom36DirectionalFeasibilityDirection,
): number[] {
  if (directionalPrior === "LONG") {
    const first = requestedAllocation.longCount >= 3 ? requestedAllocation.longCount + 1 : 4;
    return Array.from({ length: Math.max(0, 7 - first) }, (_, index) => first + index)
      .filter((longCount) => longCount <= 6);
  }
  const first = requestedAllocation.longCount <= 3 ? requestedAllocation.longCount - 1 : 2;
  return Array.from({ length: Math.max(0, first + 1) }, (_, index) => first - index)
    .filter((longCount) => longCount >= 0);
}

function completeSelection(selection: DynamicMom36Selection): boolean {
  return selection.insufficientReason === null &&
    selection.selectedLongs.length + selection.selectedShorts.length === 6;
}

function resolveDirectionalFeasibility(input: {
  active: boolean;
  vetoed: boolean;
  rows: readonly DynamicMom36RankedSymbol[];
  baseAllocation: DynamicMom36Allocation;
  requestedAllocation: DynamicMom36Allocation;
  requestedStrictSelection: DynamicMom36Selection;
  maxPerCluster: number;
  /** Optional executable geometry boundary. Fallbacks may never widen beyond this set. */
  allowedLongCounts?: readonly number[];
}): {
  selection: DynamicMom36Selection | null;
  allocation: DynamicMom36Allocation | null;
  audit: DynamicMom36DirectionalFeasibility;
} {
  const disabled = (outcome: DynamicMom36DirectionalFeasibilityOutcome): DynamicMom36DirectionalFeasibility => ({
    active: input.active,
    requestedAllocation: input.requestedAllocation,
    directionalPrior: null,
    outcome,
    attempts: [],
    effectiveAllocation: outcome === "REQUESTED_STRICT_FEASIBLE" ? input.requestedAllocation : null,
  });
  if (!input.active) return { selection: null, allocation: null, audit: disabled("DISABLED") };
  if (input.vetoed) return { selection: null, allocation: null, audit: disabled("VETOED") };
  if (completeSelection(input.requestedStrictSelection)) {
    return { selection: null, allocation: null, audit: disabled("REQUESTED_STRICT_FEASIBLE") };
  }

  const directionalPrior = directionalPriorFor(input.requestedAllocation, input.baseAllocation);
  if (!directionalPrior) {
    return {
      selection: null,
      allocation: null,
      audit: {
        active: true,
        requestedAllocation: input.requestedAllocation,
        directionalPrior: null,
        outcome: "NO_DIRECTIONAL_PRIOR",
        attempts: [],
        effectiveAllocation: null,
      },
    };
  }

  const attempts: DynamicMom36DirectionalFeasibility["attempts"] = [];
  for (const longCount of directionalFeasibilityLongCounts(input.requestedAllocation, directionalPrior)
    .filter((candidate) => allocationIsAllowed(candidate, input.allowedLongCounts))) {
    const candidateAllocation = allocation(longCount);
    const candidateSelection = selectDynamicMom36Legs(
      input.rows,
      candidateAllocation,
      input.maxPerCluster,
      { slowFastApplied: true },
    );
    const complete = completeSelection(candidateSelection);
    attempts.push({
      allocation: candidateAllocation,
      selectedLongs: candidateSelection.selectedLongs.map((row) => row.symbol),
      selectedShorts: candidateSelection.selectedShorts.map((row) => row.symbol),
      selectionInsufficientReason: candidateSelection.insufficientReason,
      complete,
    });
    if (complete) {
      return {
        selection: candidateSelection,
        allocation: candidateAllocation,
        audit: {
          active: true,
          requestedAllocation: input.requestedAllocation,
          directionalPrior,
          outcome: "FALLBACK_APPLIED",
          attempts,
          effectiveAllocation: candidateAllocation,
        },
      };
    }
  }
  return {
    selection: null,
    allocation: null,
    audit: {
      active: true,
      requestedAllocation: input.requestedAllocation,
      directionalPrior,
      outcome: "NO_FULL_STRICT_ALLOCATION",
      attempts,
      effectiveAllocation: null,
    },
  };
}

export function buildDynamicMom36Formation(input: {
  activeUniverse: readonly DynamicMom36RankedSymbol[];
  maxPerCluster: number;
  shock?: FrozenShockOverlay;
  continuation?: FrozenContinuationOverlay | null;
  continuationRuntime?: DynamicMom36ContinuationRuntimeResult | null;
  /** Continuation versions have no legacy shock fallback: unavailable continuation means base MOM36, never a veto. */
  continuationOnly?: boolean;
  /** Exact recovered legacy per-leg eligibility after the final allocation is frozen. */
  slowFastRequired?: boolean;
  /** Versioned application of the recovered per-leg predicate. `slowFastRequired` remains for V4-compatible callers. */
  slowFastMode?: DynamicMom36SlowFastMode;
  /** Optional policy boundary for executable six-leg geometry. Omitted retains historical breadth behaviour. */
  allowedLongCounts?: readonly number[];
}): DynamicMom36Formation {
  const activeUniverse = [...input.activeUniverse]
    .filter((row) => Number.isFinite(row.mom36) && Number.isFinite(row.price) && row.price > 0)
    .sort((a, b) => b.mom36 - a.mom36 || a.symbol.localeCompare(b.symbol));
  const breadth = baseDynamicMom36Allocation(activeUniverse);
  const baseSelection = selectDynamicMom36Legs(activeUniverse, breadth.allocation, input.maxPerCluster);
  const continuationOnly = input.continuationOnly === true;
  const slowFastMode = input.slowFastMode ?? (input.slowFastRequired === true ? "STRICT" : "OFF");
  // The frozen V1 shock artifact and the V3 continuation artifact are deliberately disjoint.
  // A missing V3 result must not fall through to a future/accidentally-registered V1 shock
  // mapping, because that would turn the mandated BASE fallback into an undeclared veto.
  const shock = continuationOnly
    ? noEdgeShockOverlay("v3 uses continuation-only formation", null)
    : input.shock ?? resolveFrozenRuntimeShockOverlay();
  const continuation = input.continuation ??
    (input.continuationRuntime
      ? normalizeFrozenV4ContinuationOverlay(input.continuationRuntime, breadth.allocation)
      : continuationOnly
        ? noEdgeContinuationOverlay("frozen continuation runtime unavailable", null)
        : null);
  const overlay = continuationOnly
    ? { allocation: applyBoundedContinuationOverlay(breadth.allocation, continuation!), vetoed: false }
    : continuation
      ? { allocation: applyBoundedContinuationOverlay(breadth.allocation, continuation), vetoed: false }
      : applyBoundedShockOverlay(breadth.allocation, shock);
  const requestedAllocation = constrainDynamicMom36Allocation(overlay.allocation, input.allowedLongCounts);
  const rawV3Selection = selectDynamicMom36Legs(activeUniverse, requestedAllocation, input.maxPerCluster);
  const slowFastStrictSelection = slowFastMode === "OFF"
    ? null
    : selectDynamicMom36Legs(activeUniverse, requestedAllocation, input.maxPerCluster, { slowFastApplied: true });
  let selection: DynamicMom36Selection;
  let selectionSource: DynamicMom36SelectionSource;
  let finalAllocation = requestedAllocation;
  let directionalFeasibility: DynamicMom36DirectionalFeasibility = {
    active: false,
    requestedAllocation,
    directionalPrior: null,
    outcome: "DISABLED",
    attempts: [],
    effectiveAllocation: null,
  };
  if (overlay.vetoed) {
    selection = {
      ...rawV3Selection,
      selectedLongs: [],
      selectedShorts: [],
      insufficientReason: "frozen shock mapping vetoed this candidate",
    };
    selectionSource = "VETOED";
    directionalFeasibility = {
      active: isDirectionalFeasibilityMode(slowFastMode),
      requestedAllocation,
      directionalPrior: null,
      outcome: "VETOED",
      attempts: [],
      effectiveAllocation: null,
    };
  } else if (isStrictSlowFastMode(slowFastMode)) {
    selection = slowFastStrictSelection!;
    selectionSource = "STRICT_SLOW_FAST";
    const feasibility = resolveDirectionalFeasibility({
      active: isDirectionalFeasibilityMode(slowFastMode),
      vetoed: overlay.vetoed,
      rows: activeUniverse,
      baseAllocation: breadth.allocation,
      requestedAllocation,
      requestedStrictSelection: selection,
      maxPerCluster: input.maxPerCluster,
      allowedLongCounts: input.allowedLongCounts,
    });
    directionalFeasibility = feasibility.audit;
    if (feasibility.selection && feasibility.allocation) {
      selection = feasibility.selection;
      finalAllocation = feasibility.allocation;
      selectionSource = "STRICT_SLOW_FAST_DIRECTIONAL_FEASIBILITY";
    }
    // V4/V6 may never borrow an unaligned candidate. V6 may only substitute an entire, nearest
    // strict-and-executable directional allocation from the same frozen snapshot.
    if (rawV3Selection.insufficientReason === null && selection.insufficientReason !== null) {
      selection = { ...selection, insufficientReason: "INSUFFICIENT_SLOW_FAST_ALIGNED_LEGS" };
    }
  } else if (slowFastMode === "PREFER" && slowFastStrictSelection?.insufficientReason === null) {
    selection = slowFastStrictSelection;
    selectionSource = "STRICT_SLOW_FAST";
  } else if (slowFastMode === "PREFER" && rawV3Selection.insufficientReason === null) {
    // V5 is intentionally not a partial-basket policy: this is the original, complete raw V3
    // rank walk from the same data cut, allocation, execution guards, and cluster cap.
    selection = rawV3Selection;
    selectionSource = "RAW_V3_FALLBACK";
  } else {
    selection = rawV3Selection;
    selectionSource = "RAW_V3";
  }
  // Baseline ONLY. The production caller must admit this basket before applying preference.
  return {
    preference: null,
    activeUniverse,
    positiveCount: breadth.positiveCount,
    negativeCount: breadth.negativeCount,
    zeroCount: breadth.zeroCount,
    baseAllocation: breadth.allocation,
    baseSelection,
    rawV3Selection,
    slowFastStrictSelection,
    shock,
    continuation,
    slowFast: {
      active: slowFastMode !== "OFF",
      mode: slowFastMode,
      policyId: slowFastMode !== "OFF" ? DYNAMIC_MOM36_SLOW_FAST_POLICY_ID : null,
      implementationVersion: slowFastMode !== "OFF" ? DYNAMIC_MOM36_SLOW_FAST_IMPLEMENTATION_VERSION : null,
      interval: slowFastMode !== "OFF" ? DYNAMIC_MOM36_SLOW_FAST_INTERVAL : null,
      slowBars: slowFastMode !== "OFF" ? DYNAMIC_MOM36_SLOW_FAST_SLOW_BARS : null,
      fastBars: slowFastMode !== "OFF" ? DYNAMIC_MOM36_SLOW_FAST_FAST_BARS : null,
    },
    requestedAllocation,
    directionalFeasibility,
    finalAllocation,
    vetoed: overlay.vetoed,
    selectionSource,
    selection,
  };
}

/** Complete admission is deliberately injected by the production formation caller, not copied. */
export function applyDynamicMom36Preference(
  baseline: DynamicMom36Formation,
  options: {
    maxPerCluster: number;
    admit: (candidate: DynamicMom36Formation) => boolean;
    maxCombinations?: number;
    includeSkew?: boolean;
  },
): DynamicMom36Formation {
  const { selection, finalAllocation } = baseline;
  if (baseline.vetoed || selection.insufficientReason !== null
    || selection.selectedLongs.length !== finalAllocation.longCount
    || selection.selectedShorts.length !== finalAllocation.shortCount
    || !(finalAllocation.longCount === 3 && finalAllocation.shortCount === 3
      || options.includeSkew === true && [2, 4].includes(finalAllocation.longCount)
        && finalAllocation.shortCount === 6 - finalAllocation.longCount)
    || !options.admit(baseline)) return baseline;
  const withMembers = (longs: DynamicMom36RankedSymbol[], shorts: DynamicMom36RankedSymbol[]): DynamicMom36Formation => ({
    ...baseline, selection: { ...selection, selectedLongs: longs, selectedShorts: shorts },
  });
  const preference = selectPreferredDynamicMom36Combination({
    rows: baseline.activeUniverse,
    baselineLongs: selection.selectedLongs, baselineShorts: selection.selectedShorts,
    finalAllocation, maxPerCluster: options.maxPerCluster,
    slowFastApplied: isStrictSlowFastMode(baseline.slowFast.mode),
    maxCombinations: options.maxCombinations,
    admitCombination: (longs, shorts) => options.admit(withMembers(longs, shorts)),
  });
  // Preserve every baseline object/weight on fallback; only add provenance.
  return { ...withMembers(preference.longs, preference.shorts), preference };
}

export function crossSectionalStrategyVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env.CROSS_SECTIONAL_STRATEGY_VERSION?.trim() || "legacy-cross-sectional";
}

export function isDynamicMom36ShockStrategy(env: NodeJS.ProcessEnv = process.env): boolean {
  return isDynamicMom36Version(crossSectionalStrategyVersion(env));
}

export function isDynamicMom36ShockVersion(strategyVersion: string | null | undefined): boolean {
  return isDynamicMom36Version(strategyVersion);
}

export function isDynamicMom36V3Strategy(env: NodeJS.ProcessEnv = process.env): boolean {
  return crossSectionalStrategyVersion(env) === DYNAMIC_MOM36_CONTINUATION_SL2_MFE30_36H_V3;
}

export function isDynamicMom36V3Version(strategyVersion: string | null | undefined): boolean {
  return strategyVersion === DYNAMIC_MOM36_CONTINUATION_SL2_MFE30_36H_V3;
}

/** V3 and V4 share the same pinned continuation artifact and frozen -2%/MFE/36h exit contract. */
export function isDynamicMom36ContinuationStrategy(env: NodeJS.ProcessEnv = process.env): boolean {
  return isDynamicMom36ContinuationVersion(crossSectionalStrategyVersion(env));
}

export function isDynamicMom36ContinuationVersion(strategyVersion: string | null | undefined): boolean {
  return strategyVersion === DYNAMIC_MOM36_CONTINUATION_SL2_MFE30_36H_V3 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_SL2_MFE30_36H_V4 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_PREFERRED_SL2_MFE30_36H_V5 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_SL2_MFE30_36H_V6 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_ONE_SIDED_DIRECTIONAL_QUALITY_SL2_MFE30_36H_V6_2 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_ZERO_NEUTRAL_BREADTH_ONE_SIDED_DIRECTIONAL_QUALITY_SL2_MFE30_36H_V6_3 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_BOUNDED_SKEW_SL2_MFE30_36H_V6_4 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_TESTNET_WIDE_SKEW_SL2_MFE30_36H_V6_5;
}

/** V6.1 is the first Dynamic identity whose executor requires persisted final-plan admission parity. */
export function isDynamicMom36FinalAllocationAdmissionVersion(strategyVersion: string | null | undefined): boolean {
  return strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_ONE_SIDED_DIRECTIONAL_QUALITY_SL2_MFE30_36H_V6_2 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_ZERO_NEUTRAL_BREADTH_ONE_SIDED_DIRECTIONAL_QUALITY_SL2_MFE30_36H_V6_3 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_BOUNDED_SKEW_SL2_MFE30_36H_V6_4 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_TESTNET_WIDE_SKEW_SL2_MFE30_36H_V6_5;
}

/** V6.2+ switch; older formation records remain immutable historical evidence. */
export function isDynamicMom36OneSidedDirectionalQualityVersion(strategyVersion: string | null | undefined): boolean {
  return strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_ONE_SIDED_DIRECTIONAL_QUALITY_SL2_MFE30_36H_V6_2 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_ZERO_NEUTRAL_BREADTH_ONE_SIDED_DIRECTIONAL_QUALITY_SL2_MFE30_36H_V6_3 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_BOUNDED_SKEW_SL2_MFE30_36H_V6_4 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_TESTNET_WIDE_SKEW_SL2_MFE30_36H_V6_5;
}

/** V4 and V5 both evaluate the recovered per-leg SLOW_AND_FAST predicate. */
export function isDynamicMom36SlowFastStrategy(env: NodeJS.ProcessEnv = process.env): boolean {
  return isDynamicMom36SlowFastVersion(crossSectionalStrategyVersion(env));
}

export function isDynamicMom36SlowFastVersion(strategyVersion: string | null | undefined): boolean {
  return dynamicMom36SlowFastMode(strategyVersion) !== "OFF";
}

/** Returns the versioned SLOW_AND_FAST application rule without reading process state. */
export function dynamicMom36SlowFastMode(strategyVersion: string | null | undefined): DynamicMom36SlowFastMode {
  if (strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_SL2_MFE30_36H_V4) return "STRICT";
  if (strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_PREFERRED_SL2_MFE30_36H_V5) return "PREFER";
  if (
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_SL2_MFE30_36H_V6 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_ONE_SIDED_DIRECTIONAL_QUALITY_SL2_MFE30_36H_V6_2 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_ZERO_NEUTRAL_BREADTH_ONE_SIDED_DIRECTIONAL_QUALITY_SL2_MFE30_36H_V6_3 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_BOUNDED_SKEW_SL2_MFE30_36H_V6_4 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_TESTNET_WIDE_SKEW_SL2_MFE30_36H_V6_5
  ) {
    return "STRICT_DIRECTIONAL_FEASIBILITY";
  }
  return "OFF";
}

export function isDynamicMom36SlowFastStrictVersion(strategyVersion: string | null | undefined): boolean {
  return isStrictSlowFastMode(dynamicMom36SlowFastMode(strategyVersion));
}

export function isDynamicMom36Version(strategyVersion: string | null | undefined): strategyVersion is DynamicMom36StrategyVersion {
  return strategyVersion === DYNAMIC_MOM36_SHOCK_36H_V1 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SL2_MFE30_36H_V3 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_SL2_MFE30_36H_V4 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_PREFERRED_SL2_MFE30_36H_V5 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_SL2_MFE30_36H_V6 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_ONE_SIDED_DIRECTIONAL_QUALITY_SL2_MFE30_36H_V6_2 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_ZERO_NEUTRAL_BREADTH_ONE_SIDED_DIRECTIONAL_QUALITY_SL2_MFE30_36H_V6_3 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_BOUNDED_SKEW_SL2_MFE30_36H_V6_4 ||
    strategyVersion === DYNAMIC_MOM36_CONTINUATION_SLOWFAST_TESTNET_WIDE_SKEW_SL2_MFE30_36H_V6_5;
}

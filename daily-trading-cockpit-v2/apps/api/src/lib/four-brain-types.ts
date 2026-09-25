/**
 * Four-Brain intelligence layer — shared types (Phase 1, REPORT-ONLY). Four SEPARATE brains sit on top of
 * the existing CORTEX allocator + the incumbent lane/signal engine + safety rails; each reasons about ONE
 * thing (market state / direction / entry timing / exit timing), emits a typed decision, and DRIVES
 * NOTHING. CORTEX stays the capital allocator and risk rails retain final safety authority. Every brain fails OPEN to incumbent
 * behavior: missing/stale data → a conservative UNKNOWN/FLAT/SKIP/HOLD that never forces an action.
 *
 * Target flow (each arrow is report-only in Phase 1):
 *   RAW DATA → Market State → Direction → [incumbent lane/signal engine] → Entry → CORTEX alloc →
 *   [incumbent safety + execution rails] → Exit
 *
 * The OUTPUT contracts below are the operator's exact Phase-1 schemas. The pure decision cores live in
 * market-state-brain.ts / direction-brain.ts / entry-brain.ts / exit-brain.ts; the executive combiner in
 * executive-decision.ts; invariants in four-brain-invariants.ts; the append-only report journal in
 * four-brain-journal.ts. NONE import execution / order-placement / setAllocations / position-mutation.
 */

import type { AllocationContext, MarketContextLineage } from "./authority-contract.js";

/** off (default) = zero new-brain I/O (a pure no-op — nothing computed, nothing journaled); shadow = the
 *  four brains decide + journal, driving NOTHING; live = reserved for a future, separately-approved phase.
 *  Anything unrecognized ⇒ off (safe). Mirrors CENTRAL_BRAIN_MODE's gate discipline. */
export type FourBrainMode = "off" | "shadow" | "live";
export function fourBrainMode(env: NodeJS.ProcessEnv = process.env): FourBrainMode {
  const v = (env.FOUR_BRAIN_MODE ?? "").trim().toLowerCase();
  return v === "shadow" ? "shadow" : v === "live" ? "live" : "off";
}

export const MARKET_STATE_SCHEMA_VERSION = "market-state/1";
export const DIRECTION_SCHEMA_VERSION = "direction/1";
export const ENTRY_SCHEMA_VERSION = "entry/1";
export const EXIT_SCHEMA_VERSION = "exit/1";
export const EXECUTIVE_SCHEMA_VERSION = "executive/2";

/** Per-source freshness/availability. FRESH = usable; STALE = too old (neutral-filled); MISSING = absent
 *  (neutral-filled, never fabricated); ERROR = present-but-invalid (NaN / future timestamp / causal break). */
export type SourceStatus = "FRESH" | "STALE" | "MISSING" | "ERROR";
export type SourceStatuses = Record<string, SourceStatus>;

// ── Output contracts (verbatim from the Phase-1 spec) ─────────────────────────────────────────────

export type MarketStateFamily =
  | "TREND"
  | "RANGE"
  | "BREAKOUT"
  | "SQUEEZE"
  | "PANIC"
  | "RECOVERY"
  | "EVENT_DRIVEN"
  | "UNKNOWN";
export type MarketBias = "BULLISH" | "BEARISH" | "MIXED" | "NEUTRAL";
export type VolatilityBand = "LOW" | "NORMAL" | "HIGH" | "EXTREME";
export type LiquidityBand = "THIN" | "NORMAL" | "DEEP" | "UNKNOWN";

/**
 * On the focussed testnet rollout, the executor's canonical regime is the
 * authority for an actionable market label. The Four-Brain technical
 * classifier remains available for audit, but may not silently relabel the
 * same market as an independent execution regime.
 */
export interface MarketStateAuthority {
  source: "TESTNET_EXECUTOR";
  canonicalRegimeFamily: "BULLISH" | "BEARISH" | "MIXED" | "UNKNOWN";
  scannerRegime: string | null;
  capturedAtMs: number | null;
}

export interface MarketStateDecision {
  schemaVersion: string;
  decisionId: string;
  asOfMs: number;
  validUntilMs: number;
  family: MarketStateFamily;
  bias: MarketBias;
  volatility: VolatilityBand;
  liquidity: LiquidityBand;
  transitionRisk: number; // 0..1
  confidence: number; // 0..1
  components: {
    trendScore: number | null;
    volatilityScore: number | null;
    liquidityScore: number | null;
    breadthScore: number | null;
    momentumScore: number | null;
    eventRiskScore: number | null;
    sentimentScore: number | null;
  };
  reasons: string[];
  sourceStatuses: SourceStatuses;
  /** Present only where an executor regime is explicitly authoritative. */
  authority?: MarketStateAuthority | null;
}

export type DirectionHorizon = "SCALP" | "INTRADAY" | "SWING";
export type DirectionAction = "LONG" | "SHORT" | "BOTH" | "FLAT";

export interface DirectionEvidenceFamily {
  available: boolean;
  contribution: number | null;
  credibilityPenalty: number | null;
  reasons: string[];
}

export interface DirectionDecision {
  schemaVersion: string;
  decisionId: string;
  asOfMs: number;
  validUntilMs: number;
  horizon: DirectionHorizon;
  modelScope: "MARKET_LEVEL";
  evaluationHorizon: DirectionHorizon;
  /** The one canonical verdict; `action` is retained as a compatibility projection. */
  marketDirection: "LONG" | "SHORT" | "FLAT";
  action: DirectionAction;
  longScore: number; // 0..1
  shortScore: number; // 0..1
  flatScore: number; // 0..1 — a REAL competing baseline
  confidence: number; // 0..1
  directionConfidence: number;
  dataCoverage: number;
  directionEvidenceFamilies: {
    marketStructure: DirectionEvidenceFamily;
    incumbentEconomic: DirectionEvidenceFamily;
    externalForecasts: DirectionEvidenceFamily;
    flow: DirectionEvidenceFamily;
    selfEvidence: DirectionEvidenceFamily;
  };
  expectedDirectionalR: number | null; // R (net of cost), from proven edge-memory; null if unknown
  supportingSignals: string[];
  conflictingSignals: string[];
  sourceStatuses: SourceStatuses;
}

export type EntryAction = "ENTER_NOW" | "WAIT_PULLBACK" | "WAIT_BREAKOUT" | "WAIT_CONFIRMATION" | "SKIP";
export type EntrySide = "LONG" | "SHORT";
export type EntryOrderType = "MARKET" | "LIMIT" | "STOP_LIMIT";

/**
 * Read-only reinforcement earned from CLOSED, exact testnet fills.  It is
 * deliberately a recommendation-quality adjustment, never an allocation,
 * sizing, or order authority.
 */
export type FourBrainReinforcementVerdict = "INSUFFICIENT" | "NEUTRAL" | "POSITIVE" | "NEGATIVE";
export interface FourBrainExecutionReinforcement {
  source: "TIER1_REALIZED";
  verdict: FourBrainReinforcementVerdict;
  /** Only exact lane × canonical-regime × symbol × side evidence may earn a non-zero adjustment. */
  scope: "EXACT_LANE_REGIME_SYMBOL" | "NONE";
  canonicalRegimeFamily: "BULLISH" | "BEARISH" | "MIXED" | "UNKNOWN" | null;
  laneId: string | null;
  symbolOrBasketId: string | null;
  side: "LONG" | "SHORT";
  /** Raw matched-fill count, kept separately from the conservative block count. */
  n: number;
  /** Non-overlapping four-hour decision blocks; this is the sufficiency gate. */
  effectiveN: number;
  winRate: number | null;
  avgNetR: number | null;
  /** Bounded [-0.10, +0.10], advisory-only. */
  adjustment: number;
}

export interface EntryDecision {
  schemaVersion: string;
  decisionId: string;
  asOfMs: number;
  validUntilMs: number;
  action: EntryAction;
  side: EntrySide;
  orderType: EntryOrderType;
  targetEntry: number | null;
  invalidationPrice: number | null;
  initialStopPrice: number | null;
  expectedNetR: number | null; // R after est. fees + slippage; null if unknown
  chaseRisk: number; // 0..1
  slippageRisk: number; // 0..1
  confidence: number; // 0..1
  reasons: string[];
  sourceStatuses: SourceStatuses;
}

export type ExitAction = "HOLD" | "TIGHTEN_STOP" | "MOVE_TO_BREAKEVEN" | "SCALE_OUT" | "TRAIL" | "EXIT_NOW";
export type ExitPathAssessment = "HOLD_PATH_OK" | "TIGHTEN_PATH_RISK" | "TIME_DECAY" | "HARD_RISK_EXIT" | "MISSING_THESIS_STATE";

export interface ExitDecision {
  schemaVersion: string;
  decisionId: string;
  asOfMs: number;
  validUntilMs: number;
  action: ExitAction;
  /** Advisory path assessment. It never mutates a stop, TP, or order. */
  pathAssessment: ExitPathAssessment;
  exitFraction: number; // 0..1
  edgeRemainingR: number | null; // R; null if unknown
  reversalRisk: number; // 0..1
  continuationProbability: number; // 0..1
  suggestedStop: number | null; // NEVER looser than the incumbent hard stop (invariant-enforced)
  suggestedTrailDistance: number | null; // >= 0
  reasons: string[];
  sourceStatuses: SourceStatuses;
}

export type ExecutiveCandidateStatus =
  | "VALID"
  | "FLAT"
  | "WAIT"
  | "SKIP"
  | "BLOCKED_BY_RISK"
  | "MISSING_DATA"
  | "INCUMBENT_ONLY";

export interface ExecutiveDecision {
  schemaVersion: string;
  decisionId: string;
  asOfMs: number;
  marketState: MarketStateDecision;
  direction: DirectionDecision | null;
  entry: EntryDecision | null;
  exit: ExitDecision | null;
  allocationContext: AllocationContext;
  marketContext: MarketContextLineage;
  laneId: string | null;
  symbolOrBasketId: string | null;
  /** Exact-fill reinforcement snapshot consumed for this advisory review, if one exists. */
  executionReinforcement?: FourBrainExecutionReinforcement | null;
  /**
   * Shadow-only rank data.  It is deliberately separate from candidateStatus: a positive exact
   * actual-fill cohort can reorder otherwise-valid Four-Brain candidates, but it cannot alter an
   * incumbent allocation, size, stop, or entry gate by itself.
   */
  shadowRanking?: {
    baseExpectedNetR: number | null;
    reinforcementAdjustment: number;
    adjustedExpectedNetR: number | null;
    rank: number | null;
    rankEligible: boolean;
  } | null;
  candidateStatus: ExecutiveCandidateStatus;
  disagreements: string[];
  reasons: string[];
  reportOnly: true;
  advisoryOnly: true;
}

// ── Shared pure helpers ───────────────────────────────────────────────────────────────────────────

/** Deterministic decision id (NO Date.now / random — the cores stay pure + fixtures replay identically).
 *  `${prefix}-${asOfMs}-${hash(key)}`. */
export function fourBrainDecisionId(prefix: string, asOfMs: number, key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i += 1) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0; // djb2
  const t = Number.isFinite(asOfMs) ? Math.trunc(asOfMs) : 0;
  return `${prefix}-${t}-${h.toString(36)}`;
}

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
export function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return x < lo ? lo : x > hi ? hi : x;
}
/** A finite fallback: non-finite/undefined → `fallback`. */
export function finiteOr(x: number | null | undefined, fallback: number): number {
  return typeof x === "number" && Number.isFinite(x) ? x : fallback;
}

/**
 * A freshness-tagged source reading: a value + the EVENT time it is as-of. The cores derive SourceStatus
 * from this so the causal + staleness contract is enforced in one tested place — never scattered.
 */
export interface TaggedSource<T = number> {
  value: T | null | undefined;
  /** Event/wall-clock time the value is as-of. null ⇒ treated as always-current (static/config). */
  asOfMs?: number | null;
}

/**
 * Classify a source against the decision's nowMs + a TTL. This is THE freshness/causal contract:
 *   • null/undefined value ⇒ MISSING (never fabricate a value)
 *   • asOfMs in the FUTURE (> nowMs + small skew) ⇒ ERROR (causal violation — a future timestamp is rejected)
 *   • numeric value non-finite ⇒ ERROR
 *   • asOfMs older than ttlMs ⇒ STALE (caller neutral-fills)
 *   • otherwise ⇒ FRESH
 * A null asOfMs means "no timestamp" — treated as current (config/static sources), so FRESH if the value
 * is present + finite.
 */
export function classifySource(src: TaggedSource | null | undefined, nowMs: number, ttlMs: number, skewMs = 60_000): SourceStatus {
  if (src == null || src.value == null) return "MISSING";
  if (typeof src.value === "number" && !Number.isFinite(src.value)) return "ERROR";
  const asOf = src.asOfMs;
  if (typeof asOf === "number") {
    if (!Number.isFinite(asOf)) return "ERROR";
    if (asOf > nowMs + skewMs) return "ERROR"; // future timestamp — causal break, rejected
    if (Number.isFinite(ttlMs) && ttlMs > 0 && nowMs - asOf > ttlMs) return "STALE";
  } else if (Number.isFinite(ttlMs) && ttlMs > 0) {
    // 2026-07-26: an UNTIMED value under a configured TTL is STALE, not FRESH.
    //
    // RawReadingInput.observedAtMs is deliberately `number | null`, so a producer can legitimately
    // hand over a value it has no timestamp for. Falling through to FRESH made that case claim a
    // freshness guarantee nothing had checked — a fail-OPEN on the very contract this function
    // exists to enforce, and it was silent: the payload said FRESH.
    //
    // Observed on 3101: app.ts derives every Direction reading's observedAtMs from `axisAtMs`
    // (`axis.current?.at ? Date.parse(...) : null`). With axisScore MISSING, axis.current is null,
    // so longEdge / conviction / longLaneEdge / shortLaneEdge all arrived untimed and were reported
    // FRESH *forever* — a permanently green freshness panel over values of unknown age.
    //
    // A caller that passed a TTL is asserting "this value must be recent". Without a timestamp that
    // assertion is uncheckable, so the honest answer is STALE (fail-closed). Downstream already
    // handles it correctly and without special-casing: toTagged() and freshValueOr() both drop any
    // non-FRESH value. A caller that genuinely does not care about age passes ttlMs <= 0 (or a
    // non-finite TTL) and still gets FRESH, so untimed-but-timeless sources are unaffected.
    return "STALE";
  }
  return "FRESH";
}

/** The numeric value of a source ONLY if FRESH, else `neutral` (never a stale/missing/future value). */
export function freshValueOr(src: TaggedSource | null | undefined, status: SourceStatus, neutral: number): number {
  return status === "FRESH" && typeof src?.value === "number" ? src.value : neutral;
}

/** True if a decision's validity window is well-formed (validUntil >= asOf). */
export function validWindow(asOfMs: number, validUntilMs: number): boolean {
  return Number.isFinite(asOfMs) && Number.isFinite(validUntilMs) && validUntilMs >= asOfMs;
}

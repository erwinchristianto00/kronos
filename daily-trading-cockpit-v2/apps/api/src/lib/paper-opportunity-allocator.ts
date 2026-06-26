/**
 * PAPER OPPORTUNITY ALLOCATOR V1 (REPORT-ONLY, PAPER-ONLY)
 *
 * Closes the source-starvation gap in the paper execution router. The legacy
 * paper router only mirrors CLOSED current-guard variant-matrix observations,
 * so after paperStartAt no new paper orders are ever created and the paper
 * total stays 0 even while /api/scan keeps returning fresh candidates.
 *
 * This module evaluates EVERY fresh scan candidate × paper lane directly:
 *  - It constructs the lane geometry from the scan candidate itself
 *    (deriveVariantGeometry) — it does NOT wait for a pre-existing observation.
 *  - If a candidate×lane passes the regime, lane-economics, geometry, freshness
 *    and dedupe gates, it becomes a paper opportunity (paper order is created by
 *    paper-execution-router.admitPaperOpportunities — order creation stays in
 *    one place).
 *  - If nothing passes, it emits detailed rejection diagnostics plus a universe
 *    rotation suggestion (never a bare "blocker: none").
 *
 * HARD INVARIANTS (do not weaken):
 *  - reportOnly: true and paperOnly: true on the report.
 *  - liveBlocked stays TRUE; microPilotAllowed stays FALSE. This module never
 *    sets, overrides, or returns live-trading approval.
 *  - NEVER writes to data/shadow-positions.json. The only store written is the
 *    isolated paper-execution-router store (via admitPaperOpportunities).
 *  - NEVER places a real exchange order.
 *  - No strategy / admission / criteria / route-selection changes anywhere.
 *  - Anti-lookahead: uses the SOURCE scan finished timestamp for the freshness
 *    window — never the brief request time. Candidates that predate paperStartAt
 *    are excluded from admission.
 */

import type { Candidate, Direction } from "@dtc/shared";

import {
  BULL_SCALEOUT_VARIANT_ID,
  BULL_TREND_VARIANT_ID,
  VARIANT_MATRIX_DEFINITIONS,
  deriveVariantGeometry,
  stopDistanceBpsOf,
  WIDE_STOP_MIN_BPS,
  WATCHABLE_MIN_FRESH,
  PF_STRONG,
  type VariantMatrixSignal,
  type VariantMatrixVariantId,
  type CurrentGuardVariantMatrixReport,
} from "./current-guard-variant-matrix.js";
import {
  LONG_WIDE_PAPER_LANE_ID,
  type AdaptiveLaneRouterReport,
} from "./adaptive-lane-router.js";
import {
  PAPER_ADMISSION_MAX_AGE_MS,
  allocatorDedupeKey,
  paperStopBucket,
  isWideStopBucket,
  paperIsHighBetaAlt,
  paperIsBearishRegime,
  type PaperOpportunity,
  type PaperOrderProvenance,
  type PaperOrderMode,
  type PaperRiskLabel,
  type LaneConfidence,
  type PaperOrder,
} from "./paper-execution-router.js";
import {
  buildMixedAdmissionDecisionLedger,
  buildMixedRegimeReport,
  getActiveMixedPaperBudgetProfileConfig,
  type MixedRegimeReport,
} from "./mixed-regime-router.js";
import { cgWideTargetFromEntry, readPaperTradingControls } from "./paper-trading-controls.js";

// ─── public report types ──────────────────────────────────────────────────────

export type SuggestedUniverseAction =
  | "CONTINUE_CURRENT_UNIVERSE"
  | "EXPAND_EXTERNAL_SHORTLIST"
  | "WAIT_NEXT_SCAN"
  | "NO_SAFE_PAPER_OPPORTUNITY";

export type AllocatorNoOpportunityReason =
  | "NO_FRESH_SCAN_CANDIDATE"
  | "NO_COMPATIBLE_REGIME"
  | "NO_SAFE_PAPER_OPPORTUNITY"
  | null;

/**
 * Admission posture for the active paper lane.
 *  - ACTIVE: admitting HEADLINE orders normally.
 *  - QUARANTINED: active lane is degraded — NO new HEADLINE orders, and (without
 *    PAPER_DIAGNOSTIC_CONTINUE) NO new orders at all.
 *  - DIAGNOSTIC_ONLY: active lane is degraded but the operator opted into
 *    continued DIAGNOSTIC_ONLY collection (PAPER_DIAGNOSTIC_CONTINUE=1).
 * This is NOT a loss-based hard stop; it is adaptive lane quarantine.
 */
export type LaneAdmissionStatus = "ACTIVE" | "QUARANTINED" | "DIAGNOSTIC_ONLY";

/**
 * Allocator-scoped rotation verdict (distinct from the paper router's
 * RotationAction). Never authorizes real trading.
 */
export type AllocatorRotationAction =
  | "KEEP_CURRENT_LANE"
  | "ROTATE_TO_BETTER_LANE"
  | "CONTINUE_DIAGNOSTIC_ONLY"
  | "PAPER_ONLY_NO_REAL_APPROVAL";

/** Compact symbol-loss rollup surfaced from the paper performance breakdown. */
export interface AllocatorWorstSymbol {
  symbol: string;
  closed: number;
  netSumR: number;
  wr: number | null;
}

/** Compact single-loss contributor surfaced from the paper performance breakdown. */
export interface AllocatorLossContributor {
  symbol: string;
  direction: string;
  netR: number;
  closeReason: string | null;
}

/**
 * Live state of the active paper lane, computed by the caller from the paper
 * store (headline performance) + rotation evaluation. Drives the quarantine /
 * diagnostic-only / rotation decision. When omitted the lane is treated as
 * ACTIVE (headline admission proceeds) — preserving legacy behavior.
 */
export interface AllocatorLaneState {
  activeLaneId: string | null;
  laneConfidence: LaneConfidence;
  /** HEADLINE closed-order count, net-avg-R, profit-factor and win-rate. */
  closedCount: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
  /** A strictly better, non-degraded eligible lane exists to rotate into. */
  betterLaneAvailable: boolean;
  selectedNextLaneId: string | null;
  /** Optional Section-10 enrichment from buildPaperPerformanceBreakdown. */
  worstSymbols?: AllocatorWorstSymbol[];
  topLossContributors?: AllocatorLossContributor[];
}

export interface AllocatorCountRow {
  key: string;
  count: number;
}

export interface AllocatorLaneRollup {
  laneId: VariantMatrixVariantId;
  evaluated: number;
  eligible: number;
  rejected: number;
  created: number;
}

export interface AllocatorSymbolRollup {
  symbol: string;
  evaluated: number;
  eligible: number;
  rejected: number;
  created: number;
}

export interface AllocatorRejectedOpportunity {
  symbol: string;
  direction: Direction;
  laneId: VariantMatrixVariantId;
  reason: string;
  freshValid: number | null;
  netAvgR: number | null;
}

export interface PaperOpportunityAllocatorReport {
  reportOnly: true;
  paperOnly: true;
  generatedAt: string;
  scanBatchId: string;
  scanFinishedAt: string;
  marketRegime: string | null;
  controllerMode: string;
  regimeFamily: string;

  candidatesSeen: number;
  candidatesEvaluated: number;
  laneEvaluationsCreated: number;
  paperEligibleCount: number;
  paperOrdersCreated: number;
  duplicateSuppressed: number;
  rejected: number;

  // ── adaptive lane quarantine / diagnostic-mode state ──────────────────────
  /** Posture of the active paper lane this batch. */
  laneAdmissionStatus: LaneAdmissionStatus;
  /** Allocator-scoped rotation verdict (never authorizes real trading). */
  rotationAction: AllocatorRotationAction;
  /** Accounting mode that eligible candidates were admitted under this batch. */
  paperOrderMode: PaperOrderMode;
  /** Human-readable explanation when the active lane is degraded; else null. */
  quarantineReason: string | null;
  /** Why no new HEADLINE orders were created (degraded lane / candidate gates). */
  noNewHeadlineOrderReason: string | null;
  /** Effective allocator blocker — "ACTIVE_LANE_DEGRADED" when quarantined. */
  blocker: string;
  /** Active-lane headline performance echoed for Section 10. */
  activeLaneClosed: number;
  activeLaneNetAvgR: number | null;
  activeLanePF: number | null;
  activeLaneWR: number | null;
  laneConfidence: LaneConfidence | null;
  /**
   * Paper-performance-derived lane confidence. DEGRADED whenever the active lane
   * is quarantined/degraded by paper metrics (negative netAvgR, PF<1, low WR) or
   * the routing confidence is DEGRADED — so Section 10 never shows confidence=HIGH
   * while laneAdmission=QUARANTINED. Distinct from `laneConfidence` (routing).
   */
  paperLaneConfidence: LaneConfidence | null;

  headlineEligibleCount: number;
  diagnosticEligibleCount: number;
  createdHeadline: number;
  createdDiagnostic: number;
  headlineOpenCount: number;
  diagnosticOpenCount: number;
  cgWideOpenCount: number;
  cgWideMaxOpen: number;
  cgWideStaleOpenCount: number;
  cgWideMaxStaleOpen: number;
  cgWideMaxPerSymbolOpen: number;
  cgWideMaxPerDirectionOpen: number;
  cgWideElevatedOpenThreshold: number;
  cgWideCapacityPressure: "NORMAL" | "ELEVATED" | "FULL";

  // ── rejected-candidate diagnostic sampler (V1) — forensic-only ─────────────
  /** True when PAPER_REJECT_DIAGNOSTIC_CONTINUE=1 (sampler armed this batch). */
  rejectedDiagnosticSamplerActive: boolean;
  /** DIAGNOSTIC_ONLY opportunities sampled from rejected candidates this scan. */
  rejectedDiagnosticSampled: number;
  /** Reject reasons of the sampled diagnostic orders (top rollup). */
  rejectedDiagnosticReasons: AllocatorCountRow[];
  /** Bounded paper-only challenger learning sleeve. */
  challengerDiagnosticEnabled: boolean;
  challengerDiagnosticSelected: number;
  challengerLaneId: string | null;

  worstSymbols: AllocatorWorstSymbol[];
  topLossContributors: AllocatorLossContributor[];

  topRejects: AllocatorCountRow[];
  fieldMissing: AllocatorCountRow[];
  byLane: AllocatorLaneRollup[];
  bySymbol: AllocatorSymbolRollup[];

  selectedOpportunities: PaperOpportunity[];
  topRejectedOpportunities: AllocatorRejectedOpportunity[];
  topRejectedSymbols: AllocatorCountRow[];
  topRejectedLanes: AllocatorCountRow[];
  closestNearMisses: AllocatorRejectedOpportunity[];

  noOpportunityReason: AllocatorNoOpportunityReason;
  suggestedUniverseAction: SuggestedUniverseAction;
}

// ─── inputs ─────────────────────────────────────────────────────────────────

export interface PaperOpportunityAllocatorInputs {
  candidates: Candidate[];
  scanBatchId: string;
  scanFinishedAt: string;
  marketRegime: string | null;
  vmReport: CurrentGuardVariantMatrixReport;
  routerReport: AdaptiveLaneRouterReport;
  now: string;
  /** Immutable paper-start anchor; candidates before it are excluded from admission. */
  paperStartAt: string | null;
  paperValidationAllowed?: boolean;
  admissionMaxAgeMs?: number;
  /** Already-available external/universe rotation shortlist symbols (advisory). */
  externalShortlistSymbols?: string[];
  /**
   * Live state of the active paper lane (headline performance + rotation).
   * When omitted the lane is treated as ACTIVE and HEADLINE admission proceeds.
   */
  laneState?: AllocatorLaneState;
  /**
   * PAPER_DIAGNOSTIC_CONTINUE=1: allow DIAGNOSTIC_ONLY collection from a
   * degraded/quarantined lane. Default false → a degraded lane creates NO orders.
   */
  paperDiagnosticContinue?: boolean;
  /**
   * PAPER_REJECT_DIAGNOSTIC_CONTINUE=1: when the active lane is HEALTHY (HEADLINE
   * batch) but this scan produced no HEADLINE opportunity, sample a bounded
   * number of rejected candidates as DIAGNOSTIC_ONLY orders for forensic
   * provenance growth. Default false → rejected candidates are never sampled.
   * Forensic-only: never creates HEADLINE orders, never authorizes live trading.
   */
  paperRejectDiagnosticContinue?: boolean;
  /** Max DIAGNOSTIC_ONLY orders sampled from rejected candidates per scan (default 3). */
  paperRejectDiagnosticMaxPerScan?: number;
  /**
   * Enables one accurately modeled CG_TRAIL_AFTER_TP1 DIAGNOSTIC_ONLY
   * opportunity per scan when its independent economics qualify.
   */
  paperChallengerDiagnosticEnabled?: boolean;
  paperChallengerDiagnosticMaxPerScan?: number;
  /**
   * Quarantine switch for the CG_TRAIL_AFTER_TP1 challenger lane. When true the
   * allocator admits NO new trail orders (Gate E rejects them). The trail_after_tp1
   * exit rule was falsified as net-negative on this universe — paper book SHORT
   * 1W/23 (4% WR, -264 NT) and LONG 52W/95 (55% WR but -252 NT, avgR -0.13) — and an
   * honest paired kline simulation shows trail_after_tp1 ≈ tp1_full (delta +0.004R),
   * i.e. the trail mechanic adds no measured edge. Defaults to off so the Gate A–D
   * unit tests still exercise those gates; production wiring sets it true.
   */
  paperChallengerQuarantined?: boolean;
  /**
   * Enables full variant-matrix paper collection: admits a DIAGNOSTIC_ONLY paper order for each
   * of VARIANT_MATRIX_DIAGNOSTIC_IDS (baseline / scaleout / no-fib500 / maker) in BOTH directions,
   * capped per variant per scan. Headline stays on the canonical scaleout lane. Default off.
   */
  paperVariantMatrixDiagnosticEnabled?: boolean;
  /** Per-variant cap on variant-matrix diagnostic orders per scan (default 3). */
  paperVariantMatrixDiagnosticMaxPerScan?: number;
  /**
   * When true, variant diagnostic lanes that have a confident, clearly net-negative realized paper
   * sample (see AUTO_QUARANTINE_*) stop admitting new orders. Computed from `currentPaperOrders`.
   */
  paperVariantAutoQuarantineEnabled?: boolean;
  /**
   * CG_WIDE priority. When true, the CG_WIDE_STOP_TP_WIDE lane bypasses the VM-sim economics veto
   * (admits even when the fair-geometry row is REJECT — the operator prioritizes it on its realized
   * paper performance). The paper-based lane-rotation backstop (decideLaneAdmission) still applies.
   */
  paperCgWidePriority?: boolean;
  /**
   * Target share of admitted opportunities that must be CG_WIDE (0..1, default 0.9). Diagnostic
   * (non-CG_WIDE) opportunities are trimmed per scan so CG_WIDE keeps at least this share.
   */
  paperCgWideTargetShare?: number;
  /**
   * Symbols with positive paper/live cohort evidence — overrides the
   * SYMBOL_NET_NEGATIVE candidate gate for those symbols only.
   */
  symbolsWithPositiveCohort?: string[];
  /**
   * Per-symbol HEADLINE paper net-sum-R (from the performance breakdown). Used
   * only to stamp `symbolHistoricalNet` provenance; advisory, never gates.
   */
  symbolHistoricalNetMap?: Record<string, number | null>;
  /**
   * Optional lane-level honest-edge gate (RegimeEdgeMemoryStore). When supplied,
   * a candidate whose (regime × direction × lane) edge is PROVEN-NEGATIVE is
   * rejected — so a losing lane (wide-stop SHORT, −0.25R) cannot trade while a
   * positive lane (tight/fast-TP SHORT) in the same direction does. Cold-start
   * lanes pass. Omitted ⇒ no lane gate (back-compat for tests).
   */
  laneEdgeGate?: {
    laneVerdict(
      regimeRaw: string | null | undefined,
      direction: "LONG" | "SHORT",
      lane: string,
    ): { allowed: boolean; reasonCode: string };
  };
  /** Current paper book used only for Mixed Regime occupancy-budget admission. */
  currentPaperOrders?: PaperOrder[];
  /**
   * The same Mixed report rendered by the operator brief. When supplied, the
   * allocator consumes its candidate-level decision instead of independently
   * reconstructing a potentially divergent Mixed decision.
   */
  mixedRegimeReport?: MixedRegimeReport | null;
}

// ─── lane policy ──────────────────────────────────────────────────────────────

/**
 * Headline admission is anchored on the proven scaleout exit. The trail challenger
 * is modeled accurately by the paper resolver, but can only enter the bounded
 * DIAGNOSTIC_ONLY learning sleeve.
 *
 * Long-only forward OOS collection also uses the same scaleout exit family so the
 * bullish paper lane can create true HEADLINE paper orders when a candidate clears
 * the quality gates, instead of being hard-forced into diagnostic-only forever.
 */
const DEFAULT_HEADLINE_VARIANT_ID: VariantMatrixVariantId = "CG_SCALEOUT_TP1_TRAIL";
/**
 * The lane(s) whose orders may be emitted as HEADLINE (the only mode the live engine mirrors).
 * PAPER_HEADLINE_VARIANT_IDS lets a deliberately configured testnet-live instance promote a small
 * STABLE allowlist without affecting the default diagnostic instance. Unknown ids are ignored; if
 * none survive validation we fall back to the default rather than silently trading nothing.
 */
const HEADLINE_VARIANT_IDS: readonly VariantMatrixVariantId[] = (() => {
  const raw = process.env.PAPER_HEADLINE_VARIANT_IDS?.trim() || process.env.PAPER_HEADLINE_VARIANT_ID?.trim();
  if (!raw) return [DEFAULT_HEADLINE_VARIANT_ID];
  const known = new Set(VARIANT_MATRIX_DEFINITIONS.map((d) => d.id));
  const rejected: string[] = [];
  const out: VariantMatrixVariantId[] = [];
  for (const id of raw.split(/[,\s]+/).map((part) => part.trim()).filter(Boolean)) {
    if (!known.has(id as VariantMatrixVariantId)) {
      rejected.push(id);
      continue;
    }
    if (!out.includes(id as VariantMatrixVariantId)) out.push(id as VariantMatrixVariantId);
  }
  if (rejected.length > 0) {
    console.warn(`[allocator] headline override ignored unknown variant id(s): ${rejected.join(", ")}`);
  }
  if (out.length === 0) {
    console.warn(`[allocator] headline override had no known variant ids — falling back to ${DEFAULT_HEADLINE_VARIANT_ID}`);
    return [DEFAULT_HEADLINE_VARIANT_ID];
  }
  return out;
})();

const PAPER_HEADLINE_ALLOWLIST_ACTIVE = Boolean(process.env.PAPER_HEADLINE_VARIANT_IDS?.trim());
const PAPER_HEADLINE_REQUIRE_STABLE =
  process.env.PAPER_HEADLINE_REQUIRE_STABLE === "1" ||
  (process.env.PAPER_HEADLINE_VARIANT_IDS?.trim() ? process.env.PAPER_HEADLINE_REQUIRE_STABLE !== "0" : false);

function isHeadlineVariantId(id: VariantMatrixVariantId): boolean {
  return HEADLINE_VARIANT_IDS.includes(id);
}

const PAPER_ADMISSIBLE_LANE_IDS: readonly VariantMatrixVariantId[] = (() => {
  const base: VariantMatrixVariantId[] = [
    "CG_WIDE_STOP_TP_WIDE",
    "CG_SCALEOUT_TP1_TRAIL",
    "CG_TRAIL_AFTER_TP1",
  ];
  // The headline lane MUST be admissible — it's the only lane that can reach PAPER_ELIGIBLE
  // (→ HEADLINE orders → mirrored live). When the testnet override promotes diagnostic STABLE
  // lanes, fold them in so they aren't rejected as LANE_NOT_PAPER_MODELED.
  for (const id of HEADLINE_VARIANT_IDS) {
    if (!base.includes(id)) base.push(id);
  }
  return base;
})();
const PAPER_CHALLENGER_LANE_ID: VariantMatrixVariantId = "CG_TRAIL_AFTER_TP1";
/**
 * Variants admitted as DIAGNOSTIC_ONLY paper sleeves in BOTH directions when the full
 * variant-matrix paper collection is enabled. CG_SCALEOUT_TP1_TRAIL stays the HEADLINE lane and
 * CG_TRAIL_AFTER_TP1 stays the quarantine-able challenger — so neither is listed here. The
 * resolver honestly resolves every exit/fill rule (tp1_full, scaleout, maker no-fill) via
 * walkVariantPath, so these never silently mis-resolve. All stay excluded from headline net/PF/WR.
 */
const VARIANT_MATRIX_DIAGNOSTIC_IDS: readonly VariantMatrixVariantId[] = [
  "CG_BASELINE_CURRENT",
  "CG_SCALEOUT_TP1_TRAIL",
  "CG_NO_FIB500_ENTRYSET",
  "CG_MAKER_LIMIT_SIM",
  // Long-only reward-geometry research lanes (GPT deep-research candidates).
  BULL_TREND_VARIANT_ID,
  BULL_SCALEOUT_VARIANT_ID,
  "LG_R12_STOP250_FULL",
  "LG_R12_STOP300_FULL",
  // 2026-06-23: the SHORT-fade edge is real (78-80% WR) but TP placement decides payoff — the
  // VM-sim ladder showed the fast 0.5R exit is the sweet spot (CG_WIDE_FAST_SHORT +0.139R) while
  // the raw tiny TP nets ~flat (+0.017R) and a far 1R TP loses (-0.181R, shorts don't reach it in
  // this up-mean-reverting market). Admit the 0.5R fast-short into the paper book (DIAGNOSTIC,
  // shortOnly) so the proven geometry accrues REAL paper economics — the measurement-first step
  // before it can be promoted to the headline short lane (gated by liveBlocked).
  "CG_WIDE_FAST_SHORT",
  // 2026-06-26: LONG_ONLY paper mirrors of the short stable-candidate geometries. These are
  // diagnostic-only long probes: they can open/close paper orders in bullish LONG_ONLY regimes,
  // but do not become live/headline just because the short side is stable.
  "CG_TIGHT_FAST_05",
  "CG_BASELINE_FAST_05",
  "CG_MAKER_FAST_05",
  "CG_MFE_GIVEBACK",
];
/** Per-variant cap on DIAGNOSTIC_ONLY variant-matrix orders sampled per scan (keeps the book bounded). */
const DEFAULT_VARIANT_DIAGNOSTIC_MAX_PER_SCAN = 3;
/** Standing caps on the OPEN diagnostic book: per (variant×direction) lane and per symbol. ~13 active
 *  diagnostic laneIds × 60 ≈ 800 total — matched to the resolver's ~3h sweep throughput (OOS velocity
 *  is resolution-bound, so more open past this is bloat). Per-symbol 50 stops one coin dominating
 *  (one hit ~290). Env-tunable. */
const PAPER_DIAGNOSTIC_MAX_OPEN_PER_LANE = Number(process.env.PAPER_DIAGNOSTIC_MAX_OPEN_PER_LANE) || 60;
const PAPER_DIAGNOSTIC_MAX_OPEN_PER_SYMBOL = Number(process.env.PAPER_DIAGNOSTIC_MAX_OPEN_PER_SYMBOL) || 50;
/** Hard GLOBAL ceiling on the open diagnostic book. The per-lane/per-symbol caps alone summed to
 *  ~1455 (selectedLaneId includes direction → ~24 lane×dir combos × 60), well past the ~800 target,
 *  because they don't bound the TOTAL. Below this the per-lane/per-symbol caps still rebalance
 *  concentration; AT this ceiling diagnostic admission hard-stops until the resolver drains it back
 *  under. OOS velocity is resolution-bound, so 800 is plenty. Env-tunable. */
const PAPER_DIAGNOSTIC_MAX_OPEN_TOTAL = Number(process.env.PAPER_DIAGNOSTIC_MAX_OPEN_TOTAL) || 800;

/**
 * Auto-quarantine thresholds for variant diagnostic lanes. A lane is auto-quarantined (admission
 * halted, rendered violet in the neural map) once it has a confident sample AND a clearly negative
 * realized paper netAvgR — i.e. "let it run, then bench confirmed losers" (the CG_TRAIL discipline,
 * automated). Based on the lane's OWN paper economics per laneId, never the VM-sim row, and only for
 * VARIANT_MATRIX_DIAGNOSTIC lanes (headline lanes are handled by the allocator policy). Tunable.
 */
const AUTO_QUARANTINE_MIN_CLOSED = 40;
const AUTO_QUARANTINE_MAX_NETAVGR = -0.03;

/**
 * Given the current paper book, returns the variant diagnostic lane ids (short `CG_VARIANT_MATRIX:<v>`
 * and long `CG_LONG_VARIANT_MATRIX:<v>`) that have earned auto-quarantine: closed >= MIN and realized
 * netAvgR <= threshold. Pure; used both to halt admission (allocator) and to color the lane violet
 * (neural map), so the two stay in sync.
 */
export function computeAutoQuarantinedVariantLanes(orders: readonly PaperOrder[]): string[] {
  const variantSuffixes = new Set<string>(VARIANT_MATRIX_DIAGNOSTIC_IDS);
  const byLane = new Map<string, { closed: number; sumNetR: number }>();
  for (const o of orders) {
    const id = o.selectedLaneId;
    if (!id) continue;
    if (!(id.startsWith("CG_VARIANT_MATRIX:") || id.startsWith("CG_LONG_VARIANT_MATRIX:"))) continue;
    const suffix = id.slice(id.indexOf(":") + 1);
    if (!variantSuffixes.has(suffix)) continue;
    if (o.netR == null || !Number.isFinite(o.netR)) continue; // resolved win/loss only (skip open/no-fill)
    const agg = byLane.get(id) ?? { closed: 0, sumNetR: 0 };
    agg.closed += 1;
    agg.sumNetR += o.netR;
    byLane.set(id, agg);
  }
  const out: string[] = [];
  for (const [id, agg] of byLane) {
    if (agg.closed >= AUTO_QUARANTINE_MIN_CLOSED && agg.sumNetR / agg.closed <= AUTO_QUARANTINE_MAX_NETAVGR) {
      out.push(id);
    }
  }
  return out;
}
/**
 * Minimum ratio of TP1 distance to stop distance required for TRAIL challenger
 * admission. Below this threshold a single 5-minute candle's normal intrabar
 * range simultaneously touches TP1 and the breakeven stop, producing guaranteed
 * TRAIL_BREAKEVEN_SAME_CANDLE losses at cost-only. 0.15 means TP1 must be at
 * least 15% as far from entry as the stop.
 */
const TRAIL_MIN_TP1_STOP_RATIO = 0.15;
const BULL_TREND_MIN_SCORE = 60;
const BENCHMARK_ONLY_LANE_IDS: readonly VariantMatrixVariantId[] = [
  "CG_BASELINE_CURRENT",
  "CG_MAKER_LIMIT_SIM",
];

export function paperOpportunityStopFloorRejection(
  stopDistanceBps: number,
  minimumBps = WIDE_STOP_MIN_BPS,
): "STOP_DISTANCE_BELOW_FLOOR" | null {
  return Number.isFinite(stopDistanceBps) && stopDistanceBps >= minimumBps
    ? null
    : "STOP_DISTANCE_BELOW_FLOOR";
}

// Reasons surfaced as "near miss" — geometry/regime/direction ok, only economics failed.
const NEAR_MISS_REASONS = new Set<string>([
  "ECONOMICS_REJECT",
  "ECONOMICS_INSUFFICIENT_SAMPLE",
  "ECONOMICS_NEGATIVE_NET",
  "ECONOMICS_PF_BELOW_FLOOR",
  "ECONOMICS_FAILS_PLUS10BPS_STRESS",
  "LANE_NO_EVIDENCE",
]);

function isAdmissionTargetLaneId(laneId: string | null | undefined): boolean {
  return HEADLINE_VARIANT_IDS.some(
    (id) => laneId === `CG_VARIANT_MATRIX:${id}` || laneId === `CG_LONG_VARIANT_MATRIX:${id}`,
  );
}

/** Cost-in-R ceiling: above this the geometry/candidate cannot pay for itself. */
const CANDIDATE_MAX_COST_R = 0.5;
const CG_WIDE_STALE_HOURS = 30;
const OPEN_PAPER_STATUSES = new Set<string>([
  "CREATED",
  "PAPER_SUBMITTED",
  "PAPER_FILLED",
  "PAPER_PARTIAL",
]);

function isOpenPaperOrder(order: PaperOrder): boolean {
  return OPEN_PAPER_STATUSES.has(order.paperStatus);
}

function isCgWideLaneId(laneId: string | null | undefined): boolean {
  return typeof laneId === "string" && laneId.endsWith(":CG_WIDE_STOP_TP_WIDE");
}

function paperOrderOpenHours(order: PaperOrder, nowMs: number): number | null {
  const openedMs = new Date(order.openedAt).getTime();
  if (!Number.isFinite(openedMs) || !Number.isFinite(nowMs)) return null;
  return (nowMs - openedMs) / 3_600_000;
}

function cgWideCapacityRejectReason(args: {
  orders: readonly PaperOrder[];
  nowMs: number;
  symbol: string;
  direction: Direction;
  maxWideOpen: number;
  maxWideStale: number;
  maxPerSymbolOpen: number;
  maxPerDirectionOpen: number;
}): string | null {
  const openWide = args.orders.filter((order) => isOpenPaperOrder(order) && isCgWideLaneId(order.selectedLaneId));
  const staleWide = openWide.filter((order) => (paperOrderOpenHours(order, args.nowMs) ?? 0) >= CG_WIDE_STALE_HOURS);
  const perSymbol = openWide.filter((order) => order.symbol === args.symbol);
  const perDirection = openWide.filter((order) => order.direction === args.direction);
  if (openWide.length >= args.maxWideOpen) return "CG_WIDE_MAX_OPEN_REACHED";
  if (staleWide.length >= args.maxWideStale) return "CG_WIDE_MAX_STALE_REACHED";
  if (perSymbol.length >= args.maxPerSymbolOpen) return "CG_WIDE_MAX_PER_SYMBOL_REACHED";
  if (perDirection.length >= args.maxPerDirectionOpen) return "CG_WIDE_MAX_PER_DIRECTION_REACHED";
  return null;
}

// Long large-cap-only gate. The 2026-06-21 forward audit decomposed the -$3.3k
// diagnostic loss: it is ~entirely high-beta-alt LONGs (avgR -0.66R, n=246) — small
// alts chop/revert and hit stops even in an up market (BTC +1.58% over the window),
// while large-cap longs are ~flat and the top majors (SOL/ETH/BNB) actually trend.
// SHORTS are unaffected (the fade edge works on alts, ~86% WR). So we block LONGs on
// high-beta alts (paperIsHighBetaAlt). Env-tunable; disable with LONG_LARGE_CAP_ONLY=0.
const LONG_LARGE_CAP_ONLY = process.env.LONG_LARGE_CAP_ONLY !== "0";

// ─── rejected-candidate diagnostic sampler (V1) ─────────────────────────────
/** Default cap on DIAGNOSTIC_ONLY orders sampled from rejected candidates per scan. */
const DEFAULT_REJECT_DIAGNOSTIC_MAX_PER_SCAN = 3;

/**
 * HEADLINE candidate-quality reject reasons that are eligible for the
 * rejected-candidate diagnostic sampler. Each is a *diagnostic-eligible* soft
 * fail: the candidate failed a HEADLINE fingerprint gate while the lane
 * economics + geometry were otherwise OK, making it a high-provenance forensic
 * sample. These can ONLY become DIAGNOSTIC_ONLY orders — never HEADLINE.
 */
const REJECT_DIAGNOSTIC_SAMPLEABLE_REASONS = new Set<string>([
  "CANDIDATE_ALL_REPLAY_VARIANTS_NEGATIVE",
  "CANDIDATE_RAW_EDGE_NOT_VALIDATED",
  "CANDIDATE_SYMBOL_NET_NEGATIVE",
  "CANDIDATE_SOURCE_CONFLICT",
  "CANDIDATE_CHASE_RISK_HIGH",
  "CANDIDATE_CALIBRATED_NEGATIVE",
  "CANDIDATE_COST_R_TOO_HIGH",
  "WIDE_GEOMETRY_COST_FAILS_STRESS",
]);

/** One rejected candidate captured as a candidate forensic diagnostic sample. */
interface RejectDiagnosticSample {
  opportunity: PaperOpportunity;
  reason: string;
  symbol: string;
  laneId: VariantMatrixVariantId;
  /** Source scan rank (lower = stronger candidate); null when unavailable. */
  rank: number | null;
  freshValid: number | null;
}

/**
 * Rank + diversify the rejected-candidate pool, then take up to `maxN`.
 * Preference (req): closest near-misses first, then top candidates by source
 * rank, then freshValid; symbols are diversified (distinct symbols first, only
 * repeating a symbol when capacity remains and no fresh symbol is left).
 */
function selectRejectDiagnosticSamples(
  pool: RejectDiagnosticSample[],
  maxN: number,
): RejectDiagnosticSample[] {
  if (maxN <= 0 || pool.length === 0) return [];
  const ranked = [...pool].sort((a, b) => {
    const an = NEAR_MISS_REASONS.has(a.reason) ? 0 : 1;
    const bn = NEAR_MISS_REASONS.has(b.reason) ? 0 : 1;
    if (an !== bn) return an - bn;
    const ar = a.rank ?? Number.POSITIVE_INFINITY;
    const br = b.rank ?? Number.POSITIVE_INFINITY;
    if (ar !== br) return ar - br;
    return (b.freshValid ?? 0) - (a.freshValid ?? 0);
  });
  const picked: RejectDiagnosticSample[] = [];
  const usedSymbols = new Set<string>();
  for (const s of ranked) {
    if (picked.length >= maxN) break;
    if (usedSymbols.has(s.symbol)) continue;
    picked.push(s);
    usedSymbols.add(s.symbol);
  }
  if (picked.length < maxN) {
    for (const s of ranked) {
      if (picked.length >= maxN) break;
      if (picked.includes(s)) continue;
      picked.push(s);
    }
  }
  return picked;
}

// ─── adaptive lane quarantine decision (Part 2 / Part 5) ────────────────────

interface LaneAdmissionDecision {
  laneAdmissionStatus: LaneAdmissionStatus;
  rotationAction: AllocatorRotationAction;
  /** HEADLINE → admit headline; DIAGNOSTIC_ONLY → collect diagnostics; NONE → no new orders. */
  batchOrderMode: "HEADLINE" | "DIAGNOSTIC_ONLY" | "NONE";
  quarantineReason: string | null;
  noNewHeadlineOrderReason: string | null;
  degraded: boolean;
}

function _fmt(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v as number)) return "n/a";
  return (v as number).toFixed(digits);
}

/**
 * Adaptive lane quarantine. A degraded active lane must NOT keep admitting new
 * HEADLINE orders. This is NOT a loss-based hard stop — it downgrades / rotates
 * / halts new HEADLINE admission, and never touches live trading.
 */
function decideLaneAdmission(
  laneState: AllocatorLaneState | undefined,
  diagnosticContinue: boolean,
): LaneAdmissionDecision {
  if (!laneState) {
    return {
      laneAdmissionStatus: "ACTIVE",
      rotationAction: "KEEP_CURRENT_LANE",
      batchOrderMode: "HEADLINE",
      quarantineReason: null,
      noNewHeadlineOrderReason: null,
      degraded: false,
    };
  }

  const c = laneState.closedCount;
  const reasons: string[] = [];
  if (laneState.laneConfidence === "DEGRADED") reasons.push("laneConfidence=DEGRADED");
  if (c >= 10 && (laneState.netAvgR ?? 0) < 0) reasons.push(`closed>=10 & netAvgR=${_fmt(laneState.netAvgR, 4)}<0`);
  if (c >= 10 && laneState.pf !== null && Number.isFinite(laneState.pf) && (laneState.pf as number) < 1.0)
    reasons.push(`closed>=10 & PF=${_fmt(laneState.pf)}<1.0`);
  if (c >= 10 && laneState.wr !== null && Number.isFinite(laneState.wr) && (laneState.wr as number) < 0.3)
    reasons.push(`closed>=10 & WR=${_fmt((laneState.wr ?? 0) * 100, 1)}%<30%`);

  const degraded = reasons.length > 0;
  if (!degraded) {
    return {
      laneAdmissionStatus: "ACTIVE",
      rotationAction: "KEEP_CURRENT_LANE",
      batchOrderMode: "HEADLINE",
      quarantineReason: null,
      noNewHeadlineOrderReason: null,
      degraded: false,
    };
  }

  const quarantineReason = reasons.join("; ");
  const betterLane =
    laneState.betterLaneAvailable === true &&
    laneState.selectedNextLaneId != null &&
    laneState.selectedNextLaneId !== laneState.activeLaneId;

  // A better lane that IS the allocator's admission target → resume HEADLINE
  // admission there (the degraded active lane was a different lane).
  if (betterLane && isAdmissionTargetLaneId(laneState.selectedNextLaneId)) {
    return {
      laneAdmissionStatus: "ACTIVE",
      rotationAction: "ROTATE_TO_BETTER_LANE",
      batchOrderMode: "HEADLINE",
      quarantineReason,
      noNewHeadlineOrderReason: null,
      degraded: true,
    };
  }

  // A better lane exists but it is not one the allocator can admit into here.
  if (betterLane) {
    return {
      laneAdmissionStatus: "QUARANTINED",
      rotationAction: "ROTATE_TO_BETTER_LANE",
      batchOrderMode: "NONE",
      quarantineReason,
      noNewHeadlineOrderReason: `active lane degraded; rotate to ${laneState.selectedNextLaneId} (not allocator-admissible)`,
      degraded: true,
    };
  }

  // No better lane. Diagnostic-only collection iff explicitly opted in.
  if (diagnosticContinue) {
    return {
      laneAdmissionStatus: "DIAGNOSTIC_ONLY",
      rotationAction: "CONTINUE_DIAGNOSTIC_ONLY",
      batchOrderMode: "DIAGNOSTIC_ONLY",
      quarantineReason,
      noNewHeadlineOrderReason:
        "active lane degraded; no better lane — DIAGNOSTIC_ONLY collection (PAPER_DIAGNOSTIC_CONTINUE=1)",
      degraded: true,
    };
  }

  return {
    laneAdmissionStatus: "QUARANTINED",
    rotationAction: "PAPER_ONLY_NO_REAL_APPROVAL",
    batchOrderMode: "NONE",
    quarantineReason,
    noNewHeadlineOrderReason:
      "active lane degraded; no better lane and PAPER_DIAGNOSTIC_CONTINUE not set — no new paper orders",
    degraded: true,
  };
}

// ─── candidate-level quality gates (Part 4 — fingerprint gating) ─────────────

interface CandidateGateVerdict {
  /** Passes all gates required for HEADLINE admission. */
  headlineOk: boolean;
  /** May still be collected as a DIAGNOSTIC_ONLY order (soft fail). */
  diagnosticEligible: boolean;
  /** Rejection reason when !headlineOk. */
  reason: string | null;
  /** True when the candidate is missing a required evidence field. */
  fieldMissing: string | null;
}

/**
 * Candidate fingerprint gating. A positive lane-level history is NOT sufficient
 * to admit a fresh scan candidate as a HEADLINE paper order — the candidate
 * itself must clear calibration / replay / symbol / chase / source-conflict /
 * cost gates. Missing required fields reject HEADLINE admission (recorded as
 * FIELD_MISSING) but may still be collected as DIAGNOSTIC_ONLY.
 */
function evaluateCandidateQualityGates(
  c: Candidate,
  geoCostR: number,
  symbolsWithPositiveCohort: Set<string>,
): CandidateGateVerdict {
  const plan = c.selectedExecutionPlan ?? null;
  if (!plan) {
    return { headlineOk: false, diagnosticEligible: true, reason: "FIELD_MISSING_EXECUTION_PLAN", fieldMissing: "selectedExecutionPlan" };
  }

  const calibVerdict = plan.calibrationVerdict ?? null;
  const calibNetR =
    typeof plan.calibratedExpectedNetR === "number" && Number.isFinite(plan.calibratedExpectedNetR)
      ? plan.calibratedExpectedNetR
      : null;
  const chaseRisk = plan.chaseRisk ?? null;
  const routeCodes = Array.isArray(plan.routeReasonCodes) ? plan.routeReasonCodes : [];
  const costR = typeof plan.costR === "number" && Number.isFinite(plan.costR) ? plan.costR : null;

  // Required calibration evidence must exist for HEADLINE.
  if (calibVerdict === null && calibNetR === null) {
    return { headlineOk: false, diagnosticEligible: true, reason: "FIELD_MISSING_CALIBRATION", fieldMissing: "calibration" };
  }
  if (chaseRisk === null) {
    return { headlineOk: false, diagnosticEligible: true, reason: "FIELD_MISSING_CHASE_RISK", fieldMissing: "chaseRisk" };
  }

  // Gate: admit only if calibratedExpectedNetR>0 OR verdict != RAW_EDGE_NOT_VALIDATED.
  const calibrationOk = (calibNetR !== null && calibNetR > 0) || calibVerdict !== "RAW_EDGE_NOT_VALIDATED";
  if (!calibrationOk) {
    return { headlineOk: false, diagnosticEligible: true, reason: "CANDIDATE_RAW_EDGE_NOT_VALIDATED", fieldMissing: null };
  }
  // Explicit calibrated-negative with non-positive net R is never HEADLINE.
  if (calibVerdict === "CALIBRATED_NEGATIVE" && (calibNetR === null || calibNetR <= 0)) {
    return { headlineOk: false, diagnosticEligible: true, reason: "CANDIDATE_CALIBRATED_NEGATIVE", fieldMissing: null };
  }

  // Gate: ALL_REPLAY_VARIANTS_NEGATIVE → reject HEADLINE (diagnostic-only ok).
  if (routeCodes.includes("ALL_REPLAY_VARIANTS_NEGATIVE")) {
    return { headlineOk: false, diagnosticEligible: true, reason: "CANDIDATE_ALL_REPLAY_VARIANTS_NEGATIVE", fieldMissing: null };
  }

  // Gate: SYMBOL_NET_NEGATIVE → reject unless symbol has positive cohort evidence.
  if (routeCodes.includes("SYMBOL_NET_NEGATIVE") && !symbolsWithPositiveCohort.has(c.symbol)) {
    return { headlineOk: false, diagnosticEligible: true, reason: "CANDIDATE_SYMBOL_NET_NEGATIVE", fieldMissing: null };
  }

  // Gate: chaseRisk=HIGH → reject HEADLINE (diagnostic-only ok).
  if (chaseRisk === "HIGH") {
    return { headlineOk: false, diagnosticEligible: true, reason: "CANDIDATE_CHASE_RISK_HIGH", fieldMissing: null };
  }

  // Gate: sourceConflict → reject unless stronger compensating evidence
  // (calibrated-positive with a positive calibrated net R).
  if (c.sourceConflict === true) {
    const compensating = calibVerdict === "CALIBRATED_POSITIVE" && calibNetR !== null && calibNetR > 0;
    if (!compensating) {
      return { headlineOk: false, diagnosticEligible: true, reason: "CANDIDATE_SOURCE_CONFLICT", fieldMissing: null };
    }
  }

  // Gate: candidate cost too high after cost.
  if (costR !== null && Math.abs(costR) >= CANDIDATE_MAX_COST_R) {
    return { headlineOk: false, diagnosticEligible: true, reason: "CANDIDATE_COST_R_TOO_HIGH", fieldMissing: null };
  }

  // Gate: wide geometry cannot produce an acceptable cost/stress profile.
  if (Number.isFinite(geoCostR) && Math.abs(geoCostR) >= CANDIDATE_MAX_COST_R) {
    return { headlineOk: false, diagnosticEligible: true, reason: "WIDE_GEOMETRY_COST_FAILS_STRESS", fieldMissing: null };
  }

  return { headlineOk: true, diagnosticEligible: true, reason: null, fieldMissing: null };
}

// ─── small helpers ────────────────────────────────────────────────────────────

/** Mirror of regimeAllowsPaper in paper-execution-router (kept local for granular reasons). */
function regimeAllowsPaperLane(
  controllerMode: string,
  regimeFamily: string,
  paperValidationAllowed: boolean,
): boolean {
  if (controllerMode === "LONG_ONLY") return regimeFamily === "BULLISH";
  if (controllerMode === "NO_TRADE_CHOP") return false;
  if (controllerMode === "NO_TRADE_NEGATIVE_EDGE") return false;
  if (controllerMode === "UNKNOWN") return false;
  if (regimeFamily === "UNKNOWN") return false;
  if (controllerMode === "VALIDATION_ONLY" || regimeFamily === "MIXED") {
    return paperValidationAllowed === true;
  }
  return true;
}

function candidateDirection(c: Candidate): "LONG" | "SHORT" | null {
  const d = c.finalDirection ?? c.direction;
  if (d === "LONG" || d === "SHORT") return d;
  return null;
}

function candidateEntryPrice(c: Candidate): number | null {
  if (typeof c.currentPrice === "number" && Number.isFinite(c.currentPrice) && c.currentPrice > 0) {
    return c.currentPrice;
  }
  const close = c.indicators?.fiveMinute?.latestClose;
  if (typeof close === "number" && Number.isFinite(close) && close > 0) return close;
  return null;
}

function directionCompatibleWithMode(direction: "LONG" | "SHORT", controllerMode: string): boolean {
  if (controllerMode === "SHORT_ONLY") return direction === "SHORT";
  if (controllerMode === "LONG_ONLY") return direction === "LONG";
  if (controllerMode === "NO_TRADE_CHOP" || controllerMode === "NO_TRADE_NEGATIVE_EDGE" || controllerMode === "UNKNOWN") {
    return false; // no direction is admissible under a no-trade posture
  }
  return true; // BOTH_ALLOWED, VALIDATION_ONLY, etc.
}

function toCountRows(map: Map<string, number>, limit: number): AllocatorCountRow[] {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

// ─── candidate provenance capture (PROVENANCE V1) ────────────────────────────

type GeoLike = {
  entryPrice: number;
  stopLoss: number;
  takeProfitLevels: number[];
  stopDistanceBps: number;
};

function _num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function _str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function _bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}
function _strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Build the candidate-level provenance object stamped onto an allocator paper
 * order. Pure read of the candidate + selected execution plan + the transformed
 * lane geometry. Fields that are unavailable are recorded as null and named in
 * the returned `fieldMissing` list. Report-only — never gates admission.
 */
function buildCandidateProvenance(
  c: Candidate,
  direction: "LONG" | "SHORT",
  regime: string | null,
  currentPrice: number | null,
  geo: GeoLike,
  symbolHistoricalNet: number | null,
): { provenance: PaperOrderProvenance; fieldMissing: string[] } {
  const plan = c.selectedExecutionPlan ?? null;
  const fieldMissing: string[] = [];
  const mark = (name: string, present: boolean): void => {
    if (!present) fieldMissing.push(name);
  };

  const entry = geo.entryPrice;
  const tp1 = Array.isArray(geo.takeProfitLevels) ? geo.takeProfitLevels[0] ?? null : null;
  const tpDistanceBps =
    typeof tp1 === "number" && Number.isFinite(tp1) && entry > 0
      ? Math.abs((tp1 - entry) / entry) * 10_000
      : null;
  const stopBps = _num(geo.stopDistanceBps);
  const riskReward = tpDistanceBps !== null && stopBps !== null && stopBps > 0 ? tpDistanceBps / stopBps : null;
  const stopBucket = paperStopBucket(geo.stopDistanceBps);

  const calibVerdict = _str(plan?.calibrationVerdict);
  const calibNetR = _num(plan?.calibratedExpectedNetR);
  const chaseRisk = _str(plan?.chaseRisk);
  const routeMode = _str(plan?.routeMode);
  const routeReasonCodes = _strArr(plan?.routeReasonCodes);
  const sourceConflict = _bool(c.sourceConflict);
  const entryDriftAtr = _num(plan?.entryDriftAtr);

  // Provenance-critical fields (audit/gate inputs) get coverage tracking.
  mark("calibrationVerdict", calibVerdict !== null);
  mark("calibratedExpectedNetR", calibNetR !== null);
  mark("chaseRisk", chaseRisk !== null);
  mark("routeMode", routeMode !== null);
  mark("routeReasonCodes", Array.isArray(plan?.routeReasonCodes));
  mark("sourceConflict", sourceConflict !== null);
  mark("entryDriftAtr", entryDriftAtr !== null);
  mark("whaleSignal", _str(c.whale?.signal) !== null);
  mark("sentimentSignal", _str(c.sentiment?.signal) !== null);
  mark("kronosBias", _str(c.kronosBias) !== null);
  mark("symbolHistoricalNet", symbolHistoricalNet !== null);
  mark("variantConfidenceTier", _str(plan?.variantConfidenceTier) !== null);

  // ── fingerprint flags (human-readable; gate predicates use canonical fields) ──
  const flags: string[] = [];
  if (calibVerdict === "RAW_EDGE_NOT_VALIDATED") flags.push("RAW_EDGE_NOT_VALIDATED");
  if (calibVerdict === "CALIBRATED_NEGATIVE") flags.push("CALIBRATED_NEGATIVE");
  if (calibNetR !== null && calibNetR <= 0) flags.push("CALIBRATED_NET_NON_POSITIVE");
  if (routeReasonCodes.includes("ALL_REPLAY_VARIANTS_NEGATIVE")) flags.push("ALL_REPLAY_VARIANTS_NEGATIVE");
  if (routeReasonCodes.includes("SYMBOL_NET_NEGATIVE")) flags.push("SYMBOL_NET_NEGATIVE");
  if (chaseRisk === "HIGH") flags.push("CHASE_RISK_HIGH");
  if (sourceConflict === true) flags.push("SOURCE_CONFLICT");
  if (c.directionConflict === true) flags.push("DIRECTION_CONFLICT");
  if (routeMode === "DATA_COLLECTION") flags.push("ROUTE_DATA_COLLECTION");
  if (isWideStopBucket(stopBucket)) flags.push("WIDE_STOP_GE_400");
  if (paperIsHighBetaAlt(c.symbol)) flags.push("HIGH_BETA_ALT");
  if (direction === "SHORT" && paperIsBearishRegime(regime)) flags.push("BEARISH_SHORT");

  const provenance: PaperOrderProvenance = {
    sourceRank: _num(c.rank),
    sourceStatus: _str(c.finalStatus) ?? _str(c.status),
    currentPriceAtAdmission: currentPrice,
    referencePrice: _num(entry),
    stopBucket,
    tpDistanceBps,
    riskReward,
    selectedEntryVariant: _str(plan?.selectedEntryVariant),
    selectedExitVariant: _str(plan?.selectedExitVariant),
    expectedGrossR: _num(plan?.expectedGrossR),
    expectedNetR: _num(plan?.expectedNetR),
    calibratedExpectedNetR: calibNetR,
    calibrationVerdict: calibVerdict,
    calibrationPenaltyR: _num(plan?.calibrationPenaltyR),
    calibrationConfidence: _str(plan?.calibrationConfidence),
    calibrationDiagnosisCodes: _strArr(plan?.calibrationDiagnosisCodes),
    routeMode,
    routeScore: _num(plan?.routeScore),
    routeReasonCodes,
    primaryProfitEligible: _bool(plan?.primaryProfitEligible),
    dataCollectionReason: _str(plan?.dataCollectionReason),
    sourceConflict,
    directionConflict: _bool(c.directionConflict),
    horizonConflict: _bool(c.horizonConflict),
    kronosBias: _str(c.kronosBias),
    kronosConfidence: _num(c.kronosConfidence),
    whaleSignal: _str(c.whale?.signal),
    whaleScore: _num(c.whale?.score),
    sentimentSignal: _str(c.sentiment?.signal),
    sentimentScore: _num(c.sentiment?.score),
    chaseRisk,
    entryDriftPct: _num(plan?.entryDriftPct),
    entryDriftAtr,
    costR: _num(plan?.costR),
    spreadR: _num(plan?.spreadR),
    feeSlippageR: _num(plan?.feeSlippageR),
    stopDistanceBpsFromPlan: _num(plan?.stopDistanceBps),
    symbolHistoricalNet,
    variantSampleSize: _num(plan?.variantSampleSize),
    variantConfidenceTier: _str(plan?.variantConfidenceTier),
    candidateQualityFlags: flags,
  };

  return { provenance, fieldMissing };
}

// ─── allocator ─────────────────────────────────────────────────────────────────

/**
 * Pure evaluation: produces the allocator report and the list of paper
 * opportunities ready to be admitted. Never mutates any store; never throws.
 */
export function buildPaperOpportunityAllocatorReport(
  inputs: PaperOpportunityAllocatorInputs,
): PaperOpportunityAllocatorReport {
  const controllerMode = inputs.routerReport.controllerMode;
  const regimeFamily = inputs.routerReport.regimeFamily;
  const paperValidationAllowed = inputs.paperValidationAllowed === true;
  const maxAge = inputs.admissionMaxAgeMs ?? PAPER_ADMISSION_MAX_AGE_MS;
  const nowMs = new Date(inputs.now).getTime();
  const scanFinishedMs = new Date(inputs.scanFinishedAt).getTime();
  const paperStartMs = inputs.paperStartAt ? new Date(inputs.paperStartAt).getTime() : null;
  const paperControls = readPaperTradingControls();

  const regimeOk = regimeAllowsPaperLane(controllerMode, regimeFamily, paperValidationAllowed) || regimeFamily === "MIXED";

  // ── adaptive lane quarantine + accounting-mode decision (Parts 2/3/5) ──────
  const diagnosticContinue = inputs.paperDiagnosticContinue === true;
  const laneState = inputs.laneState;
  const laneDecision = decideLaneAdmission(laneState, diagnosticContinue);
  const symbolsWithPositiveCohort = new Set<string>(inputs.symbolsWithPositiveCohort ?? []);
  const symbolHistoricalNetMap = inputs.symbolHistoricalNetMap ?? {};
  const activeMixedBudget = getActiveMixedPaperBudgetProfileConfig();
  const currentPaperOrders = inputs.currentPaperOrders ?? [];
  const cgWideBudget = activeMixedBudget.budget;
  const openCgWideOrders = currentPaperOrders.filter((order) => isOpenPaperOrder(order) && isCgWideLaneId(order.selectedLaneId));
  const headlineOpenCount = currentPaperOrders.filter(
    (order) => isOpenPaperOrder(order) && order.paperOrderMode === "HEADLINE",
  ).length;
  const diagnosticOpenCount = currentPaperOrders.filter(
    (order) => isOpenPaperOrder(order) && order.paperOrderMode === "DIAGNOSTIC_ONLY",
  ).length;
  // Open DIAGNOSTIC book caps (2026-06-23): the diagnostic sleeve has no total cap (the HEADLINE
  // caps are headline-only, never bind under liveBlocked), so it balloons (+~105/h → ~15k steady
  // state) and over-concentrates (one symbol hit ~290 open). OOS velocity is bounded by RESOLUTION
  // throughput, not open count, so a bigger book past the resolver's sweep capacity is pure bloat.
  // A global total ceiling (PAPER_DIAGNOSTIC_MAX_OPEN_TOTAL=800) bounds the book; per-lane + per-symbol
  // caps rebalance concentration BELOW it (over-full lanes/symbols stop, under-provisioned keep filling).
  // Counts mutate as we admit this scan. Pure measurement — no real money (live is separately capped at
  // MAX_CONCURRENT). diagnosticOpenRunning tracks the total across this scan's admissions.
  let diagnosticOpenRunning = diagnosticOpenCount;
  const diagnosticOpenByLane = new Map<string, number>();
  const diagnosticOpenBySymbol = new Map<string, number>();
  for (const order of currentPaperOrders) {
    if (!isOpenPaperOrder(order) || order.paperOrderMode !== "DIAGNOSTIC_ONLY") continue;
    diagnosticOpenByLane.set(order.selectedLaneId, (diagnosticOpenByLane.get(order.selectedLaneId) ?? 0) + 1);
    diagnosticOpenBySymbol.set(order.symbol, (diagnosticOpenBySymbol.get(order.symbol) ?? 0) + 1);
  }
  const staleCgWideOpenCount = openCgWideOrders.filter(
    (order) => (paperOrderOpenHours(order, nowMs) ?? 0) >= CG_WIDE_STALE_HOURS,
  ).length;
  const cgWideElevatedOpenThreshold = Math.floor(cgWideBudget.maxWideOpen * 0.75);
  const cgWideCapacityPressure =
    openCgWideOrders.length >= cgWideBudget.maxWideOpen ||
    staleCgWideOpenCount >= cgWideBudget.maxWideStale
      ? "FULL"
      : openCgWideOrders.length >= cgWideElevatedOpenThreshold
        ? "ELEVATED"
        : "NORMAL";

  // ── rejected-candidate diagnostic sampler (V1) config ──────────────────────
  const rejectDiagnosticContinue = inputs.paperRejectDiagnosticContinue === true;
  const rejectDiagnosticMaxPerScan =
    typeof inputs.paperRejectDiagnosticMaxPerScan === "number" &&
    Number.isFinite(inputs.paperRejectDiagnosticMaxPerScan) &&
    inputs.paperRejectDiagnosticMaxPerScan > 0
      ? Math.floor(inputs.paperRejectDiagnosticMaxPerScan)
      : DEFAULT_REJECT_DIAGNOSTIC_MAX_PER_SCAN;
  const rejectDiagnosticPool: RejectDiagnosticSample[] = [];
  const challengerDiagnosticEnabled = inputs.paperChallengerDiagnosticEnabled === true;
  const challengerQuarantined = inputs.paperChallengerQuarantined === true;
  const variantMatrixDiagnosticEnabled = inputs.paperVariantMatrixDiagnosticEnabled === true;
  const variantMatrixDiagnosticMaxPerScan =
    typeof inputs.paperVariantMatrixDiagnosticMaxPerScan === "number" &&
    Number.isFinite(inputs.paperVariantMatrixDiagnosticMaxPerScan) &&
    inputs.paperVariantMatrixDiagnosticMaxPerScan > 0
      ? Math.floor(inputs.paperVariantMatrixDiagnosticMaxPerScan)
      : DEFAULT_VARIANT_DIAGNOSTIC_MAX_PER_SCAN;
  const variantDiagnosticSelected = new Map<VariantMatrixVariantId, number>();
  const autoQuarantinedVariantLanes =
    inputs.paperVariantAutoQuarantineEnabled === true
      ? new Set(computeAutoQuarantinedVariantLanes(currentPaperOrders))
      : new Set<string>();
  const cgWidePriority = inputs.paperCgWidePriority === true;
  const cgWideTargetShare =
    typeof inputs.paperCgWideTargetShare === "number" &&
    Number.isFinite(inputs.paperCgWideTargetShare) &&
    inputs.paperCgWideTargetShare > 0 &&
    inputs.paperCgWideTargetShare < 1
      ? inputs.paperCgWideTargetShare
      : 0.9;
  const challengerDiagnosticMaxPerScan =
    typeof inputs.paperChallengerDiagnosticMaxPerScan === "number" &&
    Number.isFinite(inputs.paperChallengerDiagnosticMaxPerScan) &&
    inputs.paperChallengerDiagnosticMaxPerScan > 0
      ? Math.floor(inputs.paperChallengerDiagnosticMaxPerScan)
      : 1;
  let challengerDiagnosticSelected = 0;

  const report: PaperOpportunityAllocatorReport = {
    reportOnly: true,
    paperOnly: true,
    generatedAt: inputs.now,
    scanBatchId: inputs.scanBatchId,
    scanFinishedAt: inputs.scanFinishedAt,
    marketRegime: inputs.marketRegime,
    controllerMode,
    regimeFamily,
    candidatesSeen: 0,
    candidatesEvaluated: 0,
    laneEvaluationsCreated: 0,
    paperEligibleCount: 0,
    paperOrdersCreated: 0,
    duplicateSuppressed: 0,
    rejected: 0,
    laneAdmissionStatus: laneDecision.laneAdmissionStatus,
    rotationAction: laneDecision.rotationAction,
    paperOrderMode: laneDecision.batchOrderMode === "DIAGNOSTIC_ONLY" ? "DIAGNOSTIC_ONLY" : "HEADLINE",
    quarantineReason: laneDecision.quarantineReason,
    noNewHeadlineOrderReason: laneDecision.noNewHeadlineOrderReason,
    blocker: laneDecision.degraded ? "ACTIVE_LANE_DEGRADED" : "none",
    activeLaneClosed: laneState?.closedCount ?? 0,
    activeLaneNetAvgR: laneState?.netAvgR ?? null,
    activeLanePF: laneState?.pf ?? null,
    activeLaneWR: laneState?.wr ?? null,
    laneConfidence: laneState?.laneConfidence ?? null,
    paperLaneConfidence: laneDecision.degraded
      ? "DEGRADED"
      : (laneState?.laneConfidence ?? null),
    headlineEligibleCount: 0,
    diagnosticEligibleCount: 0,
    createdHeadline: 0,
    createdDiagnostic: 0,
    headlineOpenCount,
    diagnosticOpenCount,
    cgWideOpenCount: openCgWideOrders.length,
    cgWideMaxOpen: cgWideBudget.maxWideOpen,
    cgWideStaleOpenCount: staleCgWideOpenCount,
    cgWideMaxStaleOpen: cgWideBudget.maxWideStale,
    cgWideMaxPerSymbolOpen: cgWideBudget.maxPerSymbolOpen,
    cgWideMaxPerDirectionOpen: cgWideBudget.maxPerDirectionOpen,
    cgWideElevatedOpenThreshold,
    cgWideCapacityPressure,
    rejectedDiagnosticSamplerActive: false,
    rejectedDiagnosticSampled: 0,
    rejectedDiagnosticReasons: [],
    challengerDiagnosticEnabled,
    challengerDiagnosticSelected: 0,
    challengerLaneId: challengerDiagnosticEnabled
      ? `CG_VARIANT_MATRIX:${PAPER_CHALLENGER_LANE_ID}`
      : null,
    worstSymbols: laneState?.worstSymbols ?? [],
    topLossContributors: laneState?.topLossContributors ?? [],
    topRejects: [],
    fieldMissing: [],
    byLane: [],
    bySymbol: [],
    selectedOpportunities: [],
    topRejectedOpportunities: [],
    topRejectedSymbols: [],
    topRejectedLanes: [],
    closestNearMisses: [],
    noOpportunityReason: null,
    suggestedUniverseAction: "CONTINUE_CURRENT_UNIVERSE",
  };

  // Aggregators
  const rejectReasonCounts = new Map<string, number>();
  const fieldMissingCounts = new Map<string, number>();
  const rejectedSymbolCounts = new Map<string, number>();
  const rejectedLaneCounts = new Map<string, number>();
  const laneRollups = new Map<VariantMatrixVariantId, AllocatorLaneRollup>();
  const symbolRollups = new Map<string, AllocatorSymbolRollup>();
  const allRejected: AllocatorRejectedOpportunity[] = [];
  const batchDedupe = new Set<string>();

  const laneRollup = (laneId: VariantMatrixVariantId): AllocatorLaneRollup => {
    let r = laneRollups.get(laneId);
    if (!r) {
      r = { laneId, evaluated: 0, eligible: 0, rejected: 0, created: 0 };
      laneRollups.set(laneId, r);
    }
    return r;
  };
  const symbolRollup = (symbol: string): AllocatorSymbolRollup => {
    let r = symbolRollups.get(symbol);
    if (!r) {
      r = { symbol, evaluated: 0, eligible: 0, rejected: 0, created: 0 };
      symbolRollups.set(symbol, r);
    }
    return r;
  };

  const recordReject = (
    symbol: string,
    direction: Direction,
    laneId: VariantMatrixVariantId,
    reason: string,
    freshValid: number | null,
    netAvgR: number | null,
  ): void => {
    report.rejected += 1;
    rejectReasonCounts.set(reason, (rejectReasonCounts.get(reason) ?? 0) + 1);
    rejectedSymbolCounts.set(symbol, (rejectedSymbolCounts.get(symbol) ?? 0) + 1);
    rejectedLaneCounts.set(laneId, (rejectedLaneCounts.get(laneId) ?? 0) + 1);
    laneRollup(laneId).rejected += 1;
    symbolRollup(symbol).rejected += 1;
    allRejected.push({ symbol, direction, laneId, reason, freshValid, netAvgR });
  };

  for (const c of inputs.candidates) {
    report.candidatesSeen += 1;
    const symbol = c.symbol;
    const direction = candidateDirection(c);
    const entryPrice = candidateEntryPrice(c);
    const stopLoss =
      typeof c.stopLoss === "number" && Number.isFinite(c.stopLoss) && c.stopLoss > 0 ? c.stopLoss : null;
    const tp1 =
      typeof c.takeProfits?.tp1 === "number" && Number.isFinite(c.takeProfits.tp1) && c.takeProfits.tp1 > 0
        ? c.takeProfits.tp1
        : null;
    const tp2 =
      typeof c.takeProfits?.tp2 === "number" && Number.isFinite(c.takeProfits.tp2) && c.takeProfits.tp2 > 0
        ? c.takeProfits.tp2
        : null;
    const tp3 =
      typeof c.takeProfits?.tp3 === "number" && Number.isFinite(c.takeProfits.tp3) && c.takeProfits.tp3 > 0
        ? c.takeProfits.tp3
        : null;

    // Required-field validation
    if (direction === null) fieldMissingCounts.set("direction", (fieldMissingCounts.get("direction") ?? 0) + 1);
    if (entryPrice === null) fieldMissingCounts.set("currentPrice", (fieldMissingCounts.get("currentPrice") ?? 0) + 1);
    if (stopLoss === null) fieldMissingCounts.set("stopLoss", (fieldMissingCounts.get("stopLoss") ?? 0) + 1);
    if (tp1 === null) fieldMissingCounts.set("tp1", (fieldMissingCounts.get("tp1") ?? 0) + 1);

    if (direction === null || entryPrice === null || stopLoss === null || tp1 === null) {
      // Cannot evaluate any lane — record one reject for visibility.
      recordReject(symbol, c.finalDirection ?? c.direction, "CG_WIDE_STOP_TP_WIDE", "MISSING_REQUIRED_FIELDS", null, null);
      continue;
    }

    report.candidatesEvaluated += 1;

    const signal: VariantMatrixSignal = {
      sourceSignalId: `${symbol}-${direction}`,
      symbol,
      direction,
      entryPrice,
      stopLoss,
      tp1,
      tp2,
      tp3,
      stopDistanceBps: stopDistanceBpsOf(direction, entryPrice, stopLoss),
      regime: inputs.marketRegime,
      entryVariant: c.selectedExecutionPlan?.selectedEntryVariant ?? null,
      openedAt: inputs.scanFinishedAt,
      closedAt: null,
    };

    for (const def of VARIANT_MATRIX_DEFINITIONS) {
      // Long-only research lanes are entirely skipped on incompatible-direction candidates —
      // before any evaluation/reject accounting, so they add no noise to SHORT-side stats.
      if (def.longOnly && direction !== "LONG") continue;

      report.laneEvaluationsCreated += 1;
      laneRollup(def.id).evaluated += 1;
      symbolRollup(symbol).evaluated += 1;

      const row = inputs.vmReport.rows.find((r) => r.variantId === def.id) ?? null;
      const rowFresh = row?.freshValid ?? null;
      const rowNet = row?.netAvgR ?? null;
      const headlineVariant = isHeadlineVariantId(def.id);
      const headlineStableOk =
        !PAPER_HEADLINE_REQUIRE_STABLE || row?.status === "STABLE_CANDIDATE";

      const geo = deriveVariantGeometry(signal, def);
      if (geo.kind === "rejected") {
        recordReject(symbol, direction, def.id, "ENTRY_FILTER_FIB500_EXCLUDED", rowFresh, rowNet);
        continue;
      }
      if (geo.kind === "failed") {
        recordReject(
          symbol,
          direction,
          def.id,
          def.id === "CG_WIDE_STOP_TP_WIDE" ? "MISSING_WIDE_GEOMETRY" : "GEOMETRY_DERIVATION_FAILED",
          rowFresh,
          rowNet,
        );
        continue;
      }

      // geo.kind === "ok"
      const challengerDiagnosticCollection =
        challengerDiagnosticEnabled && def.id === PAPER_CHALLENGER_LANE_ID;
      // Full variant-matrix diagnostic collection: admit the 4 non-headline, non-challenger
      // variants as DIAGNOSTIC_ONLY sleeves (both directions). Bypasses the benchmark-only and
      // not-paper-modeled rejections below; economics gates are skipped (it's diagnostic).
      const bullTrendCollection = def.bullishOnly === true;
      const longPaperCollection =
        direction === "LONG" &&
        def.id === "CG_WIDE_STOP_TP_WIDE" &&
        regimeFamily === "MIXED";
      const longHeadlineCollection =
        direction === "LONG" &&
        headlineVariant &&
        headlineStableOk &&
        controllerMode === "LONG_ONLY" &&
        regimeFamily === "BULLISH";
      const variantDiagnosticCollection =
        variantMatrixDiagnosticEnabled &&
        VARIANT_MATRIX_DIAGNOSTIC_IDS.includes(def.id) &&
        (
          !headlineVariant ||
          !headlineStableOk ||
          (laneDecision.batchOrderMode !== "HEADLINE" && !longHeadlineCollection)
        );
      if (
        BENCHMARK_ONLY_LANE_IDS.includes(def.id) &&
        !variantDiagnosticCollection &&
        !(headlineVariant && headlineStableOk && laneDecision.batchOrderMode === "HEADLINE")
      ) {
        recordReject(symbol, direction, def.id, "LANE_DIAGNOSTIC_ONLY", rowFresh, rowNet);
        continue;
      }
      if (def.id === PAPER_CHALLENGER_LANE_ID && !challengerDiagnosticEnabled) {
        recordReject(symbol, direction, def.id, "LANE_NOT_PAPER_MODELED", rowFresh, rowNet);
        continue;
      }
      if (!PAPER_ADMISSIBLE_LANE_IDS.includes(def.id) && !variantDiagnosticCollection) {
        recordReject(symbol, direction, def.id, "LANE_NOT_PAPER_MODELED", rowFresh, rowNet);
        continue;
      }
      const stopFloorRejection = paperOpportunityStopFloorRejection(
        geo.stopDistanceBps,
        def.stopFloorBps ?? WIDE_STOP_MIN_BPS,
      );
      if (stopFloorRejection) {
        recordReject(symbol, direction, def.id, stopFloorRejection, rowFresh, rowNet);
        continue;
      }
      if (
        def.bullishOnly &&
        !(direction === "LONG" && controllerMode === "LONG_ONLY" && regimeFamily === "BULLISH")
      ) {
        recordReject(symbol, direction, def.id, "BULL_TREND_REQUIRES_BULLISH_LONG_ONLY", rowFresh, rowNet);
        continue;
      }

      // CG_WIDE priority collection: the operator prioritizes CG_WIDE on its realized paper
      // performance, so it bypasses the VM-sim economics veto AND the degraded-lane gate, and
      // admits as HEADLINE when the candidate is headline-quality, else falls back to
      // DIAGNOSTIC_ONLY (rather than being rejected). Applies to BOTH directions.
      const cgWidePriorityCollection = cgWidePriority && def.id === "CG_WIDE_STOP_TP_WIDE";
      if (def.id === "CG_WIDE_STOP_TP_WIDE") {
        const cgWideCapacityReason = cgWideCapacityRejectReason({
          orders: currentPaperOrders,
          nowMs,
          symbol,
          direction,
          maxWideOpen: cgWideBudget.maxWideOpen,
          maxWideStale: cgWideBudget.maxWideStale,
          maxPerSymbolOpen: cgWideBudget.maxPerSymbolOpen,
          maxPerDirectionOpen: cgWideBudget.maxPerDirectionOpen,
        });
        if (cgWideCapacityReason) {
          recordReject(symbol, direction, def.id, cgWideCapacityReason, rowFresh, rowNet);
          continue;
        }
      }
      // Diagnostic collection paths admit regardless of the lane's own economics row (they exist
      // to COLLECT that economics honestly). Regime/direction-compat gates below still apply.
      const skipEconomics =
        longPaperCollection ||
        longHeadlineCollection ||
        variantDiagnosticCollection ||
        cgWidePriorityCollection;

      // ── CG_WIDE_STOP_TP_WIDE eligibility gates ───────────────────────────
      if (!regimeOk) {
        recordReject(symbol, direction, def.id, "NO_COMPATIBLE_REGIME", rowFresh, rowNet);
        continue;
      }
      if (!directionCompatibleWithMode(direction, controllerMode)) {
        recordReject(symbol, direction, def.id, "DIRECTION_INCOMPATIBLE_WITH_MODE", rowFresh, rowNet);
        continue;
      }
      // High-beta-alt LONGs have no edge (chop/revert → stop, even in up markets) and
      // are the bulk of the diagnostic loss; large-cap longs are ~flat, majors trend.
      // Shorts unaffected (fade works on alts). See LONG_LARGE_CAP_ONLY note above.
      // NOTE (2026-06-22): do NOT relax this gate to "enable the fade-long edge" — the
      // scanner candidates here are all CHASE entries (entryDrift ~+4 ATR, no dips), which
      // is exactly why alt-longs bleed. The new oversold dip-buy edge lives in its own
      // measurement lane (fade-long-edge.ts), NOT this allocator path; relaxing the gate
      // would only re-admit the losing chase-longs. The gate stays until the fade lane
      // matures and earns its own admission path.
      if (LONG_LARGE_CAP_ONLY && direction === "LONG" && paperIsHighBetaAlt(symbol)) {
        recordReject(symbol, direction, def.id, "LONG_HIGH_BETA_ALT_NO_EDGE", rowFresh, rowNet);
        continue;
      }
      // Lane-level honest-edge veto: reject a lane whose (regime × direction × lane)
      // edge is proven-negative, even when the direction is allowed. This is what
      // lets a positive SHORT lane (tight/fast-TP) trade while the losing wide-stop
      // SHORT lane stays blocked — capturing edge the coarse direction gate missed.
      if (inputs.laneEdgeGate) {
        const lv = inputs.laneEdgeGate.laneVerdict(inputs.marketRegime, direction, def.id);
        if (!lv.allowed) {
          recordReject(symbol, direction, def.id, "EDGE_LANE_PROVEN_NEGATIVE", rowFresh, rowNet);
          continue;
        }
      }
      if (!row && !skipEconomics) {
        recordReject(symbol, direction, def.id, "LANE_NO_EVIDENCE", rowFresh, rowNet);
        continue;
      }
      if (!skipEconomics && row!.status === "REJECT") {
        recordReject(symbol, direction, def.id, "ECONOMICS_REJECT", rowFresh, rowNet);
        continue;
      }
      if (!skipEconomics && row!.freshValid < WATCHABLE_MIN_FRESH) {
        recordReject(symbol, direction, def.id, "ECONOMICS_INSUFFICIENT_SAMPLE", rowFresh, rowNet);
        continue;
      }
      if (!skipEconomics && (row!.netAvgR ?? 0) <= 0) {
        recordReject(symbol, direction, def.id, "ECONOMICS_NEGATIVE_NET", rowFresh, rowNet);
        continue;
      }
      if (!skipEconomics && row!.pf !== null && Number.isFinite(row!.pf) && row!.pf <= PF_STRONG) {
        recordReject(symbol, direction, def.id, "ECONOMICS_PF_BELOW_FLOOR", rowFresh, rowNet);
        continue;
      }
      if (!skipEconomics && row!.plus10bpsStillPositive !== true) {
        recordReject(symbol, direction, def.id, "ECONOMICS_FAILS_PLUS10BPS_STRESS", rowFresh, rowNet);
        continue;
      }
      if (
        def.id === "CG_WIDE_STOP_TP_WIDE" &&
        !cgWidePriorityCollection &&
        !longPaperCollection &&
        regimeFamily !== "MIXED"
      ) {
        recordReject(symbol, direction, def.id, "FULL_EXIT_COMPARISON_ONLY", rowFresh, rowNet);
        continue;
      }

      // Freshness (anti-lookahead) — uses the SOURCE scan timestamp.
      if (!Number.isFinite(scanFinishedMs) || nowMs - scanFinishedMs > maxAge) {
        recordReject(symbol, direction, def.id, "SOURCE_STALE_FOR_PAPER", rowFresh, rowNet);
        continue;
      }
      if (paperStartMs !== null && scanFinishedMs < paperStartMs) {
        recordReject(symbol, direction, def.id, "BACKFILL_PRE_PAPER_START", rowFresh, rowNet);
        continue;
      }

      const laneId = longPaperCollection
        ? LONG_WIDE_PAPER_LANE_ID
        : longHeadlineCollection
          ? `CG_LONG_VARIANT_MATRIX:${def.id}`
        : variantDiagnosticCollection && direction === "LONG"
          ? `CG_LONG_VARIANT_MATRIX:${def.id}`
          : `CG_VARIANT_MATRIX:${def.id}`;
      if (bullTrendCollection && laneId !== `CG_LONG_VARIANT_MATRIX:${def.id}`) {
        recordReject(symbol, direction, def.id, "BULL_TREND_LANE_ID_MISMATCH", rowFresh, rowNet);
        continue;
      }
      const sourceCandidateId = `${symbol}-${direction}`;
      const dedupeKey = allocatorDedupeKey({
        scanBatchId: inputs.scanBatchId,
        sourceCandidateId,
        symbol,
        direction,
        laneId,
      });
      if (batchDedupe.has(dedupeKey)) {
        report.duplicateSuppressed += 1;
        rejectReasonCounts.set("DUPLICATE_IN_BATCH", (rejectReasonCounts.get("DUPLICATE_IN_BATCH") ?? 0) + 1);
        continue;
      }
      batchDedupe.add(dedupeKey);

      // ── adaptive lane quarantine: a degraded lane must NOT admit new orders
      //    unless diagnostic-only collection was explicitly opted into ─────────
      if (
        laneDecision.batchOrderMode === "NONE" &&
        !longPaperCollection &&
        !challengerDiagnosticCollection &&
        !variantDiagnosticCollection &&
        !cgWidePriorityCollection
      ) {
        recordReject(symbol, direction, def.id, "ACTIVE_LANE_DEGRADED", rowFresh, rowNet);
        continue;
      }
      if (
        challengerDiagnosticCollection &&
        challengerDiagnosticSelected >= challengerDiagnosticMaxPerScan
      ) {
        recordReject(symbol, direction, def.id, "CHALLENGER_DIAGNOSTIC_CAP_REACHED", rowFresh, rowNet);
        continue;
      }
      // Per-variant per-scan cap for the full variant-matrix diagnostic collection.
      if (
        variantDiagnosticCollection &&
        (variantDiagnosticSelected.get(def.id) ?? 0) >= variantMatrixDiagnosticMaxPerScan
      ) {
        recordReject(symbol, direction, def.id, "VARIANT_DIAGNOSTIC_CAP_REACHED", rowFresh, rowNet);
        continue;
      }
      // Standing open-book caps: global total ceiling (~800) + per-symbol/per-lane concentration.
      if (variantDiagnosticCollection) {
        if (diagnosticOpenRunning >= PAPER_DIAGNOSTIC_MAX_OPEN_TOTAL) {
          recordReject(symbol, direction, def.id, "DIAGNOSTIC_TOTAL_OPEN_CAP_REACHED", rowFresh, rowNet);
          continue;
        }
        if ((diagnosticOpenBySymbol.get(symbol) ?? 0) >= PAPER_DIAGNOSTIC_MAX_OPEN_PER_SYMBOL) {
          recordReject(symbol, direction, def.id, "DIAGNOSTIC_SYMBOL_OPEN_CAP_REACHED", rowFresh, rowNet);
          continue;
        }
        if ((diagnosticOpenByLane.get(laneId) ?? 0) >= PAPER_DIAGNOSTIC_MAX_OPEN_PER_LANE) {
          recordReject(symbol, direction, def.id, "DIAGNOSTIC_LANE_OPEN_CAP_REACHED", rowFresh, rowNet);
          continue;
        }
      }
      // Auto-quarantine: a variant lane that is confidently net-negative in realized paper stops
      // admitting new orders (and renders violet). "Let it run, then bench confirmed losers."
      if (variantDiagnosticCollection && autoQuarantinedVariantLanes.has(laneId)) {
        recordReject(symbol, direction, def.id, "VARIANT_LANE_AUTO_QUARANTINED", rowFresh, rowNet);
        continue;
      }

      // Pure-bullish lane gates. Missing optional external evidence is allowed,
      // but explicit contradiction is not. This keeps collection moving while
      // isolating it from weak-trend and contra-flow LONG candidates.
      if (bullTrendCollection) {
        if (!Number.isFinite(c.trendScore) || c.trendScore < BULL_TREND_MIN_SCORE) {
          recordReject(symbol, direction, def.id, "BULL_TREND_SCORE_BELOW_60", rowFresh, rowNet);
          continue;
        }
        const kronosBias = _str(c.kronosBias);
        if (kronosBias === "SHORT") {
          recordReject(symbol, direction, def.id, "BULL_TREND_KRONOS_CONTRA", rowFresh, rowNet);
          continue;
        }
        const whaleSignal = _str(c.whale?.signal);
        if (whaleSignal === "BEARISH") {
          recordReject(symbol, direction, def.id, "BULL_TREND_WHALE_CONTRA", rowFresh, rowNet);
          continue;
        }
        const symbolSlotOccupied = currentPaperOrders.some(
          (order) =>
            order.symbol === symbol &&
            order.direction === "LONG" &&
            order.selectedLaneId === laneId &&
            (order.paperStatus === "CREATED" || order.paperStatus === "PAPER_SUBMITTED"),
        );
        if (symbolSlotOccupied) {
          recordReject(symbol, direction, def.id, "BULL_TREND_SYMBOL_SLOT_OCCUPIED", rowFresh, rowNet);
          continue;
        }
      }

      // ── CG_TRAIL_AFTER_TP1 challenger quality gates ───────────────────────────
      // Applied after the cap check so they don't consume the per-scan cap slot.
      // These raise the structural quality floor for trail data collection beyond
      // the permissive diagnosticEligible threshold.
      if (challengerDiagnosticCollection) {
        // Gate E: Lane quarantine. The trail_after_tp1 exit rule has been falsified
        // as net-negative on this universe (see paperChallengerQuarantined). Reject
        // every new trail admission so the bleeding diagnostic stops adding orders;
        // the separate VM-simulation research view is unaffected. Placed first so it
        // short-circuits before the per-candidate quality gates.
        if (challengerQuarantined) {
          recordReject(symbol, direction, def.id, "TRAIL_LANE_QUARANTINED", rowFresh, rowNet);
          continue;
        }

        // Gate A: Raw-candidate TP1/stop ratio floor.
        // trail_after_tp1 works by moving the stop to breakeven after TP1 hit.
        // When the raw candidate's TP1 is tiny relative to the stop (e.g., 6 bps
        // vs 487 bps), normal 5-minute intrabar noise touches both TP1 and the
        // entry-level breakeven stop in the same candle — every such trade becomes
        // TRAIL_BREAKEVEN_SAME_CANDLE at cost-only loss. Check the raw signal tp1
        // (not the widened geo target) because the resolver uses the stored order's
        // takeProfitLevels, which for TRAIL is always set to 1R by deriveVariantGeometry.
        const rawTp1DistanceBps =
          signal.tp1 > 0 && signal.entryPrice > 0
            ? (Math.abs(signal.entryPrice - signal.tp1) / signal.entryPrice) * 10_000
            : 0;
        const rawStopBps = signal.stopDistanceBps ?? 0;
        if (!(rawTp1DistanceBps >= rawStopBps * TRAIL_MIN_TP1_STOP_RATIO)) {
          recordReject(symbol, direction, def.id, "TRAIL_TP1_TOO_CLOSE_FOR_TRAIL", rowFresh, rowNet);
          continue;
        }

        // Gate B: Kronos contra-direction.
        // Don't admit TRAIL SHORT when Kronos bias is LONG (or vice versa).
        // The trail mechanic only helps when price moves in the trade direction
        // first; a confirmed contra-bias is a reliable early-exit signal.
        const kronosBias = _str(c.kronosBias);
        if (kronosBias !== null && kronosBias !== "UNAVAILABLE") {
          if (
            (direction === "SHORT" && kronosBias === "LONG") ||
            (direction === "LONG" && kronosBias === "SHORT")
          ) {
            recordReject(symbol, direction, def.id, "TRAIL_KRONOS_CONTRA_BIAS", rowFresh, rowNet);
            continue;
          }
        }

        // Gate C: Per-symbol open-order occupancy.
        // Prevent stacking multiple TRAIL orders for the same symbol+direction
        // while one is still open. The trail strategy is a single-slot design:
        // consecutive same-symbol entries during the same adverse move compound
        // the loss rather than recovering it.
        const trailLaneId = `CG_VARIANT_MATRIX:${PAPER_CHALLENGER_LANE_ID}`;
        const trailSlotOccupied = currentPaperOrders.some(
          (o) =>
            o.symbol === symbol &&
            o.direction === direction &&
            o.selectedLaneId === trailLaneId &&
            (o.paperStatus === "CREATED" || o.paperStatus === "PAPER_SUBMITTED"),
        );
        if (trailSlotOccupied) {
          recordReject(symbol, direction, def.id, "TRAIL_SYMBOL_SLOT_OCCUPIED", rowFresh, rowNet);
          continue;
        }

        // Gate D: Whale contra-direction.
        // A confirmed contra-direction whale signal (BULLISH on a SHORT, BEARISH on
        // a LONG) is the single cleanest separator of the -1R TRAIL_SL_HIT cluster:
        // in the observed sample it flagged 7 of 11 directional blow-ups while never
        // touching a winner. Whales accumulating against the trade reliably precede
        // the adverse move that stops the trail out before TP1. Mirrors Gate B's
        // categorical contra-signal logic; NEUTRAL/UNAVAILABLE/null pass through.
        const whaleSignal = _str(c.whale?.signal);
        if (whaleSignal !== null) {
          if (
            (direction === "SHORT" && whaleSignal === "BULLISH") ||
            (direction === "LONG" && whaleSignal === "BEARISH")
          ) {
            recordReject(symbol, direction, def.id, "TRAIL_WHALE_CONTRA_BIAS", rowFresh, rowNet);
            continue;
          }
        }
      }

      // Build a paper opportunity for the in-scope candidate×lane under a given
      // accounting mode. OOS-unconfirmed is allowed for PAPER. Pure — no store.
      const suppliedMixedState =
        regimeFamily === "MIXED" && inputs.mixedRegimeReport?.regimeIsMixed
          ? inputs.mixedRegimeReport.states.find(
              (state) =>
                state.symbol === symbol &&
                state.direction === direction,
            ) ?? null
          : null;
      const mixedBudgetReport =
        regimeFamily === "MIXED" && inputs.mixedRegimeReport == null
          ? buildMixedRegimeReport({
              regime: inputs.marketRegime,
              candidates: [{
                symbol,
                direction,
                regime: inputs.marketRegime,
                laneId,
                atrPercent: c.indicators?.fiveMinute?.atrPercent ?? null,
                volatilityScore: typeof c.volatilityScore === "number" ? c.volatilityScore : null,
                liquidityScore: typeof c.liquidityScore === "number" ? c.liquidityScore : null,
              }],
              orders: currentPaperOrders,
              nowMs,
              trailLaneAvailable: true,
              occupancyBudget: activeMixedBudget.budget,
              activeMixedBudgetProfile: activeMixedBudget.activeMixedBudgetProfile,
              budgetSource: activeMixedBudget.budgetSource,
              budgetActivationScope: activeMixedBudget.budgetActivationScope,
              mixedBudgetVersion: activeMixedBudget.mixedBudgetVersion,
            })
          : null;
      const mixedBudgetState = suppliedMixedState ?? mixedBudgetReport?.states[0] ?? null;
      const ledgerSource = suppliedMixedState ? inputs.mixedRegimeReport : mixedBudgetReport;
      const mixedBudgetLedgerEntry = ledgerSource
        ? buildMixedAdmissionDecisionLedger(ledgerSource, inputs.scanFinishedAt).entries.find(
            (entry) =>
              entry.symbol === symbol &&
              entry.direction === direction,
          ) ?? null
        : null;
      if (
        regimeFamily === "MIXED" &&
        (
          !mixedBudgetState ||
          (
            inputs.mixedRegimeReport != null &&
            !inputs.mixedRegimeReport.activeMixedLanes.includes(laneId)
          ) ||
          (
            mixedBudgetState.admissionResult !== "ALLOW" &&
            mixedBudgetState.admissionResult !== "ALLOW_REDUCED"
          )
        )
      ) {
        recordReject(
          symbol,
          direction,
          def.id,
          `MIXED_${mixedBudgetState?.admissionResult ?? "INSUFFICIENT_CONTEXT"}`,
          rowFresh,
          rowNet,
        );
        continue;
      }

      const buildOpportunity = (mode: PaperOrderMode): PaperOpportunity => {
        const manualCgWideTarget =
          def.id === "CG_WIDE_STOP_TP_WIDE"
            ? cgWideTargetFromEntry(geo.entryPrice, direction, paperControls.cgWideTpPct)
            : null;
        const takeProfitLevels = manualCgWideTarget !== null
          ? [manualCgWideTarget]
          : geo.takeProfitLevels.slice();
        // Diagnostic-collection lanes are OOS-unconfirmed by definition; null-safe because long
        // variant lanes have no short VM-sim row.
        const oosUnconfirmed =
          longPaperCollection || variantDiagnosticCollection || (row ? !row.allThreeOosPositive : true);
        const paperRiskLabel: PaperRiskLabel = oosUnconfirmed ? "EXPERIMENTAL" : "NORMAL";
        // ── PROVENANCE V1: capture candidate-level forensic metadata ─────────
        const symbolHistoricalNet =
          typeof symbolHistoricalNetMap[symbol] === "number" ? symbolHistoricalNetMap[symbol]! : null;
        const { provenance, fieldMissing: provFieldMissing } = buildCandidateProvenance(
          c,
          direction,
          inputs.marketRegime,
          entryPrice,
          geo,
          symbolHistoricalNet,
        );
        if (longPaperCollection) {
          provenance.candidateQualityFlags.push(
            regimeFamily === "MIXED"
              ? "MIXED_LONG_PAPER_OOS_COLLECTION"
              : "LONG_PAPER_OOS_COLLECTION",
          );
        }
        if (longHeadlineCollection) {
          provenance.candidateQualityFlags.push("LONG_HEADLINE_FORWARD_OOS_COLLECTION");
        }
        if (challengerDiagnosticCollection) {
          provenance.candidateQualityFlags.push("TRAIL_CHALLENGER_FORWARD_OOS");
        }
        if (variantDiagnosticCollection) {
          provenance.candidateQualityFlags.push(
            bullTrendCollection
              ? "PURE_BULLISH_TREND_OOS"
              : "VARIANT_MATRIX_DIAGNOSTIC_OOS",
          );
        }
        if (manualCgWideTarget !== null) {
          provenance.candidateQualityFlags.push(`MANUAL_CG_WIDE_TP_${paperControls.cgWideTpPct?.toFixed(2)}PCT`);
        }
        return {
          sourceCandidateId,
          scanBatchId: inputs.scanBatchId,
          symbol,
          direction,
          regime: inputs.marketRegime,
          laneId,
          variantId: def.id,
          controllerMode,
          entryPrice: geo.entryPrice,
          stopLoss: geo.stopLoss,
          takeProfitLevels,
          variantExitRule: def.exitRule,
          fillMode: def.fillMode,
          plannedStopDistanceBps: geo.stopDistanceBps,
          oosUnconfirmed,
          paperRiskLabel,
          paperOrderMode: mode,
          openedAt: inputs.scanFinishedAt,
          provenance,
          provenanceFieldMissing: provFieldMissing,
          mixedBudgetProfile: mixedBudgetState ? activeMixedBudget.activeMixedBudgetProfile : undefined,
          mixedBudgetVersion: mixedBudgetState ? activeMixedBudget.mixedBudgetVersion : undefined,
          budgetActivationScope: mixedBudgetState ? activeMixedBudget.budgetActivationScope : undefined,
          admissionResult: mixedBudgetState?.admissionResult,
          occupancyMode: mixedBudgetState?.occupancyMode,
          stalePassHealth: mixedBudgetState?.stalePassHealth,
          riskMultiplierAfterOccupancy: mixedBudgetState?.risk.riskMultiplier,
          budgetUsed: mixedBudgetLedgerEntry?.budgetUsed,
          budgetReason: mixedBudgetLedgerEntry?.occupancyReason,
        };
      };

      // ── candidate-level fingerprint gating (Part 4) ──────────────────────────
      const verdict = evaluateCandidateQualityGates(c, geo.costR, symbolsWithPositiveCohort);
      if (verdict.fieldMissing) {
        fieldMissingCounts.set(verdict.fieldMissing, (fieldMissingCounts.get(verdict.fieldMissing) ?? 0) + 1);
      }

      let orderMode: PaperOrderMode;
      if (challengerDiagnosticCollection) {
        if (!verdict.diagnosticEligible) {
          recordReject(symbol, direction, def.id, verdict.reason ?? "CANDIDATE_REJECTED_HARD", rowFresh, rowNet);
          continue;
        }
        orderMode = "DIAGNOSTIC_ONLY";
      } else if (variantDiagnosticCollection) {
        // Full variant-matrix collection: DIAGNOSTIC_ONLY only — must be checked BEFORE the
        // HEADLINE branch so these sleeves never enter headline net/PF/WR accounting.
        if (!verdict.diagnosticEligible) {
          recordReject(symbol, direction, def.id, verdict.reason ?? "CANDIDATE_REJECTED_HARD", rowFresh, rowNet);
          continue;
        }
        orderMode = "DIAGNOSTIC_ONLY";
      } else if (longHeadlineCollection) {
        if (!headlineStableOk) {
          recordReject(symbol, direction, def.id, "HEADLINE_LANE_NOT_STABLE_CANDIDATE", rowFresh, rowNet);
          continue;
        }
        if (laneDecision.batchOrderMode === "HEADLINE") {
          if (!verdict.headlineOk) {
            const reason = verdict.reason ?? "CANDIDATE_REJECTED";
            recordReject(symbol, direction, def.id, reason, rowFresh, rowNet);
            if (
              rejectDiagnosticContinue &&
              verdict.diagnosticEligible &&
              REJECT_DIAGNOSTIC_SAMPLEABLE_REASONS.has(reason)
            ) {
              rejectDiagnosticPool.push({
                opportunity: buildOpportunity("DIAGNOSTIC_ONLY"),
                reason,
                symbol,
                laneId: def.id,
                rank: typeof c.rank === "number" && Number.isFinite(c.rank) ? c.rank : null,
                freshValid: rowFresh,
              });
            }
            continue;
          }
          orderMode = "HEADLINE";
        } else {
          if (!verdict.diagnosticEligible) {
            recordReject(symbol, direction, def.id, verdict.reason ?? "CANDIDATE_REJECTED_HARD", rowFresh, rowNet);
            continue;
          }
          orderMode = "DIAGNOSTIC_ONLY";
        }
      } else if (longPaperCollection) {
        if (!verdict.diagnosticEligible) {
          recordReject(symbol, direction, def.id, verdict.reason ?? "CANDIDATE_REJECTED_HARD", rowFresh, rowNet);
          continue;
        }
        orderMode = "DIAGNOSTIC_ONLY";
      } else if (laneDecision.batchOrderMode === "HEADLINE") {
        if (PAPER_HEADLINE_ALLOWLIST_ACTIVE && !headlineVariant) {
          recordReject(symbol, direction, def.id, "HEADLINE_LANE_NOT_CONFIGURED", rowFresh, rowNet);
          continue;
        }
        if (headlineVariant && !headlineStableOk) {
          recordReject(symbol, direction, def.id, "HEADLINE_LANE_NOT_STABLE_CANDIDATE", rowFresh, rowNet);
          continue;
        }
        if (!verdict.headlineOk) {
          // CG_WIDE priority: a candidate that fails the stricter HEADLINE gate but is still
          // diagnostic-eligible is collected as DIAGNOSTIC_ONLY rather than rejected — so the
          // prioritized lane keeps admitting. (Headline net/PF/WR stays clean: these are diagnostic.)
          if (cgWidePriorityCollection && verdict.diagnosticEligible) {
            orderMode = "DIAGNOSTIC_ONLY";
            const opportunity = buildOpportunity(orderMode);
            report.selectedOpportunities.push(opportunity);
            report.paperEligibleCount += 1;
            report.diagnosticEligibleCount += 1;
            laneRollup(def.id).eligible += 1;
            symbolRollup(symbol).eligible += 1;
            continue;
          }
          const reason = verdict.reason ?? "CANDIDATE_REJECTED";
          recordReject(symbol, direction, def.id, reason, rowFresh, rowNet);
          // Rejected-candidate diagnostic sampler (V1): a HEADLINE-rejected but
          // diagnostic-eligible candidate is captured as a candidate forensic
          // sample. It can ONLY become a DIAGNOSTIC_ONLY order — never HEADLINE.
          if (
            rejectDiagnosticContinue &&
            verdict.diagnosticEligible &&
            REJECT_DIAGNOSTIC_SAMPLEABLE_REASONS.has(reason)
          ) {
            rejectDiagnosticPool.push({
              opportunity: buildOpportunity("DIAGNOSTIC_ONLY"),
              reason,
              symbol,
              laneId: def.id,
              rank: typeof c.rank === "number" && Number.isFinite(c.rank) ? c.rank : null,
              freshValid: rowFresh,
            });
          }
          continue;
        }
        orderMode = "HEADLINE";
      } else {
        // DIAGNOSTIC_ONLY batch: relax the "unless diagnostic-only" gates but
        // still reject hard failures.
        if (!verdict.diagnosticEligible) {
          recordReject(symbol, direction, def.id, verdict.reason ?? "CANDIDATE_REJECTED_HARD", rowFresh, rowNet);
          continue;
        }
        orderMode = "DIAGNOSTIC_ONLY";
      }

      // Eligible — build the opportunity.
      const opportunity = buildOpportunity(orderMode);
      report.selectedOpportunities.push(opportunity);
      report.paperEligibleCount += 1;
      if (orderMode === "HEADLINE") report.headlineEligibleCount += 1;
      else report.diagnosticEligibleCount += 1;
      if (challengerDiagnosticCollection) {
        challengerDiagnosticSelected += 1;
        report.challengerDiagnosticSelected = challengerDiagnosticSelected;
      }
      if (variantDiagnosticCollection) {
        variantDiagnosticSelected.set(def.id, (variantDiagnosticSelected.get(def.id) ?? 0) + 1);
        // keep the standing open-book caps accurate within this scan
        diagnosticOpenRunning += 1;
        diagnosticOpenByLane.set(laneId, (diagnosticOpenByLane.get(laneId) ?? 0) + 1);
        diagnosticOpenBySymbol.set(symbol, (diagnosticOpenBySymbol.get(symbol) ?? 0) + 1);
      }
      laneRollup(def.id).eligible += 1;
      symbolRollup(symbol).eligible += 1;
    }
  }

  // ── roll-ups ───────────────────────────────────────────────────────────────
  report.topRejects = toCountRows(rejectReasonCounts, 6);
  report.fieldMissing = toCountRows(fieldMissingCounts, 6);
  report.topRejectedSymbols = toCountRows(rejectedSymbolCounts, 6);
  report.topRejectedLanes = toCountRows(rejectedLaneCounts, 6);
  report.byLane = [...laneRollups.values()].sort((a, b) => b.evaluated - a.evaluated);
  report.bySymbol = [...symbolRollups.values()].sort((a, b) => b.evaluated - a.evaluated);

  const nearMisses = allRejected
    .filter((r) => r.laneId === "CG_WIDE_STOP_TP_WIDE" && NEAR_MISS_REASONS.has(r.reason))
    .sort((a, b) => (b.freshValid ?? 0) - (a.freshValid ?? 0));
  report.closestNearMisses = nearMisses.slice(0, 5);

  // Top rejected opportunities — near misses first, then the rest.
  const ranked = [
    ...nearMisses,
    ...allRejected.filter((r) => !(r.laneId === "CG_WIDE_STOP_TP_WIDE" && NEAR_MISS_REASONS.has(r.reason))),
  ];
  report.topRejectedOpportunities = ranked.slice(0, 5);

  // ── no-opportunity reason + universe action ─────────────────────────────────
  if (report.paperEligibleCount > 0) {
    report.noOpportunityReason = null;
    report.suggestedUniverseAction = "CONTINUE_CURRENT_UNIVERSE";
  } else if (report.candidatesSeen === 0) {
    report.noOpportunityReason = "NO_FRESH_SCAN_CANDIDATE";
    report.suggestedUniverseAction = "WAIT_NEXT_SCAN";
  } else if (!regimeOk) {
    report.noOpportunityReason = "NO_COMPATIBLE_REGIME";
    report.suggestedUniverseAction = "WAIT_NEXT_SCAN";
  } else {
    report.noOpportunityReason = "NO_SAFE_PAPER_OPPORTUNITY";
    report.suggestedUniverseAction =
      inputs.externalShortlistSymbols && inputs.externalShortlistSymbols.length > 0
        ? "EXPAND_EXTERNAL_SHORTLIST"
        : nearMisses.length > 0
          ? "CONTINUE_CURRENT_UNIVERSE"
          : "NO_SAFE_PAPER_OPPORTUNITY";
  }

  // Effective allocator blocker: a degraded active lane always surfaces
  // ACTIVE_LANE_DEGRADED (never "none"), regardless of candidate availability.
  report.blocker = laneDecision.degraded ? "ACTIVE_LANE_DEGRADED" : report.noOpportunityReason ?? "none";

  // ── Rejected-candidate diagnostic sampler (V1) — forensic-only ─────────────
  // Runs AFTER the headline-only no-opportunity / blocker semantics are fixed,
  // so the diagnostic samples are purely additive and never mask a headline
  // blocker. Fires only when the active lane is HEALTHY (HEADLINE batch) yet
  // produced NO headline opportunity this scan and candidates were rejected by
  // sampleable quality gates. The sampled orders are DIAGNOSTIC_ONLY and can
  // NEVER affect headline net/PF/WR, authorize live trading, or change a gate.
  report.rejectedDiagnosticSamplerActive = rejectDiagnosticContinue;
  const samplerCanFire =
    rejectDiagnosticContinue &&
    laneDecision.batchOrderMode === "HEADLINE" &&
    report.headlineEligibleCount === 0 &&
    report.candidatesEvaluated > 0 &&
    rejectDiagnosticPool.length > 0;
  if (samplerCanFire) {
    const selected = selectRejectDiagnosticSamples(rejectDiagnosticPool, rejectDiagnosticMaxPerScan);
    const reasonCounts = new Map<string, number>();
    for (const s of selected) {
      report.selectedOpportunities.push(s.opportunity);
      report.paperEligibleCount += 1;
      report.diagnosticEligibleCount += 1;
      report.rejectedDiagnosticSampled += 1;
      reasonCounts.set(s.reason, (reasonCounts.get(s.reason) ?? 0) + 1);
      laneRollup(s.laneId).eligible += 1;
      symbolRollup(s.symbol).eligible += 1;
    }
    report.rejectedDiagnosticReasons = toCountRows(reasonCounts, 6);
  }

  // ── CG_WIDE priority share ────────────────────────────────────────────────
  // Keep CG_WIDE at >= cgWideTargetShare of admitted opportunities this scan by trimming the
  // diagnostic (non-CG_WIDE) sleeves. Round-robin across lanes so the surviving diagnostics stay
  // varied. Only trims when CG_WIDE actually admitted (never starves the book of all orders).
  if (cgWidePriority && regimeFamily !== "BULLISH") {
    const isWide = (o: PaperOpportunity): boolean => o.variantId === "CG_WIDE_STOP_TP_WIDE";
    const wide = report.selectedOpportunities.filter(isWide);
    const others = report.selectedOpportunities.filter((o) => !isWide(o));
    const maxOthers = Math.floor((wide.length * (1 - cgWideTargetShare)) / cgWideTargetShare);
    if (wide.length > 0 && others.length > maxOthers) {
      const byLane = new Map<string, PaperOpportunity[]>();
      for (const o of others) {
        const arr = byLane.get(o.laneId) ?? [];
        arr.push(o);
        byLane.set(o.laneId, arr);
      }
      const queues = [...byLane.values()];
      const kept: PaperOpportunity[] = [];
      let i = 0;
      while (kept.length < maxOthers && queues.some((q) => q.length > 0)) {
        const next = queues[i % queues.length]!.shift();
        if (next) kept.push(next);
        i += 1;
      }
      report.selectedOpportunities = [...wide, ...kept];
      report.paperEligibleCount = report.selectedOpportunities.length;
      report.headlineEligibleCount = report.selectedOpportunities.filter(
        (o) => o.paperOrderMode === "HEADLINE",
      ).length;
      report.diagnosticEligibleCount = report.selectedOpportunities.filter(
        (o) => o.paperOrderMode !== "HEADLINE",
      ).length;
    }
  }

  return report;
}

// ─── compact brief lines (appended to section 10) ───────────────────────────────

function _n(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v as number)) return "n/a";
  return String(v);
}

function _pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v as number)) return "n/a";
  return `${((v as number) * 100).toFixed(1)}%`;
}
function _sr(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v as number)) return "n/a";
  const n = v as number;
  return `${n >= 0 ? "+" : ""}${n.toFixed(4)}`;
}

export function buildPaperOpportunityAllocatorBriefLines(
  report: PaperOpportunityAllocatorReport,
): string[] {
  const L: string[] = [];
  const paperAccountingNote =
    report.headlineOpenCount === 0 && report.diagnosticOpenCount > 0
      ? "DIAGNOSTIC_OPEN_ONLY"
      : report.createdHeadline === 0 && report.createdDiagnostic > 0
        ? "DIAGNOSTIC_ONLY_COLLECTION"
        : report.headlineOpenCount === 0 && report.diagnosticOpenCount === 0
          ? "NO_OPEN_PAPER_ORDERS"
          : "HEADLINE_AND_DIAGNOSTIC_SPLIT";
  L.push(
    `   allocator: candidatesSeen=${report.candidatesSeen} evaluated=${report.candidatesEvaluated}` +
      ` laneEvals=${report.laneEvaluationsCreated} eligible=${report.paperEligibleCount}` +
      ` created=${report.paperOrdersCreated} dupSuppressed=${report.duplicateSuppressed}`,
  );
  // Adaptive lane quarantine / accounting-mode posture (Part 6).
  L.push(
    `   laneAdmission=${report.laneAdmissionStatus}  rotationAction=${report.rotationAction}` +
      `  orderMode=${report.paperOrderMode}` +
      `  createdHeadline=${report.createdHeadline} createdDiagnostic=${report.createdDiagnostic}`,
  );
  L.push(
    `   paperAccounting: headlineCreated=${report.createdHeadline}` +
      ` headlineOpen=${report.headlineOpenCount}` +
      ` diagnosticCreated=${report.createdDiagnostic}` +
      ` diagnosticOpen=${report.diagnosticOpenCount}` +
      ` note=${paperAccountingNote}`,
  );
  L.push(
    `   cgWideCapacity: open=${report.cgWideOpenCount}/${report.cgWideMaxOpen}` +
      ` stale=${report.cgWideStaleOpenCount}/${report.cgWideMaxStaleOpen}` +
      ` perSymbolMax=${report.cgWideMaxPerSymbolOpen}` +
      ` perDirectionMax=${report.cgWideMaxPerDirectionOpen}` +
      ` warningAt=${report.cgWideElevatedOpenThreshold}` +
      ` pressure=${report.cgWideCapacityPressure}`,
  );
  L.push(
    `   headlineLanes=${HEADLINE_VARIANT_IDS.map((id) => `CG_VARIANT_MATRIX:${id}`).join(",")}` +
      ` status=${
        report.controllerMode === "LONG_ONLY" && report.regimeFamily === "BULLISH"
          ? "ACTIVE"
          : "STANDBY"
      }` +
      ` mode=HEADLINE evidence=FORWARD_OOS_COLLECTION`,
  );
  L.push(
    `   longDiagnosticLane=${LONG_WIDE_PAPER_LANE_ID}` +
      ` status=${
        (
          report.controllerMode === "LONG_ONLY" &&
          report.regimeFamily === "BULLISH"
        ) ||
        report.selectedOpportunities.some((o) => o.laneId === LONG_WIDE_PAPER_LANE_ID)
          ? "ACTIVE"
          : "STANDBY"
      }` +
      ` mode=DIAGNOSTIC_ONLY evidence=FORWARD_OOS_COLLECTION shortLaneUnchanged=TRUE`,
  );
  // Rejected-candidate diagnostic sampler (V1) — forensic-only, never headline.
  const rdReasons =
    report.rejectedDiagnosticReasons.length > 0
      ? report.rejectedDiagnosticReasons.map((r) => `${r.key}(${r.count})`).join(" | ")
      : "none";
  L.push(
    `   rejectedDiagnosticSampler=${report.rejectedDiagnosticSamplerActive ? "ON" : "OFF"}` +
      ` rejectedDiagnosticCreated=${report.rejectedDiagnosticSampled}` +
      ` rejectedDiagnosticReasons=${rdReasons}`,
  );
  L.push(
    `   challengerDiagnostic=${report.challengerDiagnosticEnabled ? "ON" : "OFF"}` +
      ` lane=${report.challengerLaneId ?? "none"}` +
      ` selected=${report.challengerDiagnosticSelected}` +
      ` mode=DIAGNOSTIC_ONLY headlineImpact=NONE`,
  );
  L.push(
    `   activeLanePerf: paperConfidence=${report.paperLaneConfidence ?? "n/a"}` +
      ` routingConfidence=${report.laneConfidence ?? "n/a"}` +
      ` closed=${report.activeLaneClosed} netAvgR=${_sr(report.activeLaneNetAvgR)}` +
      ` PF=${_n2(report.activeLanePF)} WR=${_pct(report.activeLaneWR)}`,
  );
  if (report.quarantineReason) {
    L.push(`   quarantineReason: ${report.quarantineReason}`);
  }
  if (report.noNewHeadlineOrderReason) {
    L.push(`   noNewHeadlineOrder: ${report.noNewHeadlineOrderReason}`);
  }
  if (report.worstSymbols.length > 0) {
    const ws = report.worstSymbols
      .map((w) => `${w.symbol}(net=${_sr(w.netSumR)},n=${w.closed},wr=${_pct(w.wr)})`)
      .join(" | ");
    L.push(`   worstSymbols: ${ws}`);
  }
  if (report.topLossContributors.length > 0) {
    const lc = report.topLossContributors
      .map((c) => `${c.symbol}/${c.direction}(${_sr(c.netR)},${c.closeReason ?? "?"})`)
      .join(" | ");
    L.push(`   topLossContributors: ${lc}`);
  }
  const topRejects =
    report.topRejects.length > 0
      ? report.topRejects.map((r) => `${r.key}(${r.count})`).join(" | ")
      : "none";
  L.push(`   topRejects: ${topRejects}`);
  const nearMisses =
    report.closestNearMisses.length > 0
      ? report.closestNearMisses
          .map((r) => `${r.symbol}/${r.direction}/${r.reason}(n=${_n(r.freshValid)})`)
          .join(" | ")
      : "none";
  L.push(`   closestNearMisses: ${nearMisses}`);
  L.push(
    `   universeAction=${report.suggestedUniverseAction}  allocatorBlocker=${report.blocker}`,
  );
  return L;
}

function _n2(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v as number)) return "n/a";
  return (v as number).toFixed(2);
}

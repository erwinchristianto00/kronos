/**
 * PAPER EXECUTION ROUTER V1 (REPORT-ONLY, PAPER-ONLY)
 *
 * Bounded paper-trading orchestration over qualifying current-guard variant
 * matrix observations and allocator opportunities. Headline admission remains
 * on CG_WIDE_STOP_TP_WIDE; the bounded CG_TRAIL_AFTER_TP1 challenger is
 * DIAGNOSTIC_ONLY. The resolver walks 5m (and where available 1m) candles with
 * variant-specific exit behavior and surfaces a compact operator report.
 *
 * HARD INVARIANTS (do not weaken):
 *  - paperOnly: true and reportOnly: true on every paper order.
 *  - liveBlocked stays TRUE; microPilotAllowed stays FALSE. This module never
 *    sets, overrides, or returns live-trading approval.
 *  - NEVER writes to data/shadow-positions.json. Isolated JSON store at
 *    data/paper-execution-router.json only.
 *  - NEVER places a real exchange order. The resolver consumes klines and
 *    nothing else.
 *  - Backfill-diagnostic and stale-source observations create REJECTED paper
 *    orders for full transparency; they are excluded from headline metrics.
 *  - All I/O is swallowed; failures never propagate to the request handler.
 *
 * RISK CONTROL (paper-only): the headline lane is the proven scaleout exit
 * (CG_SCALEOUT_TP1_TRAIL), and a portfolio drawdown circuit-breaker HALTS new
 * PAPER admission when the headline book draws down >= BREAKER_DRAWDOWN_R from
 * its peak. This halts paper admission only — it never sets/overrides live
 * approval; liveBlocked stays TRUE and microPilotAllowed stays FALSE.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  CurrentGuardVariantMatrixStore,
  CurrentGuardVariantMatrixObservation,
  CurrentGuardVariantMatrixReport,
  VariantMatrixVariantId,
  VariantExitRule,
  VariantFillMode,
  VariantRPathPoint,
} from "./current-guard-variant-matrix.js";
import {
  effectiveMfeGivebackArmR,
  walkVariantPath,
  MAKER_FILL_WINDOW_CANDLES,
  VARIANT_MATRIX_DEFINITIONS,
  MAKER_ROUNDTRIP_BPS,
  TAKER_ROUNDTRIP_BPS,
  STOP_OUT_SLIPPAGE_BPS,
} from "./current-guard-variant-matrix.js";
import {
  excludeSubFloorRowsForReport,
  subFloorExclusionEnabledForDecisions,
  type SubFloorExclusionSummary,
} from "./paper-subfloor-exclusion.js";
import { REALISTIC_FEE_BPS_PER_SIDE } from "./shadow-engine.js";
import {
  paperExitCostRV2,
  paperFundingCostR,
  slipAlreadyInGrossBps as _slipInGrossV2,
} from "./paper-cost-model-v2.js";
import type { AdaptiveLaneRouterReport } from "./adaptive-lane-router.js";
import type { LiveTradingGateReport } from "./live-trading-gate.js";
import { recordHeatShadowSnapshot } from "./portfolio-heat-shadow.js";
import {
  CURRENT_DECISION_POLICY_VERSION,
  CURRENT_EVIDENCE_ERA,
  EVIDENCE_POLICY_VERSION,
  EXECUTION_POLICY_VERSION,
  MIN_EXECUTION_RR,
  resolveEndToEndCorrectnessDeploymentAt,
} from "@dtc/shared";
import { getSimulatedPaperPathStore, simulatedPaperPathDirFor } from "./paper-simulated-path-store.js";
import {
  prepareForwardCausalIdentity,
  recordForwardOpportunity,
  recordForwardOutcomes,
  resolveCausalCollectionActivation,
  withResolvedCausalIdentity,
  type CausalIdentity,
} from "../experience-engine/forward-causal-collection.js";
import { latestCortexDecisionSnapshotForLane, type CortexDecisionSnapshot } from "./cortex-decision-snapshot.js";
import type { ExecutiveReviewExecutionLink } from "./executive-review-store.js";

// ─── public enums / type tokens ──────────────────────────────────────────────

export type PaperOrderStatus =
  | "CREATED"
  | "PAPER_SUBMITTED"
  | "PAPER_FILLED"
  | "PAPER_PARTIAL"
  | "PAPER_CANCELED"
  | "PAPER_REJECTED"
  | "PAPER_CLOSED_WIN"
  | "PAPER_CLOSED_LOSS"
  | "PAPER_EXPIRED"
  | "PAPER_NO_FILL"
  | "PAPER_DATA_FAILURE";

/**
 * Market entries fill at the decision timestamp. Limit entries are deliberately
 * pending until their exact order price trades; a broad zone touch is not a fill.
 */
export type PaperEntryOrderType = "MARKET" | "LIMIT";

export type PaperRiskLabel = "NORMAL" | "EXPERIMENTAL" | "DEGRADED";
export type OperationalSafetyStatus = "OK" | "BLOCKED";
/**
 * Paper-order accounting mode.
 *  - HEADLINE: counts toward the headline net/PF/WR profit metrics. Only orders
 *    that pass BOTH lane-level economics AND candidate-level quality gates while
 *    the active lane is NOT quarantined may be HEADLINE.
 *  - DIAGNOSTIC_ONLY: tracked + resolved for learning, but EXCLUDED from headline
 *    profit metrics. Used when the active lane is degraded/quarantined and the
 *    operator opted into continued diagnostic collection (PAPER_DIAGNOSTIC_CONTINUE=1).
 */
export type PaperOrderMode = "HEADLINE" | "DIAGNOSTIC_ONLY";
/**
 * Source provenance for a paper order. The legacy lane mirrors closed
 * current-guard variant-matrix observations; the allocator lane mirrors fresh
 * /api/scan candidates evaluated across paper lanes.
 */
export type PaperOrderSourceType =
  | "VARIANT_MATRIX_OBSERVATION"
  | "SCAN_CANDIDATE_LANE_ALLOCATOR"
  // Real-time short live-mirror ("mode 2"): fresh scanner short emitted straight to the
  // dedicated mirror store with openedAt = now. See lib/realtime-short-mirror.ts.
  | "REALTIME_SHORT_MIRROR";
export type PaperDiagnosticLabel =
  | "BACKFILL_DIAGNOSTIC"
  | "SOURCE_TOO_OLD_FOR_PAPER_ADMISSION"
  | "MISSING_GEOMETRY"
  | "POSITION_SIZE_SANITY_CAP";
export type LaneConfidence = "HIGH" | "MEDIUM" | "LOW" | "DEGRADED";
export type RotationAction =
  | "KEEP_CURRENT_LANE"
  | "ROTATE_TO_BETTER_LANE"
  | "CONTINUE_PAPER_WITH_LOW_CONFIDENCE"
  | "PAPER_ONLY_NO_REAL_APPROVAL";

// ─── constants ───────────────────────────────────────────────────────────────

export const PAPER_ADMISSION_MAX_AGE_MS = 10 * 60 * 1000; // 10 min
export const PAPER_ORDER_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Max-hold time-stop. A position that has hit neither TP nor SL within the 72h
// signal horizon has lost its thesis: it is force-closed at the last observed
// close (mark-to-market) and BOOKED as win/loss. Without this, wide-stop losers
// drift unresolved (PAPER_SUBMITTED) past 72h and never reach the ledger — the
// "phantom equity" bug where the book shows only realized winners. 72h matches
// FASTTP_HORIZON_HOURS / SIGNAL_DECAY_HORIZON_HOURS / the STALE-open warn bucket.
export const PAPER_MAX_HOLD_MS = 72 * 60 * 60 * 1000; // 72 h
export const DEFAULT_PAPER_EQUITY = 2000;
const DEFAULT_PER_LANE_DIAGNOSTIC_FLOOR = 200;
const DEFAULT_PAPER_MAX_CLOSED_DIAGNOSTIC = 5_000;
const DEFAULT_PAPER_MAX_TERMINAL_NON_OUTCOME = 5_000;

/** Validated env parse for the two closed-diagnostic retention knobs below. Mirrors
 *  getPaperEquityFromEnv()'s shape (this file's established idiom): FALL BACK to the compiled
 *  default on anything invalid rather than clamping, so a typo can never silently install a
 *  different retention policy.
 *
 *  Replaces `Number(process.env.X) || DEFAULT`, which catches NaN/""/0 but passes NEGATIVES
 *  straight through (`Number("-1") || 200` → `-1`). A negative is not merely "a smaller cap":
 *  pruneClosedDiagnostic() feeds these into Array.slice(), where a negative index counts from
 *  the END. With PER_LANE_DIAGNOSTIC_FLOOR = -1, `bucket.slice(0, -1)` makes the per-lane FLOOR
 *  "everything except the oldest row" and `bucket.slice(-1)` makes the remainder pool a single
 *  row — the global cap then never binds and the store grows unbounded, i.e. exactly the OOM
 *  class this cap exists to prevent, installed by a one-character env typo. */
export function parseDiagnosticRetentionEnv(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

/** Max DIAGNOSTIC closed orders retained in the paper store (rolling measurement window). The
 *  store loads fully each resolve cycle, so unbounded closed-order growth is a memory/latency risk
 *  (the OOM class). HEADLINE (real-ledger) + OPEN orders are NEVER pruned by this. Env-tunable.
 *  2026-07-11: the previous default (9,999,999) was effectively infinite — confirmed live, the
 *  research instance had grown to 11,213 total orders / 34MB and was never once pruned, directly
 *  correlated with that instance's 2x-higher OOM crash-restart rate vs live/testnet (whose smaller
 *  paper-order volume kept them under the same inert ceiling by chance, not by this cap doing
 *  anything).
 *
 *  2026-07-26 — DEFAULT DELIBERATELY LEFT AT 5,000. A raise to 12,000 was implemented and then
 *  REVERTED at gate. Read this before touching the number again.
 *
 *  The diagnosis that motivated the raise is correct BUT IS INSTANCE-SPECIFIC, and this is a
 *  process-global constant with exactly one call site shared by every PaperExecutionRouterStore
 *  on every instance. pruneClosedDiagnostic() keeps `Σ min(n_lane, PER_LANE_DIAGNOSTIC_FLOOR)`
 *  unconditionally and only then spends `max(0, maxClosed − floorKept)` on the remainder, so the
 *  cap does NOTHING once `laneCount × floor >= maxClosed`. Measured 2026-07-26, read-only:
 *
 *    testnet (/root/kronos-testnet, 117.9 MB): 35 lanes, floorKept 6,349 ⇒ remainderBudget
 *      max(0, 5,000 − 6,349) = 0. Cap INERT; retention is exactly "newest 200 per lane", a
 *      3.7–16 h window on the busy lanes. This is the starvation the raise was aimed at.
 *    research (/root/kronos, 19.2 MB): 30 lanes, aggregate floor 3,173, closedDiag pinned at
 *      EXACTLY 5,000 ⇒ remainderBudget 1,827. Cap FULLY BINDING. Closed-diagnostic rows are
 *      15.4 MB of that 19.2 MB store at 3,085 B/row, so 12,000 would take it to ~40.8 MB
 *      (+112%) — past the 34 MB size cited above as correlating with research's 2x OOM
 *      crash-restart rate, i.e. straight back into the incident this cap was created to fix.
 *      Research closes only ~150/day, so 12,000 buys it ~80 days of history, not 30 h.
 *      Research also runs a SECOND store (data/realtime-short/, 11.1 MB) under this same cap.
 *
 *  Second reason the default must not move: the retained pool is the entire input to
 *  computeAutoQuarantinedVariantLanes() (paper-opportunity-allocator.ts), which is a REAL
 *  ADMISSION GATE — its output halts admission for variant diagnostic lanes. It averages netR
 *  over the whole retained pool with NO recency weighting, so changing retention changes which
 *  lanes are quarantined. It is default-ON (`PAPER_VARIANT_AUTO_QUARANTINE !== "0"`). Testnet
 *  sets =0 so it is OFF there; research sets nothing so it is ON — and research is precisely
 *  the instance where the cap binds and retention would actually change. A retention knob must
 *  not silently move an admission gate.
 *
 *  THE SUPPORTED WAY TO RAISE RETENTION IS PER-INSTANCE ENV, NOT THIS DEFAULT:
 *    testnet only:  PAPER_MAX_CLOSED_DIAGNOSTIC=12000
 *  That is safe on testnet specifically because auto-quarantine is disabled there and the store
 *  has the headroom (112 → ~128 MB). Do NOT set it on research or mainnet without re-measuring
 *  that instance's own lane count, row size and quarantine setting.
 *
 *  Whatever value is chosen, it must clear `laneCount × PER_LANE_DIAGNOSTIC_FLOOR` or it governs
 *  nothing at all — silently, with no error. Use closedDiagnosticRetentionBudget() below to check
 *  before setting it. And it must NOT be raised far enough to restore multi-week history: 19 days
 *  at testnet's ~8,700/day is ~165,000 rows ≈ 650 MB of closed-diagnostic alone, far past the
 *  234 MB store that caused the 2026-07-20 testnet CPU incident.
 *
 *  Note also this cap governs only 22.4% of the testnet store — the other 77.6% (PAPER_SUBMITTED
 *  43 MB, PAPER_CANCELED 29.7 MB, PAPER_NO_FILL 10.0 MB) is untouchable by
 *  pruneClosedDiagnostic() at ANY cap value, and those terminal rows carry no closed-outcome
 *  information. Reclaiming them is the real headroom, and is a separate change. */
export const PAPER_MAX_CLOSED_DIAGNOSTIC = parseDiagnosticRetentionEnv(
  process.env.PAPER_MAX_CLOSED_DIAGNOSTIC,
  DEFAULT_PAPER_MAX_CLOSED_DIAGNOSTIC,
);
/** Terminal rows with no PnL label are useful for audit, but not for learning or resolution.
 * Keep a bounded hot tail and archive older rows before removing them from the active store. */
export const PAPER_MAX_TERMINAL_NON_OUTCOME = parseDiagnosticRetentionEnv(
  process.env.PAPER_MAX_TERMINAL_NON_OUTCOME,
  DEFAULT_PAPER_MAX_TERMINAL_NON_OUTCOME,
);
/** Never reduce a single lane's retained closed-diagnostic count below this purely because sibling
 *  lanes are busier — see pruneClosedDiagnostic()'s doc comment. Comfortably above every n>=30/
 *  n>=40 sample-size gate in the codebase. Env-tunable, mirrors PAPER_DIAGNOSTIC_MAX_OPEN_PER_LANE's
 *  naming in paper-opportunity-allocator.ts. Value deliberately UNCHANGED at 200 by the 2026-07-26
 *  cap raise: the floor was never the broken part, the cap that had to clear it was. */
export const PER_LANE_DIAGNOSTIC_FLOOR = parseDiagnosticRetentionEnv(
  process.env.PAPER_MAX_CLOSED_DIAGNOSTIC_PER_LANE_FLOOR,
  DEFAULT_PER_LANE_DIAGNOSTIC_FLOOR,
);

/**
 * The floor-vs-cap arithmetic pruneClosedDiagnostic() performs, exposed as a pure function so the
 * SILENT-INERTNESS failure mode has a name, a test and a pre-flight check.
 *
 * `capIsInert` is the whole point: when the aggregate per-lane floor already meets or exceeds the
 * global cap, `remainderBudget` is 0, `remainder.slice(0, 0)` keeps nothing, and the cap governs
 * NOTHING — retention silently collapses to "newest PER_LANE_DIAGNOSTIC_FLOOR per lane" with no
 * error, no log and no observable difference from a correctly-configured cap. That is how a 5,000
 * cap came to be inert on a 35-lane testnet instance while binding on a 30-lane research instance.
 *
 * It is a lane-COUNT problem, not a value problem: the condition returns whenever lanes grow past
 * `maxClosed / floor` (at the shipped 5,000/200 that is 25 lanes; at 12,000/200 it is 60). Any new
 * lane batch can re-introduce it. Check with this before choosing PAPER_MAX_CLOSED_DIAGNOSTIC.
 *
 * `laneClosedCounts` are the per-lane closed-DIAGNOSTIC row counts, in any order.
 */
export function closedDiagnosticRetentionBudget(
  laneClosedCounts: readonly number[],
  maxClosed: number = PAPER_MAX_CLOSED_DIAGNOSTIC,
  perLaneFloor: number = PER_LANE_DIAGNOSTIC_FLOOR,
): { aggregateFloor: number; remainderBudget: number; capIsInert: boolean; laneCount: number } {
  let aggregateFloor = 0;
  for (const n of laneClosedCounts) {
    if (!Number.isFinite(n) || n <= 0) continue;
    aggregateFloor += Math.min(n, perLaneFloor);
  }
  const remainderBudget = Math.max(0, maxClosed - aggregateFloor);
  return {
    aggregateFloor,
    remainderBudget,
    capIsInert: remainderBudget === 0,
    laneCount: laneClosedCounts.filter((n) => Number.isFinite(n) && n > 0).length,
  };
}
const RISK_PCT = 1; // 1% of equity per trade — never changed
const DEFAULT_PAPER_MAX_NOTIONAL_CAP = 50_000;
const PAPER_TAKER_COST_BPS = 22; // mirrors TAKER_ROUNDTRIP_BPS from CG variant matrix
const CANDLE_MS = 5 * 60 * 1000;

// Portfolio drawdown circuit-breaker (PAPER-ONLY safety; halts PAPER admission only —
// liveBlocked stays TRUE and no live behavior is ever influenced). When the headline book
// draws down >= BREAKER_DRAWDOWN_R from its peak, new paper admission halts for a cooldown,
// then re-arms with the peak baseline reset to the trough. Tuned from the in-session sim
// (a -10..-15R breaker capped the full-exit -157R catastrophe at ~-11R drawdown).
const BREAKER_DRAWDOWN_R = 15;
const BREAKER_COOLDOWN_MS = 90 * 60 * 1000; // 90 min

function getPaperEquityFromEnv(): number {
  const raw = process.env.PAPER_EQUITY;
  if (!raw) return DEFAULT_PAPER_EQUITY;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PAPER_EQUITY;
  return parsed;
}

export const PAPER_EQUITY = getPaperEquityFromEnv();

const DEFAULT_PAPER_ELIGIBLE_VARIANT_IDS: readonly VariantMatrixVariantId[] = ["CG_SCALEOUT_TP1_TRAIL"];

function parseHeadlineVariantIds(envName: string, raw: string | undefined): VariantMatrixVariantId[] {
  const known = new Set(VARIANT_MATRIX_DEFINITIONS.map((d) => d.id));
  const parsed = (raw ?? "")
    .split(/[,\s]+/)
    .map((id) => id.trim())
    .filter(Boolean);
  const out: VariantMatrixVariantId[] = [];
  const rejected: string[] = [];
  for (const id of parsed) {
    if (!known.has(id as VariantMatrixVariantId)) {
      rejected.push(id);
      continue;
    }
    if (!out.includes(id as VariantMatrixVariantId)) out.push(id as VariantMatrixVariantId);
  }
  if (rejected.length > 0) {
    console.warn(`[paper-router] ${envName} ignored unknown variant id(s): ${rejected.join(", ")}`);
  }
  return out;
}

// Variant policy: default production keeps the single proven scaleout headline. A deliberately
// configured testnet-live instance may promote an explicit comma-separated allowlist via
// PAPER_HEADLINE_VARIANT_IDS (or the legacy singular PAPER_HEADLINE_VARIANT_ID). Unknown ids are
// ignored; if none survive validation, fall back to the default rather than silently trading nothing.
const PAPER_ELIGIBLE_VARIANT_IDS: readonly VariantMatrixVariantId[] = (() => {
  const plural = process.env.PAPER_HEADLINE_VARIANT_IDS?.trim();
  const singular = process.env.PAPER_HEADLINE_VARIANT_ID?.trim();
  const raw = plural || singular;
  if (!raw) return DEFAULT_PAPER_ELIGIBLE_VARIANT_IDS;
  const parsed = parseHeadlineVariantIds(plural ? "PAPER_HEADLINE_VARIANT_IDS" : "PAPER_HEADLINE_VARIANT_ID", raw);
  if (parsed.length === 0) {
    console.warn("[paper-router] headline override had no known variant ids; falling back to CG_SCALEOUT_TP1_TRAIL");
    return DEFAULT_PAPER_ELIGIBLE_VARIANT_IDS;
  }
  return parsed;
})();

const PAPER_HEADLINE_REQUIRE_STABLE =
  process.env.PAPER_HEADLINE_REQUIRE_STABLE === "1" ||
  (process.env.PAPER_HEADLINE_VARIANT_IDS?.trim() ? process.env.PAPER_HEADLINE_REQUIRE_STABLE !== "0" : false);

function isConfiguredPaperHeadlineVariant(variantId: string): boolean {
  return PAPER_ELIGIBLE_VARIANT_IDS.includes(variantId as VariantMatrixVariantId);
}

const PAPER_REJECT_VARIANT_IDS: readonly string[] = [
  "CG_BASELINE_CURRENT",
  "CG_MAKER_LIMIT_SIM",
] as const;

// ─── paper order shape ──────────────────────────────────────────────────────

/**
 * PAPER ORDER PROVENANCE V1 (report-only, paper-only).
 *
 * Candidate-level evidence captured at admission for allocator-created paper
 * orders. Before V1 these fields were dropped at admission, leaving the audit
 * blind to WHY a loser was admitted (calibration verdict, route mode, chase
 * risk, source conflict, entry drift, …). Persisting them lets the provenance
 * audit + the report-only loser-fingerprint gate reason about real fingerprints.
 *
 * NEVER influences admission or live behavior — pure forensic metadata. Fields
 * that were unavailable at admission are persisted as null and named in the
 * owning order's `provenanceFieldMissing` list.
 *
 * Note: identity/geometry fields already persisted at the top level of
 * PaperOrder (sourceType, sourceCandidateId, scanBatchId, symbol, direction,
 * regime, controllerMode, entryPrice, stopLoss, takeProfitLevels,
 * selectedLaneId, plannedStopDistanceBps) are NOT duplicated here.
 */
export interface PaperOrderProvenance {
  // ── source identity ──
  sourceRank: number | null;
  sourceStatus: string | null;
  currentPriceAtAdmission: number | null;
  /** Reference/fill price used for the order (planned entry; no real fill in paper). */
  referencePrice: number | null;
  // ── transformed lane geometry ──
  stopBucket: string;
  tpDistanceBps: number | null;
  riskReward: number | null;
  // ── variant selection ──
  selectedEntryVariant: string | null;
  selectedExitVariant: string | null;
  expectedGrossR: number | null;
  expectedNetR: number | null;
  // ── calibration ──
  calibratedExpectedNetR: number | null;
  calibrationVerdict: string | null;
  calibrationPenaltyR: number | null;
  calibrationConfidence: string | null;
  calibrationDiagnosisCodes: string[];
  // ── routing ──
  routeMode: string | null;
  routeScore: number | null;
  routeReasonCodes: string[];
  primaryProfitEligible: boolean | null;
  dataCollectionReason: string | null;
  // ── conflicts + external signals ──
  sourceConflict: boolean | null;
  directionConflict: boolean | null;
  horizonConflict: boolean | null;
  kronosBias: string | null;
  kronosConfidence: number | null;
  whaleSignal: string | null;
  whaleScore: number | null;
  sentimentSignal: string | null;
  sentimentScore: number | null;
  // ── chase / entry drift ──
  chaseRisk: string | null;
  entryDriftPct: number | null;
  entryDriftAtr: number | null;
  // ── cost geometry ──
  costR: number | null;
  spreadR: number | null;
  feeSlippageR: number | null;
  stopDistanceBpsFromPlan: number | null;
  // ── cohort ──
  symbolHistoricalNet: number | null;
  variantSampleSize: number | null;
  variantConfidenceTier: string | null;
  // ── fingerprint flags (human-readable; gate predicates use canonical fields) ──
  candidateQualityFlags: string[];
}

export interface PaperOrder {
  paperOrderId: string;
  /**
   * Source provenance. Defaults to VARIANT_MATRIX_OBSERVATION when omitted on
   * legacy records (added with the scan-candidate allocator lane).
   */
  sourceType?: PaperOrderSourceType;
  /** Allocator-lane only: the scan candidate id this order was derived from. */
  sourceCandidateId?: string | null;
  /** Allocator-lane only: the scan batch (generatedAt) this order belongs to. */
  scanBatchId?: string | null;
  sourceObservationId: string;
  sourceSignalId: string | null;
  dedupeKey: string; // `${sourceObservationId}:${selectedLaneId}`
  /**
   * DECISION time (ISO) — the instant admission stamped this order. Every label-shaped
   * field on the row (regime, controllerMode/controllerConfidence, routerPermission,
   * provenance, the forward-gate block) is as-of THIS instant, not openedAt.
   * STRICTLY AFTER openedAt: measured over the 29,968-order testnet store on 2026-07-26,
   * createdAt − openedAt was positive on 29,968/29,968 rows (closed cohort p50 +213.9s,
   * p90 +394.2s, max +586.6s). There is no negative-skew cohort.
   */
  createdAt: string;
  updatedAt: string;
  /**
   * OBSERVATION time (ISO) — the source scan instant at which `entryPrice` was observed.
   * PRECEDES createdAt (see above). LABEL LEAK, measured not theoretical: the resolver
   * anchors its candle walk here (`startTime = openedAtMs − CANDLE_MS`, and the walk loop
   * admits the whole 5m bar containing openedAtMs), so an order can reach a terminal
   * outcome from price action that closed BEFORE its own label existed. On the testnet
   * store 2026-07-26, 106 of 6,229 closed rows carrying closedAtMs had
   * closedAtMs < createdAt (86 of them TP1_HIT wins); 0 had closedAtMs < openedAt.
   * Surfaced report-only by buildPaperLatencyDiagnostics as resolvedBeforeDecisionCount /
   * labelLeak*Sec / preDecisionResolvableSecP50. Resolution semantics are deliberately
   * UNCHANGED: entryPrice was observed at openedAt, so re-anchoring the walk to createdAt
   * without also re-deriving the entry would simulate a fill that never existed.
   */
  openedAt: string; // mirrors source observation
  /** Original scanner-observation timestamp. Kept separate from decision/fill time post-fix. */
  sourceObservedAt?: string | null;
  /** Pending expiry clock. Post-fix orders stamp this at decision admission. */
  firstSeenAt?: string | null;
  /** Actual position clock. Null only while a post-fix limit entry remains pending. */
  entryFilledAt?: string | null;
  entryOrderType?: PaperEntryOrderType;
  /** Exact resting price for LIMIT entries; never inferred from a touched zone. */
  entryOrderPrice?: number | null;
  /** Explicit policy stamp: unstamped orders are legacy-only evidence. */
  executionPolicyVersion?: string | null;
  /** Complete post-fix evidence policy lineage. Missing values remain legacy-only. */
  decisionPolicyVersion?: string | null;
  evidencePolicyVersion?: string | null;
  evidenceEra?: string | null;
  policyDeploymentAt?: string | null;
  /** Geometry recomputed from the actual selected/fill price. */
  actualStopDistanceBps?: number | null;
  actualRiskReward?: number | null;
  symbol: string;
  direction: "LONG" | "SHORT";
  regime: string | null;
  /** Repair-only explicit axes. Direction and regime are separate dimensions. */
  axisVersion?: 1;
  axisDirection?: "LONG" | "SHORT";
  axisRegimeFamily?: "BULLISH" | "BEARISH" | "MIXED" | "UNKNOWN";
  axisKey?: string;
  controllerMode: string;
  controllerConfidence?: string | null;
  selectedLaneId: string;
  routerPermission: string;
  entryPrice: number;
  stopLoss: number;
  takeProfitLevels: number[];
  /** Exact paper exit behavior. Legacy orders default to tp1_full. */
  variantExitRule?: VariantExitRule;
  /** Fill model. Legacy/most orders are taker; maker_limit carries post-only no-fill risk. */
  fillMode?: VariantFillMode;
  plannedStopDistanceBps: number;
  riskPctOfEquity: number; // 1 by default; reduced for paper-only Mixed ALLOW_REDUCED
  paperEquity: number;
  plannedRiskAmount: number;
  plannedPositionNotional: number;
  plannedRiskR: number; // always 1
  oosUnconfirmed: boolean;
  infraNotReady: boolean;
  paperRiskLabel: PaperRiskLabel;
  /**
   * Accounting mode. Omitted on legacy records (treated as HEADLINE). Allocator
   * orders stamp this explicitly; DIAGNOSTIC_ONLY orders are excluded from
   * headline profit metrics.
   */
  paperOrderMode?: PaperOrderMode;
  operationalSafetyStatus: OperationalSafetyStatus;
  diagnosticLabel: PaperDiagnosticLabel | null;
  paperStatus: PaperOrderStatus;
  grossR: number | null;
  costR: number | null;
  /**
   * Which cost model produced `costR`. COHORT DISCRIMINATOR — absent/1 and 2 are NOT comparable
   * and must never be pooled silently.
   *   absent (v1) — flat PAPER_TAKER_COST_BPS (22) on every close regardless of fillMode or exit:
   *                 maker lanes overcharged 3.67x, stop-outs undercharged, and 2-7bps of the
   *                 execution-realism slippage double-counted (already inside grossR).
   *   2           — exit-aware: roundTrip(costModel) + STOP_OUT_SLIPPAGE_BPS on stop-like exits,
   *                 minus the slippage grossR already realized. See PAPER_COST_MODEL_VERSION.
   * Stamped only by resolvePaperOrders. Report-only metadata: no gate reads it.
   */
  costModelVersion?: number;
  netR: number | null;
  netPnlAmount: number | null;
  closeReason: string | null;
  /** MARKET timestamp (ms) of the exit candle that first satisfied the exit rule — from candle data, NOT process
   *  time. Candle-granularity; conservative adverse-first when a bar spans both stop and target. Null on legacy
   *  records + non-close statuses. Use THIS (never updatedAt/Date.now) for outcome attribution + chronological
   *  learning. Added 2026-07-13 (Track 1a); see lane-context-journal.ts. */
  closedAtMs?: number | null;
  /** PROCESS timestamp (ms) when the resolver persisted the close. Audit only — never an attribution key. Always
   *  ≥ closedAtMs (a close is persisted at/after the market bar that triggered it). */
  resolvedAtMs?: number | null;
  /** True when the exit candle spanned BOTH stop and target and intrabar order was unprovable (resolved
   *  adverse-first) — the row is intrabar-ambiguous for close-timing purposes. */
  closeIntrabarAmbiguous?: boolean;
  /**
   * Candidate-level provenance (PAPER ORDER PROVENANCE V1). Present on
   * allocator-created orders; null/omitted on legacy variant-matrix orders.
   * Report-only forensic metadata — never read by admission/resolution.
   */
  provenance?: PaperOrderProvenance | null;
  /** Provenance source fields that were unavailable at admission (persisted as null). */
  provenanceFieldMissing?: string[];
  /** Forward-only causal identity. Absent on legacy orders and whenever collection mode is off. */
  causalIdentity?: CausalIdentity | null;
  /** Exact CORTEX x captured at admission; absent means explicitly ineligible for CORTEX learning. */
  cortexDecisionSnapshot?: CortexDecisionSnapshot | null;
  /** Present only when an exact Four-Brain review was persisted before admission. */
  executiveReviewLink?: ExecutiveReviewExecutionLink | null;
  // ── forward-gate shadow label (report-only OOS validation; NEVER blocks admission) ──
  forwardGateId?: string;
  forwardGateVersion?: number;
  forwardGateDecision?: ForwardGateDecision;
  forwardGateReasons?: string[];
  forwardGateEvaluatedAt?: string;
  forwardGateCapTier?: string | null;
  forwardGateIsToxicSymbol?: boolean;
  // Mixed paper-budget forward OOS metadata. Report-only/paper-only; never read by resolver.
  mixedBudgetProfile?: string;
  mixedBudgetVersion?: number;
  budgetActivationScope?: "PAPER_ONLY";
  admissionResult?: string;
  occupancyMode?: string;
  stalePassHealth?: string;
  riskMultiplierAfterOccupancy?: number;
  experimentalLeverage?: number;
  paperRiskMultiplier?: number;
  budgetUsed?: unknown;
  budgetReason?: string;
  reportOnly: true;
  paperOnly: true;
}

// ─── store ───────────────────────────────────────────────────────────────────

interface PaperExecutionRouterState {
  paperStartAt: string | null;
  paperEquityStart: number;
  activeLaneId: string | null;
  laneConfidence: LaneConfidence;
  /** Peak headline-book equity ever reached (for the drawdown circuit-breaker). */
  peakEquityReached: number;
  peakEquityReachedAt: string | null;
  /** When set and in the future, paper admission is halted by the drawdown breaker. */
  breakerHaltUntil: string | null;
  orders: PaperOrder[];
  version: number;
}

const PAPER_STATE_VERSION = 1;

function paperAxisRegimeFamily(regime: string | null | undefined): NonNullable<PaperOrder["axisRegimeFamily"]> {
  const label = (regime ?? "").toLowerCase();
  if (/mixed|rotation|chop|range|sideways|neutral/.test(label)) return "MIXED";
  if (/bull|long/.test(label)) return "BULLISH";
  if (/bear|short/.test(label)) return "BEARISH";
  return "UNKNOWN";
}

function stampPaperOrderAxis(order: PaperOrder): void {
  const family = paperAxisRegimeFamily(order.regime);
  order.axisVersion = 1;
  order.axisDirection = order.direction;
  order.axisRegimeFamily = family;
  order.axisKey = `${order.direction}::${family}`;
}

export class PaperExecutionRouterStore {
  private readonly file: string;
  private state: PaperExecutionRouterState;
  private batchDepth = 0;
  private dirtyDuringBatch = false;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "paper-execution-router.json");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort
    }
    this.state = this._load();
  }

  get path(): string {
    return this.file;
  }

  get all(): PaperOrder[] {
    return this.state.orders;
  }

  getState(): PaperExecutionRouterState {
    return this.state;
  }

  private _parseFile(path: string): PaperExecutionRouterState | null {
    try {
      if (!existsSync(path)) return null;
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { orders?: unknown }).orders)) {
        const p = parsed as Partial<PaperExecutionRouterState>;
        const equityStart = typeof p.paperEquityStart === "number" ? p.paperEquityStart : PAPER_EQUITY;
        return {
          paperStartAt: p.paperStartAt ?? null,
          paperEquityStart: equityStart,
          activeLaneId: p.activeLaneId ?? null,
          laneConfidence: (p.laneConfidence ?? "MEDIUM") as LaneConfidence,
          peakEquityReached:
            typeof p.peakEquityReached === "number" ? p.peakEquityReached : equityStart,
          peakEquityReachedAt: p.peakEquityReachedAt ?? null,
          breakerHaltUntil: p.breakerHaltUntil ?? null,
          orders: (p.orders ?? []) as PaperOrder[],
          version: typeof p.version === "number" ? p.version : PAPER_STATE_VERSION,
        };
      }
    } catch {
      // corrupt/partial file — fall through to the backup
    }
    return null;
  }

  private _load(): PaperExecutionRouterState {
    // Never silently wipe: a corrupt/partial main file falls back to the last good backup before
    // resorting to an empty book. (A non-atomic write interrupted mid-flush used to parse-fail here
    // and reset the entire paper book — atomic save() + this recovery path prevent that.)
    const main = this._parseFile(this.file);
    if (main) return main;
    const backup = this._parseFile(this.file + ".bak");
    if (backup) return backup;
    return this._empty();
  }

  private _empty(): PaperExecutionRouterState {
    return {
      paperStartAt: null,
      paperEquityStart: PAPER_EQUITY,
      activeLaneId: null,
      laneConfidence: "MEDIUM",
      peakEquityReached: PAPER_EQUITY,
      peakEquityReachedAt: null,
      breakerHaltUntil: null,
      orders: [],
      version: PAPER_STATE_VERSION,
    };
  }

  /**
   * Defers save() to a single flush on endBatch(). Callers that mutate many orders in a loop
   * (e.g. resolvePaperOrders, which used to call store.update() — and therefore a full-array
   * JSON.stringify + writeFileSync — once PER ORDER) should wrap the loop in begin/endBatch so
   * the O(n) flush happens once per batch instead of once per order (same class of fix already
   * applied to current-guard-variant-matrix.ts's resolver).
   */
  beginBatch(): void {
    this.batchDepth += 1;
  }

  endBatch(): void {
    if (this.batchDepth > 0) this.batchDepth -= 1;
    if (this.batchDepth === 0 && this.dirtyDuringBatch) {
      this.dirtyDuringBatch = false;
      this.flush();
    }
  }

  save(): void {
    if (this.batchDepth > 0) {
      this.dirtyDuringBatch = true;
      return;
    }
    this.flush();
  }

  private flush(): void {
    try {
      for (const order of this.state.orders) stampPaperOrderAxis(order);
      // Atomic write: serialize to a temp file, snapshot the previous good file as .bak, then
      // rename into place (atomic on the same volume). A reload can therefore never observe a
      // partially-written main file, and the .bak is the recovery source if anything goes wrong.
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
      if (existsSync(this.file)) {
        try {
          copyFileSync(this.file, `${this.file}.bak`);
        } catch {
          // best-effort backup
        }
      }
      renameSync(tmp, this.file);
    } catch {
      // report-only storage failures must never affect the app
    }
  }

  ensurePaperStartAt(now: string): string {
    if (this.state.paperStartAt) return this.state.paperStartAt;
    this.state.paperStartAt = now;
    this.state.paperEquityStart = PAPER_EQUITY;
    this.save();
    return this.state.paperStartAt;
  }

  setActiveLane(laneId: string | null, confidence: LaneConfidence): void {
    this.state.activeLaneId = laneId;
    this.state.laneConfidence = confidence;
    this.save();
  }

  /** True while the portfolio drawdown circuit-breaker is halting paper admission. */
  isAdmissionHalted(now: string): boolean {
    const until = this.state.breakerHaltUntil;
    if (!until) return false;
    const untilMs = new Date(until).getTime();
    const nowMs = new Date(now).getTime();
    if (!Number.isFinite(untilMs) || !Number.isFinite(nowMs)) return false;
    return nowMs < untilMs;
  }

  getBreakerState(): {
    peakEquityReached: number;
    peakEquityReachedAt: string | null;
    breakerHaltUntil: string | null;
  } {
    return {
      peakEquityReached: this.state.peakEquityReached,
      peakEquityReachedAt: this.state.peakEquityReachedAt,
      breakerHaltUntil: this.state.breakerHaltUntil,
    };
  }

  /**
   * Portfolio drawdown circuit-breaker bookkeeping (PAPER-ONLY; never influences live).
   * Call once per pass AFTER resolution with the current headline-book equity. Raises the
   * tracked peak; auto-resumes (clearing the halt and re-baselining the peak to the trough)
   * once the cooldown elapses; and trips a new cooldown halt when drawdown-from-peak reaches
   * BREAKER_DRAWDOWN_R (in dollars = R * 1% of the starting equity).
   */
  updateEquityPeakAndBreaker(currentEquity: number, now: string): void {
    if (!Number.isFinite(currentEquity)) return;
    const nowMs = new Date(now).getTime();
    if (!Number.isFinite(nowMs)) return;

    // Raise the peak.
    if (currentEquity > this.state.peakEquityReached) {
      this.state.peakEquityReached = currentEquity;
      this.state.peakEquityReachedAt = now;
    }

    // Auto-resume once the cooldown has elapsed: clear the halt and re-baseline the peak to
    // the current (trough) equity so the next drawdown is measured fresh from here.
    if (this.state.breakerHaltUntil) {
      const untilMs = new Date(this.state.breakerHaltUntil).getTime();
      if (Number.isFinite(untilMs) && nowMs >= untilMs) {
        this.state.breakerHaltUntil = null;
        this.state.peakEquityReached = currentEquity;
        this.state.peakEquityReachedAt = now;
      }
    }

    // Trip a fresh halt when drawdown-from-peak reaches the threshold (only when not already halted).
    if (!this.state.breakerHaltUntil) {
      const dollarsPerR = (RISK_PCT / 100) * (this.state.paperEquityStart || PAPER_EQUITY);
      const drawdown = this.state.peakEquityReached - currentEquity;
      if (dollarsPerR > 0 && drawdown >= BREAKER_DRAWDOWN_R * dollarsPerR) {
        this.state.breakerHaltUntil = new Date(nowMs + BREAKER_COOLDOWN_MS).toISOString();
      }
    }

    this.save();
  }

  add(order: PaperOrder): void {
    this.state.orders.push(order);
    this.save();
  }

  /** Bound memory: DIAGNOSTIC closed orders only feed the ROLLING diagnostic measurement view
   *  (per-lane net/PF/WR + diagnostic P&L tile) — the VM matrix is the authoritative OOS spine, and
   *  the HEADLINE ledger (real money) is NEVER pruned here. OPEN orders (resolver inputs) and ALL
   *  non-diagnostic orders are untouched. Pruned orders' signals are from old scan batches, so their
   *  dedupeKeys can't collide with fresh candidates → no re-admission. No-op below the cap. Returns
   *  count pruned.
   *
   *  2026-07-11: a flat global "keep newest maxClosed across every lane combined" was found by
   *  adversarial review to cliff-cut quiet lanes' ENTIRE history the first time this ever engages
   *  (this store had never been pruned before, so the first real prune jumps straight from whatever
   *  the current total is down to maxClosed in one shot) — whichever lanes are busiest would crowd
   *  out quiet ones (rare-regime variants, benchmark-only lanes closing 1-3/day) entirely, corrupting
   *  the n>=30/n>=40 sample-size gates computeAutoQuarantinedVariantLanes()/laneEconomics()/
   *  per-symbol-lane-book-edge.ts all compute from this same pool. Fixed by giving every
   *  selectedLaneId a floor (PER_LANE_DIAGNOSTIC_FLOOR) that's kept regardless of how busy sibling
   *  lanes are — mirrors the per-lane/per-symbol/global-backstop shape paper-opportunity-allocator.ts
   *  already uses for the OPEN book (PAPER_DIAGNOSTIC_MAX_OPEN_PER_LANE et al). The global maxClosed
   *  ceiling still applies to whatever's left over each lane's floor, so total size can modestly
   *  exceed maxClosed when there are many quiet lanes each sitting at their floor — an intentional
   *  tradeoff: never zero out a lane's history purely because a sibling is busier. */
  pruneClosedDiagnostic(maxClosed: number): number {
    const isClosedDiag = (o: PaperOrder): boolean =>
      (o.paperStatus === "PAPER_CLOSED_WIN" || o.paperStatus === "PAPER_CLOSED_LOSS") &&
      o.paperOrderMode === "DIAGNOSTIC_ONLY";
    const closedDiag = this.state.orders.filter(isClosedDiag);
    if (closedDiag.length <= maxClosed) return 0;
    const tsOf = (o: PaperOrder): number => {
      const ms = new Date(o.updatedAt ?? o.createdAt ?? 0).getTime();
      return Number.isFinite(ms) ? ms : 0;
    };

    const byLane = new Map<string, PaperOrder[]>();
    for (const o of closedDiag) {
      const laneId = o.selectedLaneId ?? "unknown";
      const bucket = byLane.get(laneId);
      if (bucket) bucket.push(o);
      else byLane.set(laneId, [o]);
    }
    const floorKept: PaperOrder[] = [];
    const remainder: PaperOrder[] = [];
    for (const bucket of byLane.values()) {
      bucket.sort((a, b) => tsOf(b) - tsOf(a));
      floorKept.push(...bucket.slice(0, PER_LANE_DIAGNOSTIC_FLOOR));
      remainder.push(...bucket.slice(PER_LANE_DIAGNOSTIC_FLOOR));
    }
    remainder.sort((a, b) => tsOf(b) - tsOf(a));
    const remainderBudget = Math.max(0, maxClosed - floorKept.length);
    const keep = new Set(
      [...floorKept, ...remainder.slice(0, remainderBudget)].map((o) => o.paperOrderId),
    );

    const before = this.state.orders.length;
    this.state.orders = this.state.orders.filter((o) => !isClosedDiag(o) || keep.has(o.paperOrderId));
    const pruned = before - this.state.orders.length;
    if (pruned > 0) this.save();
    return pruned;
  }

  /**
   * Archive terminal rows that cannot produce an outcome before removing them from the hot store.
   * OPEN and realized rows are never eligible. This keeps resolver persistence bounded without
   * sacrificing the audit trail that explains rejects, no-fills, cancellations, or data failures.
   */
  pruneTerminalNonOutcome(maxRetained: number): number {
    const terminalNonOutcome = new Set<PaperOrderStatus>([
      "PAPER_CANCELED",
      "PAPER_REJECTED",
      "PAPER_EXPIRED",
      "PAPER_NO_FILL",
      "PAPER_DATA_FAILURE",
    ]);
    const eligible = this.state.orders.filter((order) => terminalNonOutcome.has(order.paperStatus));
    if (eligible.length <= maxRetained) return 0;

    const tsOf = (order: PaperOrder): number => {
      const ms = new Date(order.updatedAt ?? order.createdAt ?? 0).getTime();
      return Number.isFinite(ms) ? ms : 0;
    };
    eligible.sort((a, b) => tsOf(b) - tsOf(a));
    const prunedOrders = eligible.slice(maxRetained);
    const prunedIds = new Set(prunedOrders.map((order) => order.paperOrderId));

    // Archive first. If preservation fails, leave the hot store untouched.
    try {
      const archiveDir = resolve(dirname(this.file), "archive");
      mkdirSync(archiveDir, { recursive: true });
      const archiveFile = resolve(
        archiveDir,
        `paper-terminal-non-outcome.${Date.now()}.${process.pid}.json`,
      );
      writeFileSync(
        archiveFile,
        JSON.stringify({
          archivedAt: new Date().toISOString(),
          source: this.file,
          count: prunedOrders.length,
          orders: prunedOrders,
        }),
        "utf-8",
      );
    } catch {
      return 0;
    }

    this.state.orders = this.state.orders.filter((order) => !prunedIds.has(order.paperOrderId));
    this.save();
    return prunedOrders.length;
  }

  update(orderId: string, patch: Partial<PaperOrder>): void {
    const idx = this.state.orders.findIndex((o) => o.paperOrderId === orderId);
    if (idx < 0) return;
    const previous = this.state.orders[idx]!;
    const next: PaperOrder = {
      ...previous,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    // Central resolvedAtMs stamp (Track 1a): the PROCESS time this close was persisted, stamped ONLY on a genuine
    // NON-terminal → terminal transition. NOT "current status is closed && field empty" — that would fabricate a
    // resolution time on a legacy already-closed order the moment an unrelated update touches it (legacy orders
    // have no resolvedAtMs). Audit only — never an attribution key; a re-transition keeps the first value.
    const isClosedOutcome = (s: PaperOrderStatus): boolean => s === "PAPER_CLOSED_WIN" || s === "PAPER_CLOSED_LOSS";
    if (!isClosedOutcome(previous.paperStatus) && isClosedOutcome(next.paperStatus)) {
      next.resolvedAtMs = next.resolvedAtMs ?? Date.now();
    }
    this.state.orders[idx] = next;
    this.save();
  }

  hasOrder(dedupeKey: string): boolean {
    return this.state.orders.some((o) => o.dedupeKey === dedupeKey);
  }

  /**
   * Reset orders that were permanently killed by a transient fetch error back to
   * PAPER_SUBMITTED so the resolver retries them. Only touches orders whose
   * paperStatus is PAPER_DATA_FAILURE AND closeReason is "DATA_FETCH_ERROR" — the
   * pattern written by the (now-fixed) catch block. Hard data errors (NO_CANDLES,
   * INVALID_GEOMETRY) are left as-is.
   *
   * Safe to call on every run: once all DATA_FETCH_ERROR orders are cleared,
   * subsequent calls are no-ops (the fixed catch block no longer writes that reason).
   */
  resetTransientFailures(): number {
    const nowIso = new Date().toISOString();
    let count = 0;
    for (let i = 0; i < this.state.orders.length; i++) {
      const o = this.state.orders[i]!;
      if (o.paperStatus === "PAPER_DATA_FAILURE" && o.closeReason === "DATA_FETCH_ERROR") {
        this.state.orders[i] = {
          ...o,
          paperStatus: "PAPER_SUBMITTED",
          closeReason: null,
          updatedAt: nowIso,
        };
        count += 1;
      }
    }
    if (count > 0) this.save();
    return count;
  }

  /**
   * One-time retroactive cleanup of the pre-gate CG_TRAIL_AFTER_TP1 SHORT backlog.
   *
   * Cancels OPEN (CREATED / PAPER_SUBMITTED) trail-challenger SHORT orders that the
   * now-active allocator admission gates would have rejected at intake, so they stop
   * resolving into the directional -1R losses that dominate the sleeve:
   *   - Gate B violator: provenance.kronosBias === "LONG" (contra to the SHORT).
   *   - Gate C violator: a same-symbol stack — keep only the earliest-created open
   *     order per symbol, cancel the rest (the trail sleeve is single-slot).
   *   - Gate D violator: provenance.whaleSignal === "BULLISH" (contra-direction whale).
   *
   * Gate A is intentionally NOT reconstructed: deriveVariantGeometry widens TP1 to 1R
   * so the persisted geometry no longer carries the raw tp1/stop ratio — membership is
   * not recoverable post-hoc and must not be guessed.
   *
   * Voided orders get paperStatus PAPER_CANCELED (already terminal, already excluded
   * from the resolver open-filter and from headline accounting) and a marker
   * closeReason. History (provenance, geometry, timestamps, R) is preserved. The
   * gate-clean singletons stay OPEN so a clean pre/post-gate cohort remains measurable.
   *
   * Idempotent: canceled orders no longer match the OPEN filter, so re-runs are no-ops.
   */
  cancelPreGateTrailBacklog(): number {
    const TRAIL_LANE = "CG_VARIANT_MATRIX:CG_TRAIL_AFTER_TP1";
    const isOpen = (o: PaperOrder): boolean =>
      o.paperStatus === "CREATED" || o.paperStatus === "PAPER_SUBMITTED";
    const candidates = this.state.orders.filter(
      (o) => o.selectedLaneId === TRAIL_LANE && o.direction === "SHORT" && isOpen(o),
    );
    if (candidates.length === 0) return 0;

    const toVoid = new Set<string>();

    // Gate B (kronos contra) + Gate D (whale contra) — direct per-order violations.
    for (const o of candidates) {
      const bias = o.provenance?.kronosBias ?? null;
      const whale = o.provenance?.whaleSignal ?? null;
      if (bias === "LONG" || whale === "BULLISH") {
        toVoid.add(o.paperOrderId);
      }
    }

    // Gate C (per-symbol single-slot) — across the orders that survive B/D, keep the
    // earliest-created open order per symbol and void the rest of that symbol's stack.
    const bySymbol = new Map<string, PaperOrder[]>();
    for (const o of candidates) {
      if (toVoid.has(o.paperOrderId)) continue;
      const arr = bySymbol.get(o.symbol) ?? [];
      arr.push(o);
      bySymbol.set(o.symbol, arr);
    }
    for (const arr of bySymbol.values()) {
      if (arr.length <= 1) continue;
      arr.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
      for (let i = 1; i < arr.length; i++) toVoid.add(arr[i]!.paperOrderId);
    }

    if (toVoid.size === 0) return 0;
    const nowIso = new Date().toISOString();
    let count = 0;
    for (let i = 0; i < this.state.orders.length; i++) {
      const o = this.state.orders[i]!;
      if (!toVoid.has(o.paperOrderId)) continue;
      this.state.orders[i] = {
        ...o,
        paperStatus: "PAPER_CANCELED",
        closeReason: "TRAIL_PREGATE_BACKLOG_VOID",
        updatedAt: nowIso,
      };
      count += 1;
    }
    if (count > 0) this.save();
    return count;
  }

  /**
   * Quarantine cleanup for the CG_TRAIL_AFTER_TP1 challenger lane. The trail_after_tp1
   * exit rule was falsified as net-negative on this universe (paired kline sim shows
   * trail ≈ tp1_full, no edge), so the allocator stops admitting new trail orders
   * (Gate E / paperChallengerQuarantined). This voids the residual OPEN SHORT trail
   * backlog — the confirmed-broken, negative-EV direction (1W/23 = 4% WR) — uniformly
   * (every open SHORT, not outcome-selected, so no lookahead/cherry-picking), so it
   * stops resolving into more directional -1R losses. LONG trail opens (55% WR,
   * near-breakeven) are intentionally left to resolve naturally. Idempotent; no-op
   * once cleared. Never touches measurement: it only cancels open paper orders.
   */
  cancelQuarantinedTrailShortBacklog(): number {
    const TRAIL_LANE = "CG_VARIANT_MATRIX:CG_TRAIL_AFTER_TP1";
    const isOpen = (o: PaperOrder): boolean =>
      o.paperStatus === "CREATED" || o.paperStatus === "PAPER_SUBMITTED";
    const nowIso = new Date().toISOString();
    let count = 0;
    for (let i = 0; i < this.state.orders.length; i++) {
      const o = this.state.orders[i]!;
      if (o.selectedLaneId !== TRAIL_LANE || o.direction !== "SHORT" || !isOpen(o)) {
        continue;
      }
      this.state.orders[i] = {
        ...o,
        paperStatus: "PAPER_CANCELED",
        closeReason: "TRAIL_LANE_QUARANTINED",
        updatedAt: nowIso,
      };
      count += 1;
    }
    if (count > 0) this.save();
    return count;
  }

  /**
   * Headline-demotion cleanup. CG_WIDE_STOP_TP_WIDE (full-exit) is no longer a headline lane — the
   * headline is now the proven scaleout exit. Any residual full-exit order still tagged HEADLINE
   * (e.g. admitted during a config transition) is reclassified to DIAGNOSTIC_ONLY so it cannot
   * pollute the scaleout headline net/PF/WR. The order is otherwise untouched and still resolves
   * as a diagnostic comparison sample. Idempotent; no-op once cleared.
   */
  reclassifyDemotedFullExitHeadlineOrders(): number {
    const nowIso = new Date().toISOString();
    let count = 0;
    for (let i = 0; i < this.state.orders.length; i++) {
      const o = this.state.orders[i]!;
      const isFullExit =
        typeof o.selectedLaneId === "string" && o.selectedLaneId.endsWith(":CG_WIDE_STOP_TP_WIDE");
      if (!isFullExit || o.paperOrderMode === "DIAGNOSTIC_ONLY") continue;
      this.state.orders[i] = {
        ...o,
        paperOrderMode: "DIAGNOSTIC_ONLY",
        updatedAt: nowIso,
      };
      count += 1;
    }
    if (count > 0) this.save();
    return count;
  }
}

let _singleton: PaperExecutionRouterStore | null = null;

export function getPaperExecutionRouterStore(dataDir = "data"): PaperExecutionRouterStore {
  if (!_singleton) _singleton = new PaperExecutionRouterStore(dataDir);
  return _singleton;
}

/**
 * NON-INSTANTIATING peek at the module singleton: returns the store ONLY if some earlier caller has
 * already constructed it (and therefore already paid the one-time file parse), never constructing it
 * here. Added 2026-07-26 for CORTEX's nightly refit, which wants to read this book as an outcome source
 * but must never be the caller that FIRST materializes it: `new PaperExecutionRouterStore()` does a
 * synchronous readFileSync + JSON.parse of paper-execution-router.json, which is ~107 MB in production.
 * A refit runs on an interval inside the same single Node process as the live execution engine, so a
 * cold parse there is the exact shape of the 2026-07-20 testnet-unresponsive incident (a large JSON
 * re-read per poll pinning the event loop). Callers that legitimately need the book to EXIST must keep
 * using getPaperExecutionRouterStore(); callers that only want it opportunistically use this and treat
 * null as "no data available this run".
 */
export function peekPaperExecutionRouterStore(): PaperExecutionRouterStore | null {
  return _singleton;
}

export function _resetPaperExecutionRouterStoreForTests(): void {
  _singleton = null;
}

/** Test-only: install an already-constructed store as the resident singleton, so a test can exercise
 *  the peek path above without reaching into module internals. */
export function _setPaperExecutionRouterStoreForTests(store: PaperExecutionRouterStore | null): void {
  _singleton = store;
}

// ─── position sizing ────────────────────────────────────────────────────────

export interface PaperPositionSizeResult {
  ok: boolean;
  riskPct: number;
  paperEquity: number;
  plannedRiskAmount: number;
  plannedPositionNotional: number;
  stopDistancePct: number;
  rejectReason: string | null;
  diagnosticLabel: PaperDiagnosticLabel | null;
}

export function computePaperPositionSize(
  paperEquity: number,
  entryPrice: number,
  stopLoss: number,
  opts: { maxNotionalCap?: number; riskPct?: number } = {},
): PaperPositionSizeResult {
  const cap = opts.maxNotionalCap ?? DEFAULT_PAPER_MAX_NOTIONAL_CAP;
  const riskPct =
    typeof opts.riskPct === "number" && Number.isFinite(opts.riskPct) && opts.riskPct > 0
      ? opts.riskPct
      : RISK_PCT;
  const stopDistancePct =
    entryPrice > 0 && stopLoss > 0 ? Math.abs(entryPrice - stopLoss) / entryPrice : 0;
  if (!(stopDistancePct > 0) || !Number.isFinite(stopDistancePct)) {
    return {
      ok: false,
      riskPct,
      paperEquity,
      plannedRiskAmount: 0,
      plannedPositionNotional: 0,
      stopDistancePct: 0,
      rejectReason: "Zero or invalid stop distance",
      diagnosticLabel: null,
    };
  }
  const plannedRiskAmount = paperEquity * (riskPct / 100);
  const plannedPositionNotional = plannedRiskAmount / stopDistancePct;
  if (plannedPositionNotional > cap) {
    return {
      ok: false,
      riskPct,
      paperEquity,
      plannedRiskAmount,
      plannedPositionNotional,
      stopDistancePct,
      rejectReason: `Position notional ${plannedPositionNotional.toFixed(2)} exceeds cap ${cap}`,
      diagnosticLabel: "POSITION_SIZE_SANITY_CAP",
    };
  }
  return {
    ok: true,
    riskPct,
    paperEquity,
    plannedRiskAmount,
    plannedPositionNotional,
    stopDistancePct,
    rejectReason: null,
    diagnosticLabel: null,
  };
}

// ─── eligible-lane selector ─────────────────────────────────────────────────

export interface PaperEligibleLane {
  laneId: string;
  variantId: string;
  freshValid: number;
  netAvgR: number | null;
  pf: number | null;
  isExperimental: boolean;
  oosUnconfirmed: boolean;
  paperRiskLabel: PaperRiskLabel;
}

export interface SelectEligiblePaperLaneInputs {
  vmReport: CurrentGuardVariantMatrixReport;
  controllerMode: string;
  regimeFamily: string;
  paperValidationAllowed?: boolean;
}

function regimeAllowsPaper(
  controllerMode: string,
  regimeFamily: string,
  paperValidationAllowed: boolean,
): boolean {
  if (controllerMode === "LONG_ONLY") return false;
  if (controllerMode === "NO_TRADE_CHOP") return false;
  if (controllerMode === "UNKNOWN") return false;
  if (regimeFamily === "UNKNOWN") return false;
  if (controllerMode === "VALIDATION_ONLY" || regimeFamily === "MIXED") {
    return paperValidationAllowed === true;
  }
  return true;
}

export function selectEligiblePaperLanes(
  inputs: SelectEligiblePaperLaneInputs,
): PaperEligibleLane[] {
  const { vmReport, controllerMode, regimeFamily } = inputs;
  const paperValidationAllowed = inputs.paperValidationAllowed === true;
  if (!regimeAllowsPaper(controllerMode, regimeFamily, paperValidationAllowed)) {
    return [];
  }

  const out: PaperEligibleLane[] = [];
  for (const variantId of PAPER_ELIGIBLE_VARIANT_IDS) {
    if (PAPER_REJECT_VARIANT_IDS.includes(variantId) && !isConfiguredPaperHeadlineVariant(variantId)) continue;
    const row = vmReport.rows.find((r) => r.variantId === variantId);
    if (!row) continue;
    if (PAPER_HEADLINE_REQUIRE_STABLE) {
      if (row.status !== "STABLE_CANDIDATE") continue;
    } else if (row.status === "REJECT") {
      continue;
    }
    if (row.freshValid < 50) continue;
    if ((row.netAvgR ?? 0) <= 0) continue;
    // PF can be null when there are no losses; treat as "infinite, passes".
    // Otherwise it must exceed 1.2.
    const pfVal = row.pf;
    if (pfVal !== null && Number.isFinite(pfVal) && pfVal <= 1.2) continue;
    if (row.plus10bpsStillPositive !== true) continue;

    const oosUnconfirmed = !row.allThreeOosPositive;
    const isExperimental = oosUnconfirmed;
    const paperRiskLabel: PaperRiskLabel = oosUnconfirmed ? "EXPERIMENTAL" : "NORMAL";
    out.push({
      laneId: `CG_VARIANT_MATRIX:${variantId}`,
      variantId,
      freshValid: row.freshValid,
      netAvgR: row.netAvgR,
      pf: row.pf,
      isExperimental,
      oosUnconfirmed,
      paperRiskLabel,
    });
  }
  return out;
}

export function selectEligiblePaperLane(
  inputs: SelectEligiblePaperLaneInputs,
): PaperEligibleLane | null {
  return selectEligiblePaperLanes(inputs)[0] ?? null;
}

// ─── admission ──────────────────────────────────────────────────────────────

export interface PaperAdmissionInputs {
  store: PaperExecutionRouterStore;
  vmStore: CurrentGuardVariantMatrixStore;
  eligibleLane: PaperEligibleLane;
  routerReport: AdaptiveLaneRouterReport;
  gateReport: LiveTradingGateReport;
  now: string;
  admissionMaxAgeMs?: number;
  paperEquity?: number;
  maxNotionalCap?: number;
}

export interface PaperAdmissionResult {
  admitted: number;
  skipped: number;
  skippedReasons: string[];
}

function _buildBaseOrder(
  obs: CurrentGuardVariantMatrixObservation,
  eligibleLane: PaperEligibleLane,
  routerReport: AdaptiveLaneRouterReport,
  gateReport: LiveTradingGateReport,
  paperEquity: number,
  now: string,
): PaperOrder {
  const infraNotReady =
    !gateReport.killSwitchReady ||
    !gateReport.orderReconciliationReady ||
    !gateReport.exchangeHealthReady;
  const isMarketEntry = obs.entryVariant == null || obs.entryVariant === "base_current_entry";
  const actualGeometry = paperActualEntryGeometry(
    obs.direction,
    obs.simulatedEntryPrice,
    obs.simulatedStopLoss,
    obs.simulatedTakeProfitLevels,
  );
  const order = _stampForwardGate({
    paperOrderId: `paper-${randomUUID()}`,
    sourceType: "VARIANT_MATRIX_OBSERVATION",
    sourceCandidateId: null,
    scanBatchId: null,
    sourceObservationId: obs.observationId,
    sourceSignalId: obs.sourceSignalId ?? null,
    dedupeKey: `${obs.observationId}:${eligibleLane.laneId}`,
    createdAt: now,
    updatedAt: now,
    // The observation time remains provenance only. A new market order exists
    // at decision time, never retroactively at the scanner's source candle.
    openedAt: now,
    sourceObservedAt: obs.openedAt,
    firstSeenAt: now,
    entryFilledAt: isMarketEntry ? now : null,
    entryOrderType: isMarketEntry ? "MARKET" : "LIMIT",
    entryOrderPrice: obs.simulatedEntryPrice,
    executionPolicyVersion: EXECUTION_POLICY_VERSION,
    decisionPolicyVersion: CURRENT_DECISION_POLICY_VERSION,
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    evidenceEra: CURRENT_EVIDENCE_ERA,
    policyDeploymentAt: resolveEndToEndCorrectnessDeploymentAt(),
    actualStopDistanceBps: actualGeometry.stopDistanceBps,
    actualRiskReward: actualGeometry.riskReward,
    symbol: obs.symbol,
    direction: obs.direction,
    regime: obs.regime ?? null,
    controllerMode: routerReport.controllerMode,
    // 2026-07-26: persist the confidence that produced controllerMode. Declared on PaperOrder and
    // consumed by meta-label-gate.ts:286 (controllerConfFeature) since day one, but never assigned —
    // 0 of 28,889 stored orders carried it, so the controllerConf feature sat at 0% coverage and every
    // refit pinned its weight to exactly 0.0000. Sourced from the same regime report controllerMode is.
    controllerConfidence: routerReport.controllerConfidence ?? null,
    selectedLaneId: eligibleLane.laneId,
    routerPermission: routerReport.currentPermission,
    entryPrice: obs.simulatedEntryPrice,
    stopLoss: obs.simulatedStopLoss,
    takeProfitLevels: obs.simulatedTakeProfitLevels.slice(),
    // Carry the variant's exit rule + fill mode so the resolver honors them (e.g. the scaleout
    // headline must resolve as scaleout_tp1_trail, not the default tp1_full).
    variantExitRule: obs.exitRule,
    fillMode: obs.fillMode,
    plannedStopDistanceBps: obs.stopDistanceBps ?? 0,
    riskPctOfEquity: RISK_PCT,
    paperEquity,
    plannedRiskAmount: paperEquity * (RISK_PCT / 100),
    plannedPositionNotional: 0,
    plannedRiskR: 1,
    oosUnconfirmed: eligibleLane.oosUnconfirmed,
    infraNotReady,
    paperRiskLabel: eligibleLane.paperRiskLabel,
    paperOrderMode: "HEADLINE",
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
  }, now);
  // Persist the exact CORTEX lane snapshot available at admission. This is a
  // direct hand-off, never a later nearest-timestamp attribution.
  order.cortexDecisionSnapshot = latestCortexDecisionSnapshotForLane(order.selectedLaneId);
  const identity = prepareForwardCausalIdentity(order);
  if (identity) order.causalIdentity = identity;
  return order;
}

/**
 * 2026-07-11: every rejected/admitted observation in the loop below calls store.add(), which
 * (outside a batch) does a full-array JSON.stringify + writeFileSync on its own — on the research
 * instance's ~34MB pre-fix store, that's a full-store reserialize per candidate, once per scan
 * cycle, for however many candidates that cycle produced. Same class of write-amplification
 * resolvePaperOrders() was already fixed for (see its own beginBatch/endBatch wrapper above) —
 * applying the identical pattern here so a single flush happens once per admission pass instead of
 * once per candidate.
 */
export function admitPaperOrders(inputs: PaperAdmissionInputs): PaperAdmissionResult {
  inputs.store.beginBatch();
  try {
    return admitPaperOrdersInner(inputs);
  } finally {
    inputs.store.endBatch();
  }
}

function admitPaperOrdersInner(inputs: PaperAdmissionInputs): PaperAdmissionResult {
  const {
    store, vmStore, eligibleLane, routerReport, gateReport, now,
  } = inputs;
  const maxAge = inputs.admissionMaxAgeMs ?? PAPER_ADMISSION_MAX_AGE_MS;
  const paperEquity = inputs.paperEquity ?? PAPER_EQUITY;
  const maxNotionalCap = inputs.maxNotionalCap ?? DEFAULT_PAPER_MAX_NOTIONAL_CAP;
  const paperStartAt = store.ensurePaperStartAt(now);
  const paperStartAtMs = new Date(paperStartAt).getTime();
  const nowMs = new Date(now).getTime();

  const result: PaperAdmissionResult = { admitted: 0, skipped: 0, skippedReasons: [] };

  for (const obs of vmStore.all) {
    if (obs.variantId !== eligibleLane.variantId) continue;
    if (obs.status !== "OPEN") continue;

    const dedupeKey = `${obs.observationId}:${eligibleLane.laneId}`;
    if (store.hasOrder(dedupeKey)) {
      result.skipped += 1;
      result.skippedReasons.push(`duplicate:${obs.observationId}`);
      continue;
    }

    // Geometry sanity (cheap)
    if (
      !Number.isFinite(obs.simulatedEntryPrice) ||
      !Number.isFinite(obs.simulatedStopLoss) ||
      !obs.simulatedTakeProfitLevels ||
      obs.simulatedTakeProfitLevels.length === 0
    ) {
      const rej = _buildBaseOrder(obs, eligibleLane, routerReport, gateReport, paperEquity, now);
      rej.diagnosticLabel = "MISSING_GEOMETRY";
      rej.paperStatus = "PAPER_REJECTED";
      rej.closeReason = "MISSING_GEOMETRY";
      store.add(rej);
      result.skipped += 1;
      result.skippedReasons.push(`missing_geometry:${obs.observationId}`);
      continue;
    }

    const openedAtMs = new Date(obs.openedAt).getTime();

    // Source freshness
    if (nowMs - openedAtMs > maxAge) {
      const rej = _buildBaseOrder(obs, eligibleLane, routerReport, gateReport, paperEquity, now);
      rej.diagnosticLabel = "SOURCE_TOO_OLD_FOR_PAPER_ADMISSION";
      rej.paperStatus = "PAPER_REJECTED";
      rej.closeReason = "SOURCE_STALE";
      store.add(rej);
      result.skipped += 1;
      result.skippedReasons.push(`stale:${obs.observationId}`);
      continue;
    }

    // Anti-lookahead / backfill diagnostic — observation predates paperStartAt
    if (openedAtMs < paperStartAtMs) {
      const rej = _buildBaseOrder(obs, eligibleLane, routerReport, gateReport, paperEquity, now);
      rej.diagnosticLabel = "BACKFILL_DIAGNOSTIC";
      rej.paperStatus = "PAPER_REJECTED";
      rej.closeReason = "BACKFILL";
      store.add(rej);
      result.skipped += 1;
      result.skippedReasons.push(`backfill:${obs.observationId}`);
      continue;
    }

    // Position size
    const size = computePaperPositionSize(paperEquity, obs.simulatedEntryPrice, obs.simulatedStopLoss, { maxNotionalCap });
    if (!size.ok) {
      const rej = _buildBaseOrder(obs, eligibleLane, routerReport, gateReport, paperEquity, now);
      rej.diagnosticLabel = size.diagnosticLabel ?? "MISSING_GEOMETRY";
      rej.paperStatus = "PAPER_REJECTED";
      rej.closeReason = size.rejectReason ?? "POSITION_SIZE_INVALID";
      rej.plannedPositionNotional = size.plannedPositionNotional;
      store.add(rej);
      result.skipped += 1;
      result.skippedReasons.push(`sizing:${obs.observationId}`);
      continue;
    }

    // OK — admit
    const order = _buildBaseOrder(obs, eligibleLane, routerReport, gateReport, paperEquity, now);
    order.plannedPositionNotional = size.plannedPositionNotional;
    // Operational safety: paper itself is OK even if infra is not ready; we
    // stamp infraNotReady so the brief is transparent. Live remains blocked.
    order.operationalSafetyStatus = "OK";
    store.add(order);
    // Exact-ID collection is best-effort only; a journal failure cannot affect admission.
    recordForwardOpportunity(order);
    result.admitted += 1;
  }

  return result;
}

// ─── scan-candidate allocator admission ──────────────────────────────────────

/**
 * A paper opportunity selected by the Paper Opportunity Allocator from a FRESH
 * scan candidate × paper lane. Geometry is already transformed/validated by the
 * allocator; this module performs the final dedupe + sizing + order creation so
 * all paper-order creation stays in one place.
 */
export interface PaperOpportunity {
  sourceCandidateId: string;
  scanBatchId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  regime: string | null;
  laneId: string; // e.g. "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE"
  variantId: string;
  controllerMode: string;
  entryPrice: number;
  stopLoss: number;
  takeProfitLevels: number[];
  variantExitRule?: VariantExitRule;
  fillMode?: VariantFillMode;
  plannedStopDistanceBps: number;
  oosUnconfirmed: boolean;
  paperRiskLabel: PaperRiskLabel;
  experimentalLeverage?: number;
  paperRiskMultiplier?: number;
  /**
   * Accounting mode decided by the allocator. HEADLINE only when the active lane
   * is NOT quarantined and the candidate passes candidate-level quality gates;
   * otherwise DIAGNOSTIC_ONLY (excluded from headline profit metrics).
   */
  paperOrderMode: PaperOrderMode;
  /** Source scan finished timestamp (anti-lookahead anchor). */
  openedAt: string;
  /** Candidate-level provenance captured by the allocator (PROVENANCE V1). */
  provenance?: PaperOrderProvenance | null;
  /** Provenance source fields that were unavailable at admission. */
  provenanceFieldMissing?: string[];
  // Mixed paper-budget forward OOS metadata. Optional; stamped only for Mixed Regime paper admissions.
  mixedBudgetProfile?: string;
  mixedBudgetVersion?: number;
  budgetActivationScope?: "PAPER_ONLY";
  admissionResult?: string;
  occupancyMode?: string;
  stalePassHealth?: string;
  riskMultiplierAfterOccupancy?: number;
  budgetUsed?: unknown;
  budgetReason?: string;
  /** Optional exact Four-Brain review hand-off supplied by the originating candidate producer. */
  executiveReviewLink?: ExecutiveReviewExecutionLink | null;
}

export interface PaperOpportunityAdmissionInputs {
  store: PaperExecutionRouterStore;
  opportunities: PaperOpportunity[];
  routerReport: AdaptiveLaneRouterReport;
  gateReport: LiveTradingGateReport;
  now: string;
  admissionMaxAgeMs?: number;
  paperEquity?: number;
  maxNotionalCap?: number;
}

export interface PaperOpportunityAdmissionResult {
  admitted: number;
  admittedHeadline: number;
  admittedDiagnostic: number;
  duplicateSuppressed: number;
  rejected: number;
  skippedReasons: string[];
}

/** Stable dedupe key for an allocator-sourced opportunity. */
export function allocatorDedupeKey(o: {
  scanBatchId: string;
  sourceCandidateId: string;
  symbol: string;
  direction: string;
  laneId: string;
}): string {
  return `alloc:${o.scanBatchId}:${o.sourceCandidateId}:${o.symbol}:${o.direction}:${o.laneId}`;
}

function opportunityRiskMultiplier(o: PaperOpportunity): number {
  const experimental =
    typeof o.paperRiskMultiplier === "number" &&
    Number.isFinite(o.paperRiskMultiplier) &&
    o.paperRiskMultiplier > 0
      ? o.paperRiskMultiplier
      : 1;
  const occupancy =
    o.admissionResult === "ALLOW_REDUCED" &&
    o.budgetActivationScope === "PAPER_ONLY" &&
    typeof o.riskMultiplierAfterOccupancy === "number" &&
    Number.isFinite(o.riskMultiplierAfterOccupancy)
      ? Math.max(0, Math.min(1, o.riskMultiplierAfterOccupancy))
      : 1;
  return experimental * occupancy;
}

function _buildAllocatorOrder(
  o: PaperOpportunity,
  routerReport: AdaptiveLaneRouterReport,
  gateReport: LiveTradingGateReport,
  paperEquity: number,
  now: string,
): PaperOrder {
  const infraNotReady =
    !gateReport.killSwitchReady ||
    !gateReport.orderReconciliationReady ||
    !gateReport.exchangeHealthReady;
  const dedupeKey = allocatorDedupeKey(o);
  const riskMultiplier = opportunityRiskMultiplier(o);
  const effectiveRiskPct = RISK_PCT * riskMultiplier;
  const selectedEntryVariant = o.provenance?.selectedEntryVariant ?? "base_current_entry";
  const isMarketEntry = selectedEntryVariant === "base_current_entry";
  const actualGeometry = paperActualEntryGeometry(o.direction, o.entryPrice, o.stopLoss, o.takeProfitLevels);
  const order = _stampForwardGate({
    paperOrderId: `paper-${randomUUID()}`,
    sourceType: "SCAN_CANDIDATE_LANE_ALLOCATOR",
    sourceCandidateId: o.sourceCandidateId,
    scanBatchId: o.scanBatchId,
    sourceObservationId: `alloc:${o.scanBatchId}:${o.sourceCandidateId}`,
    sourceSignalId: o.sourceCandidateId,
    dedupeKey,
    createdAt: now,
    updatedAt: now,
    openedAt: now,
    sourceObservedAt: o.openedAt,
    firstSeenAt: now,
    entryFilledAt: isMarketEntry ? now : null,
    entryOrderType: isMarketEntry ? "MARKET" : "LIMIT",
    entryOrderPrice: o.entryPrice,
    executionPolicyVersion: EXECUTION_POLICY_VERSION,
    decisionPolicyVersion: CURRENT_DECISION_POLICY_VERSION,
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    evidenceEra: CURRENT_EVIDENCE_ERA,
    policyDeploymentAt: resolveEndToEndCorrectnessDeploymentAt(),
    actualStopDistanceBps: actualGeometry.stopDistanceBps,
    actualRiskReward: actualGeometry.riskReward,
    symbol: o.symbol,
    direction: o.direction,
    regime: o.regime ?? null,
    controllerMode: o.controllerMode || routerReport.controllerMode,
    // PaperOpportunity carries controllerMode but no per-opportunity confidence, so this comes from
    // the router report — the same regime read that produced the mode above.
    controllerConfidence: routerReport.controllerConfidence ?? null,
    selectedLaneId: o.laneId,
    routerPermission: routerReport.currentPermission,
    entryPrice: o.entryPrice,
    stopLoss: o.stopLoss,
    takeProfitLevels: o.takeProfitLevels.slice(),
    variantExitRule: o.variantExitRule ?? "tp1_full",
    fillMode: o.fillMode ?? "taker",
    plannedStopDistanceBps: o.plannedStopDistanceBps,
    riskPctOfEquity: effectiveRiskPct,
    paperEquity,
    plannedRiskAmount: paperEquity * (effectiveRiskPct / 100),
    plannedPositionNotional: 0,
    plannedRiskR: 1,
    oosUnconfirmed: o.oosUnconfirmed,
    infraNotReady,
    paperRiskLabel: o.paperRiskLabel,
    paperOrderMode: o.paperOrderMode ?? "HEADLINE",
    operationalSafetyStatus: "OK",
    diagnosticLabel: null,
    paperStatus: "CREATED",
    grossR: null,
    costR: null,
    netR: null,
    netPnlAmount: null,
    closeReason: null,
    provenance: o.provenance ?? null,
    provenanceFieldMissing: o.provenanceFieldMissing ? o.provenanceFieldMissing.slice() : [],
    mixedBudgetProfile: o.mixedBudgetProfile,
    mixedBudgetVersion: o.mixedBudgetVersion,
    budgetActivationScope: o.budgetActivationScope,
    admissionResult: o.admissionResult,
    occupancyMode: o.occupancyMode,
    stalePassHealth: o.stalePassHealth,
    riskMultiplierAfterOccupancy: o.riskMultiplierAfterOccupancy,
    experimentalLeverage: o.experimentalLeverage,
    paperRiskMultiplier: o.paperRiskMultiplier,
    budgetUsed: o.budgetUsed,
    budgetReason: o.budgetReason,
    executiveReviewLink: o.executiveReviewLink ?? null,
    reportOnly: true,
    paperOnly: true,
  }, now);
  // Persist the exact CORTEX lane snapshot available at admission. This is a
  // direct hand-off, never a later nearest-timestamp attribution.
  order.cortexDecisionSnapshot = latestCortexDecisionSnapshotForLane(order.selectedLaneId);
  const identity = prepareForwardCausalIdentity(order);
  if (identity) order.causalIdentity = identity;
  return order;
}

// ─── Global HEADLINE concentration caps (anti-correlation safety) ─────────────
// HEADLINE paper orders are the only ones that mirror to live, so the set of OPEN
// HEADLINE orders == real (or live-bound) exposure. Each risks plannedRiskR=1
// (~1% of equity), so capping the TOTAL open count doubles as a portfolio-heat
// cap (e.g. 50 ≈ 50% peak heat — the heat-shadow sweep shows ~30–50% keeps
// drawdown small vs ~117% uncapped). Per-symbol/per-direction caps stop a
// correlated basket (e.g. "182 long alts", or the same symbol opened across many
// lane variants) from going live all at once, where one correlated dump would
// hit every position together.
//
// DIAGNOSTIC_ONLY probes are measurement only and NEVER mirror to live, so they
// are deliberately NOT capped here (that is a separate, opt-in lever). Tunable
// via env; 0/empty falls back to the defaults below.
export const HEADLINE_MAX_OPEN = Number(process.env.HEADLINE_MAX_OPEN) || 50;
export const HEADLINE_MAX_PER_SYMBOL = Number(process.env.HEADLINE_MAX_PER_SYMBOL) || 2;
export const HEADLINE_MAX_PER_DIRECTION = Number(process.env.HEADLINE_MAX_PER_DIRECTION) || 30;

const HEADLINE_OPEN_STATUSES = new Set<PaperOrder["paperStatus"]>(["CREATED", "PAPER_SUBMITTED"]);

/** An OPEN order that counts toward real/live-bound exposure (headline, not a
 *  diagnostic probe or backfill, and still open). */
export function isOpenHeadlineOrder(o: PaperOrder): boolean {
  return (
    (o.paperOrderMode ?? "HEADLINE") !== "DIAGNOSTIC_ONLY" &&
    o.diagnosticLabel !== "BACKFILL_DIAGNOSTIC" &&
    HEADLINE_OPEN_STATUSES.has(o.paperStatus)
  );
}

/** Returns a reject reason if admitting one more open HEADLINE order for this
 *  (symbol, direction) would breach a global concentration cap, else null.
 *  `openHeadline` must already be filtered to open headline orders. */
export function headlineConcentrationRejectReason(
  openHeadline: readonly PaperOrder[],
  symbol: string,
  direction: "LONG" | "SHORT",
): string | null {
  if (openHeadline.length >= HEADLINE_MAX_OPEN) return "HEADLINE_MAX_OPEN_REACHED";
  if (openHeadline.filter((o) => o.direction === direction).length >= HEADLINE_MAX_PER_DIRECTION)
    return "HEADLINE_MAX_PER_DIRECTION_REACHED";
  if (openHeadline.filter((o) => o.symbol === symbol).length >= HEADLINE_MAX_PER_SYMBOL)
    return "HEADLINE_MAX_PER_SYMBOL_REACHED";
  return null;
}

/**
 * Admits allocator-selected scan-candidate opportunities as paper orders.
 * Bypasses the variant-matrix observation tape entirely — the source is a
 * FRESH scan candidate. Same hard invariants apply: paperOnly/reportOnly,
 * deterministic 1%-of-equity sizing (reduced only for paper Mixed
 * ALLOW_REDUCED), anti-lookahead freshness + paperStartAt gating, no live
 * behavior. Report-only; never throws.
 */
export function admitPaperOpportunities(
  inputs: PaperOpportunityAdmissionInputs,
): PaperOpportunityAdmissionResult {
  // One flush for this whole admission pass instead of one full-array JSON.stringify+writeFileSync
  // per store.add() call in the loop below (up to 3 add() sites per opportunity: backfill-reject,
  // sizing-reject, real admit). Same fix, same reasoning, same file as
  // runPaperAdmissionAndResolution's own beginBatch/endBatch wrap above — this is its sibling
  // allocator-sourced admission path, called independently and BEFORE it from shadow.ts, and was
  // flagged during that fix's review as capable of reproducing the identical
  // operator-brief?resolve=1&paper=1 event-loop freeze (100MB+ store, N opportunities admitted in one
  // cycle = N synchronous full-store rewrites) via this separate call site.
  inputs.store.beginBatch();
  try {
    return admitPaperOpportunitiesInner(inputs);
  } finally {
    inputs.store.endBatch();
  }
}

function admitPaperOpportunitiesInner(
  inputs: PaperOpportunityAdmissionInputs,
): PaperOpportunityAdmissionResult {
  const { store, opportunities, routerReport, gateReport, now } = inputs;
  const maxAge = inputs.admissionMaxAgeMs ?? PAPER_ADMISSION_MAX_AGE_MS;
  const paperEquity = inputs.paperEquity ?? PAPER_EQUITY;
  const maxNotionalCap = inputs.maxNotionalCap ?? DEFAULT_PAPER_MAX_NOTIONAL_CAP;
  const paperStartAt = store.ensurePaperStartAt(now);
  const paperStartAtMs = new Date(paperStartAt).getTime();
  const nowMs = new Date(now).getTime();

  const result: PaperOpportunityAdmissionResult = {
    admitted: 0,
    admittedHeadline: 0,
    admittedDiagnostic: 0,
    duplicateSuppressed: 0,
    rejected: 0,
    skippedReasons: [],
  };

  // Portfolio drawdown circuit-breaker: halt allocator-sourced admission too (paper-only).
  if (store.isAdmissionHalted(now)) {
    result.skippedReasons.push("portfolio-drawdown-circuit-breaker-halt");
    return result;
  }

  for (const o of opportunities) {
    const dedupeKey = allocatorDedupeKey(o);
    if (store.hasOrder(dedupeKey)) {
      result.duplicateSuppressed += 1;
      result.skippedReasons.push(`duplicate:${o.sourceCandidateId}:${o.laneId}`);
      continue;
    }

    // Geometry sanity
    if (
      !Number.isFinite(o.entryPrice) ||
      !Number.isFinite(o.stopLoss) ||
      !Array.isArray(o.takeProfitLevels) ||
      o.takeProfitLevels.length === 0
    ) {
      result.rejected += 1;
      result.skippedReasons.push(`missing_geometry:${o.sourceCandidateId}`);
      continue;
    }

    // Admission and resolver share the same actual-entry contract. A pending
    // limit will be checked again at fill time, but an invalid planned geometry
    // must never enter the paper book in the first place.
    const plannedGeometry = paperActualEntryGeometry(
      o.direction,
      o.entryPrice,
      o.stopLoss,
      o.takeProfitLevels,
    );
    if (!plannedGeometry.ok) {
      result.rejected += 1;
      result.skippedReasons.push(`geometry:${plannedGeometry.reason ?? "INVALID"}:${o.sourceCandidateId}`);
      continue;
    }

    const openedAtMs = new Date(o.openedAt).getTime();

    // Source freshness (anti-lookahead)
    if (!Number.isFinite(openedAtMs) || nowMs - openedAtMs > maxAge) {
      result.rejected += 1;
      result.skippedReasons.push(`stale:${o.sourceCandidateId}`);
      continue;
    }

    // Anti-lookahead: candidate must not predate paperStartAt
    if (openedAtMs < paperStartAtMs) {
      const rej = _buildAllocatorOrder(o, routerReport, gateReport, paperEquity, now);
      rej.diagnosticLabel = "BACKFILL_DIAGNOSTIC";
      rej.paperStatus = "PAPER_REJECTED";
      rej.closeReason = "BACKFILL";
      store.add(rej);
      result.rejected += 1;
      result.skippedReasons.push(`backfill:${o.sourceCandidateId}`);
      continue;
    }

    // Position size
    const size = computePaperPositionSize(paperEquity, o.entryPrice, o.stopLoss, {
      maxNotionalCap,
      riskPct: RISK_PCT * opportunityRiskMultiplier(o),
    });
    if (!size.ok) {
      const rej = _buildAllocatorOrder(o, routerReport, gateReport, paperEquity, now);
      rej.diagnosticLabel = size.diagnosticLabel ?? "MISSING_GEOMETRY";
      rej.paperStatus = "PAPER_REJECTED";
      rej.closeReason = size.rejectReason ?? "POSITION_SIZE_INVALID";
      rej.plannedPositionNotional = size.plannedPositionNotional;
      store.add(rej);
      result.rejected += 1;
      result.skippedReasons.push(`sizing:${o.sourceCandidateId}`);
      continue;
    }

    const order = _buildAllocatorOrder(o, routerReport, gateReport, paperEquity, now);
    order.plannedPositionNotional = size.plannedPositionNotional;
    order.operationalSafetyStatus = "OK";

    // Global concentration cap — HEADLINE only (diagnostic probes are measurement,
    // never mirror to live, so they are not capped). Drops the over-cap headline
    // candidate rather than downgrading it, so correlated/duplicate exposure can't
    // pile up live. Counts orders already added earlier in THIS batch too.
    if ((order.paperOrderMode ?? "HEADLINE") !== "DIAGNOSTIC_ONLY") {
      const openHeadline = store.all.filter(isOpenHeadlineOrder);
      const concentrationReason = headlineConcentrationRejectReason(
        openHeadline,
        order.symbol,
        order.direction,
      );
      if (concentrationReason) {
        result.rejected += 1;
        result.skippedReasons.push(`${concentrationReason}:${o.sourceCandidateId}`);
        continue;
      }
    }

    store.add(order);
    // Persist the immutable pre-open snapshot only after the incumbent paper store accepted the order.
    recordForwardOpportunity(order);
    result.admitted += 1;
    if ((order.paperOrderMode ?? "HEADLINE") === "DIAGNOSTIC_ONLY") {
      result.admittedDiagnostic += 1;
    } else {
      result.admittedHeadline += 1;
    }
  }

  return result;
}

// ─── resolver ───────────────────────────────────────────────────────────────

export type PaperKlineTuple = [number, string, string, string, string, string, number];

export interface PaperResolverClient {
  getKlines(
    symbol: string,
    interval: string,
    opts: { startTime: number; endTime: number; limit: number },
  ): Promise<PaperKlineTuple[]>;
}

/**
 * Binance caps a kline response at 1,000 rows. A paper lane may intentionally
 * hold longer than that (for example the 144h runner needs 1,728 five-minute
 * candles), so one request would silently mark the trade at an earlier candle.
 * Page to the requested market horizon and deduplicate candle opens.
 */
async function fetchPaperKlinesRange(
  client: PaperResolverClient,
  symbol: string,
  interval: "5m",
  startTime: number,
  endTime: number,
): Promise<PaperKlineTuple[]> {
  const out: PaperKlineTuple[] = [];
  const seen = new Set<number>();
  let cursor = startTime;
  let pages = 0;
  while (cursor < endTime && pages < 50) {
    pages += 1;
    const remaining = Math.ceil((endTime - cursor) / CANDLE_MS) + 2;
    const limit = Math.min(Math.max(remaining, 12), 1000);
    const page = await client.getKlines(symbol, interval, { startTime: cursor, endTime, limit });
    if (!page.length) break;
    let lastOpen = Number.NaN;
    for (const candle of page) {
      const open = Number(candle[0]);
      if (!Number.isFinite(open)) continue;
      lastOpen = open;
      if (!seen.has(open)) {
        seen.add(open);
        out.push(candle);
      }
    }
    if (!Number.isFinite(lastOpen) || lastOpen < cursor) break;
    // A short page is the venue's end-of-range signal. Continuing would re-request
    // the same mocked/stale page until the safety page cap and inflate resolver work.
    if (page.length < limit) break;
    const next = lastOpen + CANDLE_MS;
    if (next <= cursor) break;
    cursor = next;
  }
  return out.sort((a, b) => Number(a[0]) - Number(b[0]));
}

function _rewardR(direction: "LONG" | "SHORT", entry: number, tp: number, risk: number): number {
  if (!(risk > 0)) return 0;
  return direction === "LONG" ? (tp - entry) / risk : (entry - tp) / risk;
}

/**
 * Effective exit rule for an order. Allocator orders persist `variantExitRule`; legacy/variant-matrix
 * orders may not, so derive it from the lane's variant definition before defaulting to tp1_full. This
 * guarantees the scaleout headline resolves as scaleout_tp1_trail even for orders admitted before the
 * exit rule was persisted.
 */
/**
 * Per-order max-hold before the resolver marks to market. Lanes can extend the
 * default (e.g. CG_WIDE's let-it-run geometry holds ~6 days so a slow winner
 * gets room to trend) via `maxHoldHours` on their variant definition. Always
 * kept below PAPER_ORDER_EXPIRY_MS so the max-hold MTM books P&L before the
 * fetch-failure expiry backstop can fire.
 */
function maxHoldMsForOrder(order: PaperOrder): number {
  const def = variantDefinitionForOrder(order);
  if (def?.maxHoldHours != null && def.maxHoldHours > 0) {
    return Math.min(def.maxHoldHours * 60 * 60 * 1000, PAPER_ORDER_EXPIRY_MS - CANDLE_MS);
  }
  return PAPER_MAX_HOLD_MS;
}

function variantDefinitionForOrder(order: PaperOrder) {
  const laneId = order.selectedLaneId;
  if (typeof laneId !== "string" || !laneId.includes(":")) return null;
  const suffix = laneId.slice(laneId.indexOf(":") + 1);
  return VARIANT_MATRIX_DEFINITIONS.find((d) => d.id === suffix) ?? null;
}

function paperOrderOpenedAtMs(order: PaperOrder, fallbackMs: number): number {
  const openedAtMs = new Date(order.openedAt).getTime();
  return Number.isFinite(openedAtMs) ? openedAtMs : fallbackMs;
}

/** Legacy rows had one `openedAt` field and were already treated as filled. New
 * rows carry an explicit decision/fill lifecycle. This boundary is intentionally
 * fail-closed for post-fix LIMIT orders: missing price means no fill. */
function paperOrderFirstSeenAtMs(order: PaperOrder, fallbackMs: number): number {
  const firstSeenMs = new Date(order.firstSeenAt ?? order.createdAt).getTime();
  return Number.isFinite(firstSeenMs) ? firstSeenMs : paperOrderOpenedAtMs(order, fallbackMs);
}

function paperOrderEntryFilledAtMs(order: PaperOrder, fallbackMs: number): number {
  const filledMs = new Date(order.entryFilledAt ?? order.openedAt).getTime();
  return Number.isFinite(filledMs) ? filledMs : fallbackMs;
}

function isPendingPaperEntry(order: PaperOrder): boolean {
  return order.executionPolicyVersion === EXECUTION_POLICY_VERSION &&
    order.entryOrderType === "LIMIT" &&
    !order.entryFilledAt;
}

export interface PaperActualEntryGeometry {
  ok: boolean;
  stopDistanceBps: number | null;
  riskReward: number | null;
  reason: string | null;
}

/** Recompute the executable geometry from the actual fill, not an entry-zone midpoint. */
export function paperActualEntryGeometry(
  direction: "LONG" | "SHORT",
  entryPrice: number,
  stopLoss: number,
  takeProfitLevels: readonly number[],
): PaperActualEntryGeometry {
  const tp1 = takeProfitLevels[0];
  if (!(Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(stopLoss) && Number.isFinite(tp1))) {
    return { ok: false, stopDistanceBps: null, riskReward: null, reason: "INVALID_GEOMETRY" };
  }
  const directionallyValid = direction === "LONG"
    ? stopLoss < entryPrice && entryPrice < tp1
    : stopLoss > entryPrice && entryPrice > tp1;
  if (!directionallyValid) return { ok: false, stopDistanceBps: null, riskReward: null, reason: "INVALID_DIRECTIONAL_GEOMETRY" };
  const risk = Math.abs(entryPrice - stopLoss);
  const reward = Math.abs(tp1 - entryPrice);
  const riskReward = risk > 0 ? reward / risk : null;
  const stopDistanceBps = (risk / entryPrice) * 10_000;
  // Decimal arithmetic around an exact configured floor (for example 4.5/3)
  // must not reject a geometrically valid order due only to IEEE rounding.
  if (riskReward === null || !Number.isFinite(riskReward) || !Number.isFinite(stopDistanceBps) || riskReward + 1e-9 < MIN_EXECUTION_RR) {
    return { ok: false, stopDistanceBps, riskReward, reason: "ACTUAL_RR_BELOW_EXECUTION_FLOOR" };
  }
  return { ok: true, stopDistanceBps, riskReward, reason: null };
}

type PendingEntryResolution = "NO_FILL" | "FILLED" | "AMBIGUOUS_STOP";

/** A limit must trade at its exact price. On an unresolvable fill+stop candle,
 * adverse-first is the only defensible paper result. TP is intentionally not
 * evaluated on a fill-only candle; the next candle owns the exit evaluation. */
function resolvePendingEntryCandle(
  order: PaperOrder,
  candle: PaperKlineTuple,
): PendingEntryResolution {
  const price = order.entryOrderPrice;
  if (!(typeof price === "number" && Number.isFinite(price))) return "NO_FILL";
  const high = Number(candle[2]);
  const low = Number(candle[3]);
  if (!(Number.isFinite(high) && Number.isFinite(low)) || low > price || high < price) return "NO_FILL";
  const stopHit = order.direction === "LONG" ? low <= order.stopLoss : high >= order.stopLoss;
  return stopHit ? "AMBIGUOUS_STOP" : "FILLED";
}

function latestCloseTouchesExit(order: PaperOrder, close: number): boolean {
  if (!(Number.isFinite(close) && close > 0)) return false;
  const tp = order.takeProfitLevels[0];
  const sl = order.stopLoss;
  if (!(typeof tp === "number" && Number.isFinite(tp) && typeof sl === "number" && Number.isFinite(sl))) {
    return false;
  }
  return order.direction === "LONG"
    ? close >= tp || close <= sl
    : close <= tp || close >= sl;
}

async function findOrdersAtExitNow(
  orders: PaperOrder[],
  binanceClient: PaperResolverClient,
  nowMs: number,
): Promise<Set<string>> {
  const symbols = Array.from(new Set(orders.map((order) => order.symbol))).sort();
  const latestCloseBySymbol = new Map<string, number>();
  await Promise.all(symbols.map(async (symbol) => {
    try {
      const candles = await binanceClient.getKlines(symbol, "5m", {
        startTime: nowMs - 3 * CANDLE_MS,
        endTime: nowMs,
        limit: 3,
      });
      const close = Number(candles.at(-1)?.[4]);
      if (Number.isFinite(close) && close > 0) latestCloseBySymbol.set(symbol, close);
    } catch {
      // Ranking hint only. Exact candle-walk resolution below remains authoritative.
    }
  }));

  const touched = new Set<string>();
  for (const order of orders) {
    const close = latestCloseBySymbol.get(order.symbol);
    if (close !== undefined && latestCloseTouchesExit(order, close)) {
      touched.add(order.paperOrderId);
    }
  }
  return touched;
}

function effectiveExitRuleForOrder(order: PaperOrder): VariantExitRule {
  if (order.variantExitRule) return order.variantExitRule;
  const def = variantDefinitionForOrder(order);
  if (def) return def.exitRule;
  return "tp1_full";
}

/** FLAT legacy cost (v1): taker round-trip only, no maker discount, no stop-out surcharge, no credit
 *  for slippage the execution-realism model already charged inside grossR. This is what every stored
 *  row before the v2 cutover was priced at, and what _computePaperExitCostR still returns while
 *  PAPER_COST_MODEL_V2 is off. */
function _computePaperCostR(plannedStopDistanceBps: number): number {
  if (!(plannedStopDistanceBps > 0)) return 0;
  return -(PAPER_TAKER_COST_BPS / plannedStopDistanceBps);
}

// ─── exit-aware paper cost model (v2, 2026-07-26) ────────────────────────────
//
// The flat model above was asymmetric in three ways at once, and every one of them biased the
// paper book's netR:
//
//  1. MAKER OVERCHARGE. A maker_limit variant posts a resting limit and never crosses the spread,
//     so the VM matrix's own resolver charges it MAKER_ROUNDTRIP_BPS (6). The paper book charged
//     every order TAKER_ROUNDTRIP_BPS (22) regardless of fillMode — a 3.67x overcharge on the
//     maker lanes (CG_MAKER_LIMIT_SIM / CG_MAKER_FAST_05).
//  2. MISSING STOP-OUT SURCHARGE. A stop-market exit fills during a fast ADVERSE move and slips
//     more than a resting TP. The VM matrix charges STOP_OUT_SLIPPAGE_BPS extra on stop-triggered
//     exits (current-guard-variant-matrix.ts, resolveVariantMatrixObservations); the paper book
//     charged losers exactly what it charged winners. That made low-win-rate lanes look as cheap
//     as high-WR ones — the exact bias STOP_OUT_SLIPPAGE_BPS exists to remove.
//  3. DOUBLE-COUNTED SLIPPAGE. PAPER_TAKER_COST_BPS (22) is REALISTIC_ROUND_TRIP_FEE_SLIP_BPS =
//     (5 fee + 6 slippage) x 2 sides — i.e. 10bps of fee and 12bps of SLIPPAGE. Meanwhile
//     PAPER_EXECUTION_MODEL_REALISTIC (the DEFAULT model — routes/shadow.ts only falls back to
//     IDEAL when PAPER_EXECUTION_REALISM=0) already moves the fill prices by entry 2 / stop 5 / tp
//     0 bps, so that slippage is ALREADY inside grossR. The old comment on PaperExecutionModel
//     claiming "no double-count" was wrong: an inline SL exit paid 12bps of slippage in costR AND
//     7bps more in grossR.
//
// v2 charges a single honest total per exit — roundTrip(costModel) + stopOutSurcharge(if stop-like)
// — and books in costR only the portion the gross path did NOT already realize. The ROUND-TRIP
// component then lines up with the VM matrix: taker TP 22, taker stop 34, maker TP 6, maker stop 18.
// It also charges completed 8h funding periods at exit time, so long-hold rows no longer receive
// an unearned cost advantage over their matrix counterparts.
//
// Fixing only (1) would have been a purely cost-REDUCING change (a fake positive); (2) lands on
// ~1/3 of all closes and pushes the other way. They ship together deliberately.
type PaperExitKind =
  /** Resting limit / favorable exit — grossR used the model's tpSlippageBps. */
  | "TP_LIKE"
  /** Stop-market-like fill on an ADVERSE move (hard stop, trailing stop, trail-to-breakeven,
   *  MFE-giveback retrace) — grossR used the model's stopSlippageBps and the exit pays the
   *  stop-out surcharge on top. */
  | "STOP_LIKE"
  /** Horizon mark-to-market close at a candle close. grossR used stopSlippageBps (conservative),
   *  but it is NOT a stop trigger, so it pays no stop-out surcharge. */
  | "MARK_TO_MARKET";

/**
 * v2 is the default for every new book. `PAPER_COST_MODEL_V2=0` exists only
 * for an explicit historical-replay compatibility run.
 *
 * The v2 model is more correct, but this remains a STORE-COHORT decision, not just a code
 * change: use it only for a fresh book or an explicitly version-isolated cohort.
 * `costModelVersion` is stamped but has ZERO readers (grep-confirmed): every netR consumer —
 * laneEconomics(), computeAutoQuarantinedVariantLanes(), per-symbol-lane-book-edge.ts,
 * meta-label-gate, and cortex-refit-runner-bindings.ts:274, which feeds CORTEX outcome
 * observations directly — pools v1 and v2 rows silently.
 *
 * Flipping it moves per-trade netR with NO underlying edge change: maker lanes by up to
 * +16bps/stopBps (22 → 6) and taker stop-heavy lanes by −5bps/stopBps. A CORTEX refit whose
 * rolling window straddles a change reads that as an edge shift. A full internal reset avoids
 * that artifact; otherwise, keep the legacy replay explicitly on v1.
 *
 * While OFF, EVERYTHING is v1 — resolver and the three what-if counterfactuals alike — so the
 * paper book is byte-identical to its pre-change behaviour and the counterfactual deltas stay
 * internally consistent. There is no half-applied state.
 *
 * Flip only together with a cohort plan: age the v1 rows out of the refit window, reset the
 * store, or make the consumers version-aware. And flip T1-a (the sentinel stop-floor fix) FIRST
 * or at the same time — without it the artifact is concentrated on maker TPs on sentinel
 * geometries where stopBps is small and the R impact is largest.
 */
export const PAPER_COST_MODEL_V2_ENABLED = process.env.PAPER_COST_MODEL_V2 !== "0";

/**
 * Cost-model generation stamped on every order this resolver closes. Two generations are NOT
 * comparable and must never be pooled silently. New v1 rows are stamped explicitly as 1 (an
 * ABSENT field means a legacy row written before stamping existed — also v1, but unverified).
 *
 * NOT BUMPED to 3 for the 2026-07-28 arithmetic corrections (maker stop-outs now charged
 * maker-in/taker-out; funding counted on the venue's fixed UTC grid instead of elapsed-time-since-
 * open) — a measurement, not an assumption. Both are corrections WITHIN v2's own stated contract
 * ("exit-aware" and "funded"); it simply implemented each slightly wrong. Measured against the live
 * stores the day of the change: of 668 closed rows across research+testnet, exactly **3** would
 * reprice under the maker fix (maker-lane LOSSES: 0 on research, 3 on testnet) and **0** under the
 * funding fix (no stored hold spans a settlement boundary — every current hold is short). Bumping
 * would have invalidated 668 rows, blanking lane telemetry and quarantine evidence, to represent a
 * divergence affecting 0.45% of them.
 *
 * Re-derive before assuming this still holds. It stops being true the moment maker-lane losses or
 * multi-hour holds accumulate in a store whose older rows predate this change: at that point old and
 * new rows really are on different bases and a bump becomes the honest call.
 */
export const PAPER_COST_MODEL_VERSION = PAPER_COST_MODEL_V2_ENABLED ? 2 : 1;

/**
 * walkVariantPath resolutionSources that are RESTING-STOP fills on an ADVERSE move, and therefore
 * slip like a stop even when they book a win. THE single source of that classification — the walk
 * path and the inline path both resolve through it, so the two can never disagree.
 *
 * This set existing is the fix for a real asymmetry: the walk path used to test only
 * `status === "CLOSED_LOSS" || resolutionSource === "MFE_GIVEBACK_EXIT"`, so a walk-resolved
 * TRAIL_BREAKEVEN_EXIT / TRAIL_BREAKEVEN_SAME_CANDLE / ATR_TRAIL_STOP /
 * LIVE_LONG_RUNNER_BREAKEVEN_AFTER_COST **win** was charged as TP_LIKE and skipped the
 * STOP_OUT_SLIPPAGE_BPS surcharge — while the INLINE path charged the identical exit as STOP_LIKE.
 * Which path an order takes is decided purely by exitRule (scaleout_tp1_trail | mfe_giveback |
 * maker_limit → walk; trail_after_tp1 → inline), so two taker lanes got different costs for the
 * same exit: reproduced at 22bps (walk) vs 27bps (inline) on identical SHORT geometry. That is a
 * systematic 5bps/stopBps discount to the scaleout lanes over the trail lanes on 221 rows in the
 * testnet store, and cortex-refit-runner-bindings.ts reads exactly this netR per lane.
 *
 * NOT included: TRAIL_PATH_END and MAX_HOLD_MTM are horizon mark-to-market closes at a candle
 * close, not stop triggers — they stay TP_LIKE / MARK_TO_MARKET, matching the inline path.
 */
const WALK_STOP_LIKE_RESOLUTION_SOURCES: ReadonlySet<string> = new Set([
  "MFE_GIVEBACK_EXIT", // retrace AGAINST the position: a sell-stop below / buy-stop above
  "ATR_TRAIL_STOP", // trailing stop
  "TRAIL_BREAKEVEN_EXIT", // resting stop pulled up to entry, fills on the adverse retrace
  "TRAIL_BREAKEVEN_SAME_CANDLE",
  "LIVE_LONG_RUNNER_BREAKEVEN_AFTER_COST",
]);

/** Exit kind for a walk-resolved close. CLOSED_LOSS is always a stop; a WIN is stop-like only if it
 *  came from one of the resting-stop sources above. */
function _walkExitKind(status: string, resolutionSource: string | null | undefined): PaperExitKind {
  if (status === "CLOSED_LOSS") return "STOP_LIKE";
  return resolutionSource != null && WALK_STOP_LIKE_RESOLUTION_SOURCES.has(resolutionSource)
    ? "STOP_LIKE"
    : "TP_LIKE";
}

/** Cost basis for an order. Mirrors variantRoundTripBps()'s `def.costModel` in the VM matrix (the
 *  declared cost basis, which is what the matrix charges), falling back to the order's persisted
 *  fillMode for non-variant lanes. Today every VariantMatrixVariantDefinition has
 *  costModel === fillMode, so this is identical to reading fillMode. */
function _paperCostModelForOrder(order: PaperOrder): VariantFillMode {
  const def = variantDefinitionForOrder(order);
  return def?.costModel ?? order.fillMode ?? "taker";
}

/** Slippage (bps) this exit path ALREADY realized inside grossR, and must therefore not be charged
 *  again in costR. walkVariantPath is handed raw E/S/T, so a walk-resolved close has none. */
function _slipAlreadyInGrossBps(
  kind: PaperExitKind,
  model: PaperExecutionModel,
  viaWalk: boolean,
): number {
  if (viaWalk) return 0;
  return _slipInGrossV2(kind, model.entrySlippageBps, model.tpSlippageBps, model.stopSlippageBps);
}

/** Exit-aware paper cost, in R, SIGNED NEGATIVE (paper convention: netR = grossR + costR — note the
 *  VM matrix uses the opposite sign, netR = grossR - costR). Never charges less than the pure
 *  exchange fee: the floor makes an over-configured PAPER_*_SLIPPAGE_BPS unable to drive the modeled
 *  cost to zero or negative.
 *
 *  THE SINGLE ENTRY POINT for every paper cost — resolver branches and the three what-if
 *  counterfactuals alike. While PAPER_COST_MODEL_V2 is off it returns the flat v1 value, so the
 *  whole book stays on one model and no delta can straddle the two. */
function _fundingCostR(order: PaperOrder, exitAtMs: number | null | undefined): number {
  if (!PAPER_COST_MODEL_V2_ENABLED) return 0;
  return paperFundingCostR(order.plannedStopDistanceBps, Date.parse(order.openedAt), exitAtMs);
}

function _computePaperExitCostR(
  order: PaperOrder,
  kind: PaperExitKind,
  model: PaperExecutionModel,
  viaWalk: boolean,
  exitAtMs?: number | null,
): number {
  const stopBps = order.plannedStopDistanceBps;
  if (!(stopBps > 0)) return 0;
  if (!PAPER_COST_MODEL_V2_ENABLED) return _computePaperCostR(stopBps);
  // The arithmetic lives in paper-cost-model-v2.ts (no imports) so live/3103, whose router is ~977
  // lines behind this one, can charge the IDENTICAL cost without inheriting this file's dependency
  // graph. One copy of the formula, or the two cohorts diverge silently.
  return paperExitCostRV2({
    stopBps,
    costModel: _paperCostModelForOrder(order),
    kind,
    takerRoundTripBps: TAKER_ROUNDTRIP_BPS,
    makerRoundTripBps: MAKER_ROUNDTRIP_BPS,
    realisticFeeBpsPerSide: REALISTIC_FEE_BPS_PER_SIDE,
    stopOutSlippageBps: STOP_OUT_SLIPPAGE_BPS,
    slipAlreadyInGrossBps: _slipAlreadyInGrossBps(kind, model, viaWalk),
    openedAtMs: Date.parse(order.openedAt),
    exitAtMs,
  });
}

/**
 * Cost for a MANUAL operator close at the current mark (POST /api/shadow/paper-controls/
 * realize-open). Exported so that endpoint stops hardcoding its own flat `-(22 / stopBps)`: it
 * writes grossR/costR/netR into the SAME store the resolver writes, so a hardcoded literal there
 * would leave maker lanes overcharged 3.67x and produce untagged rows in a cohort the resolver is
 * versioning — the opposite of what a cohort discriminator is for.
 *
 * MARK_TO_MARKET (an operator close at mark is not a stop trigger, so no stop-out surcharge), and
 * `viaWalk = true` because that path computes grossR from the RAW mark with no execution model, so
 * there is no already-realized slippage to net out. Routes through the same
 * PAPER_COST_MODEL_V2_ENABLED gate as everything else — pair it with PAPER_COST_MODEL_VERSION.
 */
export function paperManualRealizeCostR(order: PaperOrder): number {
  return _computePaperExitCostR(order, "MARK_TO_MARKET", PAPER_EXECUTION_MODEL_IDEAL, true, Date.now());
}

// ─── SIMULATED R-path capture (2026-07-26, REPORT-ONLY) ─────────────────────
//
// Paper orders resolved through walkVariantPath already have their whole candle path reconstructed;
// collectRPath surfaces the per-candle R series that walk computes, and it is persisted here for the
// Exit Brain's SIMULATED evidence tier (paper-simulated-path-store.ts). Absolutely nothing in this
// block can move a paper outcome: it is called AFTER grossR/costR/netR are computed, it writes only
// to its own isolated bounded JSON store, and every failure mode is swallowed.
//
// Default-ON with a single env kill-switch, matching the repo's `*_DISABLED !== "1"` idiom (the same
// shape EXIT_BRAIN_SHADOW_DISABLED / RESIDUAL_MOMENTUM_DISABLED use). Deliberately NOT
// instance-gated: it touches no live gate on any instance, so there is no gating code to change.

function _simulatedPathCaptureEnabled(): boolean {
  return process.env.PAPER_SIMULATED_PATH_CAPTURE_DISABLED !== "1";
}

/** Best-effort side-record of one resolved paper order's simulated R path. Never throws; a missing
 *  rPath (capture disabled, or a walk whose path was invalidated) is simply not recorded — never
 *  fabricated. `closeR` is the walk's RAW grossR, the same unit as the series. The store lives next
 *  to the paper store itself (simulatedPaperPathDirFor — the same locality idiom
 *  recordHeatShadowSnapshot uses below), so it follows the instance's real data dir instead of
 *  assuming the process cwd, and the Exit Brain reader derives its dir the exact same way.
 *
 *  ALWAYS deferSave (2026-07-26 review fix): without it every resolved order serialized and
 *  writeFileSync'd the WHOLE store synchronously. At steady state (300 paths) that store is ~3.5MB,
 *  and resolverMaxOrders defaults to 80 — measured at ~565ms of BLOCKED EVENT LOOP per resolver pass.
 *  This resolver shares its process with the live mainnet execution engine on 3103, so that is a
 *  real-money latency hazard, not just slow bookkeeping. The single write now happens in
 *  _flushSimulatedPaperPaths, hung off resolvePaperOrders' existing beginBatch/endBatch wrapper. */
function _recordSimulatedPaperPath(
  store: PaperExecutionRouterStore,
  order: PaperOrder,
  walk: { rPath?: VariantRPathPoint[] | null; closedAtMs: number | null },
  closeR: number,
): void {
  try {
    if (!_simulatedPathCaptureEnabled()) return;
    const rPath = walk.rPath;
    if (!Array.isArray(rPath) || rPath.length === 0) return;
    if (!Number.isFinite(walk.closedAtMs)) return;
    getSimulatedPaperPathStore(simulatedPaperPathDirFor(store.path)).recordResolvedPath(
      {
        key: order.paperOrderId,
        laneId: order.selectedLaneId,
        symbol: order.symbol,
        direction: order.direction,
        closedAtMs: walk.closedAtMs as number,
        closeR,
        rPath,
      },
      { deferSave: true },
    );
  } catch {
    // report-only bookkeeping never breaks paper resolution
  }
}

// ─── execution-realism model (live-preview fidelity) ────────────────────────
//
// The paper-shadow run SIMULATES live execution, so fills are modeled with the
// costs a real venue imposes — not idealized perfect fills. Two costs map directly
// to the operator's "don't enter/exit late" concern:
//   - entrySlippageBps  telat-masuk: a taker entry placed after the signal candle
//                        closes fills at a slightly worse price than the signal.
//   - stopSlippageBps   telat-jual: a resting STOP_MARKET exit fills PAST the stop
//                        on the triggering move/gap (a loss can exceed 1R).
//   - tpSlippageBps     a resting LIMIT take-profit fills at the limit (≈0).
//
// This assumes the live exit design is RESTING exchange orders (SL/TP placed at
// entry) — the only design that avoids poll-delayed late exits. If live instead
// polled for exits, telat-jual would be far worse than this models.
//
// CORRECTED 2026-07-26 — the previous note here claimed these bps were "additive on top of fees
// (price impact ≠ commission), so there is no double-count". That was FALSE.
// PAPER_TAKER_COST_BPS (22) = REALISTIC_ROUND_TRIP_FEE_SLIP_BPS = (5 fee + 6 SLIPPAGE) × 2 sides,
// i.e. it is 10bps of fee and 12bps of slippage, not fees alone — so every bps configured here WAS
// double-counted against it. _computePaperExitCostR now nets whatever this model already moved into
// grossR back out of costR, per exit kind. Do NOT zero these values "because cost covers slippage":
// they are what produces the R-multiple drift (loss worse than −1R, win below nominal) that the
// realism model exists to show; the cost model only stops charging for it twice.
export interface PaperExecutionModel {
  /** Adverse entry slippage, bps of price (LONG buys higher, SHORT sells lower). */
  entrySlippageBps: number;
  /** Adverse stop-exit slippage, bps of price (fills past the stop). */
  stopSlippageBps: number;
  /** Take-profit slippage, bps of price (resting limit ≈ 0). */
  tpSlippageBps: number;
}

/** Zero-slippage idealized fills. NOT a live preview — kept for unit-test determinism. */
export const PAPER_EXECUTION_MODEL_IDEAL: PaperExecutionModel = {
  entrySlippageBps: 0,
  stopSlippageBps: 0,
  tpSlippageBps: 0,
};

/**
 * Default REALISTIC model for the running paper-shadow. Conservative liquid-perp
 * taker assumptions; calibrate per symbol/venue via PAPER_*_SLIPPAGE_BPS env. These
 * are ASSUMPTIONS, not measured fills — tighten them against real fills once live.
 */
export const PAPER_EXECUTION_MODEL_REALISTIC: PaperExecutionModel = {
  entrySlippageBps: 2,
  stopSlippageBps: 5,
  tpSlippageBps: 0,
};

/** Adverse entry fill: LONG buys higher, SHORT sells lower. */
function _entryFill(direction: "LONG" | "SHORT", entry: number, bps: number): number {
  const f = Math.max(0, bps) / 10_000;
  return direction === "LONG" ? entry * (1 + f) : entry * (1 - f);
}

/** Adverse exit fill: LONG sells lower, SHORT buys higher (applies to both SL and TP). */
function _exitFill(direction: "LONG" | "SHORT", price: number, bps: number): number {
  const f = Math.max(0, bps) / 10_000;
  return direction === "LONG" ? price * (1 - f) : price * (1 + f);
}

async function _resolve1mForPaper(
  client: PaperResolverClient,
  symbol: string,
  candleOpenMs: number,
  direction: "LONG" | "SHORT",
  _entry: number,
  stop: number,
  tp: number,
): Promise<"SL" | "TP" | null> {
  try {
    const startTime = candleOpenMs;
    const endTime = candleOpenMs + CANDLE_MS;
    const candles = await client.getKlines(symbol, "1m", { startTime, endTime, limit: 6 });
    for (const c of candles) {
      const high = Number(c[2]);
      const low = Number(c[3]);
      const slHit = direction === "LONG" ? low <= stop : high >= stop;
      const tpHit = direction === "LONG" ? high >= tp : low <= tp;
      if (slHit && tpHit) return "SL"; // still ambiguous → conservative SL-first
      if (slHit) return "SL";
      if (tpHit) return "TP";
    }
    return null;
  } catch {
    return null;
  }
}

export async function resolvePaperOrders(
  store: PaperExecutionRouterStore,
  binanceClient: PaperResolverClient,
  executionModel: PaperExecutionModel = PAPER_EXECUTION_MODEL_IDEAL,
  opts: { maxOrders?: number; maxRuntimeMs?: number; yieldEvery?: number } = {},
): Promise<{ resolved: number; expired: number; dataFailures: number; errors: number }> {
  store.beginBatch();
  try {
    const result = await resolvePaperOrdersInner(store, binanceClient, executionModel, opts);
    recordForwardCausalResolutions(store);
    _pruneSimulatedPaperPaths(store);
    return result;
  } finally {
    store.endBatch();
    // Exactly ONE write of the simulated-path store per resolver pass, on the SAME wrapper the paper
    // store's own batching already uses. In the `finally` so an aborted/throwing pass still persists
    // whatever it managed to record (and so a deferred prune is never left unwritten).
    _flushSimulatedPaperPaths(store);
  }
}

/** Age-prune of the report-only simulated R-path store, once per resolver pass (the FIFO cap is
 *  enforced on write; this is the second, time-based bound — same two-bound idiom
 *  position-path-recorder.ts uses, whose pruneExpired the live engine likewise calls once per tick).
 *  Fully swallowed: a prune failure can never affect paper resolution. */
function _pruneSimulatedPaperPaths(store: PaperExecutionRouterStore): void {
  try {
    if (!_simulatedPathCaptureEnabled()) return;
    // Deferred like every other write in this pass — _flushSimulatedPaperPaths persists it below.
    getSimulatedPaperPathStore(simulatedPaperPathDirFor(store.path)).pruneExpired(Date.now(), { deferSave: true });
  } catch {
    // report-only bookkeeping never breaks paper resolution
  }
}

/** The ONE write of the simulated R-path store per resolver pass (see _recordSimulatedPaperPath's
 *  event-loop note). flush() is a no-op while the store is clean, so a pass that recorded nothing
 *  costs nothing. Fully swallowed: a persistence failure can never affect paper resolution. */
function _flushSimulatedPaperPaths(store: PaperExecutionRouterStore): void {
  try {
    if (!_simulatedPathCaptureEnabled()) return;
    getSimulatedPaperPathStore(simulatedPaperPathDirFor(store.path)).flush();
  } catch {
    // report-only bookkeeping never breaks paper resolution
  }
}

/**
 * Forward collection observes already-persisted terminal paper outcomes. It only
 * stamps the additive lineage outcomeId and appends a report-only event; no
 * resolver result, risk control, allocation, or exchange action is changed.
 */
function recordForwardCausalResolutions(store: PaperExecutionRouterStore): void {
  if (!resolveCausalCollectionActivation(process.env).active) return;
  const resolved: PaperOrder[] = [];
  for (const order of store.all) {
    if (order.paperStatus !== "PAPER_CLOSED_WIN" && order.paperStatus !== "PAPER_CLOSED_LOSS") continue;
    const identity = withResolvedCausalIdentity(order);
    if (identity && identity !== order.causalIdentity) store.update(order.paperOrderId, { causalIdentity: identity });
    resolved.push(order);
  }
  recordForwardOutcomes(resolved);
}

async function resolvePaperOrdersInner(
  store: PaperExecutionRouterStore,
  binanceClient: PaperResolverClient,
  executionModel: PaperExecutionModel,
  opts: { maxOrders?: number; maxRuntimeMs?: number; yieldEvery?: number },
): Promise<{ resolved: number; expired: number; dataFailures: number; errors: number }> {
  const nowMs = Date.now();
  const startedMs = nowMs;
  const maxOrders =
    typeof opts.maxOrders === "number" && Number.isFinite(opts.maxOrders) && opts.maxOrders > 0
      ? Math.floor(opts.maxOrders)
      : Number.POSITIVE_INFINITY;
  const maxRuntimeMs =
    typeof opts.maxRuntimeMs === "number" && Number.isFinite(opts.maxRuntimeMs) && opts.maxRuntimeMs > 0
      ? Math.floor(opts.maxRuntimeMs)
      : Number.POSITIVE_INFINITY;
  const yieldEvery =
    typeof opts.yieldEvery === "number" && Number.isFinite(opts.yieldEvery) && opts.yieldEvery > 0
      ? Math.floor(opts.yieldEvery)
      : 1;
  let resolved = 0;
  let expired = 0;
  let dataFailures = 0;
  let errors = 0;
  let processed = 0;

  const openOrders = store.all
    .slice()
    .filter((order) => order.paperStatus === "CREATED" || order.paperStatus === "PAPER_SUBMITTED");

  const processableOrders: PaperOrder[] = [];
  for (const order of openOrders) {
    // A resting entry expires from first-seen. A filled position instead owns a
    // full holding window from its actual fill; pending time never consumes it.
    const expiryAnchorMs = isPendingPaperEntry(order)
      ? paperOrderFirstSeenAtMs(order, nowMs)
      : paperOrderEntryFilledAtMs(order, nowMs);
    if (nowMs - expiryAnchorMs > PAPER_ORDER_EXPIRY_MS) {
      store.update(order.paperOrderId, {
        paperStatus: "PAPER_EXPIRED",
        closeReason: "EXPIRED_UNRESOLVED",
        updatedAt: new Date().toISOString(),
      });
      expired += 1;
      resolved += 1;
      continue;
    }
    processableOrders.push(order);
  }

  const atExitNow = processableOrders.length > 0
    ? await findOrdersAtExitNow(processableOrders, binanceClient, nowMs)
    : new Set<string>();
  const rankedOrders = processableOrders
    .map((order) => {
      const openedAtMs = isPendingPaperEntry(order)
        ? paperOrderFirstSeenAtMs(order, nowMs)
        : paperOrderEntryFilledAtMs(order, nowMs);
      const updatedAtMs = new Date(order.updatedAt).getTime();
      const rank = nowMs - openedAtMs >= maxHoldMsForOrder(order)
        ? 0
        : atExitNow.has(order.paperOrderId)
          ? 1
          : 2;
      return {
        order,
        openedAtMs,
        lastCheckedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : openedAtMs,
        rank,
      };
    })
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      const aSortMs = a.rank === 2 ? a.lastCheckedAtMs : a.openedAtMs;
      const bSortMs = b.rank === 2 ? b.lastCheckedAtMs : b.openedAtMs;
      return aSortMs - bSortMs || a.openedAtMs - b.openedAtMs;
    });

  for (const item of rankedOrders) {
    const order = item.order;
    if (Date.now() - startedMs >= maxRuntimeMs) break;
    let openedAtMs = item.openedAtMs;

    // The budget applies ONLY to real fetch-walk resolution.
    if (processed >= maxOrders) break;
    processed += 1;
    if (processed % yieldEvery === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    try {
      // Post-fix fills may occur inside a candle. Resolve exits only from the
      // next whole candle, otherwise its high/low can include pre-fill path.
      const resolutionStartMs = order.executionPolicyVersion === EXECUTION_POLICY_VERSION
        ? Math.ceil(openedAtMs / CANDLE_MS) * CANDLE_MS
        : openedAtMs - CANDLE_MS;
      // A post-fix fill may happen at any point inside its opening candle. That
      // candle is deliberately excluded from causal resolution, so there is no
      // valid market path until the following whole candle has closed. Treat the
      // interval before that boundary as pending, not as a permanent data gap.
      if (
        order.executionPolicyVersion === EXECUTION_POLICY_VERSION
        && nowMs < resolutionStartMs + CANDLE_MS
      ) {
        continue;
      }
      const startTime = resolutionStartMs;
      const endTime = Math.min(nowMs, openedAtMs + 14 * 24 * 60 * 60 * 1000);
      const candles = await fetchPaperKlinesRange(binanceClient, order.symbol, "5m", startTime, endTime);

      if (!Array.isArray(candles) || candles.length === 0) {
        store.update(order.paperOrderId, {
          paperStatus: "PAPER_DATA_FAILURE",
          closeReason: "NO_CANDLES",
          updatedAt: new Date().toISOString(),
        });
        dataFailures += 1;
        continue;
      }

      if (isPendingPaperEntry(order)) {
        const firstSeenAtMs = paperOrderFirstSeenAtMs(order, nowMs);
        let pendingResolution: PendingEntryResolution = "NO_FILL";
        let fillCandle: PaperKlineTuple | null = null;
        for (const candle of candles) {
          // Never use the candle already in progress at the decision time: its
          // high/low contains unknown pre-decision path. The first fully causal
          // candidate is the next 5m candle.
          if (Number(candle[0]) < firstSeenAtMs) continue;
          pendingResolution = resolvePendingEntryCandle(order, candle);
          if (pendingResolution !== "NO_FILL") {
            fillCandle = candle;
            break;
          }
        }

        if (pendingResolution === "NO_FILL" || !fillCandle) {
          store.update(order.paperOrderId, { paperStatus: "PAPER_SUBMITTED", updatedAt: new Date().toISOString() });
          continue;
        }

        const actualEntry = order.entryOrderPrice!;
        const geometry = paperActualEntryGeometry(order.direction, actualEntry, order.stopLoss, order.takeProfitLevels);
        const fillClosedAtMs = Number(fillCandle[0]) + CANDLE_MS;
        const risk = Math.abs(actualEntry - order.stopLoss);
        const Ef = _entryFill(order.direction, actualEntry, executionModel.entrySlippageBps);
        if (!geometry.ok || !(risk > 0)) {
          store.update(order.paperOrderId, {
            paperStatus: "PAPER_REJECTED",
            closeReason: geometry.reason ?? "INVALID_GEOMETRY",
            updatedAt: new Date().toISOString(),
          });
          dataFailures += 1;
          continue;
        }

        if (pendingResolution === "AMBIGUOUS_STOP") {
          const Sf = _exitFill(order.direction, order.stopLoss, executionModel.stopSlippageBps);
          const grossR = _rewardR(order.direction, Ef, Sf, risk);
          const costR = _computePaperExitCostR(order, "STOP_LIKE", executionModel, false, fillClosedAtMs);
          const netR = grossR + costR;
          store.update(order.paperOrderId, {
            entryPrice: actualEntry,
            entryFilledAt: new Date(fillClosedAtMs).toISOString(),
            actualStopDistanceBps: geometry.stopDistanceBps,
            actualRiskReward: geometry.riskReward,
            paperStatus: "PAPER_CLOSED_LOSS",
            grossR,
            costR,
            costModelVersion: PAPER_COST_MODEL_VERSION,
            netR,
            netPnlAmount: netR * order.plannedRiskAmount,
            closeReason: "PENDING_FILL_STOP_AMBIGUOUS",
            closedAtMs: fillClosedAtMs,
            closeIntrabarAmbiguous: true,
            updatedAt: new Date().toISOString(),
          });
          resolved += 1;
          continue;
        }

        // Fill-only candle: TP/SL evaluation starts at the following candle so
        // we never invent intrabar ordering or a free TP on entry.
        store.update(order.paperOrderId, {
          entryPrice: actualEntry,
          entryFilledAt: new Date(fillClosedAtMs).toISOString(),
          actualStopDistanceBps: geometry.stopDistanceBps,
          actualRiskReward: geometry.riskReward,
          paperStatus: "PAPER_SUBMITTED",
          updatedAt: new Date().toISOString(),
        });
        continue;
      }

      openedAtMs = paperOrderEntryFilledAtMs(order, nowMs);

      const E = order.entryPrice;
      const S = order.stopLoss;
      const T = order.takeProfitLevels[0];
      const dir = order.direction;
      const risk = Math.abs(E - S);
      if (!(risk > 0) || T == null || !Number.isFinite(T)) {
        store.update(order.paperOrderId, {
          paperStatus: "PAPER_DATA_FAILURE",
          closeReason: "INVALID_GEOMETRY",
          updatedAt: new Date().toISOString(),
        });
        dataFailures += 1;
        continue;
      }

      // Realistic fills: position size is fixed by the PLANNED risk distance |E−S|,
      // so slippage shows up as the R-multiple drifting (loss < −1R, win < nominal).
      // In the IDEAL model these collapse back to E/S/T → grossR is unchanged.
      const Ef = _entryFill(dir, E, executionModel.entrySlippageBps);
      const Sf = _exitFill(dir, S, executionModel.stopSlippageBps);
      const Tf = _exitFill(dir, T, executionModel.tpSlippageBps);
      const exitRule = effectiveExitRuleForOrder(order);
      const fillMode: VariantFillMode = order.fillMode ?? "taker";
      const variantDef = variantDefinitionForOrder(order);

      // Scaleout, mfe_giveback, and maker_limit are resolved by the canonical VM-sim engine
      // (walkVariantPath) so the paper book uses the SAME honest intrabar reconstruction as the
      // research view. This prevents silent mis-resolution — scaleout must NOT collapse to
      // tp1_full, an mfe_giveback exit must run its peak-retrace logic (not a full TP/stop), and a
      // maker post-only entry must NOT collapse to a taker fill (no-fill risk is real). tp1_full
      // and trail_after_tp1 keep their existing inline paths untouched.
      //
      // The walk is handed RAW E/S/T. The old note here said that meant "slippage 0 under
      // PAPER_EXECUTION_MODEL_IDEAL, which is the only model in use" — WRONG on the second half:
      // routes/shadow.ts builds PAPER_EXECUTION_MODEL_REALISTIC by default and only falls back to
      // IDEAL when PAPER_EXECUTION_REALISM=0 (unset on testnet and research). What is still true is
      // that this walk ignores the model, so a walk-resolved grossR carries NO slippage — hence
      // viaWalk=true below, which charges the full round-trip with nothing netted out. The inline
      // paths further down DO price Ef/Sf/Tf through the model and pass viaWalk=false.
      // No fabricated profit either way.
      if (exitRule === "scaleout_tp1_trail" || exitRule === "mfe_giveback" || fillMode === "maker_limit") {
        const walk = await walkVariantPath(
          {
            direction: dir,
            entryPrice: E,
            stopLoss: S,
            target: T,
            exitRule,
            fillMode,
            openedAtMs: resolutionStartMs,
            candles,
            makerFillWindowCandles: MAKER_FILL_WINDOW_CANDLES,
            ...(variantDef ? { mfeGivebackArmR: effectiveMfeGivebackArmR(variantDef, order.plannedStopDistanceBps) } : {}),
            // OPT-IN R-series capture (2026-07-26, REPORT-ONLY). Purely additive: collectRPath only
            // ADDS walk.rPath and provably changes no other field of VariantWalkResult, so paper
            // resolution — and everything downstream of it, including lane maturity and live
            // eligibility — is byte-for-byte unaffected. The series feeds the Exit Brain's SIMULATED
            // tier only (paper-simulated-path-store.ts). Kill-switch: default-on, one env var off.
            ...(_simulatedPathCaptureEnabled() ? { collectRPath: true as const } : {}),
          },
          (fillCandleOpenMs) => _resolve1mForPaper(binanceClient, order.symbol, fillCandleOpenMs, dir, E, S, T),
        );
        if (walk.status === "NO_FILL") {
          store.update(order.paperOrderId, {
            paperStatus: "PAPER_NO_FILL",
            closeReason: walk.resolutionSource ?? "MAKER_NO_FILL",
            updatedAt: new Date().toISOString(),
          });
          resolved += 1;
          continue;
        }
        if (walk.status === "CLOSED_WIN" || walk.status === "CLOSED_LOSS") {
          const grossR = walk.grossR ?? 0;
          // Shared with the inline path via WALK_STOP_LIKE_RESOLUTION_SOURCES: every resting-stop
          // exit is stop-like regardless of which resolver path booked it. Previously this tested
          // only MFE_GIVEBACK_EXIT, so a walk-resolved trail-to-breakeven WIN escaped the stop-out
          // surcharge that the identical inline exit paid — a path-dependent cost.
          const walkExitKind: PaperExitKind = _walkExitKind(walk.status, walk.resolutionSource);
          // viaWalk=true: walkVariantPath is handed the RAW E/S/T above, so grossR carries no
          // execution-model slippage and nothing has to be netted out of the cost.
          const costR = _computePaperExitCostR(order, walkExitKind, executionModel, true, walk.closedAtMs ?? nowMs);
          const netR = grossR + costR;
          // REPORT-ONLY side-record of the SIMULATED R path (Exit Brain SIMULATED tier). Wrapped +
          // fail-open: it runs AFTER the outcome numbers above are computed and cannot influence any
          // of them, and a store failure is swallowed inside the store itself. closeR is the walk's
          // RAW grossR — the same unit as the series (costR is the paper book's separate modeling).
          _recordSimulatedPaperPath(store, order, walk, grossR);
          store.update(order.paperOrderId, {
            paperStatus: netR > 0 ? "PAPER_CLOSED_WIN" : "PAPER_CLOSED_LOSS",
            grossR,
            costR,
            costModelVersion: PAPER_COST_MODEL_VERSION,
            netR,
            netPnlAmount: netR * order.plannedRiskAmount,
            closeReason: walk.resolutionSource ?? (exitRule === "scaleout_tp1_trail" ? "SCALEOUT_EXIT" : "MAKER_EXIT"),
            closedAtMs: walk.closedAtMs ?? null, // MARKET ts of the exit candle (from walkVariantPath), not process time
            closeIntrabarAmbiguous: walk.intrabarResolutionStatus === "AMBIGUOUS_SAME_CANDLE_SL_FIRST",
            updatedAt: new Date().toISOString(),
          });
          resolved += 1;
          continue;
        }
        // UNRESOLVED. Apply the per-lane max-hold time-stop as the inline path:
        // mark-to-market at the last candle close and BOOK it, so a filled but
        // never-resolved order cannot drift past the horizon uncounted.
        if (nowMs - openedAtMs >= maxHoldMsForOrder(order)) {
          const lastCandle = candles[candles.length - 1];
          const lastClose = lastCandle ? Number(lastCandle[4]) : E;
          const exitFill = _exitFill(dir, Number.isFinite(lastClose) ? lastClose : E, executionModel.stopSlippageBps);
          const grossR = _rewardR(dir, Ef, exitFill, risk);
          // viaWalk=false: this horizon close is priced by THIS function's own Ef/_exitFill, not by
          // walkVariantPath, so the model's entry+stop slippage IS already inside grossR.
          const closedAtMs = lastCandle ? Number(lastCandle[0]) + CANDLE_MS : nowMs;
          const costR = _computePaperExitCostR(order, "MARK_TO_MARKET", executionModel, false, closedAtMs);
          const netR = grossR + costR;
          store.update(order.paperOrderId, {
            paperStatus: netR > 0 ? "PAPER_CLOSED_WIN" : "PAPER_CLOSED_LOSS",
            grossR,
            costR,
            costModelVersion: PAPER_COST_MODEL_VERSION,
            netR,
            netPnlAmount: netR * order.plannedRiskAmount,
            closeReason: "MAX_HOLD_MTM",
            // MARKET ts: the mark-to-market horizon exit happens at the LAST candle's close (open + interval).
            closedAtMs,
            updatedAt: new Date().toISOString(),
          });
          resolved += 1;
          continue;
        }
        // Still within horizon — revisit on the next pass.
        store.update(order.paperOrderId, { paperStatus: "PAPER_SUBMITTED", updatedAt: new Date().toISOString() });
        continue;
      }

      let found = false;
      let tp1Touched = false;
      let lastPathClose = E;
      // Cost is exit-time dependent as well as exit-kind dependent: funding is
      // charged in completed 8h periods using the actual market close time.
      const inlineStopLikeCostR = (closedAtMs: number) =>
        _computePaperExitCostR(order, "STOP_LIKE", executionModel, false, closedAtMs);
      const inlineTpLikeCostR = (closedAtMs: number) =>
        _computePaperExitCostR(order, "TP_LIKE", executionModel, false, closedAtMs);
      for (const c of candles) {
        const openMs = c[0];
        if (openMs < resolutionStartMs) continue;
        const candleCloseMs = Number(openMs) + CANDLE_MS; // MARKET close time of THIS candle — the exit bar's ts (Track 1a)
        const high = Number(c[2]);
        const low = Number(c[3]);
        const close = Number(c[4]);
        if (Number.isFinite(close)) lastPathClose = close;
        const slHit = dir === "LONG" ? low <= S : high >= S;
        const tpHit = T != null && (dir === "LONG" ? high >= T : low <= T);

        if (exitRule === "trail_after_tp1") {
          const backToEntry = dir === "LONG" ? low <= E : high >= E;
          if (!tp1Touched) {
            if (slHit && tpHit) {
              const refined = await _resolve1mForPaper(binanceClient, order.symbol, openMs, dir, E, S, T);
              if (refined !== "TP") {
                const grossR = _rewardR(dir, Ef, Sf, risk);
                const costR = inlineStopLikeCostR(candleCloseMs);
                const netR = grossR + costR;
                store.update(order.paperOrderId, {
                  paperStatus: "PAPER_CLOSED_LOSS",
                  grossR,
                  costR,
                  costModelVersion: PAPER_COST_MODEL_VERSION,
                  netR,
                  netPnlAmount: netR * order.plannedRiskAmount,
                  closeReason: "TRAIL_SL_HIT_AMBIGUOUS",
                  closedAtMs: candleCloseMs,
                  closeIntrabarAmbiguous: true,
                  updatedAt: new Date().toISOString(),
                });
                resolved += 1;
                found = true;
                break;
              }
              tp1Touched = true;
              if (backToEntry) {
                const breakEvenFill = _exitFill(dir, E, executionModel.stopSlippageBps);
                const grossR = _rewardR(dir, Ef, breakEvenFill, risk);
                // Trail-to-breakeven is a resting STOP order pulled up to entry: it fills on the
                // adverse retrace, so it is stop-like for cost purposes even when it books a win.
                const costR = inlineStopLikeCostR(candleCloseMs);
                const netR = grossR + costR;
                store.update(order.paperOrderId, {
                  paperStatus: netR > 0 ? "PAPER_CLOSED_WIN" : "PAPER_CLOSED_LOSS",
                  grossR,
                  costR,
                  costModelVersion: PAPER_COST_MODEL_VERSION,
                  netR,
                  netPnlAmount: netR * order.plannedRiskAmount,
                  closeReason: "TRAIL_BREAKEVEN_SAME_CANDLE",
                  closedAtMs: candleCloseMs,
                  closeIntrabarAmbiguous: true,
                  updatedAt: new Date().toISOString(),
                });
                resolved += 1;
                found = true;
                break;
              }
              continue;
            }
            if (slHit) {
              const grossR = _rewardR(dir, Ef, Sf, risk);
              const costR = inlineStopLikeCostR(candleCloseMs);
              const netR = grossR + costR;
              store.update(order.paperOrderId, {
                paperStatus: "PAPER_CLOSED_LOSS",
                grossR,
                costR,
                costModelVersion: PAPER_COST_MODEL_VERSION,
                netR,
                netPnlAmount: netR * order.plannedRiskAmount,
                closeReason: "TRAIL_SL_HIT",
                closedAtMs: candleCloseMs,
                updatedAt: new Date().toISOString(),
              });
              resolved += 1;
              found = true;
              break;
            }
            if (tpHit) {
              tp1Touched = true;
              if (backToEntry) {
                const breakEvenFill = _exitFill(dir, E, executionModel.stopSlippageBps);
                const grossR = _rewardR(dir, Ef, breakEvenFill, risk);
                // Trail-to-breakeven is a resting STOP order pulled up to entry: it fills on the
                // adverse retrace, so it is stop-like for cost purposes even when it books a win.
                const costR = inlineStopLikeCostR(candleCloseMs);
                const netR = grossR + costR;
                store.update(order.paperOrderId, {
                  paperStatus: netR > 0 ? "PAPER_CLOSED_WIN" : "PAPER_CLOSED_LOSS",
                  grossR,
                  costR,
                  costModelVersion: PAPER_COST_MODEL_VERSION,
                  netR,
                  netPnlAmount: netR * order.plannedRiskAmount,
                  closeReason: "TRAIL_BREAKEVEN_SAME_CANDLE",
                  closedAtMs: candleCloseMs,
                  closeIntrabarAmbiguous: true,
                  updatedAt: new Date().toISOString(),
                });
                resolved += 1;
                found = true;
                break;
              }
            }
            continue;
          }

          if (backToEntry) {
            const breakEvenFill = _exitFill(dir, E, executionModel.stopSlippageBps);
            const grossR = _rewardR(dir, Ef, breakEvenFill, risk);
            const costR = inlineStopLikeCostR(candleCloseMs);
            const netR = grossR + costR;
            store.update(order.paperOrderId, {
              paperStatus: netR > 0 ? "PAPER_CLOSED_WIN" : "PAPER_CLOSED_LOSS",
              grossR,
              costR,
              costModelVersion: PAPER_COST_MODEL_VERSION,
              netR,
              netPnlAmount: netR * order.plannedRiskAmount,
              closeReason: "TRAIL_BREAKEVEN_EXIT",
              closedAtMs: candleCloseMs,
              updatedAt: new Date().toISOString(),
            });
            resolved += 1;
            found = true;
            break;
          }
          continue;
        }

        if (slHit && tpHit) {
          // Same-candle ambiguity: try 1m refinement
          const refined = await _resolve1mForPaper(binanceClient, order.symbol, openMs, dir, E, S, T);
          if (refined === "TP") {
            const grossR = _rewardR(dir, Ef, Tf, risk);
            const costR = inlineTpLikeCostR(candleCloseMs);
            const netR = grossR + costR;
            store.update(order.paperOrderId, {
              paperStatus: "PAPER_CLOSED_WIN",
              grossR,
              costR,
              costModelVersion: PAPER_COST_MODEL_VERSION,
              netR,
              netPnlAmount: netR * order.plannedRiskAmount,
              closeReason: "TP1_HIT_REFINED_1M",
              closedAtMs: candleCloseMs, // 1m-refined resolution, so intrabar order WAS proven — not ambiguous
              updatedAt: new Date().toISOString(),
            });
          } else {
            const grossR = _rewardR(dir, Ef, Sf, risk);
            const costR = inlineStopLikeCostR(candleCloseMs);
            const netR = grossR + costR;
            store.update(order.paperOrderId, {
              paperStatus: "PAPER_CLOSED_LOSS",
              grossR,
              costR,
              costModelVersion: PAPER_COST_MODEL_VERSION,
              netR,
              netPnlAmount: netR * order.plannedRiskAmount,
              closeReason: "SL_HIT_AMBIGUOUS",
              closedAtMs: candleCloseMs,
              closeIntrabarAmbiguous: true,
              updatedAt: new Date().toISOString(),
            });
          }
          resolved += 1;
          found = true;
          break;
        }

        if (slHit) {
          const grossR = _rewardR(dir, Ef, Sf, risk);
          const costR = inlineStopLikeCostR(candleCloseMs);
          const netR = grossR + costR;
          store.update(order.paperOrderId, {
            paperStatus: "PAPER_CLOSED_LOSS",
            grossR,
            costR,
            costModelVersion: PAPER_COST_MODEL_VERSION,
            netR,
            netPnlAmount: netR * order.plannedRiskAmount,
            closeReason: "SL_HIT",
            closedAtMs: candleCloseMs,
            updatedAt: new Date().toISOString(),
          });
          resolved += 1;
          found = true;
          break;
        }

        if (tpHit) {
          const grossR = _rewardR(dir, Ef, Tf, risk);
          const costR = inlineTpLikeCostR(candleCloseMs);
          const netR = grossR + costR;
          store.update(order.paperOrderId, {
            paperStatus: "PAPER_CLOSED_WIN",
            grossR,
            costR,
            costModelVersion: PAPER_COST_MODEL_VERSION,
            netR,
            netPnlAmount: netR * order.plannedRiskAmount,
            closeReason: "TP1_HIT",
            closedAtMs: candleCloseMs,
            updatedAt: new Date().toISOString(),
          });
          resolved += 1;
          found = true;
          break;
        }
      }

      if (!found && exitRule === "trail_after_tp1" && tp1Touched) {
        const pathEndFill = _exitFill(dir, lastPathClose, executionModel.tpSlippageBps);
        const grossR = _rewardR(dir, Ef, pathEndFill, risk);
        // Path-end MTM on a runner that already banked TP1. It exits at the last close via the
        // model's TP slippage (a working limit, not a stop trigger) — TP_LIKE, no stop surcharge.
        const closedAtMs = candles.length ? Number(candles[candles.length - 1]![0]) + CANDLE_MS : nowMs;
        const costR = _computePaperExitCostR(order, "TP_LIKE", executionModel, false, closedAtMs);
        const netR = grossR + costR;
        store.update(order.paperOrderId, {
          paperStatus: netR > 0 ? "PAPER_CLOSED_WIN" : "PAPER_CLOSED_LOSS",
          grossR,
          costR,
          costModelVersion: PAPER_COST_MODEL_VERSION,
          netR,
          netPnlAmount: netR * order.plannedRiskAmount,
          closeReason: "TRAIL_PATH_END",
          // path-end MTM exit ⇒ market ts is the LAST candle's close (open + interval).
          closedAtMs,
          updatedAt: new Date().toISOString(),
        });
        resolved += 1;
        found = true;
      }

      // Max-hold time-stop: neither TP nor SL hit within the lane's hold horizon
      // → force-exit at the last observed close (mark-to-market) and BOOK the
      // result, so wide-stop losers cannot drift unresolved and silently inflate
      // equity (phantom-equity bug). Symmetric: a position marked above water
      // books a win, below water a loss. Let-it-run lanes (CG_WIDE) extend the
      // horizon so a slow trending winner is given room instead of cut at 72h.
      if (!found && nowMs - openedAtMs >= maxHoldMsForOrder(order)) {
        const exitFill = _exitFill(dir, lastPathClose, executionModel.stopSlippageBps);
        const grossR = _rewardR(dir, Ef, exitFill, risk);
        // Horizon force-close at the last observed close — a market exit, NOT a stop trigger, so no
        // stop-out surcharge; grossR already carries the model's entry+stop slippage.
        const closedAtMs = candles.length ? Number(candles[candles.length - 1]![0]) + CANDLE_MS : nowMs;
        const costR = _computePaperExitCostR(order, "MARK_TO_MARKET", executionModel, false, closedAtMs);
        const netR = grossR + costR;
        store.update(order.paperOrderId, {
          paperStatus: netR > 0 ? "PAPER_CLOSED_WIN" : "PAPER_CLOSED_LOSS",
          grossR,
          costR,
          costModelVersion: PAPER_COST_MODEL_VERSION,
          netR,
          netPnlAmount: netR * order.plannedRiskAmount,
          closeReason: "MAX_HOLD_MTM",
          // MTM force-exit at the last observed candle's close (open + interval) — market ts, not process time.
          closedAtMs,
          updatedAt: new Date().toISOString(),
        });
        resolved += 1;
        found = true;
      }

      if (!found) {
        // Still no resolution after this run — mark PAPER_SUBMITTED so we revisit later.
        store.update(order.paperOrderId, {
          paperStatus: "PAPER_SUBMITTED",
          updatedAt: new Date().toISOString(),
        });
      }
    } catch {
      // Transient fetch error (network blip, rate-limit, etc.): leave the order as
      // PAPER_SUBMITTED so the resolver retries on the next pass. Permanent kill
      // (PAPER_DATA_FAILURE) is only appropriate for hard data errors (NO_CANDLES,
      // INVALID_GEOMETRY) where retrying will not help.
      store.update(order.paperOrderId, {
        paperStatus: "PAPER_SUBMITTED",
        updatedAt: new Date().toISOString(),
      });
      errors += 1;
    }
  }

  // Bound memory: prune old DIAGNOSTIC closed orders beyond the rolling-window cap (HEADLINE/OPEN
  // untouched). No-op while under the cap, so it changes nothing today.
  store.pruneClosedDiagnostic(PAPER_MAX_CLOSED_DIAGNOSTIC);
  store.pruneTerminalNonOutcome(PAPER_MAX_TERMINAL_NON_OUTCOME);

  return { resolved, expired, dataFailures, errors };
}

// ─── rotation logic ─────────────────────────────────────────────────────────

export interface PaperLaneRotationInputs {
  activeLaneId: string | null;
  routerReport: AdaptiveLaneRouterReport;
  vmReport: CurrentGuardVariantMatrixReport;
  closedOrders: PaperOrder[];
  controllerMode: string;
  regimeFamily: string;
  paperValidationAllowed?: boolean;
}

export interface PaperLaneComparison {
  laneId: string;
  netAvgR: number | null;
  pf: number | null;
  freshValid: number;
  eligible: boolean;
}

export interface PaperLaneRotationResult {
  currentLaneConfidence: LaneConfidence;
  action: RotationAction;
  selectedNextLaneId: string | null;
  reason: string;
  comparisonTable: PaperLaneComparison[];
}

export interface ActiveLanePaperMetrics {
  closed: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
}

/**
 * Active-lane health must not be diluted by portfolio-wide headline history.
 * This leaves headline PnL untouched while admission evaluates its own lane.
 */
export function buildActiveLanePaperMetrics(
  // `readonly` (widened 2026-07-26, T1-b) so report builders can pass an already-filtered view.
  // Purely a type widening — the body never mutated the array.
  orders: readonly PaperOrder[],
  activeLaneId: string | null,
): ActiveLanePaperMetrics {
  const closedStatuses: PaperOrderStatus[] = ["PAPER_CLOSED_WIN", "PAPER_CLOSED_LOSS"];
  const closed = orders.filter(
    (order) =>
      closedStatuses.includes(order.paperStatus) &&
      order.diagnosticLabel !== "BACKFILL_DIAGNOSTIC" &&
      order.paperOrderMode !== "DIAGNOSTIC_ONLY" &&
      (activeLaneId === null || order.selectedLaneId === activeLaneId),
  );
  const netRs = closed
    .map((order) => order.netR)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const netAvgR =
    netRs.length > 0 ? netRs.reduce((sum, value) => sum + value, 0) / netRs.length : null;
  const winSum = netRs.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const lossSum = netRs
    .filter((value) => value < 0)
    .reduce((sum, value) => sum + Math.abs(value), 0);
  const pf = lossSum > 0 ? winSum / lossSum : winSum > 0 ? Infinity : null;
  const wins = closed.filter((order) => (order.netR ?? 0) > 0).length;
  return {
    closed: closed.length,
    netAvgR,
    pf,
    wr: closed.length > 0 ? wins / closed.length : null,
  };
}

function _computeRollingMetrics(closed: PaperOrder[]): {
  rollingNetAvgR: number | null;
  rollingPF: number | null;
  consecutiveLosses: number;
  closedCount: number;
} {
  const headline = closed.filter(
    (o) => o.diagnosticLabel !== "BACKFILL_DIAGNOSTIC" && o.paperOrderMode !== "DIAGNOSTIC_ONLY",
  );
  const sorted = headline.slice().sort((a, b) => {
    const am = new Date(a.updatedAt).getTime();
    const bm = new Date(b.updatedAt).getTime();
    return am - bm;
  });
  const last = sorted.slice(-10);
  const netRs = last.map((o) => o.netR).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  let rollingNetAvgR: number | null = null;
  let rollingPF: number | null = null;
  if (netRs.length > 0) {
    rollingNetAvgR = netRs.reduce((s, v) => s + v, 0) / netRs.length;
    const wins = netRs.filter((v) => v > 0).reduce((s, v) => s + v, 0);
    const losses = netRs.filter((v) => v < 0).reduce((s, v) => s + Math.abs(v), 0);
    rollingPF = losses > 0 ? wins / losses : wins > 0 ? Infinity : null;
  }
  let consecutiveLosses = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const o = sorted[i]!;
    if ((o.netR ?? 0) < 0) consecutiveLosses += 1;
    else break;
  }
  return { rollingNetAvgR, rollingPF, consecutiveLosses, closedCount: sorted.length };
}

export function evaluatePaperLaneRotation(
  inputs: PaperLaneRotationInputs,
): PaperLaneRotationResult {
  const { activeLaneId, vmReport, closedOrders, controllerMode, regimeFamily } = inputs;
  const paperValidationAllowed = inputs.paperValidationAllowed === true;

  const activeLaneClosedOrders =
    activeLaneId === null
      ? closedOrders
      : closedOrders.filter((order) => order.selectedLaneId === activeLaneId);
  const { rollingNetAvgR, rollingPF, consecutiveLosses, closedCount } =
    _computeRollingMetrics(activeLaneClosedOrders);

  const currentLaneVariantId =
    activeLaneId?.startsWith("CG_VARIANT_MATRIX:") === true
      ? activeLaneId.split(":")[1] ?? null
      : null;
  const currentLaneVmRow = currentLaneVariantId
    ? vmReport.rows.find((row) => row.variantId === currentLaneVariantId)
    : undefined;
  const currentLaneFreshValid = currentLaneVmRow?.freshValid ?? 0;
  const vmEconomicsRejected =
    currentLaneVmRow?.status === "REJECT" ||
    (
      (currentLaneVmRow?.freshValid ?? 0) >= 50 &&
      (
        (currentLaneVmRow?.netAvgR !== null && (currentLaneVmRow?.netAvgR ?? 0) < 0) ||
        (
          currentLaneVmRow?.pf !== null &&
          Number.isFinite(currentLaneVmRow?.pf) &&
          (currentLaneVmRow?.pf ?? Infinity) < 1
        )
      )
    );

  // Determine current confidence
  let confidence: LaneConfidence;
  if (vmEconomicsRejected) {
    confidence = "DEGRADED";
  } else if (closedCount < 3) {
    confidence = "MEDIUM";
  } else if (consecutiveLosses >= 5) {
    confidence = "DEGRADED";
  } else if ((rollingNetAvgR ?? 0) < 0 || (rollingPF ?? 0) < 1.2) {
    confidence = "LOW";
  } else if ((rollingNetAvgR ?? 0) >= 0.05 && (rollingPF ?? 0) >= 1.2) {
    confidence = "HIGH";
  } else {
    confidence = "MEDIUM";
  }

  // Determine if a better eligible lane exists
  const eligible = selectEligiblePaperLane({
    vmReport,
    controllerMode,
    regimeFamily,
    paperValidationAllowed,
  });
  const betterLane =
    eligible !== null && eligible.laneId !== activeLaneId && eligible.freshValid > currentLaneFreshValid;

  // Action
  let action: RotationAction;
  let selectedNextLaneId: string | null = null;
  let reason: string;
  if (confidence === "HIGH" || confidence === "MEDIUM") {
    action = "KEEP_CURRENT_LANE";
    reason = `confidence=${confidence}; keep current lane`;
  } else if (confidence === "LOW" && betterLane) {
    action = "ROTATE_TO_BETTER_LANE";
    selectedNextLaneId = eligible!.laneId;
    reason = `confidence=LOW; rotate to ${eligible!.laneId}`;
  } else if (confidence === "LOW") {
    action = "CONTINUE_PAPER_WITH_LOW_CONFIDENCE";
    reason = "confidence=LOW; no better eligible lane available";
  } else if (confidence === "DEGRADED" && betterLane) {
    action = "ROTATE_TO_BETTER_LANE";
    selectedNextLaneId = eligible!.laneId;
    reason = `confidence=DEGRADED; rotate to ${eligible!.laneId}`;
  } else {
    action = "PAPER_ONLY_NO_REAL_APPROVAL";
    reason = vmEconomicsRejected
      ? `confidence=DEGRADED; active lane variant-matrix status=${currentLaneVmRow?.status ?? "REJECT"} ` +
        `(n=${currentLaneVmRow?.freshValid ?? 0}, net=${currentLaneVmRow?.netAvgR?.toFixed(4) ?? "n/a"}, ` +
        `PF=${currentLaneVmRow?.pf?.toFixed(2) ?? "n/a"}); quarantine new paper admission`
      : "confidence=DEGRADED; no better eligible lane; continue paper only with no live approval";
  }

  // Comparison table — include eligible candidate(s) and active lane
  const comparisonTable: PaperLaneComparison[] = [];
  if (activeLaneId) {
    comparisonTable.push({
      laneId: activeLaneId,
      netAvgR: rollingNetAvgR,
      pf: rollingPF,
      freshValid: currentLaneFreshValid,
      eligible: false,
    });
  }
  if (eligible) {
    comparisonTable.push({
      laneId: eligible.laneId,
      netAvgR: eligible.netAvgR,
      pf: eligible.pf,
      freshValid: eligible.freshValid,
      eligible: true,
    });
  }

  return {
    currentLaneConfidence: confidence,
    action,
    selectedNextLaneId,
    reason,
    comparisonTable,
  };
}

// ─── performance report ─────────────────────────────────────────────────────

export interface PaperRollingWindow {
  n: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
}

export interface PaperPerformanceReport {
  total: number;
  open: number;
  closed: number;
  win: number;
  loss: number;
  noFill: number;
  expired: number;
  dataFailure: number;

  headlineTotal: number;
  headlineClosed: number;
  headlineWin: number;
  headlineLoss: number;
  /** Diagnostic-only orders (excluded from all headline metrics). */
  diagnosticOnlyTotal: number;
  diagnosticOnlyClosed: number;
  headlineNetAvgR: number | null;
  headlinePF: number | null;
  headlineWR: number | null;
  headlineAvgWinR: number | null;
  headlineAvgLossR: number | null;
  headlinePayoffRatio: number | null;

  paperEquity: number;
  startingEquity: number;
  /** Official headline-only realized PnL. */
  realizedPaperPnl: number;
  /** Realized PnL excluded from headline metrics. */
  diagnosticRealizedPaperPnl: number;
  /** Headline plus diagnostic realized PnL, for operational visibility only. */
  totalRealizedPaperPnl: number;
  monthHeadlinePaperPnl: number;
  monthDiagnosticPaperPnl: number;
  monthTotalPaperPnl: number;
  taipeiDailyClosed: number;
  taipeiDailyWins: number;
  taipeiDailyLosses: number;
  taipeiDailyHeadlinePnl: number;
  taipeiDailyDiagnosticPnl: number;
  taipeiDailyTotalPnl: number;
  dailyPaperPnl: number;
  rolling5: PaperRollingWindow;
  rolling10: PaperRollingWindow;
  rolling20: PaperRollingWindow;

  activeLane: string | null;
  /** Routing confidence from the adaptive lane router (may say HIGH even when performance has degraded). */
  laneConfidence: LaneConfidence;
  /**
   * Paper-performance-derived confidence — mirrors the allocator's degradation thresholds so
   * Section 10 always reflects the actual paper economics, not just the routing signal.
   * Values: DEGRADED when headlineClosed≥10 and any of netAvgR<0 | PF<1.0 | WR<30%.
   */
  paperLaneConfidence: LaneConfidence;
  activeLaneClosed: number;
  activeLaneNetAvgR: number | null;
  activeLanePF: number | null;
  activeLaneWR: number | null;
  rotationAction: RotationAction;
  selectedNextLaneId: string | null;

  operationalSafetyStatus: OperationalSafetyStatus;
  paperStartAt: string | null;

  latestOrders: PaperOrder[];
  noOrderReason: string | null;
  /** Current batch lane that admitted paper opportunities, if different from persisted headline lane. */
  currentBatchActiveLane?: string | null;
  /** Accounting mode used by the current batch lane, when known. */
  currentBatchOrderMode?: PaperOrderMode | null;
  /** Number of opportunities admitted in the current batch. */
  currentBatchCreatedCount?: number;

  /** Execution-realism model used to resolve fills (slippage). Undefined ⇒ IDEAL. */
  executionModel?: PaperExecutionModel;

  /**
   * T1-b: closed rows removed from EVERY aggregate above because their admitted stop distance is
   * below the admission floor `admissionStopFloorBpsForVariant` now returns for their own variant
   * — i.e. rows that could not exist under the fixed gate. Surfaced, never silent: it is rendered
   * unconditionally by buildPaperExecutionRouterBriefLines, and an operator reconstructs the
   * pre-exclusion aggregates as
   *   closed             = retainedClosedCount + excludedCount
   *   headlineClosed     = retainedHeadlineClosedCount + excludedHeadlineCount
   *   headlineNetAvgR    = (retainedHeadlineNetRSum + excludedHeadlineNetRSum) / headlineClosed
   *   realizedPaperPnl   = retainedHeadlineNetPnlAmount + excludedHeadlineNetPnlAmount
   * USE THE HEADLINE SUMS FOR THE HEADLINE METRICS. `headlineNetAvgR` / `headlinePF` / `headlineWR`
   * / `realizedPaperPnl` are HEADLINE-scoped; the report exposes no all-closed mean at all, so the
   * all-closed sums reconstruct nothing that is printed. On the measured store only ~4 of ~599
   * excluded rows are HEADLINE, so mixing the two bases is off by orders of magnitude.
   * Nothing is deleted from the store; this is a read-time filter only.
   */
  subFloorExclusion: SubFloorExclusionSummary;

  reportOnly: true;
  paperOnly: true;
}

function _rollingFromOrders(closedHeadline: PaperOrder[], n: number): PaperRollingWindow {
  const sorted = closedHeadline.slice().sort((a, b) => {
    const am = new Date(a.updatedAt).getTime();
    const bm = new Date(b.updatedAt).getTime();
    return am - bm;
  });
  const last = sorted.slice(-n);
  if (last.length === 0) return { n: 0, netAvgR: null, pf: null, wr: null };
  const netRs = last.map((o) => o.netR).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const netAvgR = netRs.length > 0 ? netRs.reduce((s, v) => s + v, 0) / netRs.length : null;
  const winSum = netRs.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const lossSum = netRs.filter((v) => v < 0).reduce((s, v) => s + Math.abs(v), 0);
  const pf = lossSum > 0 ? winSum / lossSum : winSum > 0 ? Infinity : null;
  const wins = last.filter((o) => (o.netR ?? 0) > 0).length;
  const wr = last.length > 0 ? wins / last.length : null;
  return { n: last.length, netAvgR, pf, wr };
}

/**
 * Derives paper-performance-based lane confidence, mirroring the allocator's
 * `decideLaneAdmission` degradation thresholds so Section 10 is always consistent
 * with laneAdmission=QUARANTINED. Never overrides DEGRADED → something better.
 */
export function derivePaperLaneConfidence(
  headlineClosed: number,
  headlineNetAvgR: number | null,
  headlinePF: number | null,
  headlineWR: number | null,
  routingConfidence: LaneConfidence,
): LaneConfidence {
  if (routingConfidence === "DEGRADED") return "DEGRADED";
  if (headlineClosed >= 10) {
    const netNeg = headlineNetAvgR !== null && headlineNetAvgR < 0;
    const pfBad = headlinePF !== null && Number.isFinite(headlinePF) && (headlinePF as number) < 1.0;
    const wrBad = headlineWR !== null && Number.isFinite(headlineWR) && (headlineWR as number) < 0.3;
    if (netNeg || pfBad || wrBad) return "DEGRADED";
  }
  return routingConfidence;
}

export function buildPaperPerformanceReport(
  store: PaperExecutionRouterStore,
  opts: {
    activeLaneId?: string | null;
    laneConfidence?: LaneConfidence;
    rotationResult?: PaperLaneRotationResult | null;
    operationalSafetyStatus?: OperationalSafetyStatus;
    noOrderReason?: string | null;
    executionModel?: PaperExecutionModel;
    /**
     * T1-b. Default TRUE (report semantics), so an ad-hoc/diagnostic caller gets the clean view.
     * EVERY production call site passes `subFloorExclusionEnabledForDecisions()` instead — see the
     * CLASSIFICATION CORRECTION below, and the [T1-b/9] wiring-contract test that enforces it for
     * routes/shadow.ts.
     */
    applySubFloorExclusion?: boolean;
  } = {},
): PaperPerformanceReport {
  // T1-b — drop closed rows the current admission gate would have rejected, and SURFACE what left
  // as `subFloorExclusion` so the pre-exclusion number stays reconstructible.
  //
  // CLASSIFICATION CORRECTION (code over brief; revised after review 2026-07-27): this builder is
  // NOT purely report-only, and treating it as such produced FIVE cross-population defects.
  //   - routes/shadow.ts (~:2767) builds a report solely to populate `AllocatorLaneState` —
  //     activeLane* go straight into `decideLaneAdmission`, which halts admission on a degraded lane.
  //   - the post-resolve reconciliation (~:3049) OVERWRITES those same four fields on the allocator
  //     report and recomputes paperLaneConfidence, and becomes `paperReport` for the brief + Telegram.
  //   - the neural map (~:1855) renders this report's global tiles directly ABOVE per-lane rows that
  //     come from `laneEconomics` / `buildPerSymbolLaneBookEdge`, both of which are flag-gated.
  // A report on a different population than the decisions it is used to explain cannot be
  // reconciled, so EVERY production call site now passes
  // `applySubFloorExclusion: subFloorExclusionEnabledForDecisions()` — ONE population, ONE lever.
  // The parameter still DEFAULTS to `true` so an ad-hoc/diagnostic caller gets the clean view.
  // The summary is computed either way, so an operator always sees what WOULD be removed even when
  // nothing is — but must read `subFloorExclusion.applied` to know which basis the metrics are on.
  // buildPaperExecutionRouterBriefLines prints both bases side by side for exactly that reason.
  const { rows: orders, exclusion: subFloorExclusion } = excludeSubFloorRowsForReport(
    store.all,
    opts.applySubFloorExclusion ?? true,
  );
  const state = store.getState();

  // All orders aggregates
  const closedStatuses: PaperOrderStatus[] = ["PAPER_CLOSED_WIN", "PAPER_CLOSED_LOSS"];
  const open = orders.filter((o) => o.paperStatus === "CREATED" || o.paperStatus === "PAPER_SUBMITTED").length;
  const closed = orders.filter((o) => closedStatuses.includes(o.paperStatus)).length;
  const win = orders.filter((o) => o.paperStatus === "PAPER_CLOSED_WIN").length;
  const loss = orders.filter((o) => o.paperStatus === "PAPER_CLOSED_LOSS").length;
  const noFill = orders.filter((o) => o.paperStatus === "PAPER_NO_FILL").length;
  const expired = orders.filter((o) => o.paperStatus === "PAPER_EXPIRED").length;
  const dataFailure = orders.filter((o) => o.paperStatus === "PAPER_DATA_FAILURE").length;

  // Headline (exclude BACKFILL_DIAGNOSTIC and DIAGNOSTIC_ONLY accounting mode)
  const headline = orders.filter(
    (o) => o.diagnosticLabel !== "BACKFILL_DIAGNOSTIC" && o.paperOrderMode !== "DIAGNOSTIC_ONLY",
  );
  // Diagnostic-only orders are tracked separately and never affect headline metrics.
  const diagnosticOnly = orders.filter((o) => o.paperOrderMode === "DIAGNOSTIC_ONLY");
  const diagnosticOnlyClosed = diagnosticOnly.filter((o) => closedStatuses.includes(o.paperStatus)).length;
  const headlineClosedArr = headline.filter((o) => closedStatuses.includes(o.paperStatus));
  const headlineWinArr = headline.filter((o) => o.paperStatus === "PAPER_CLOSED_WIN");
  const headlineLossArr = headline.filter((o) => o.paperStatus === "PAPER_CLOSED_LOSS");

  const headlineNetRs = headlineClosedArr
    .map((o) => o.netR)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const headlineNetAvgR =
    headlineNetRs.length > 0 ? headlineNetRs.reduce((s, v) => s + v, 0) / headlineNetRs.length : null;
  const headlineWinSum = headlineNetRs.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const headlineLossSum = headlineNetRs.filter((v) => v < 0).reduce((s, v) => s + Math.abs(v), 0);
  const headlinePF = headlineLossSum > 0 ? headlineWinSum / headlineLossSum : headlineWinSum > 0 ? Infinity : null;
  const headlineWR = headlineClosedArr.length > 0 ? headlineWinArr.length / headlineClosedArr.length : null;
  const headlineAvgWinR =
    headlineWinArr.length > 0
      ? headlineWinArr
          .map((o) => o.netR ?? 0)
          .reduce((s, v) => s + v, 0) / headlineWinArr.length
      : null;
  const headlineAvgLossR =
    headlineLossArr.length > 0
      ? headlineLossArr
          .map((o) => o.netR ?? 0)
          .reduce((s, v) => s + v, 0) / headlineLossArr.length
      : null;
  const headlinePayoffRatio =
    headlineAvgWinR !== null && headlineAvgLossR !== null && headlineAvgLossR < 0
      ? headlineAvgWinR / Math.abs(headlineAvgLossR)
      : null;

  // PnL
  const realizedPaperPnl = headlineClosedArr
    .map((o) => o.netPnlAmount)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .reduce((s, v) => s + v, 0);
  const diagnosticRealizedPaperPnl = diagnosticOnly
    .filter((o) => closedStatuses.includes(o.paperStatus))
    .map((o) => o.netPnlAmount)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .reduce((s, v) => s + v, 0);
  const totalRealizedPaperPnl = realizedPaperPnl + diagnosticRealizedPaperPnl;

  const today = new Date();
  const todayUtc = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
  const monthUtc = todayUtc.slice(0, 7);
  const monthHeadlinePaperPnl = headlineClosedArr
    .filter((o) => (o.updatedAt || "").slice(0, 7) === monthUtc)
    .reduce((sum, o) => sum + (o.netPnlAmount ?? 0), 0);
  const monthDiagnosticPaperPnl = diagnosticOnly
    .filter(
      (o) =>
        closedStatuses.includes(o.paperStatus) &&
        (o.updatedAt || "").slice(0, 7) === monthUtc,
    )
    .reduce((sum, o) => sum + (o.netPnlAmount ?? 0), 0);
  const monthTotalPaperPnl = monthHeadlinePaperPnl + monthDiagnosticPaperPnl;
  // Hoisted out of orderTaipeiDate: constructing a new Intl.DateTimeFormat is expensive
  // (ICU/locale setup), and this used to happen once PER ORDER (10k+ and growing) inside the
  // filter below — ~1.8s of /api/shadow/neural-map's ~9s response time (found 2026-07-06
  // profiling why the dashboard's 5s auto-refresh was consistently outrunning its own request).
  const taipeiFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const taipeiDate = taipeiFormatter.format(today);
  const orderTaipeiDate = (order: PaperOrder): string => taipeiFormatter.format(new Date(order.updatedAt));
  const taipeiDailyClosedOrders = orders.filter(
    (order) =>
      closedStatuses.includes(order.paperStatus) &&
      orderTaipeiDate(order) === taipeiDate,
  );
  const taipeiDailyHeadlineOrders = taipeiDailyClosedOrders.filter(
    (order) =>
      order.diagnosticLabel !== "BACKFILL_DIAGNOSTIC" &&
      order.paperOrderMode !== "DIAGNOSTIC_ONLY",
  );
  const taipeiDailyDiagnosticOrders = taipeiDailyClosedOrders.filter(
    (order) => order.paperOrderMode === "DIAGNOSTIC_ONLY",
  );
  const taipeiDailyHeadlinePnl = taipeiDailyHeadlineOrders.reduce(
    (sum, order) => sum + (order.netPnlAmount ?? 0),
    0,
  );
  const taipeiDailyDiagnosticPnl = taipeiDailyDiagnosticOrders.reduce(
    (sum, order) => sum + (order.netPnlAmount ?? 0),
    0,
  );
  const dailyPaperPnl = headlineClosedArr
    .filter((o) => (o.updatedAt || "").slice(0, 10) === todayUtc)
    .map((o) => o.netPnlAmount ?? 0)
    .reduce((s, v) => s + v, 0);

  // Lane / rotation
  const activeLane = opts.activeLaneId ?? state.activeLaneId ?? null;
  const laneConfidence = opts.laneConfidence ?? state.laneConfidence ?? "MEDIUM";
  const activeLaneMetrics = buildActiveLanePaperMetrics(orders, activeLane);
  const paperLaneConfidence = derivePaperLaneConfidence(
    activeLaneMetrics.closed,
    activeLaneMetrics.netAvgR,
    activeLaneMetrics.pf,
    activeLaneMetrics.wr,
    laneConfidence,
  );
  const rotationAction: RotationAction = opts.rotationResult?.action ?? "KEEP_CURRENT_LANE";
  const selectedNextLaneId = opts.rotationResult?.selectedNextLaneId ?? null;

  // Operational safety surface: BLOCKED only if explicitly passed or if a
  // recent order carries BLOCKED. Losses alone NEVER set BLOCKED.
  let operationalSafetyStatus: OperationalSafetyStatus = opts.operationalSafetyStatus ?? "OK";
  if (operationalSafetyStatus !== "BLOCKED") {
    const recent = orders.slice(-5);
    if (recent.some((o) => o.operationalSafetyStatus === "BLOCKED")) {
      operationalSafetyStatus = "BLOCKED";
    }
  }

  return {
    total: orders.length,
    open,
    closed,
    win,
    loss,
    noFill,
    expired,
    dataFailure,
    headlineTotal: headline.length,
    headlineClosed: headlineClosedArr.length,
    headlineWin: headlineWinArr.length,
    headlineLoss: headlineLossArr.length,
    diagnosticOnlyTotal: diagnosticOnly.length,
    diagnosticOnlyClosed,
    headlineNetAvgR,
    headlinePF,
    headlineWR,
    headlineAvgWinR,
    headlineAvgLossR,
    headlinePayoffRatio,
    paperEquity: PAPER_EQUITY,
    startingEquity: state.paperEquityStart,
    realizedPaperPnl,
    diagnosticRealizedPaperPnl,
    totalRealizedPaperPnl,
    monthHeadlinePaperPnl,
    monthDiagnosticPaperPnl,
    monthTotalPaperPnl,
    taipeiDailyClosed: taipeiDailyClosedOrders.length,
    taipeiDailyWins: taipeiDailyClosedOrders.filter(
      (order) => order.paperStatus === "PAPER_CLOSED_WIN",
    ).length,
    taipeiDailyLosses: taipeiDailyClosedOrders.filter(
      (order) => order.paperStatus === "PAPER_CLOSED_LOSS",
    ).length,
    taipeiDailyHeadlinePnl,
    taipeiDailyDiagnosticPnl,
    taipeiDailyTotalPnl: taipeiDailyHeadlinePnl + taipeiDailyDiagnosticPnl,
    dailyPaperPnl,
    rolling5: _rollingFromOrders(headlineClosedArr, 5),
    rolling10: _rollingFromOrders(headlineClosedArr, 10),
    rolling20: _rollingFromOrders(headlineClosedArr, 20),
    activeLane,
    laneConfidence,
    paperLaneConfidence,
    activeLaneClosed: activeLaneMetrics.closed,
    activeLaneNetAvgR: activeLaneMetrics.netAvgR,
    activeLanePF: activeLaneMetrics.pf,
    activeLaneWR: activeLaneMetrics.wr,
    rotationAction,
    selectedNextLaneId,
    operationalSafetyStatus,
    paperStartAt: state.paperStartAt,
    latestOrders: orders.slice(-3).reverse(),
    noOrderReason: opts.noOrderReason ?? null,
    currentBatchActiveLane: null,
    currentBatchOrderMode: null,
    currentBatchCreatedCount: 0,
    executionModel: opts.executionModel,
    subFloorExclusion,
    reportOnly: true,
    paperOnly: true,
  };
}

// ─── paper performance breakdown (Part 1 — root-cause diagnostics) ──────────

export interface PaperBreakdownRow {
  key: string;
  closed: number;
  win: number;
  loss: number;
  netSumR: number;
  netAvgR: number | null;
  wr: number | null;
}

export interface PaperLossContributor {
  symbol: string;
  direction: string;
  lane: string;
  closeReason: string | null;
  netR: number;
  stopDistanceBps: number;
  closedAt: string;
}

export interface PaperPerformanceBreakdown {
  /** Headline closed sample size the breakdown was computed over. */
  headlineClosed: number;
  byLane: PaperBreakdownRow[];
  bySymbol: PaperBreakdownRow[];
  bySourceType: PaperBreakdownRow[];
  byRegime: PaperBreakdownRow[];
  byControllerMode: PaperBreakdownRow[];
  byCloseReason: PaperBreakdownRow[];
  byStopBucket: PaperBreakdownRow[];
  worstSymbols: PaperBreakdownRow[];
  topLossContributors: PaperLossContributor[];
  latest10Closed: PaperOrder[];
  avgWinR: number | null;
  avgLossR: number | null;
  payoffRatio: number | null;
  /** T1-b: closed rows removed from every row above. See PaperPerformanceReport.subFloorExclusion. */
  subFloorExclusion: SubFloorExclusionSummary;
  reportOnly: true;
  paperOnly: true;
}

/**
 * Stop-distance bucket label shared by the performance breakdown, the
 * provenance audit, and the loser-fingerprint gate simulation. Buckets at the
 * 400bps boundary because the audit shows the 400-599bps band is 0-win.
 */
export function paperStopBucket(bps: number | null | undefined): string {
  if (typeof bps !== "number" || !Number.isFinite(bps)) return "unknown";
  if (bps < 200) return "<200bps";
  if (bps < 300) return "200-299bps";
  if (bps < 400) return "300-399bps";
  if (bps < 600) return "400-599bps";
  return ">=600bps";
}
/** True when the bucket label denotes a wide stop (>=400bps). */
export function isWideStopBucket(bucket: string): boolean {
  return bucket === "400-599bps" || bucket === ">=600bps";
}

/**
 * Large-cap base symbols. Everything else is treated as a high-beta alt for the
 * loser-fingerprint heuristics — the audit shows the toxic cluster (SEI/WLD/OP/
 * FET/INJ/NEAR) are high-beta alts shorted into a bearish regime, while the only
 * green cluster (BTC/ADA/BNB) are large-caps.
 */
const PAPER_LARGE_CAP_BASES: ReadonlySet<string> = new Set([
  "BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "DOGE", "TRX", "AVAX",
  "DOT", "LINK", "MATIC", "LTC", "BCH", "ATOM", "ETC", "XLM",
]);
/** Strip common quote suffixes to compare on the base asset. */
export function paperNormalizeSymbolBase(symbol: string): string {
  let s = (symbol || "").toUpperCase();
  for (const q of ["USDT", "USDC", "BUSD", "USD", "PERP"]) {
    if (s.endsWith(q) && s.length > q.length) {
      s = s.slice(0, -q.length);
      break;
    }
  }
  return s;
}
/** True when the symbol is NOT a large-cap (i.e. a high-beta alt). */
export function paperIsHighBetaAlt(symbol: string): boolean {
  return !PAPER_LARGE_CAP_BASES.has(paperNormalizeSymbolBase(symbol));
}
/** Case-insensitive "bearish regime" classifier. */
export function paperIsBearishRegime(regime: string | null | undefined): boolean {
  return typeof regime === "string" && /bear/i.test(regime);
}

function _rowsFromGroups(groups: Map<string, PaperOrder[]>): PaperBreakdownRow[] {
  const rows: PaperBreakdownRow[] = [];
  for (const [key, list] of groups.entries()) {
    const win = list.filter((o) => o.paperStatus === "PAPER_CLOSED_WIN").length;
    const loss = list.filter((o) => o.paperStatus === "PAPER_CLOSED_LOSS").length;
    const closed = win + loss;
    const netRs = list
      .map((o) => o.netR)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const netSumR = netRs.reduce((s, v) => s + v, 0);
    const netAvgR = netRs.length > 0 ? netSumR / netRs.length : null;
    const wr = closed > 0 ? win / closed : null;
    rows.push({ key, closed, win, loss, netSumR, netAvgR, wr });
  }
  return rows.sort((a, b) => b.closed - a.closed || a.key.localeCompare(b.key));
}

/**
 * Root-cause performance breakdown over HEADLINE closed paper orders. Pure
 * read of the store; never mutates. Excludes BACKFILL_DIAGNOSTIC and
 * DIAGNOSTIC_ONLY orders so the breakdown mirrors the headline profit metrics.
 */
export function buildPaperPerformanceBreakdown(
  store: PaperExecutionRouterStore,
  // T1-b. Default TRUE (report semantics). Same CLASSIFICATION CORRECTION as
  // buildPaperPerformanceReport: routes/shadow.ts (~:2772) derives `symbolsWithPositiveCohort`
  // from `bySymbol` — which OVERRIDES the SYMBOL_NET_NEGATIVE candidate gate — plus `worstSymbols`
  // and `topLossContributors` into AllocatorLaneState. That call site passes the decision gate.
  opts: { applySubFloorExclusion?: boolean } = {},
): PaperPerformanceBreakdown {
  const { rows: orders, exclusion: subFloorExclusion } = excludeSubFloorRowsForReport(
    store.all,
    opts.applySubFloorExclusion ?? true,
  );
  const closedStatuses: PaperOrderStatus[] = ["PAPER_CLOSED_WIN", "PAPER_CLOSED_LOSS"];
  const closed = orders.filter(
    (o) =>
      closedStatuses.includes(o.paperStatus) &&
      o.diagnosticLabel !== "BACKFILL_DIAGNOSTIC" &&
      o.paperOrderMode !== "DIAGNOSTIC_ONLY",
  );

  const group = (keyOf: (o: PaperOrder) => string): Map<string, PaperOrder[]> => {
    const m = new Map<string, PaperOrder[]>();
    for (const o of closed) {
      const k = keyOf(o);
      const arr = m.get(k);
      if (arr) arr.push(o);
      else m.set(k, [o]);
    }
    return m;
  };

  const bySymbol = _rowsFromGroups(group((o) => o.symbol));
  const byLane = _rowsFromGroups(group((o) => o.selectedLaneId));
  const bySourceType = _rowsFromGroups(group((o) => o.sourceType ?? "VARIANT_MATRIX_OBSERVATION"));
  const byRegime = _rowsFromGroups(group((o) => o.regime ?? "unknown"));
  const byControllerMode = _rowsFromGroups(group((o) => o.controllerMode ?? "unknown"));
  const byCloseReason = _rowsFromGroups(group((o) => o.closeReason ?? "unknown"));
  const byStopBucket = _rowsFromGroups(group((o) => paperStopBucket(o.plannedStopDistanceBps)));

  // Worst symbols by total net R (most negative first), tie-break by sample.
  const worstSymbols = bySymbol
    .slice()
    .sort((a, b) => a.netSumR - b.netSumR || b.closed - a.closed)
    .slice(0, 5);

  // Top loss contributors — individual closed losers ranked by magnitude.
  const topLossContributors: PaperLossContributor[] = closed
    .filter((o) => o.paperStatus === "PAPER_CLOSED_LOSS" && typeof o.netR === "number")
    .sort((a, b) => (a.netR ?? 0) - (b.netR ?? 0))
    .slice(0, 5)
    .map((o) => ({
      symbol: o.symbol,
      direction: o.direction,
      lane: o.selectedLaneId,
      closeReason: o.closeReason,
      netR: o.netR as number,
      stopDistanceBps: o.plannedStopDistanceBps,
      closedAt: o.updatedAt,
    }));

  const latest10Closed = closed
    .slice()
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 10);

  const winRs = closed
    .filter((o) => o.paperStatus === "PAPER_CLOSED_WIN")
    .map((o) => o.netR)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const lossRs = closed
    .filter((o) => o.paperStatus === "PAPER_CLOSED_LOSS")
    .map((o) => o.netR)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const avgWinR = winRs.length > 0 ? winRs.reduce((s, v) => s + v, 0) / winRs.length : null;
  const avgLossR = lossRs.length > 0 ? lossRs.reduce((s, v) => s + v, 0) / lossRs.length : null;
  const payoffRatio =
    avgWinR !== null && avgLossR !== null && avgLossR < 0 ? avgWinR / Math.abs(avgLossR) : null;

  return {
    headlineClosed: closed.length,
    byLane,
    bySymbol,
    bySourceType,
    byRegime,
    byControllerMode,
    byCloseReason,
    byStopBucket,
    worstSymbols,
    topLossContributors,
    latest10Closed,
    avgWinR,
    avgLossR,
    payoffRatio,
    subFloorExclusion,
    reportOnly: true,
    paperOnly: true,
  };
}

// ─── provenance audit + shadow loser-fingerprint gate (PROVENANCE V1) ────────

export interface PaperCountRow {
  key: string;
  count: number;
}

export interface ProvenanceLossRow {
  key: string;
  losses: number;
  netSumR: number;
}

export interface LoserFingerprint {
  fingerprint: string;
  losses: number;
  netSumR: number;
  avgNetR: number;
  example: { symbol: string; direction: string; regime: string | null };
}

/**
 * Provenance audit over HEADLINE closed paper orders. Reports coverage of the
 * persisted provenance, the most-missing fields, and loss distributions across
 * every provenance dimension plus the top loser fingerprints. Pure read of the
 * store; never mutates. Report-only.
 */
/**
 * Provenance-coverage for one closed-order scope (DIAGNOSTIC PROVENANCE V1).
 * `provenanceBlind` is true when there are closed orders but none carry
 * provenance — the legacy / blind state for that scope.
 */
export interface ProvenanceCoverageScope {
  closed: number;
  withProvenance: number;
  coveragePct: number;
  provenanceBlind: boolean;
}

export interface PaperProvenanceAudit {
  /** HEADLINE-scoped (legacy fields; unchanged so headline accounting stays clean). */
  closed: number;
  withProvenance: number;
  provenanceCoveragePct: number;
  /**
   * DIAGNOSTIC PROVENANCE V1 — separate coverage scopes so DIAGNOSTIC_ONLY
   * forensic collection is visible WITHOUT contaminating headline coverage.
   * `headlineProvenanceCoverage` mirrors the legacy top-level fields.
   */
  headlineProvenanceCoverage: ProvenanceCoverageScope;
  diagnosticProvenanceCoverage: ProvenanceCoverageScope;
  allPaperProvenanceCoverage: ProvenanceCoverageScope;
  missingProvenanceTop: PaperCountRow[];
  lossesByCalibrationVerdict: ProvenanceLossRow[];
  lossesByRouteMode: ProvenanceLossRow[];
  lossesBySourceConflict: ProvenanceLossRow[];
  lossesByChaseRisk: ProvenanceLossRow[];
  lossesByEntryDriftAtrBucket: ProvenanceLossRow[];
  lossesByStopBucket: ProvenanceLossRow[];
  lossesByRouteReasonCode: ProvenanceLossRow[];
  lossesBySymbol: ProvenanceLossRow[];
  lossesByRegime: ProvenanceLossRow[];
  lossesByDirection: ProvenanceLossRow[];
  topLoserFingerprints: LoserFingerprint[];
  /** True when every closed order predates PROVENANCE V1 (no candidate metadata available). */
  provenanceBlind: boolean;
  reportOnly: true;
  paperOnly: true;
}

/** HEADLINE closed orders (excludes BACKFILL_DIAGNOSTIC + DIAGNOSTIC_ONLY). */
function _closedHeadlineOrders(store: PaperExecutionRouterStore): PaperOrder[] {
  return store.all.filter(
    (o) =>
      (o.paperStatus === "PAPER_CLOSED_WIN" || o.paperStatus === "PAPER_CLOSED_LOSS") &&
      o.diagnosticLabel !== "BACKFILL_DIAGNOSTIC" &&
      o.paperOrderMode !== "DIAGNOSTIC_ONLY",
  );
}

/** DIAGNOSTIC_ONLY closed orders (forensic learning sample; never headline). */
function _closedDiagnosticOnlyOrders(store: PaperExecutionRouterStore): PaperOrder[] {
  return store.all.filter(
    (o) =>
      (o.paperStatus === "PAPER_CLOSED_WIN" || o.paperStatus === "PAPER_CLOSED_LOSS") &&
      o.diagnosticLabel !== "BACKFILL_DIAGNOSTIC" &&
      o.paperOrderMode === "DIAGNOSTIC_ONLY",
  );
}

/** ALL closed paper orders (HEADLINE + DIAGNOSTIC_ONLY; excludes BACKFILL). */
function _closedAllPaperOrders(store: PaperExecutionRouterStore): PaperOrder[] {
  return store.all.filter(
    (o) =>
      (o.paperStatus === "PAPER_CLOSED_WIN" || o.paperStatus === "PAPER_CLOSED_LOSS") &&
      o.diagnosticLabel !== "BACKFILL_DIAGNOSTIC",
  );
}

/** Provenance-coverage roll-up for a closed-order scope. */
function _coverageScope(orders: PaperOrder[]): ProvenanceCoverageScope {
  const withProvenance = orders.filter((o) => o.provenance != null).length;
  return {
    closed: orders.length,
    withProvenance,
    coveragePct: orders.length > 0 ? (withProvenance / orders.length) * 100 : 0,
    provenanceBlind: orders.length > 0 && withProvenance === 0,
  };
}

function _entryDriftAtrBucket(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "unknown";
  const a = Math.abs(v);
  if (a < 0.25) return "<0.25atr";
  if (a < 0.5) return "0.25-0.5atr";
  if (a < 1.0) return "0.5-1.0atr";
  return ">=1.0atr";
}

function _netR(o: PaperOrder): number {
  return typeof o.netR === "number" && Number.isFinite(o.netR) ? o.netR : 0;
}

function _lossRows(losers: PaperOrder[], keyOf: (o: PaperOrder) => string | null): ProvenanceLossRow[] {
  const m = new Map<string, { losses: number; net: number }>();
  for (const o of losers) {
    const k = keyOf(o) ?? "unknown";
    const e = m.get(k) ?? { losses: 0, net: 0 };
    e.losses += 1;
    e.net += _netR(o);
    m.set(k, e);
  }
  return [...m.entries()]
    .map(([key, e]) => ({ key, losses: e.losses, netSumR: e.net }))
    .sort((a, b) => a.netSumR - b.netSumR || b.losses - a.losses);
}

/** Multi-valued grouping (one loser can carry several route reason codes). */
function _lossRowsMulti(losers: PaperOrder[], keysOf: (o: PaperOrder) => string[]): ProvenanceLossRow[] {
  const m = new Map<string, { losses: number; net: number }>();
  for (const o of losers) {
    const keys = keysOf(o);
    const uniq = keys.length > 0 ? [...new Set(keys)] : ["none"];
    for (const k of uniq) {
      const e = m.get(k) ?? { losses: 0, net: 0 };
      e.losses += 1;
      e.net += _netR(o);
      m.set(k, e);
    }
  }
  return [...m.entries()]
    .map(([key, e]) => ({ key, losses: e.losses, netSumR: e.net }))
    .sort((a, b) => a.netSumR - b.netSumR || b.losses - a.losses);
}

function _fingerprintOf(o: PaperOrder): string {
  const p = o.provenance ?? null;
  const cv = p?.calibrationVerdict ?? "n/a";
  const cr = p?.chaseRisk ?? "n/a";
  const sc = p?.sourceConflict === true ? "Y" : p?.sourceConflict === false ? "N" : "n/a";
  const rm = p?.routeMode ?? "n/a";
  const sb = paperStopBucket(o.plannedStopDistanceBps);
  const alt = paperIsHighBetaAlt(o.symbol) ? "alt" : "lg";
  return `${o.direction}|${o.regime ?? "n/a"}|cv=${cv}|cr=${cr}|sc=${sc}|rm=${rm}|sb=${sb}|${alt}`;
}

export function buildPaperProvenanceAudit(store: PaperExecutionRouterStore): PaperProvenanceAudit {
  const closed = _closedHeadlineOrders(store);
  const losers = closed.filter((o) => o.paperStatus === "PAPER_CLOSED_LOSS");

  const withProvenance = closed.filter((o) => o.provenance != null).length;
  const provenanceCoveragePct = closed.length > 0 ? (withProvenance / closed.length) * 100 : 0;

  // DIAGNOSTIC PROVENANCE V1 — three separate coverage scopes. Headline mirrors
  // the legacy fields; diagnostic/allPaper expose forensic collection without
  // touching headline accounting (req #1, #6).
  const headlineProvenanceCoverage = _coverageScope(closed);
  const diagnosticProvenanceCoverage = _coverageScope(_closedDiagnosticOnlyOrders(store));
  const allPaperProvenanceCoverage = _coverageScope(_closedAllPaperOrders(store));

  // Missing-field tally: orders with no provenance object at all + named gaps.
  const missing = new Map<string, number>();
  for (const o of closed) {
    if (o.provenance == null) {
      missing.set("provenance(missing)", (missing.get("provenance(missing)") ?? 0) + 1);
      continue;
    }
    for (const f of o.provenanceFieldMissing ?? []) {
      missing.set(f, (missing.get(f) ?? 0) + 1);
    }
  }
  const missingProvenanceTop = [...missing.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, 8);

  // Top loser fingerprints.
  const fpMap = new Map<string, { losses: number; net: number; ex: PaperOrder }>();
  for (const o of losers) {
    const fp = _fingerprintOf(o);
    const e = fpMap.get(fp);
    if (e) {
      e.losses += 1;
      e.net += _netR(o);
    } else {
      fpMap.set(fp, { losses: 1, net: _netR(o), ex: o });
    }
  }
  const topLoserFingerprints: LoserFingerprint[] = [...fpMap.entries()]
    .map(([fingerprint, e]) => ({
      fingerprint,
      losses: e.losses,
      netSumR: e.net,
      avgNetR: e.losses > 0 ? e.net / e.losses : 0,
      example: { symbol: e.ex.symbol, direction: e.ex.direction, regime: e.ex.regime },
    }))
    .sort((a, b) => a.netSumR - b.netSumR || b.losses - a.losses)
    .slice(0, 10);

  return {
    closed: closed.length,
    withProvenance,
    provenanceCoveragePct,
    headlineProvenanceCoverage,
    diagnosticProvenanceCoverage,
    allPaperProvenanceCoverage,
    missingProvenanceTop,
    provenanceBlind: closed.length > 0 && withProvenance === 0,
    lossesByCalibrationVerdict: _lossRows(losers, (o) => o.provenance?.calibrationVerdict ?? "no-provenance"),
    lossesByRouteMode: _lossRows(losers, (o) => o.provenance?.routeMode ?? "no-provenance"),
    lossesBySourceConflict: _lossRows(losers, (o) => {
      const v = o.provenance?.sourceConflict;
      return v === true ? "sourceConflict=true" : v === false ? "sourceConflict=false" : "no-provenance";
    }),
    lossesByChaseRisk: _lossRows(losers, (o) => o.provenance?.chaseRisk ?? "no-provenance"),
    lossesByEntryDriftAtrBucket: _lossRows(losers, (o) => _entryDriftAtrBucket(o.provenance?.entryDriftAtr)),
    lossesByStopBucket: _lossRows(losers, (o) => paperStopBucket(o.plannedStopDistanceBps)),
    lossesByRouteReasonCode: _lossRowsMulti(losers, (o) => o.provenance?.routeReasonCodes ?? []),
    lossesBySymbol: _lossRows(losers, (o) => o.symbol),
    lossesByRegime: _lossRows(losers, (o) => o.regime ?? "unknown"),
    lossesByDirection: _lossRows(losers, (o) => o.direction),
    topLoserFingerprints,
    reportOnly: true,
    paperOnly: true,
  };
}

// ─── shadow loser-fingerprint gate simulation (report-only; never blocks) ────

export type ShadowGateRecommendation =
  | "WATCH"
  | "PROMISING"
  /** PROMISING criteria met, but provenance coverage <50% — predictions are unreliable. */
  | "PROMISING_BUT_PROVENANCE_BLIND"
  | "DO_NOT_ACTIVATE"
  | "READY_FOR_ACTIVE_GATE";

export interface ShadowGateResult {
  gateId: string;
  description: string;
  /** Closed orders the gate could assess (provenance present where required). */
  evaluable: number;
  tradesRemoved: number;
  lossesAvoided: number;
  winsSacrificed: number;
  /** Net-R the book would gain by removing the matched trades (= −removedNetSumR). */
  netRImprovement: number;
  removedNetSumR: number;
  remainingClosed: number;
  remainingWR: number | null;
  remainingPF: number | null;
  remainingNetAvgR: number | null;
  /** Forgone winning R (sum of netR of removed winners; ≥0). */
  falsePositiveCostR: number;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  recommendation: ShadowGateRecommendation;
}

/** Which closed-order sample the shadow gate simulation replayed. */
export type ShadowGateSampleScope = "HEADLINE_ONLY" | "DIAGNOSTIC_ONLY" | "ALL_PAPER";

export interface ShadowLoserFingerprintGateReport {
  /** This simulation NEVER activates a gate. */
  active: false;
  activeGateChange: "NO";
  /** The closed-order scope this simulation replayed. */
  scope: ShadowGateSampleScope;
  closedSample: number;
  baselineWR: number | null;
  baselinePF: number | null;
  baselineNetAvgR: number | null;
  gates: ShadowGateResult[];
  /** Best non-DO_NOT_ACTIVATE gate by net-R improvement; null when none qualify. */
  best: ShadowGateResult | null;
  /**
   * Warning emitted when provenance coverage of the closed sample is <50%.
   * Provenance-dependent gates can only assess orders that have provenance;
   * low coverage means their predictions are unreliable.
   */
  provenanceCoverageWarning: string | null;
  reportOnly: true;
  paperOnly: true;
}

function _wrOf(orders: PaperOrder[]): number | null {
  if (orders.length === 0) return null;
  const win = orders.filter((o) => o.paperStatus === "PAPER_CLOSED_WIN").length;
  return win / orders.length;
}
function _netAvgOf(orders: PaperOrder[]): number | null {
  if (orders.length === 0) return null;
  return orders.reduce((s, o) => s + _netR(o), 0) / orders.length;
}
function _pfOf(orders: PaperOrder[]): number | null {
  let gain = 0;
  let loss = 0;
  for (const o of orders) {
    const r = _netR(o);
    if (r >= 0) gain += r;
    else loss += -r;
  }
  if (loss === 0) return gain > 0 ? Infinity : null;
  return gain / loss;
}

interface GateDef {
  gateId: string;
  description: string;
  /** Requires provenance to assess (legacy orders without it can't match). */
  needsProvenance: boolean;
  predicate: (o: PaperOrder) => boolean;
}

/**
 * Report-only loser-fingerprint gate simulation. For each hypothetical gate it
 * replays the closed HEADLINE sample, computes what the book WOULD look like if
 * the matched trades had been blocked, and emits a non-binding recommendation.
 *
 * IT NEVER BLOCKS ADMISSION OR ACTIVATES ANY GATE — `active:false`,
 * `activeGateChange:"NO"`. Pure read of the store.
 */
export function simulateLoserFingerprintGate(
  store: PaperExecutionRouterStore,
  opts: { scope?: ShadowGateSampleScope } = {},
): ShadowLoserFingerprintGateReport {
  const scope: ShadowGateSampleScope = opts.scope ?? "HEADLINE_ONLY";
  const closed =
    scope === "DIAGNOSTIC_ONLY"
      ? _closedDiagnosticOnlyOrders(store)
      : scope === "ALL_PAPER"
        ? _closedAllPaperOrders(store)
        : _closedHeadlineOrders(store);

  // Per-symbol net-avg over the closed sample (for the symbol-toxicity gate).
  const symStats = new Map<string, { closed: number; net: number }>();
  for (const o of closed) {
    const e = symStats.get(o.symbol) ?? { closed: 0, net: 0 };
    e.closed += 1;
    e.net += _netR(o);
    symStats.set(o.symbol, e);
  }
  const toxicSymbols = new Set<string>();
  for (const [sym, e] of symStats.entries()) {
    if (e.closed >= 3 && e.net / e.closed < -0.5) toxicSymbols.add(sym);
  }

  const isWide = (o: PaperOrder): boolean => isWideStopBucket(paperStopBucket(o.plannedStopDistanceBps));

  const gateDefs: GateDef[] = [
    {
      gateId: "HIGH_BETA_BEARISH_SHORT_WIDE",
      description: "block SHORT in bearish regime when high-beta alt and wide stop >=400bps",
      needsProvenance: false,
      predicate: (o) =>
        o.direction === "SHORT" &&
        paperIsBearishRegime(o.regime) &&
        paperIsHighBetaAlt(o.symbol) &&
        isWide(o),
    },
    {
      gateId: "SYMBOL_NET_NEGATIVE",
      description: "block routeReasonCode SYMBOL_NET_NEGATIVE",
      needsProvenance: true,
      predicate: (o) => (o.provenance?.routeReasonCodes ?? []).includes("SYMBOL_NET_NEGATIVE"),
    },
    {
      gateId: "ALL_REPLAY_VARIANTS_NEGATIVE",
      description: "block routeReasonCode ALL_REPLAY_VARIANTS_NEGATIVE",
      needsProvenance: true,
      predicate: (o) => (o.provenance?.routeReasonCodes ?? []).includes("ALL_REPLAY_VARIANTS_NEGATIVE"),
    },
    {
      gateId: "RAW_EDGE_NOT_VALIDATED",
      description: "block calibrationVerdict RAW_EDGE_NOT_VALIDATED",
      needsProvenance: true,
      predicate: (o) => o.provenance?.calibrationVerdict === "RAW_EDGE_NOT_VALIDATED",
    },
    {
      gateId: "CHASE_RISK_HIGH",
      description: "block chaseRisk=HIGH",
      needsProvenance: true,
      predicate: (o) => o.provenance?.chaseRisk === "HIGH",
    },
    {
      gateId: "SOURCE_CONFLICT",
      description: "block sourceConflict=true",
      needsProvenance: true,
      predicate: (o) => o.provenance?.sourceConflict === true,
    },
    {
      gateId: "CALIBRATED_NET_NON_POSITIVE",
      description: "block calibratedExpectedNetR <= 0",
      needsProvenance: true,
      predicate: (o) => {
        const v = o.provenance?.calibratedExpectedNetR;
        return typeof v === "number" && Number.isFinite(v) && v <= 0;
      },
    },
    {
      gateId: "ROUTE_DATA_COLLECTION",
      description: "block routeMode=DATA_COLLECTION unless diagnostic-only",
      needsProvenance: true,
      predicate: (o) => o.provenance?.routeMode === "DATA_COLLECTION" && o.paperOrderMode !== "DIAGNOSTIC_ONLY",
    },
    {
      gateId: "WIDE_STOP_GE_400_CG_WIDE",
      description: "block stopBucket >=400bps for the CG_WIDE allocator lane",
      needsProvenance: false,
      predicate: (o) => isWide(o) && o.selectedLaneId.includes("CG_WIDE"),
    },
    {
      gateId: "SYMBOL_NET_AVG_TOXIC",
      description: "block symbols with paper netAvgR < -0.5R and closed >=3",
      needsProvenance: false,
      predicate: (o) => toxicSymbols.has(o.symbol),
    },
  ];

  const baseClosed = closed.length;

  // Provenance coverage of the closed sample.  Provenance-dependent gates can
  // only assess orders that carry provenance metadata; when coverage is <50%
  // their recommendations are unreliable and must be downgraded.
  const withProvenanceCount = closed.filter((o) => o.provenance != null).length;
  const provCoverageRatio = baseClosed > 0 ? withProvenanceCount / baseClosed : 0;
  const provBlind = baseClosed > 0 && provCoverageRatio < 0.5;
  const provenanceCoverageWarning: string | null = provBlind
    ? `provenanceCoverage=${(provCoverageRatio * 100).toFixed(1)}% (<50%) — provenance-dependent gate predictions unreliable; legacy orders lack candidate metadata`
    : null;

  const evalResult = (g: GateDef): ShadowGateResult => {
    const evaluable = g.needsProvenance ? withProvenanceCount : baseClosed;
    const removed = closed.filter((o) => g.predicate(o));
    const kept = closed.filter((o) => !g.predicate(o));
    const lossesAvoided = removed.filter((o) => o.paperStatus === "PAPER_CLOSED_LOSS").length;
    const winsSacrificed = removed.filter((o) => o.paperStatus === "PAPER_CLOSED_WIN").length;
    const removedNetSumR = removed.reduce((s, o) => s + _netR(o), 0);
    const netRImprovement = -removedNetSumR;
    const falsePositiveCostR = removed
      .filter((o) => o.paperStatus === "PAPER_CLOSED_WIN")
      .reduce((s, o) => s + _netR(o), 0);

    // Confidence by sample size and match count.
    let confidence: "LOW" | "MEDIUM" | "HIGH" = "LOW";
    if (baseClosed >= 20 && removed.length >= 3) confidence = "MEDIUM";
    if (baseClosed >= 40 && removed.length >= 8) confidence = "HIGH";

    // Non-binding recommendation.
    let recommendation: ShadowGateRecommendation;
    if (removed.length === 0) {
      recommendation = "WATCH";
    } else if (netRImprovement <= 0) {
      recommendation = "DO_NOT_ACTIVATE";
    } else if (confidence === "LOW") {
      recommendation = "WATCH";
    } else if (winsSacrificed === 0 && confidence === "HIGH") {
      recommendation = "READY_FOR_ACTIVE_GATE";
    } else {
      recommendation = "PROMISING";
    }

    // Downgrade ALL gates when overall provenance coverage is too low to trust.
    // Even gates that don't read provenance fields are evaluated against a sample
    // we can't fully attribute, so the headline recommendation (best.recommendation)
    // must never read PROMISING/READY while provenanceCoverage<50%. This guarantees
    // Section 10 stays consistent with the provenanceCoverage warning.
    if (
      provBlind &&
      (recommendation === "PROMISING" || recommendation === "READY_FOR_ACTIVE_GATE")
    ) {
      recommendation = "PROMISING_BUT_PROVENANCE_BLIND";
    }

    return {
      gateId: g.gateId,
      description: g.description,
      evaluable,
      tradesRemoved: removed.length,
      lossesAvoided,
      winsSacrificed,
      netRImprovement,
      removedNetSumR,
      remainingClosed: kept.length,
      remainingWR: _wrOf(kept),
      remainingPF: _pfOf(kept),
      remainingNetAvgR: _netAvgOf(kept),
      falsePositiveCostR,
      confidence,
      recommendation,
    };
  };

  const gates = gateDefs.map(evalResult);
  const best =
    gates
      .filter((r) => r.recommendation !== "DO_NOT_ACTIVATE" && r.tradesRemoved > 0)
      .sort((a, b) => b.netRImprovement - a.netRImprovement || a.winsSacrificed - b.winsSacrificed)[0] ?? null;

  return {
    active: false,
    activeGateChange: "NO",
    scope,
    closedSample: baseClosed,
    baselineWR: _wrOf(closed),
    baselinePF: _pfOf(closed),
    baselineNetAvgR: _netAvgOf(closed),
    gates,
    best,
    provenanceCoverageWarning,
    reportOnly: true,
    paperOnly: true,
  };
}

// ─── latency diagnostics (E2E corridor — REPORT-ONLY, rules DISABLED) ────────
//
// Measures the end-to-end paper pipeline latency so the operator can see how
// long each stage takes (scan → candidate → admission → resolve). The rules
// corridor is PREPARED but NOT enforced: staleSkipped is always 0 and
// latencyBlocker is advisory only. Nothing here ever skips an admission,
// activates a gate, changes risk, or touches live trading. The thresholds and
// the rulesEnabled flag exist so enforcement can be switched on later by wiring
// the ruleEvals into admission — this builder only MEASURES and REPORTS.
//
// The report is split into TWO blocks so current-cycle latency is never conflated
// with the age of a long-lived open-order backlog (an open position can sit for
// hours waiting on TP/SL — that age is NOT this scan cycle's latency):
//
// BLOCK A — CURRENT CYCLE LATENCY (only meaningful for THIS cycle's admission):
//  - scanAgeSec               now − cached scan generatedAt        (scan-cycle freshness)
//  - candidateAgeSec          now − freshest candidate 5m candle OPEN (candidate price-data freshness)
//  - scanToAdmissionDelaySec  this-cycle order createdAt − openedAt (scan → admission)
//  - priceAgeSec              this-cycle order: now − openedAt; else candidateAgeSec (new candidate)
//  - createdThisCycle         headline+diagnostic admissions created this cycle
//    → when createdThisCycle==0 the admission metrics are n/a (sampleSource=NO_NEW_ADMISSION);
//      an OLD open order is NEVER used as a current-cycle sample.
//
// BLOCK B — OPEN ORDER / RESOLVER BACKLOG (age of still-unresolved orders, all cycles):
//  - openOrderCount           non-terminal orders still awaiting resolution
//  - oldestOpenAgeSec         max(now − openedAt) over open orders (source-observation age)
//  - p90OpenAgeSec            p90 of (now − openedAt) over open orders
//  - resolverBacklogAgeSec    max(now − createdAt) over open orders (oldest elapsed-since-admission)
//  - unresolvedTooLongCount   open orders whose elapsed-since-admission exceeds the SLA
//    → sampleSource=OPEN_ORDER_BACKLOG when openOrderCount>0, else NONE.
//
// BLOCK C — LABEL LEAK (createdAt vs openedAt; closed cohort, all cycles):
//  openedAt is the OBSERVATION instant (entryPrice belongs to it); createdAt is the
//  DECISION instant (regime/controllerMode/routerPermission/provenance belong to IT).
//  openedAt PRECEDES createdAt — 29,968/29,968 testnet rows positive on 2026-07-26,
//  closed-cohort p50 +213.9s / p90 +394.2s / max +586.6s. The resolver anchors its walk
//  on openedAt (:startTime = openedAtMs − CANDLE_MS) and its loop admits the WHOLE 5m bar
//  containing openedAtMs, so up to 300s + (createdAt − openedAt) of price action can
//  decide an outcome before the label exists. Measured, not hypothetical: on 6,229 closed
//  testnet rows carrying closedAtMs, 114 had closedAtMs < createdAt and a further 197 had an
//  exit bar STRADDLING createdAt (opened before it, closed after) — 311 possibly-leaked, 5.0%,
//  not the 1.8% the strict counter alone implies. The win skew holds in both buckets (86 of the
//  114 TP1_HIT; 119/197 = 60% wins in the straddling bucket), i.e. fast-TP contamination.
//  - labelLeakP50/P90/MaxSec         RAW SIGNED (createdAt − openedAt) over closed orders
//  - resolvedBeforeDecisionCount     exit BAR closed before createdAt — STRICT LOWER BOUND
//  - exitBarStraddlesDecisionCount   exit bar opened before / closed after createdAt (unknowable
//                                    at 5m); possiblyLeaked = the two summed
//  - preDecisionResolvableSecUpperBoundAtP50   labelLeakP50Sec + CANDLE_MS/1000. An UPPER bound
//                                    at the p50 delay, NOT a percentile of exposure: the 300s
//                                    term is one WHOLE candle (median reach is ~150s).
//    → labelLeakSampleSource      provenance of the PERCENTILE sample
//    → labelLeakExitTsSampleSource provenance of the two COUNTERS (different denominator: rows
//      carrying closedAtMs). NONE means UNMEASURED, never "clean".
//
//  WHY THIS ONLY REPORTS. Re-anchoring the walk to createdAt without also re-deriving
//  entryPrice at createdAt would simulate a fill that never existed (the price is the one
//  observed at openedAt), i.e. it would make the number MORE wrong. A correct semantic fix
//  needs 1m data this resolver does not fetch on that path, and would split the store into
//  two incomparable cohorts that laneEconomics / variant quarantine / per-symbol-lane-book-
//  edge / meta-label-gate / CORTEX all pool without a version discriminator — on testnet
//  (CENTRAL_BRAIN_MODE=live) that arrives as an allocation shift indistinguishable from a
//  genuine edge change. Both timestamps are already persisted, so measurement costs nothing.
//
// Candidate data age anchors on the candle OPEN time (always ≥ 0): the most
// recent 5m candle is typically still forming, so its close lies in the future
// — using the open is the honest "how old is the price-bearing candle" age.

export type PaperLatencyProfile = "PAPER" | "LIVE_MICRO_PILOT";

export interface PaperLatencyThresholds {
  profile: PaperLatencyProfile;
  /** Scan-cycle max age before a HEADLINE order is suppressed. null = not enforced. */
  scanMaxAgeSec: number | null;
  /** Candidate market-data max age before the candidate is skipped. null = not enforced. */
  candidateMaxAgeSec: number | null;
  /** Admission-price max age before the candidate is skipped. null = not enforced. */
  priceMaxAgeSec: number | null;
  /** Scan → admission max delay. null = not enforced. */
  admissionMaxDelaySec: number | null;
}

/**
 * ACTIVE paper profile. Per operator: paper candidate/scan max age = 10 min.
 * Price/admission corridors are intentionally OPEN for paper (E2E measurement
 * phase) — they are populated only in the future live/micro-pilot profile.
 */
export const PAPER_LATENCY_THRESHOLDS: PaperLatencyThresholds = {
  profile: "PAPER",
  scanMaxAgeSec: 600,
  candidateMaxAgeSec: 600,
  priceMaxAgeSec: null,
  admissionMaxDelaySec: null,
};

/**
 * FUTURE live/micro-pilot profile — DOCUMENTED ONLY, never active here. Values
 * are illustrative upper bounds of the operator's stated corridor (candidate
 * 30–90 s, price 5–15 s, admission 5–10 s); tighten per strategy timeframe when
 * the corridor is switched on. Surfaced in the brief so the target is visible.
 */
export const LIVE_MICRO_PILOT_LATENCY_THRESHOLDS_FUTURE: PaperLatencyThresholds = {
  profile: "LIVE_MICRO_PILOT",
  scanMaxAgeSec: 120,
  candidateMaxAgeSec: 90,
  priceMaxAgeSec: 15,
  admissionMaxDelaySec: 10,
};

/**
 * MASTER SWITCH. While false the latency corridor is MEASUREMENT-ONLY: no rule
 * ever skips an admission, staleSkipped stays 0, and latencyBlocker is advisory.
 * Flipping this to true (or PAPER_LATENCY_RULES_ENABLED=1) only un-prefixes the
 * advisory label — actual enforcement must additionally be wired into admission.
 */
export const PAPER_LATENCY_RULES_ENABLED = false;

export type PaperLatencyRule =
  | "SCAN_TOO_OLD_NO_HEADLINE"
  | "CANDIDATE_TOO_OLD_SKIP"
  | "PRICE_TOO_STALE_SKIP"
  | "ADMISSION_DELAY_EXCEEDED";

export interface PaperLatencyRuleEval {
  rule: PaperLatencyRule;
  metricSec: number | null;
  thresholdSec: number | null;
  /** True iff the metric exceeds the threshold (both finite). Advisory while rules disabled. */
  wouldTrip: boolean;
}

/**
 * Block A (current-cycle admission) sample provenance:
 *  - ORDER_AND_SCAN / ORDER_ONLY — a fresh admission was created THIS cycle (with/without a cached scan).
 *  - NO_NEW_ADMISSION — nothing was admitted this cycle; admission metrics are n/a (an old open
 *    order is NEVER promoted into the current-cycle sample — its age belongs to Block B).
 */
export type PaperLatencySampleSource = "ORDER_AND_SCAN" | "ORDER_ONLY" | "NO_NEW_ADMISSION";

/** Block B (open-order backlog) sample provenance. */
export type PaperBacklogSampleSource = "OPEN_ORDER_BACKLOG" | "NONE";

/**
 * Block C (label-leak cohort) sample provenance. NONE means "no closed orders were
 * supplied", which is NOT the same as "no leak" — without this the caller cannot tell
 * a clean book from an unmeasured one.
 */
export type PaperLabelLeakSampleSource = "CLOSED_ORDER_COHORT" | "NONE";

export interface PaperLatencyDiagnostics {
  reportOnly: true;
  /** false = corridor measurement-only (no skips). */
  rulesEnabled: boolean;
  // ── BLOCK A — CURRENT CYCLE LATENCY ──
  scanAgeSec: number | null;
  candidateAgeSec: number | null;
  /** This-cycle admission only: createdAt − openedAt. null when createdThisCycle==0. */
  scanToAdmissionDelaySec: number | null;
  /** This-cycle admission price age (now − openedAt); falls back to candidateAgeSec when no new admission. */
  priceAgeSec: number | null;
  /** Headline+diagnostic admissions created this cycle. 0 ⇒ admission metrics are n/a. */
  createdThisCycle: number;
  /** Block A provenance. NO_NEW_ADMISSION when createdThisCycle==0. */
  sampleSource: PaperLatencySampleSource;
  // ── BLOCK B — OPEN ORDER / RESOLVER BACKLOG ──
  /** Non-terminal orders still awaiting resolution. */
  openOrderCount: number;
  /** max(now − openedAt) over open orders (source-observation age), or null. */
  oldestOpenAgeSec: number | null;
  /** p90 of (now − openedAt) over open orders, or null. */
  p90OpenAgeSec: number | null;
  /** max(now − createdAt) over open orders (oldest elapsed-since-admission), or null. */
  resolverBacklogAgeSec: number | null;
  /** Open orders whose elapsed-since-admission exceeds the resolver SLA threshold. */
  unresolvedTooLongCount: number;
  /** Block B provenance. OPEN_ORDER_BACKLOG when openOrderCount>0, else NONE. */
  backlogSampleSource: PaperBacklogSampleSource;
  // ── hold-time labeling (report-only — NEVER force-closes) ──
  /** Hold-time profile of the dominant open lane (e.g. SWING_WIDE). */
  holdProfile: string;
  /** Oldest open hold (now − openedAt), seconds. Mirrors oldestOpenAgeSec, named in hold terms. */
  oldestOpenHoldSec: number | null;
  /** p90 of open holds (now − openedAt), seconds. */
  p90OpenHoldSec: number | null;
  /** Empirical p50/p90 hold of CLOSED orders (sec) — the lane's "normal" resolution time. */
  expectedHoldP50Sec: number | null;
  expectedHoldP90Sec: number | null;
  /** Report-only open-hold buckets. NONE force a close — labels only. */
  openHoldBuckets: {
    /** 0–30h */ normalWideHold: number;
    /** 30–42h */ extendedHoldWatch: number;
    /** 42–72h */ staleWideHold: number;
    /** 72h–7d */ reviewRequired: number;
    /** >7d */ expiredBySla: number;
  };
  /** Open orders in a status the resolver never processes (PAPER_FILLED/PARTIAL) — latent stuck. */
  resolverUnprocessableOpenCount: number;
  // ── BLOCK C — LABEL LEAK (createdAt vs openedAt) — REPORT-ONLY ──
  /** Closed (WIN/LOSS) orders in the supplied cohort with parseable timestamps. */
  labelLeakClosedSampleCount: number;
  /** p50 of the RAW SIGNED (createdAt − openedAt) over the closed cohort, sec. null = no sample. */
  labelLeakP50Sec: number | null;
  /** p90 of the same signed quantity, sec. */
  labelLeakP90Sec: number | null;
  /** max of the same signed quantity, sec. */
  labelLeakMaxSec: number | null;
  /**
   * THE LOAD-BEARING COUNTER, and a STRICT LOWER BOUND — never the full magnitude.
   * Closed orders whose exit BAR closed strictly before their own createdAt, i.e. the outcome
   * was decided by price action that had entirely finished when the label was written.
   * Counted only over rows carrying closedAtMs (market ts, not process ts), so
   * labelLeakClosedWithExitTsCount is its honest denominator.
   *
   * Why a LOWER bound: closedAtMs is the exit bar's CLOSE (openMs + CANDLE_MS). A bar that
   * OPENED before createdAt and closed after it is NOT counted here even though the SL/TP touch
   * inside it may well have occurred pre-decision — at 5m granularity that is unknowable. The
   * median admission delay (~214s) is smaller than one candle (300s), so that straddling
   * population is LARGE. See exitBarStraddlesDecisionCount for it; the possibly-leaked total is
   * `resolvedBeforeDecisionCount + exitBarStraddlesDecisionCount`. Measured on the testnet store
   * 2026-07-26 (6,229 closed rows with closedAtMs): 114 counted + 197 straddling = 311 (5.0%),
   * vs 1.8% if only this counter is read — a 2.7x understatement. The win skew persists in the
   * straddling bucket (119/197 = 60% wins, 109 TP1_HIT), so it is the same fast-TP
   * contamination, not noise.
   */
  resolvedBeforeDecisionCount: number;
  /**
   * Closed orders whose exit bar STRADDLES createdAt: the bar opened strictly before the label
   * existed but closed at/after it (`exitMs − CANDLE_MS < createdMs <= exitMs`). Possibly leaked,
   * not provably leaked. Reported separately so the two are never conflated, and so a
   * quarantine decision can choose its own bound instead of inheriting the optimistic one.
   */
  exitBarStraddlesDecisionCount: number;
  /** Denominator for both counters above: closed rows that carry a finite closedAtMs. */
  labelLeakClosedWithExitTsCount: number;
  /**
   * UPPER BOUND on the width of the window of price action resolvable before the decision
   * exists, evaluated at the p50 admission delay: p50(createdAt − openedAt) + CANDLE_MS/1000.
   *
   * NOT a percentile of the exposure itself — deliberately named accordingly. The CANDLE_MS term
   * is the MAXIMUM pre-openedAt reach of the first admissible bar, not its median: the walk
   * condition (`openMs < openedAtMs − CANDLE_MS` → continue) admits exactly the one bar
   * containing openedAtMs, whose open lies uniformly in (openedAtMs − 300, openedAtMs], so the
   * MEDIAN contribution is ~150s. Reading this as a median overstates typical exposure by ~150s.
   * null when there is no sample.
   */
  preDecisionResolvableSecUpperBoundAtP50: number | null;
  /** Block C provenance for the PERCENTILE sample (labelLeak*Sec). NONE ⇒ unmeasured, NOT "clean". */
  labelLeakSampleSource: PaperLabelLeakSampleSource;
  /**
   * Provenance for the two exit-bar COUNTERS specifically. Distinct from labelLeakSampleSource
   * because they have a different denominator: a cohort of legacy rows that predate the Track-1a
   * closedAtMs field (added 2026-07-13) yields a full percentile sample but a ZERO counter
   * denominator, and would otherwise report "measured" for something unmeasurable. 139 of the
   * 6,368 closed rows on testnet 2026-07-26 carry no closedAtMs.
   */
  labelLeakExitTsSampleSource: PaperLabelLeakSampleSource;
  // ── meta / advisory corridor ──
  /** Admissions skipped by latency rules. ALWAYS 0 while rulesEnabled=false / enforcement unwired. */
  staleSkipped: number;
  /** Advisory only — worst tripped rule (ADVISORY-prefixed while disabled), or null. Never causes a skip here. */
  latencyBlocker: string | null;
  thresholds: PaperLatencyThresholds;
  futureThresholds: PaperLatencyThresholds;
  ruleEvals: PaperLatencyRuleEval[];
}

export interface PaperLatencyInputs {
  /** Brief/paper-run time (ISO). */
  now: string;
  /** Cached scan generatedAt (ISO), or null when no scan is cached. */
  scanFinishedAt: string | null;
  /**
   * Epoch ms of the freshest candidate's price-data candle OPEN time
   * (fiveMinute.lastOpenTime). The candle open is the data-age anchor — the
   * latest 5m candle is usually still forming, so its close is in the future.
   * null if unavailable.
   */
  freshestCandidatePriceObservationMs: number | null;
  /**
   * Most-recent orders newest-first (report.latestOrders). [0] is the current-cycle
   * admission sample ONLY when createdThisCycle>0 (admission appends, so the newest
   * is the freshest this-cycle order). Old open orders here are ignored for Block A.
   */
  latestOrders: PaperOrder[];
  /**
   * ALL paper orders (or at least all OPEN ones) for the Block B backlog. Open =
   * not in CLOSED_OR_TERMINAL_STATUSES; the builder filters internally. Defaults to [].
   */
  openOrders?: PaperOrder[];
  /**
   * Headline+diagnostic admissions created THIS cycle. 0 ⇒ Block A admission metrics
   * are n/a (sampleSource=NO_NEW_ADMISSION). Defaults to 0.
   */
  createdThisCycle?: number;
  /**
   * Open-order elapsed-since-admission age (sec) above which it counts as resolver-
   * backlogged. Defaults to the order-expiry SLA (PAPER_ORDER_EXPIRY_MS).
   */
  unresolvedMaxAgeSec?: number;
  /**
   * Hold-times (sec) of CLOSED orders (updatedAt − openedAt), for the lane's empirical
   * expectedHold p50/p90. Defaults to []. Lets the backlog labels reference "normal".
   */
  closedHoldSamplesSec?: number[];
  /**
   * CLOSED (WIN/LOSS) orders for the Block C label-leak cohort. The builder re-filters by
   * status internally, so passing the whole store is safe. Defaults to [] — and an empty
   * cohort reports labelLeakSampleSource=NONE rather than a fabricated "zero leak".
   *
   * Deliberately a SEPARATE input from openOrders: openOrders is documented as "all orders
   * OR at least all open ones", so deriving the closed cohort from it would silently report
   * NONE for any caller that pre-filtered.
   */
  closedOrders?: PaperOrder[];
  thresholds?: PaperLatencyThresholds;
  futureThresholds?: PaperLatencyThresholds;
  /** Defaults to PAPER_LATENCY_RULES_ENABLED (false). When false, latencyBlocker is ADVISORY-prefixed. */
  rulesEnabled?: boolean;
}

function _latencySec(fromMs: number, toMs: number): number | null {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  const sec = (toMs - fromMs) / 1000;
  // Clamp tiny negatives (clock skew) to 0; preserve large negatives as null (bad data).
  if (sec < -1) return null;
  return Math.round(Math.max(0, sec) * 10) / 10;
}

/**
 * RAW SIGNED admission delay (createdAt − openedAt) in seconds, or null when either
 * timestamp is unparseable. The SINGLE source of this quantity — _admissionDelayBucket
 * and the label-leak cohort both read it, so the two can never drift apart.
 *
 * Deliberately NOT _latencySec: that helper nulls large negatives and clamps small ones
 * to 0, which would erase exactly the sign this diagnostic exists to prove. A negative
 * here is a real finding (it would mean the decision predates its own observation), so
 * it is preserved verbatim.
 */
function _admissionDelaySec(order: PaperOrder): number | null {
  const created = new Date(order.createdAt).getTime();
  const opened = new Date(order.openedAt).getTime();
  if (!Number.isFinite(created) || !Number.isFinite(opened)) return null;
  return (created - opened) / 1000;
}

/** Nearest-rank percentile (p in [0,1]) of a numeric sample. null for an empty sample. */
function _percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}
function _p90(values: number[]): number | null {
  return _percentile(values, 0.9);
}

const CLOSED_OR_TERMINAL_STATUSES: ReadonlySet<PaperOrderStatus> = new Set<PaperOrderStatus>([
  "PAPER_CLOSED_WIN",
  "PAPER_CLOSED_LOSS",
  "PAPER_EXPIRED",
  "PAPER_NO_FILL",
  "PAPER_DATA_FAILURE",
  "PAPER_CANCELED",
  "PAPER_REJECTED",
]);

/**
 * Statuses the resolver actively re-checks each pass. An OPEN order in any OTHER
 * status (PAPER_FILLED / PAPER_PARTIAL) is "unprocessable": it never gets a TP/SL
 * check OR the expiry check (both live inside the resolver loop), so it would stay
 * open forever. Surfaced as resolverUnprocessableOpenCount — a latent-stuck guard.
 */
const RESOLVER_PROCESSABLE_STATUSES: ReadonlySet<PaperOrderStatus> = new Set<PaperOrderStatus>([
  "CREATED",
  "PAPER_SUBMITTED",
]);

// Report-only hold-time buckets for wide/swing lanes (hours → sec). The WIDE lane's
// empirical closed-hold is p50≈23h / p90≈27h, so "watch" only begins at 30h to avoid
// false alarms on normal aging. NONE of these force a close — they only LABEL the
// open backlog so a genuinely stale hold is visible against the lane's normal profile.
const HOLD_BUCKET_NORMAL_MAX_SEC = 30 * 3600; // 0–30h    NORMAL_WIDE_HOLD
const HOLD_BUCKET_EXTENDED_MAX_SEC = 42 * 3600; // 30–42h   EXTENDED_HOLD_WATCH
const HOLD_BUCKET_STALE_MAX_SEC = 72 * 3600; // 42–72h   STALE_WIDE_HOLD
// 72h–7d REVIEW_REQUIRED, then >7d (PAPER_ORDER_EXPIRY_MS) EXPIRED_BY_CURRENT_SLA.

/** Maps a lane id to its hold-time profile descriptor (report-only label). */
function _holdProfileForLane(laneId: string | null | undefined): string {
  const id = (laneId ?? "").toUpperCase();
  if (id.includes("WIDE")) return "SWING_WIDE";
  if (id.includes("TIGHT") || id.includes("FAST") || id.includes("TIMEBOX")) return "SHORT_TERM";
  return id ? "STANDARD" : "NONE";
}

/**
 * Pure latency builder. Computes the E2E corridor metrics + an advisory rules
 * evaluation. Never throws, never enforces. staleSkipped is always 0 here.
 */
export function buildPaperLatencyDiagnostics(inputs: PaperLatencyInputs): PaperLatencyDiagnostics {
  const thresholds = inputs.thresholds ?? PAPER_LATENCY_THRESHOLDS;
  const futureThresholds = inputs.futureThresholds ?? LIVE_MICRO_PILOT_LATENCY_THRESHOLDS_FUTURE;
  const rulesEnabled = inputs.rulesEnabled ?? PAPER_LATENCY_RULES_ENABLED;
  const createdThisCycle = Math.max(0, Math.floor(inputs.createdThisCycle ?? 0));
  const unresolvedMaxAgeSec = inputs.unresolvedMaxAgeSec ?? PAPER_ORDER_EXPIRY_MS / 1000;

  const nowMs = new Date(inputs.now).getTime();

  // ══ BLOCK A — CURRENT CYCLE LATENCY ══
  // ── scan-cycle freshness (cache) ──
  const scanMs = inputs.scanFinishedAt ? new Date(inputs.scanFinishedAt).getTime() : NaN;
  const hasScan = Number.isFinite(scanMs);
  const scanAgeSec = hasScan ? _latencySec(scanMs, nowMs) : null;

  // ── candidate price-data freshness (cache, freshest 5m candle OPEN) ──
  const observationMs =
    typeof inputs.freshestCandidatePriceObservationMs === "number" &&
    Number.isFinite(inputs.freshestCandidatePriceObservationMs)
      ? inputs.freshestCandidatePriceObservationMs
      : NaN;
  const candidateAgeSec = Number.isFinite(observationMs) ? _latencySec(observationMs, nowMs) : null;

  // ── current-cycle admission sample ──
  // ONLY an order created THIS cycle qualifies. latestOrders is newest-first and
  // admission appends, so [0] is the freshest this-cycle order when createdThisCycle>0.
  // An OLD open order is NEVER used here — its age is reported in Block B, not as
  // current-cycle latency (this is the fix for the backlog/current-cycle conflation).
  const currentCycleOrder =
    createdThisCycle > 0 && inputs.latestOrders.length > 0 ? inputs.latestOrders[0]! : null;
  let scanToAdmissionDelaySec: number | null = null;
  let priceAgeSec: number | null = null;
  if (currentCycleOrder) {
    const openedMs = new Date(currentCycleOrder.openedAt).getTime();
    const createdMs = new Date(currentCycleOrder.createdAt).getTime();
    // scan-observation → admission
    scanToAdmissionDelaySec = _latencySec(openedMs, createdMs);
    // admission-price freshness as of now (price observed at the source scan)
    priceAgeSec = _latencySec(openedMs, nowMs);
  } else {
    // No new admission — the "new candidate" price age is the freshest candle data age.
    priceAgeSec = candidateAgeSec;
  }

  const sampleSource: PaperLatencySampleSource =
    createdThisCycle > 0 ? (hasScan ? "ORDER_AND_SCAN" : "ORDER_ONLY") : "NO_NEW_ADMISSION";

  // ══ BLOCK B — OPEN ORDER / RESOLVER BACKLOG ══
  // Age of still-unresolved orders across ALL cycles — kept separate so a long-lived
  // open position (hours waiting on TP/SL) is never read as this cycle's latency.
  const openOrders = (inputs.openOrders ?? []).filter(
    (o) => !CLOSED_OR_TERMINAL_STATUSES.has(o.paperStatus),
  );
  const openOrderCount = openOrders.length;
  const openAges: number[] = []; // now − openedAt (source-observation / hold age)
  const backlogAges: number[] = []; // now − createdAt (elapsed-since-admission)
  let unresolvedTooLongCount = 0;
  let resolverUnprocessableOpenCount = 0;
  const openHoldBuckets = {
    normalWideHold: 0,
    extendedHoldWatch: 0,
    staleWideHold: 0,
    reviewRequired: 0,
    expiredBySla: 0,
  };
  const laneCounts = new Map<string, number>();
  for (const o of openOrders) {
    const openAge = _latencySec(new Date(o.openedAt).getTime(), nowMs);
    if (openAge !== null) {
      openAges.push(openAge);
      // Report-only hold buckets — labels only, NEVER force a close.
      if (openAge <= HOLD_BUCKET_NORMAL_MAX_SEC) openHoldBuckets.normalWideHold += 1;
      else if (openAge <= HOLD_BUCKET_EXTENDED_MAX_SEC) openHoldBuckets.extendedHoldWatch += 1;
      else if (openAge <= HOLD_BUCKET_STALE_MAX_SEC) openHoldBuckets.staleWideHold += 1;
      else if (openAge <= PAPER_ORDER_EXPIRY_MS / 1000) openHoldBuckets.reviewRequired += 1;
      else openHoldBuckets.expiredBySla += 1;
    }
    const backlogAge = _latencySec(new Date(o.createdAt).getTime(), nowMs);
    if (backlogAge !== null) {
      backlogAges.push(backlogAge);
      if (backlogAge > unresolvedMaxAgeSec) unresolvedTooLongCount += 1;
    }
    // Latent-stuck guard: open but in a status the resolver never re-checks.
    if (!RESOLVER_PROCESSABLE_STATUSES.has(o.paperStatus)) resolverUnprocessableOpenCount += 1;
    const lane = o.selectedLaneId ?? "";
    laneCounts.set(lane, (laneCounts.get(lane) ?? 0) + 1);
  }
  const oldestOpenAgeSec = openAges.length > 0 ? Math.max(...openAges) : null;
  const p90OpenAgeSec = _p90(openAges);
  const resolverBacklogAgeSec = backlogAges.length > 0 ? Math.max(...backlogAges) : null;
  const backlogSampleSource: PaperBacklogSampleSource =
    openOrderCount > 0 ? "OPEN_ORDER_BACKLOG" : "NONE";

  // Dominant open lane → hold-time profile descriptor (report-only label).
  let dominantLane: string | null = null;
  let dominantCount = -1;
  for (const [lane, count] of laneCounts) {
    if (count > dominantCount) {
      dominantCount = count;
      dominantLane = lane;
    }
  }
  const holdProfile = openOrderCount > 0 ? _holdProfileForLane(dominantLane) : "NONE";
  const closedHolds = (inputs.closedHoldSamplesSec ?? []).filter((v) => Number.isFinite(v) && v >= 0);
  const expectedHoldP50Sec = _percentile(closedHolds, 0.5);
  const expectedHoldP90Sec = _percentile(closedHolds, 0.9);

  // ══ BLOCK C — LABEL LEAK (createdAt vs openedAt) ══
  // REPORT-ONLY. Measures, and does NOT repair, the gap between the instant the price was
  // observed (openedAt, which entryPrice belongs to) and the instant the label was written
  // (createdAt). The resolver anchors on openedAt, so bars that closed before createdAt can
  // decide the outcome. Nothing here changes resolution, grossR/costR/netR, or admission.
  const leakClosed = (inputs.closedOrders ?? []).filter(
    (o) => o.paperStatus === "PAPER_CLOSED_WIN" || o.paperStatus === "PAPER_CLOSED_LOSS",
  );
  const leakDeltas: number[] = [];
  let resolvedBeforeDecisionCount = 0;
  let exitBarStraddlesDecisionCount = 0;
  let labelLeakClosedWithExitTsCount = 0;
  for (const o of leakClosed) {
    const delta = _admissionDelaySec(o);
    if (delta === null) continue;
    leakDeltas.push(Math.round(delta * 10) / 10);
    // closedAtMs is the MARKET close ts of the exit bar (never process time), which is
    // exactly what makes this comparison meaningful against the decision timestamp.
    const exitMs = o.closedAtMs;
    if (typeof exitMs === "number" && Number.isFinite(exitMs)) {
      labelLeakClosedWithExitTsCount += 1;
      const createdMs = new Date(o.createdAt).getTime();
      if (Number.isFinite(createdMs)) {
        if (exitMs < createdMs) {
          // Provably pre-decision: the whole exit bar had closed before the label was written.
          resolvedBeforeDecisionCount += 1;
        } else if (exitMs - CANDLE_MS < createdMs) {
          // POSSIBLY pre-decision: the exit bar opened before createdAt and closed at/after it,
          // so the SL/TP touch inside it may or may not predate the label. Unknowable at 5m.
          // Counted separately so resolvedBeforeDecisionCount is never mistaken for the total.
          exitBarStraddlesDecisionCount += 1;
        }
      }
    }
  }
  const labelLeakClosedSampleCount = leakDeltas.length;
  const labelLeakP50Sec = _percentile(leakDeltas, 0.5);
  const labelLeakP90Sec = _percentile(leakDeltas, 0.9);
  // Fold, not Math.max(...spread): the closed cohort is the whole book (6.4k rows today,
  // unbounded) and a spread of that size risks a call-stack overflow.
  let labelLeakMaxSec: number | null = null;
  for (const d of leakDeltas) {
    if (labelLeakMaxSec === null || d > labelLeakMaxSec) labelLeakMaxSec = d;
  }
  const preDecisionResolvableSecUpperBoundAtP50 =
    labelLeakP50Sec === null ? null : Math.round((labelLeakP50Sec + CANDLE_MS / 1000) * 10) / 10;
  const labelLeakSampleSource: PaperLabelLeakSampleSource =
    labelLeakClosedSampleCount > 0 ? "CLOSED_ORDER_COHORT" : "NONE";
  // Separate provenance: the counters' denominator is rows carrying closedAtMs, which a legacy
  // cohort can leave at zero even when the percentile sample is full. Without this, a
  // 0/0 counter would be reported alongside sampleSource=CLOSED_ORDER_COHORT, i.e. "measured".
  const labelLeakExitTsSampleSource: PaperLabelLeakSampleSource =
    labelLeakClosedWithExitTsCount > 0 ? "CLOSED_ORDER_COHORT" : "NONE";

  // ── advisory rules corridor (NOT enforced) ──
  const evalRule = (
    rule: PaperLatencyRule,
    metricSec: number | null,
    thresholdSec: number | null,
  ): PaperLatencyRuleEval => ({
    rule,
    metricSec,
    thresholdSec,
    wouldTrip:
      metricSec !== null &&
      thresholdSec !== null &&
      Number.isFinite(metricSec) &&
      Number.isFinite(thresholdSec) &&
      metricSec > thresholdSec,
  });

  const ruleEvals: PaperLatencyRuleEval[] = [
    evalRule("SCAN_TOO_OLD_NO_HEADLINE", scanAgeSec, thresholds.scanMaxAgeSec),
    evalRule("CANDIDATE_TOO_OLD_SKIP", candidateAgeSec, thresholds.candidateMaxAgeSec),
    evalRule("PRICE_TOO_STALE_SKIP", priceAgeSec, thresholds.priceMaxAgeSec),
    evalRule("ADMISSION_DELAY_EXCEEDED", scanToAdmissionDelaySec, thresholds.admissionMaxDelaySec),
  ];

  const firstTrip = ruleEvals.find((r) => r.wouldTrip) ?? null;
  const latencyBlocker = firstTrip
    ? rulesEnabled
      ? firstTrip.rule
      : `ADVISORY:${firstTrip.rule}`
    : null;

  return {
    reportOnly: true,
    rulesEnabled,
    // ── BLOCK A — CURRENT CYCLE LATENCY ──
    scanAgeSec,
    candidateAgeSec,
    scanToAdmissionDelaySec,
    priceAgeSec,
    createdThisCycle,
    sampleSource,
    // ── BLOCK B — OPEN ORDER / RESOLVER BACKLOG ──
    openOrderCount,
    oldestOpenAgeSec,
    p90OpenAgeSec,
    resolverBacklogAgeSec,
    unresolvedTooLongCount,
    backlogSampleSource,
    // ── hold-time labeling (report-only) ──
    holdProfile,
    oldestOpenHoldSec: oldestOpenAgeSec,
    p90OpenHoldSec: p90OpenAgeSec,
    expectedHoldP50Sec,
    expectedHoldP90Sec,
    openHoldBuckets,
    resolverUnprocessableOpenCount,
    // ── BLOCK C — LABEL LEAK (report-only; changes nothing) ──
    labelLeakClosedSampleCount,
    labelLeakP50Sec,
    labelLeakP90Sec,
    labelLeakMaxSec,
    resolvedBeforeDecisionCount,
    exitBarStraddlesDecisionCount,
    labelLeakClosedWithExitTsCount,
    preDecisionResolvableSecUpperBoundAtP50,
    labelLeakSampleSource,
    labelLeakExitTsSampleSource,
    // ── meta / advisory corridor ──
    // Enforcement is intentionally unwired: no admission is ever skipped by latency here.
    staleSkipped: 0,
    latencyBlocker,
    thresholds,
    futureThresholds,
    ruleEvals,
  };
}

// ─── compact brief lines (section 10) ───────────────────────────────────────

function _r4(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v as number)) return "n/a";
  const n = v as number;
  return `${n >= 0 ? "+" : ""}${n.toFixed(4)}`;
}
function _d2(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v as number)) return "n/a";
  return (v as number).toFixed(2);
}
function _p1(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v as number)) return "n/a";
  return `${((v as number) * 100).toFixed(1)}%`;
}

export function buildPaperExecutionRouterBriefLines(
  report: PaperPerformanceReport,
  _opts: { plannerEquity?: number } = {},
): string[] {
  const L: string[] = [];
  L.push("10. PAPER EXECUTION ROUTER");
  L.push(`   enabled=true  paperOnly=true  riskPerTrade=1%  lossHardStop=OFF`);
  L.push(
    `   paperEquity=${_d2(report.paperEquity)} NTD  plannedRiskAmount=${_d2(report.paperEquity * 0.01)} NTD` +
      `  consecutiveLossHardStop=OFF  operationalSafetyStop=ON`,
  );
  L.push(
    `   paperStartAt=${report.paperStartAt ?? "n/a"}  sourceFreshness=10min`,
  );
  // Execution-realism: the resolver simulates live fills WITH slippage so paper PnL
  // previews real entry/exit (telat-masuk/jual) cost. IDEAL = zero-slip (test mode).
  const em = report.executionModel;
  L.push(
    `   executionRealism=${em ? "REALISTIC" : "IDEAL"}` +
      `  entrySlip=${em?.entrySlippageBps ?? 0}bps  stopSlip=${em?.stopSlippageBps ?? 0}bps  tpSlip=${em?.tpSlippageBps ?? 0}bps` +
      ` (exit=resting SL/TP @exchange)`,
  );
  L.push(
    `   activeLane=${report.activeLane ?? "none"}  paperLaneConfidence=${report.paperLaneConfidence}` +
      `  rotationAction=${report.rotationAction}` +
      `  activeLaneN=${report.activeLaneClosed}` +
      `  activeLaneNet=${_r4(report.activeLaneNetAvgR)}` +
      `  activeLanePF=${_d2(report.activeLanePF)}`,
  );
  if (report.currentBatchActiveLane && report.currentBatchCreatedCount && report.currentBatchCreatedCount > 0) {
    L.push(
      `   currentBatchLane=${report.currentBatchActiveLane}` +
        `  batchMode=${report.currentBatchOrderMode ?? "UNKNOWN"}` +
        `  batchCreated=${report.currentBatchCreatedCount}`,
    );
  }
  L.push(
    `   total=${report.total}  open=${report.open}  closed=${report.closed}` +
      `  win=${report.win}  loss=${report.loss}  noFill=${report.noFill}` +
      `  expired=${report.expired}  dataFailure=${report.dataFailure}`,
  );
  L.push(
    `   headlineClosed=${report.headlineClosed}  diagnosticOnly=${report.diagnosticOnlyTotal}` +
      ` (closed=${report.diagnosticOnlyClosed}, excluded from headline metrics)`,
  );
  // T1-b — SUB-ADMISSION-FLOOR EXCLUSION, rendered UNCONDITIONALLY.
  //
  // Printing this only when non-zero would make its absence ambiguous, and printing nothing at all
  // is exactly the "quietly drops 14.6% of the book and shows a better number" failure this fix
  // exists to prevent. `reportsApplied` says which of the two bases the metrics ABOVE are on; both
  // bases are then printed side by side, so the operator never has to know which way to reconstruct.
  //
  // KNOWN, DELIBERATE DISAGREEMENT: the PROVENANCE V1 block below is built by
  // buildPaperProvenanceAudit, which reads the FULL unfiltered book on purpose (it audits data
  // coverage, not economics). Its `closed=` counts exceed headlineClosed above by exactly
  // subFloorExcluded whenever reportsApplied=YES. Named here so a diff never looks like a bug.
  {
    const x = report.subFloorExclusion;
    const decisionsApplied = subFloorExclusionEnabledForDecisions();
    L.push(
      `   subFloorExcluded=${x.excludedCount} (headline=${x.excludedHeadlineCount}` +
        ` diagnosticOnly=${x.excludedDiagnosticOnlyCount})` +
        `  reportsApplied=${x.applied ? "YES" : "NO"}  decisionsApplied=${decisionsApplied ? "YES" : "NO"}` +
        `  predicateV${x.predicateVersion}`,
    );
    if (x.excludedCount > 0) {
      // HEADLINE basis on both sides — headlineNet/headlineWR/headlinePnl above are HEADLINE-scoped,
      // and the all-closed sums would reconstruct a number the brief never prints.
      const withClosed = x.retainedHeadlineClosedCount + x.excludedHeadlineCount;
      const withNet =
        withClosed > 0 ? (x.retainedHeadlineNetRSum + x.excludedHeadlineNetRSum) / withClosed : null;
      const withPnl = x.retainedHeadlineNetPnlAmount + x.excludedHeadlineNetPnlAmount;
      L.push(
        `     headline WITH subFloor: closed=${withClosed} net=${_r4(withNet)} pnl=${_d2(withPnl)} NTD` +
          `  |  WITHOUT: closed=${x.retainedHeadlineClosedCount} net=${_r4(x.retainedHeadlineNetAvgR)}` +
          ` pnl=${_d2(x.retainedHeadlineNetPnlAmount)} NTD`,
      );
      L.push(
        `     subFloorByLane: ${x.byLane
          .slice(0, 4)
          .map(
            (l) =>
              `${l.laneId}(floor=${l.admissionStopFloorBps ?? "n/a"}bps n=${l.excludedCount}` +
              ` avgR=${_r4(l.excludedNetAvgR)} stop=${_d2(l.minStopDistanceBps)}..${_d2(l.maxStopDistanceBps)}bps)`,
          )
          .join(" | ")}`,
      );
      if (x.applied) {
        L.push(
          `     note: provenance/audit blocks below intentionally count the FULL book` +
            ` (+${x.excludedCount} closed vs the metrics above)`,
        );
      }
    }
  }
  L.push(
    `   headlineNet=${_r4(report.headlineNetAvgR)}  headlinePF=${_d2(report.headlinePF)}  headlineWR=${_p1(report.headlineWR)}`,
  );
  L.push(
    `   headlinePnl=${_d2(report.realizedPaperPnl)} NTD  diagnosticPnl=${_d2(report.diagnosticRealizedPaperPnl)} NTD  totalPaperPnl=${_d2(report.totalRealizedPaperPnl)} NTD  dailyPnl=${_d2(report.dailyPaperPnl)} NTD`,
  );
  if (report.latestOrders.length === 0) {
    L.push(`   latestOrders: none`);
  } else {
    const summaries = report.latestOrders.slice(0, 3).map((o) => {
      const status = o.paperStatus;
      const mode = o.paperOrderMode ?? "HEADLINE";
      const net = typeof o.netR === "number" ? _r4(o.netR) : "—";
      return `${o.symbol}/${o.direction}/${status}/${mode}(${net})`;
    });
    L.push(`   latestOrders: ${summaries.join(" | ")}`);
  }
  // Blocker line — a DEGRADED active lane (or a no-real-approval rotation
  // verdict) must never render "blocker: none". Uses paperLaneConfidence so
  // the blocker mirrors the allocator's quarantine state even when the routing
  // laneConfidence still says HIGH. Losses do not hard-stop the bot.
  const laneDegraded =
    report.paperLaneConfidence === "DEGRADED" ||
    report.laneConfidence === "DEGRADED" ||
    report.rotationAction === "PAPER_ONLY_NO_REAL_APPROVAL";
  const blocker = laneDegraded ? "ACTIVE_LANE_DEGRADED" : report.noOrderReason ?? "none";
  L.push(`   blocker: ${blocker}`);
  return L;
}

/** Format a latency seconds value as e.g. "12.3s" or "n/a". */
function _secFmt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v as number)) return "n/a";
  return `${(v as number).toFixed(1)}s`;
}
function _threshFmt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v as number)) return "off";
  return `${v}s`;
}
/** Format a seconds value as hours, e.g. "22.8h" or "n/a". */
function _hrsFmt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v as number)) return "n/a";
  return `${((v as number) / 3600).toFixed(1)}h`;
}

/**
 * Compact latency-corridor brief lines (Section 10). REPORT-ONLY: the corridor
 * is measurement-only — rules are NOT enforced, staleSkipped is always 0, and
 * latencyBlocker is advisory. Surfaces both the active PAPER thresholds and the
 * documented (inactive) live/micro-pilot target corridor.
 */
export function buildPaperLatencyBriefLines(latency: PaperLatencyDiagnostics): string[] {
  const L: string[] = [];
  const t = latency.thresholds;
  const f = latency.futureThresholds;
  L.push("   ── LATENCY (E2E corridor — MEASUREMENT-ONLY, rules DISABLED) ──");
  // ── BLOCK A — CURRENT CYCLE LATENCY ──
  L.push("   A. CURRENT CYCLE LATENCY");
  L.push(
    `      scanAgeSec=${_secFmt(latency.scanAgeSec)}  candidateAgeSec=${_secFmt(latency.candidateAgeSec)}` +
      `  priceAgeSec=${_secFmt(latency.priceAgeSec)}`,
  );
  L.push(
    `      scanToAdmissionDelaySec=${_secFmt(latency.scanToAdmissionDelaySec)}` +
      `  createdThisCycle=${latency.createdThisCycle}  sampleSource=${latency.sampleSource}`,
  );
  // ── BLOCK B — OPEN ORDER / RESOLVER BACKLOG ──
  L.push("   B. OPEN ORDER / RESOLVER BACKLOG");
  L.push(
    `      openOrderCount=${latency.openOrderCount}  oldestOpenAgeSec=${_secFmt(latency.oldestOpenAgeSec)}` +
      `  p90OpenAgeSec=${_secFmt(latency.p90OpenAgeSec)}`,
  );
  L.push(
    `      resolverBacklogAgeSec=${_secFmt(latency.resolverBacklogAgeSec)}` +
      `  unresolvedTooLongCount=${latency.unresolvedTooLongCount}  sampleSource=${latency.backlogSampleSource}`,
  );
  // Hold-time labeling (report-only — NEVER force-closes; labels vs the lane's normal profile).
  const hb = latency.openHoldBuckets;
  L.push(
    `      holdProfile=${latency.holdProfile}  expectedHoldP50=${_hrsFmt(latency.expectedHoldP50Sec)}` +
      `  expectedHoldP90=${_hrsFmt(latency.expectedHoldP90Sec)}` +
      `  oldestOpenHold=${_hrsFmt(latency.oldestOpenHoldSec)}  p90OpenHold=${_hrsFmt(latency.p90OpenHoldSec)}`,
  );
  L.push(
    `      openHoldBuckets: normalWideHold=${hb.normalWideHold} extendedHoldWatch=${hb.extendedHoldWatch}` +
      ` staleWideHold=${hb.staleWideHold} reviewRequired=${hb.reviewRequired} expiredBySla=${hb.expiredBySla}`,
  );
  L.push(`      resolverUnprocessableOpenCount=${latency.resolverUnprocessableOpenCount}`);
  // ── BLOCK C — LABEL LEAK (report-only; resolution semantics deliberately unchanged) ──
  L.push("   C. LABEL LEAK (createdAt vs openedAt — REPORT-ONLY, resolver UNCHANGED)");
  L.push(
    `      labelLeakP50=${_secFmt(latency.labelLeakP50Sec)}  p90=${_secFmt(latency.labelLeakP90Sec)}` +
      `  max=${_secFmt(latency.labelLeakMaxSec)}  n=${latency.labelLeakClosedSampleCount}` +
      `  sampleSource=${latency.labelLeakSampleSource}`,
  );
  L.push(
    `      resolvedBeforeDecision=${latency.resolvedBeforeDecisionCount}/${latency.labelLeakClosedWithExitTsCount}` +
      ` (exit bar closed BEFORE createdAt — LOWER BOUND)` +
      `  +straddling=${latency.exitBarStraddlesDecisionCount} (bar opened before, closed after)` +
      `  exitTsSource=${latency.labelLeakExitTsSampleSource}`,
  );
  L.push(
    `      possiblyLeaked=${latency.resolvedBeforeDecisionCount + latency.exitBarStraddlesDecisionCount}` +
      `/${latency.labelLeakClosedWithExitTsCount}` +
      `  preDecisionResolvableUpperBound@p50=${_secFmt(latency.preDecisionResolvableSecUpperBoundAtP50)}` +
      ` (UPPER bound, not a median — the 300s term is one WHOLE candle)`,
  );
  L.push(
    `   thresholds[${t.profile}]: scanMax=${_threshFmt(t.scanMaxAgeSec)} candidateMax=${_threshFmt(t.candidateMaxAgeSec)}` +
      ` priceMax=${_threshFmt(t.priceMaxAgeSec)} admissionMax=${_threshFmt(t.admissionMaxDelaySec)}`,
  );
  L.push(
    `   rulesEnabled=${latency.rulesEnabled ? "true" : "false"}  staleSkipped=${latency.staleSkipped}` +
      `  latencyBlocker=${latency.latencyBlocker ?? "none"}`,
  );
  const wouldTrip = latency.ruleEvals.filter((r) => r.wouldTrip);
  const wouldTripStr =
    wouldTrip.length > 0
      ? wouldTrip
          .map((r) => `${r.rule}(${_secFmt(r.metricSec)}>${_threshFmt(r.thresholdSec)})`)
          .join(" | ")
      : "none";
  L.push(`   wouldTrip (advisory): ${wouldTripStr}`);
  L.push(
    `   future[${f.profile}] (NOT active): scanMax=${_threshFmt(f.scanMaxAgeSec)} candidateMax=${_threshFmt(f.candidateMaxAgeSec)}` +
      ` priceMax=${_threshFmt(f.priceMaxAgeSec)} admissionMax=${_threshFmt(f.admissionMaxDelaySec)}`,
  );
  return L;
}

/**
 * Compact provenance-coverage + shadow loser-fingerprint-gate brief lines
 * (Part 4). Report-only: ALWAYS renders activeGateChange=NO — the gate
 * simulation never blocks admission and never activates a gate.
 */
function _covLine(label: string, c: ProvenanceCoverageScope): string {
  return `     ${label}=${_p1(c.coveragePct / 100)} (withProvenance=${c.withProvenance}/${c.closed})`;
}

export function buildPaperProvenanceBriefLines(
  audit: PaperProvenanceAudit,
  gate: ShadowLoserFingerprintGateReport,
  diagnosticGate?: ShadowLoserFingerprintGateReport | null,
): string[] {
  const L: string[] = [];
  L.push("   ── PROVENANCE V1 + SHADOW LOSER-FINGERPRINT GATE (report-only) ──");
  // DIAGNOSTIC PROVENANCE V1 — three coverage scopes so diagnostic-only forensic
  // collection is visible without contaminating headline coverage (req #4).
  L.push("   provenanceCoverage:");
  L.push(_covLine("headline", audit.headlineProvenanceCoverage));
  L.push(_covLine("diagnostic", audit.diagnosticProvenanceCoverage));
  L.push(_covLine("allPaper", audit.allPaperProvenanceCoverage));
  L.push(`   shadowGateScope=${gate.scope}`);
  // Forensic-evidence posture of the DIAGNOSTIC_ONLY sample. Never promotes.
  const dc = audit.diagnosticProvenanceCoverage;
  const diagnosticEvidenceStatus =
    dc.closed === 0
      ? "NO_DIAGNOSTIC_EVIDENCE"
      : dc.coveragePct < 50
        ? "DIAGNOSTIC_PROVENANCE_BLIND"
        : "DIAGNOSTIC_EVIDENCE_REPORT_ONLY";
  L.push(`   diagnosticEvidenceStatus=${diagnosticEvidenceStatus}`);
  const missing =
    audit.missingProvenanceTop.length > 0
      ? audit.missingProvenanceTop
          .slice(0, 4)
          .map((m) => `${m.key}(${m.count})`)
          .join(" | ")
      : "none";
  L.push(`   missingProvenanceTop=${missing}`);
  if (audit.provenanceBlind) {
    L.push(
      `   topLoserFingerprint=PROVENANCE_BLIND (calibration/chase/sourceConflict/routeMode not available on legacy orders)`,
    );
  } else if (audit.topLoserFingerprints.length > 0) {
    const top = audit.topLoserFingerprints[0]!;
    L.push(
      `   topLoserFingerprint=${top.fingerprint} (losses=${top.losses}, netSumR=${_r4(top.netSumR)})`,
    );
  }
  if (gate.provenanceCoverageWarning) {
    L.push(`   shadowGateWarning=${gate.provenanceCoverageWarning}`);
  }
  const best = gate.best;
  L.push(`   shadowGateBest=${best ? best.gateId : "none"}`);
  L.push(`   shadowGateNetImprovement=${best ? _r4(best.netRImprovement) : "n/a"}`);
  // The HEADLINE gate is the ONLY scope that could ever inform an active gate —
  // and even it never does here (activeGateChange stays NO). When headline
  // coverage <50% the existing downgrade already yields PROMISING_BUT_PROVENANCE_BLIND.
  L.push(
    `   headlineGateRecommendation=${best ? best.recommendation : "n/a"}` +
      (best ? ` (lossesAvoided=${best.lossesAvoided}, winsSacrificed=${best.winsSacrificed})` : ""),
  );
  // The DIAGNOSTIC gate is forensic-only. Promising matches are surfaced as
  // REPORT_ONLY_PROMISING — explicitly non-promotable; it can NEVER move
  // activeGateChange off NO, enable live, micro-pilot, or headline promotion (req #5, #7).
  const diagBest = diagnosticGate?.best ?? null;
  const diagnosticGateRecommendation = !diagBest
    ? "n/a"
    : diagBest.recommendation === "PROMISING" || diagBest.recommendation === "READY_FOR_ACTIVE_GATE"
      ? "REPORT_ONLY_PROMISING"
      : diagBest.recommendation;
  L.push(`   diagnosticGateRecommendation=${diagnosticGateRecommendation}`);
  L.push(`   activeGateChange=${gate.activeGateChange}`);
  return L;
}

// ─── one-shot run orchestration ─────────────────────────────────────────────

export interface PaperRunInputs {
  store: PaperExecutionRouterStore;
  vmStore: CurrentGuardVariantMatrixStore;
  routerReport: AdaptiveLaneRouterReport;
  vmReport: CurrentGuardVariantMatrixReport;
  gateReport: LiveTradingGateReport;
  binanceClient: PaperResolverClient;
  now: string;
  admissionMaxAgeMs?: number;
  paperEquity?: number;
  maxNotionalCap?: number;
  paperValidationAllowed?: boolean;
  /**
   * Qualified scan-candidate allocator lane for this run. This prevents the
   * legacy variant-tape selector from rendering a false Mixed-regime blocker
   * or clearing the report lane after allocator admission.
   */
  allocatorActiveLaneId?: string | null;
  /**
   * When true, new paper orders are admitted only from allocator-selected fresh scan
   * opportunities. The legacy variant-matrix tape remains resolver/backlog input only.
   */
  allocatorOnlyAdmission?: boolean;
  /** Live-execution fidelity for resolution fills. Defaults to IDEAL (zero slippage). */
  executionModel?: PaperExecutionModel;
  /** Bounds one resolver pass so the operator brief cannot monopolize the API event loop. */
  resolverMaxOrders?: number;
  resolverMaxRuntimeMs?: number;
}

export async function runPaperAdmissionAndResolution(
  inputs: PaperRunInputs,
): Promise<PaperPerformanceReport> {
  const {
    store, vmStore, routerReport, vmReport, gateReport, binanceClient, now,
  } = inputs;
  // One flush for this ENTIRE pass (admission across every eligible lane, the 4 backlog-cleanup
  // calls below, and resolvePaperOrders' own already-batched flush) instead of one full-array
  // JSON.stringify + writeFileSync per call. store.path on testnet has been observed at 100MB+
  // (this store has no per-lane cap, only the OOM-fix's cap on total order count, and testnet's
  // real order history is large) — 5-6 independent full-store rewrites of a file that size in one
  // operator-brief?resolve=1&paper=1 request is what actually froze the whole event loop for
  // 90-190+s per cycle (every OTHER concurrent request also hung, since writeFileSync blocks the
  // single-threaded process). Mirrors the identical fix already applied to
  // CurrentGuardVariantMatrixStore's resolveVariantMatrixObservations (current-guard-variant-matrix.ts).
  store.beginBatch();
  try {
    return await runPaperAdmissionAndResolutionInner(inputs);
  } finally {
    store.endBatch();
  }
}

async function runPaperAdmissionAndResolutionInner(
  inputs: PaperRunInputs,
): Promise<PaperPerformanceReport> {
  const {
    store, vmStore, routerReport, vmReport, gateReport, binanceClient, now,
  } = inputs;
  const paperValidationAllowed = inputs.paperValidationAllowed === true;
  store.ensurePaperStartAt(now);

  const eligibleLanes = selectEligiblePaperLanes({
    vmReport,
    controllerMode: routerReport.controllerMode,
    regimeFamily: routerReport.regimeFamily,
    paperValidationAllowed,
  });

  const allocatorActiveLaneId = inputs.allocatorActiveLaneId ?? null;
  const allocatorOnlyAdmission = inputs.allocatorOnlyAdmission === true;
  const variantTapeAdmissionLanes = allocatorOnlyAdmission ? [] : eligibleLanes;
  let noOrderReason: string | null = null;
  // Portfolio drawdown circuit-breaker: when tripped, halt NEW paper admission (both the
  // variant-matrix path here and the allocator path in admitPaperOpportunities). Paper-only;
  // liveBlocked stays TRUE. Existing open orders still resolve normally.
  const admissionHalted = store.isAdmissionHalted(now);
  if (admissionHalted) {
    noOrderReason = `portfolio drawdown circuit-breaker halt until ${store.getBreakerState().breakerHaltUntil}`;
  } else if (variantTapeAdmissionLanes.length > 0) {
    for (const eligibleLane of variantTapeAdmissionLanes) {
      admitPaperOrders({
        store,
        vmStore,
        eligibleLane,
        routerReport,
        gateReport,
        now,
        admissionMaxAgeMs: inputs.admissionMaxAgeMs,
        paperEquity: inputs.paperEquity,
        maxNotionalCap: inputs.maxNotionalCap,
      });
    }
  } else if (allocatorOnlyAdmission && allocatorActiveLaneId === null) {
    noOrderReason = "allocator-only admission waiting for fresh scan opportunity";
  } else if (allocatorActiveLaneId === null) {
    noOrderReason = `no eligible paper lane under mode=${routerReport.controllerMode} regime=${routerReport.regimeFamily}`;
  }

  // Recover any orders permanently killed by a previous transient fetch error so
  // the resolver can retry them this pass. No-op once all are cleared.
  store.resetTransientFailures();

  // Void the pre-gate CG_TRAIL SHORT backlog (contra-bias / contra-whale / stacked
  // duplicates) so it stops resolving into directional -1R losses. No-op once cleared.
  store.cancelPreGateTrailBacklog();

  // Quarantine cleanup: trail_after_tp1 is falsified net-negative (no edge over
  // tp1_full), so the lane no longer admits new orders. Void the residual open SHORT
  // trail backlog (the broken 4%-WR direction) so it stops booking -1R losses. The
  // 55%-WR LONG opens are left to resolve naturally. No-op once cleared.
  store.cancelQuarantinedTrailShortBacklog();

  // Headline-demotion cleanup: CG_WIDE_STOP_TP_WIDE (full-exit) is no longer a headline lane.
  // Reclassify any residual full-exit order still tagged HEADLINE to DIAGNOSTIC_ONLY so the
  // scaleout headline metrics stay clean. No-op once cleared.
  store.reclassifyDemotedFullExitHeadlineOrders();

  const executionModel = inputs.executionModel ?? PAPER_EXECUTION_MODEL_IDEAL;
  await resolvePaperOrders(store, binanceClient, executionModel, {
    maxOrders: inputs.resolverMaxOrders,
    maxRuntimeMs: inputs.resolverMaxRuntimeMs,
    yieldEvery: 1,
  });

  // Measurement only: record the daily portfolio-heat shadow snapshot (how bounding total
  // simultaneous risk would trade profit vs drawdown/ruin). Never gates, never trades; wrapped
  // so a snapshot failure can never break the paper pass.
  try {
    const st = store.getState();
    recordHeatShadowSnapshot(dirname(store.path), store.all, st.paperEquityStart ?? 2000, now);
  } catch {
    /* diagnostic only — ignore */
  }

  const closedOrders = store.all.filter(
    (o) =>
      (o.paperStatus === "PAPER_CLOSED_WIN" || o.paperStatus === "PAPER_CLOSED_LOSS") &&
      o.diagnosticLabel !== "BACKFILL_DIAGNOSTIC" &&
      o.paperOrderMode !== "DIAGNOSTIC_ONLY",
  );

  // Portfolio drawdown circuit-breaker bookkeeping (paper-only). Compute current headline-book
  // equity from realized headline PnL and update the peak / halt state so the NEXT pass admits
  // or halts accordingly. Best-effort — never breaks the pass.
  try {
    const equityStart = store.getState().paperEquityStart ?? PAPER_EQUITY;
    const realizedHeadlinePnl = closedOrders
      .map((o) => o.netPnlAmount)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
      .reduce((s, v) => s + v, 0);
    store.updateEquityPeakAndBreaker(equityStart + realizedHeadlinePnl, now);
  } catch {
    /* breaker bookkeeping is best-effort */
  }

  const primaryEligibleLane = variantTapeAdmissionLanes[0] ?? null;
  const effectiveActiveLaneId =
    primaryEligibleLane?.laneId ??
    allocatorActiveLaneId ??
    store.getState().activeLaneId ??
    null;
  const rotationResult = evaluatePaperLaneRotation({
    activeLaneId: effectiveActiveLaneId,
    routerReport,
    vmReport,
    closedOrders,
    controllerMode: routerReport.controllerMode,
    regimeFamily: routerReport.regimeFamily,
    paperValidationAllowed,
  });

  // The legacy selector owns this persisted field only when it selected a lane.
  // Allocator Mixed context is report-only here and must not introduce a new
  // store mutation beyond normal paper order creation.
  if (primaryEligibleLane) {
    store.setActiveLane(primaryEligibleLane.laneId, rotationResult.currentLaneConfidence);
  }

  // T1-b: this report becomes routes/shadow.ts `paperReport` (section 10 + the Telegram snapshot)
  // and sits next to allocator/per-lane numbers that are gated by
  // PAPER_EXCLUDE_SUBFLOOR_ROWS_DECISIONS. It follows the SAME flag so the operator surface can
  // never be on a different population than the decisions it is used to explain. Flag OFF (default)
  // ⇒ byte-identical to pre-T1-b; the exclusion is still SURFACED via `subFloorExclusion` and the
  // brief renders both bases side by side.
  return buildPaperPerformanceReport(store, {
    activeLaneId: effectiveActiveLaneId,
    laneConfidence: rotationResult.currentLaneConfidence,
    rotationResult,
    noOrderReason,
    executionModel,
    applySubFloorExclusion: subFloorExclusionEnabledForDecisions(),
  });
}

// ─── timeboxed-exit COUNTERFACTUAL diagnostic (DIAGNOSTIC-ONLY) ──────────────
//
// Answers one audit question WITHOUT touching the real strategy:
//   "If a CG_WIDE trade had not hit TP/SL within Nh, what is its mark-to-market?"
//
// This is a pure COUNTERFACTUAL replay over the EXISTING orders' price paths —
// SAME entries, only the exit rule changes (a time cap). It NEVER:
//   - admits a new order, mutates the store, or force-closes a CG_WIDE order,
//   - changes any existing lane, enters differently, goes live or micro-pilot,
//   - feeds headlineNet/PF/WR (diagnosticOnly:true).
// It re-prices the same trades under an Nh exit and reports the economics against
// the real run-to-completion outcome, so we can see whether shortening the hold
// preserves expectancy BEFORE ever building a real short-term lane.

const TIMEBOX_MIN_SAMPLE = 20; // closed-order sample below which the verdict abstains
const TIMEBOX_EXPECTANCY_TOLERANCE_R = -0.05; // delta >= this ⇒ "preserves"

export type TimeboxExitReason =
  | "TP_WITHIN_BOX"
  | "SL_WITHIN_BOX"
  | "TIMEBOX_MTM"; // neither hit by the cap → marked to market at the cap

export type TimeboxVerdict =
  | "INSUFFICIENT_SAMPLE"
  | "TIMEBOX_PRESERVES_EXPECTANCY"
  | "TIMEBOX_DEGRADES_EXPECTANCY";

export interface TimeboxedExitDiagnosticConfig {
  /** Diagnostic lane label, e.g. "CG_TIMEBOXED_EXIT_4H_DIAGNOSTIC". */
  laneId: string;
  /** Exit cap in hours (4 / 8 / …). */
  timeboxHours: number;
  /** Fill realism for the counterfactual. Defaults to IDEAL. */
  executionModel?: PaperExecutionModel;
}

export interface TimeboxedExitDiagnosticReport {
  reportOnly: true;
  /** Excluded from headline metrics — forensic only. */
  diagnosticOnly: true;
  laneId: string;
  timeboxHours: number;
  /** Orders whose box window is fully in the past and re-priced. */
  sampleSize: number;
  resolvedWithinBox: number;
  timeboxedMtm: number;
  dataFailures: number;
  /** Orders too young for the box window to have elapsed — excluded. */
  incompleteWindow: number;
  /** Counterfactual economics over the full sample. */
  boxNetAvgR: number | null;
  boxPf: number | null;
  boxWr: number | null;
  /** Apples-to-apples vs REAL run-to-completion on the closed subset. */
  closedSampleSize: number;
  realNetAvgR: number | null;
  realPf: number | null;
  realWr: number | null;
  boxNetAvgROnClosed: number | null;
  /** boxNetAvgROnClosed − realNetAvgR (per-trade expectancy change). */
  expectancyDeltaR: number | null;
  /** Mean hold cut on closed orders (real hold − box exit), seconds. */
  avgHoldReductionSec: number | null;
  /** Still-open real orders the box would already have exited (the hold/latency win). */
  openWouldCloseCount: number;
  verdict: TimeboxVerdict;
}

function _economicsOfRs(netRs: number[]): {
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
} {
  if (netRs.length === 0) return { netAvgR: null, pf: null, wr: null };
  const netAvgR = netRs.reduce((s, v) => s + v, 0) / netRs.length;
  const winSum = netRs.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const lossSum = netRs.filter((v) => v < 0).reduce((s, v) => s + Math.abs(v), 0);
  const pf = lossSum > 0 ? winSum / lossSum : winSum > 0 ? Infinity : null;
  const wr = netRs.filter((v) => v > 0).length / netRs.length;
  return { netAvgR, pf, wr };
}

interface _TimeboxOutcome {
  reason: TimeboxExitReason;
  netR: number;
  boxHoldSec: number;
}

async function _timeboxOutcomeForOrder(
  order: PaperOrder,
  client: PaperResolverClient,
  boxMs: number,
  nowMs: number,
  model: PaperExecutionModel,
): Promise<_TimeboxOutcome | "INCOMPLETE" | "DATA_FAILURE"> {
  const openedAtMs = new Date(order.openedAt).getTime();
  if (!Number.isFinite(openedAtMs)) return "DATA_FAILURE";
  const boxEnd = openedAtMs + boxMs;
  if (boxEnd > nowMs) return "INCOMPLETE"; // window not fully elapsed yet

  const E = order.entryPrice;
  const S = order.stopLoss;
  const T = order.takeProfitLevels[0];
  const dir = order.direction;
  const risk = Math.abs(E - S);
  if (!(risk > 0) || T == null || !Number.isFinite(T)) return "DATA_FAILURE";

  const Ef = _entryFill(dir, E, model.entrySlippageBps);
  const Sf = _exitFill(dir, S, model.stopSlippageBps);
  const Tf = _exitFill(dir, T, model.tpSlippageBps);
  // v2 exit-aware cost, matching what resolvePaperOrders now stores. These counterfactuals are
  // compared AGAINST the order's own stored netR (expectancyDeltaR = counterfactual − real), so a
  // v1 flat cost here would make the delta measure "policy change PLUS cost-model change". On a
  // maker-lane cohort that is a spurious −16bps/stopBps, several times the ±0.05R verdict
  // threshold. viaWalk=false: every branch below prices its own fills through `model`.
  const costTpLike = _computePaperExitCostR(order, "TP_LIKE", model, false);
  const costStopLike = _computePaperExitCostR(order, "STOP_LIKE", model, false);
  const costMtm = _computePaperExitCostR(order, "MARK_TO_MARKET", model, false);

  const startTime = openedAtMs - CANDLE_MS;
  const endTime = boxEnd;
  // Paginated, like the main resolver: a single getKlines call is capped at Binance's 1,000-row
  // limit, which silently truncates any window past ~83h of 5m candles and reports a timebox
  // outcome computed from a short candle set with no error and no data-quality flag. `boxes` is an
  // operator-supplied query parameter with no upper bound, so this window is directly reachable.
  let candles: PaperKlineTuple[];
  try {
    candles = await fetchPaperKlinesRange(client, order.symbol, "5m", startTime, endTime);
  } catch {
    return "DATA_FAILURE";
  }
  if (!Array.isArray(candles) || candles.length === 0) return "DATA_FAILURE";

  let lastClose: number | null = null;
  for (const c of candles) {
    const openMs = c[0];
    if (openMs < openedAtMs - CANDLE_MS) continue;
    if (openMs > boxEnd) break; // candles ascending — past the cap
    const high = Number(c[2]);
    const low = Number(c[3]);
    lastClose = Number(c[4]);
    const slHit = dir === "LONG" ? low <= S : high >= S;
    const tpHit = T != null && (dir === "LONG" ? high >= T : low <= T);
    const holdSec = Math.max(0, (openMs - openedAtMs) / 1000);
    if (slHit && tpHit) {
      const refined = await _resolve1mForPaper(client, order.symbol, openMs, dir, E, S, T);
      const g = refined === "TP" ? _rewardR(dir, Ef, Tf, risk) : _rewardR(dir, Ef, Sf, risk);
      return {
        reason: refined === "TP" ? "TP_WITHIN_BOX" : "SL_WITHIN_BOX",
        netR: g + (refined === "TP" ? costTpLike : costStopLike),
        boxHoldSec: holdSec,
      };
    }
    if (slHit)
      return { reason: "SL_WITHIN_BOX", netR: _rewardR(dir, Ef, Sf, risk) + costStopLike, boxHoldSec: holdSec };
    if (tpHit)
      return { reason: "TP_WITHIN_BOX", netR: _rewardR(dir, Ef, Tf, risk) + costTpLike, boxHoldSec: holdSec };
  }

  // Neither TP nor SL inside the box → mark to market at the cap (taker exit).
  if (lastClose == null) return "DATA_FAILURE";
  const mtmFill = _exitFill(dir, lastClose, model.stopSlippageBps);
  return {
    reason: "TIMEBOX_MTM",
    netR: _rewardR(dir, Ef, mtmFill, risk) + costMtm,
    boxHoldSec: boxMs / 1000,
  };
}

/**
 * Pure counterfactual diagnostic. Re-prices the SAME orders under an Nh exit cap.
 * Never mutates the store or the real orders. Returns DIAGNOSTIC-ONLY economics.
 */
export async function buildTimeboxedExitDiagnostic(
  orders: PaperOrder[],
  client: PaperResolverClient,
  config: TimeboxedExitDiagnosticConfig,
): Promise<TimeboxedExitDiagnosticReport> {
  const model = config.executionModel ?? PAPER_EXECUTION_MODEL_IDEAL;
  const boxMs = Math.max(0, config.timeboxHours) * 3600 * 1000;
  const nowMs = Date.now();

  let resolvedWithinBox = 0;
  let timeboxedMtm = 0;
  let dataFailures = 0;
  let incompleteWindow = 0;
  let openWouldCloseCount = 0;
  const boxNetRs: number[] = [];
  const closedRealRs: number[] = [];
  const closedBoxRs: number[] = [];
  const holdReductions: number[] = [];

  for (const o of orders) {
    const r = await _timeboxOutcomeForOrder(o, client, boxMs, nowMs, model);
    if (r === "INCOMPLETE") {
      incompleteWindow += 1;
      continue;
    }
    if (r === "DATA_FAILURE") {
      dataFailures += 1;
      continue;
    }
    boxNetRs.push(r.netR);
    if (r.reason === "TIMEBOX_MTM") timeboxedMtm += 1;
    else resolvedWithinBox += 1;

    const isClosed =
      o.paperStatus === "PAPER_CLOSED_WIN" || o.paperStatus === "PAPER_CLOSED_LOSS";
    if (isClosed && typeof o.netR === "number" && Number.isFinite(o.netR)) {
      closedRealRs.push(o.netR);
      closedBoxRs.push(r.netR);
      const realHoldSec =
        (new Date(o.updatedAt).getTime() - new Date(o.openedAt).getTime()) / 1000;
      if (Number.isFinite(realHoldSec)) holdReductions.push(Math.max(0, realHoldSec - r.boxHoldSec));
    } else if (!isClosed) {
      openWouldCloseCount += 1; // a still-open real order the box would have exited
    }
  }

  const box = _economicsOfRs(boxNetRs);
  const real = _economicsOfRs(closedRealRs);
  const boxOnClosed = _economicsOfRs(closedBoxRs);
  const expectancyDeltaR =
    boxOnClosed.netAvgR != null && real.netAvgR != null ? boxOnClosed.netAvgR - real.netAvgR : null;
  const avgHoldReductionSec =
    holdReductions.length > 0
      ? holdReductions.reduce((s, v) => s + v, 0) / holdReductions.length
      : null;
  const closedSampleSize = closedRealRs.length;

  let verdict: TimeboxVerdict;
  if (closedSampleSize < TIMEBOX_MIN_SAMPLE) verdict = "INSUFFICIENT_SAMPLE";
  else if (expectancyDeltaR != null && expectancyDeltaR >= TIMEBOX_EXPECTANCY_TOLERANCE_R)
    verdict = "TIMEBOX_PRESERVES_EXPECTANCY";
  else verdict = "TIMEBOX_DEGRADES_EXPECTANCY";

  return {
    reportOnly: true,
    diagnosticOnly: true,
    laneId: config.laneId,
    timeboxHours: config.timeboxHours,
    sampleSize: boxNetRs.length,
    resolvedWithinBox,
    timeboxedMtm,
    dataFailures,
    incompleteWindow,
    boxNetAvgR: box.netAvgR,
    boxPf: box.pf,
    boxWr: box.wr,
    closedSampleSize,
    realNetAvgR: real.netAvgR,
    realPf: real.pf,
    realWr: real.wr,
    boxNetAvgROnClosed: boxOnClosed.netAvgR,
    expectancyDeltaR,
    avgHoldReductionSec,
    openWouldCloseCount,
    verdict,
  };
}

/** Compact brief lines for the timeboxed-exit diagnostic. DIAGNOSTIC-ONLY. */
export function buildTimeboxedExitDiagnosticBriefLines(
  reports: TimeboxedExitDiagnosticReport[],
): string[] {
  const L: string[] = [];
  L.push(
    "   ── TIMEBOXED-EXIT DIAGNOSTIC (DIAGNOSTIC-ONLY — counterfactual, excluded from headline) ──",
  );
  if (reports.length === 0) {
    L.push("   (no timebox diagnostic computed)");
    return L;
  }
  for (const r of reports) {
    L.push(`   ${r.laneId}  verdict=${r.verdict}`);
    L.push(
      `      sample=${r.sampleSize} (closed=${r.closedSampleSize} incompleteWindow=${r.incompleteWindow} dataFail=${r.dataFailures})` +
        `  resolvedWithinBox=${r.resolvedWithinBox} timeboxedMtm=${r.timeboxedMtm} openWouldClose=${r.openWouldCloseCount}`,
    );
    L.push(
      `      box[net=${_r4(r.boxNetAvgR)} PF=${_d2(r.boxPf)} WR=${_p1(r.boxWr)}]` +
        `  vs real-closed[net=${_r4(r.realNetAvgR)} PF=${_d2(r.realPf)} WR=${_p1(r.realWr)}]` +
        `  ΔexpectancyR=${_r4(r.expectancyDeltaR)}`,
    );
    L.push(
      `      avgHoldReduction=${_hrsFmt(r.avgHoldReductionSec)}  (real CG_WIDE exit untouched — diagnostic only)`,
    );
  }
  return L;
}

// ─── fast/tight-TP COUNTERFACTUAL diagnostic (DIAGNOSTIC-ONLY) ───────────────
//
// Sister diagnostic to the timeboxed one, but it changes the PRICE TARGET, not the
// clock: "can we bank profit earlier at a tighter TP (0.25R/0.5R/0.75R), optionally
// scaling out and letting a runner ride, without destroying expectancy?" It avoids
// the timebox's mark-to-market-underwater failure mode because it only exits on a
// real favorable price touch (or the original stop).
//
// SAME isolation guarantees as the timeboxed diagnostic: re-prices the SAME orders'
// price paths, NEVER admits / mutates the store / force-closes CG_WIDE / changes a
// lane / feeds headline / goes live. Fees + slippage use the shared execution model.

const FASTTP_TRAIL_DISTANCE_R = 0.5; // runner trails 0.5R behind the favorable extreme
const FASTTP_HORIZON_HOURS = 72; // max counterfactual sim horizon (matches STALE bucket)
const FASTTP_MIN_SAMPLE = 20; // closed sample below which the verdict abstains
const FASTTP_PRESERVE_TOL_R = -0.05; // delta ≥ this ⇒ PRESERVES
const FASTTP_GOOD_TOL_R = -0.12; // delta ≥ this (and < preserve) ⇒ GOOD_TRADEOFF
const FASTTP_DEGRADE_TOL_R = -0.25; // delta < this ⇒ DEGRADES (between good & degrade ⇒ TRADEOFF)

export type FastTpRunnerRule = "NONE" | "KEEP_ORIGINAL" | "MOVE_STOP_TO_BE" | "TRAIL";

export interface FastTpVariant {
  id: string;
  /** Tight TP trigger in R-multiples of the planned risk distance. */
  triggerR: number;
  /** Fraction taken at the tight TP (0 = full exit; 0.5 = scale out half). */
  partialFraction: number;
  /** What the remaining runner does after a partial. */
  runnerRule: FastTpRunnerRule;
  /** TRAIL only: distance (R) the runner stop trails behind the favorable extreme. Defaults to 0.5R. */
  trailDistanceR?: number;
}

export type FastTpVerdict =
  | "INSUFFICIENT_SAMPLE"
  | "PRESERVES_EXPECTANCY"
  | "GOOD_TRADEOFF"
  | "TRADEOFF"
  | "DEGRADES_EXPECTANCY";

export type FastTpExitKind =
  | "SL_FIRST"
  | "TIGHT_TP_FULL"
  | "RUNNER_TRAIL_STOP"
  | "RUNNER_BE_STOP"
  | "RUNNER_ORIGINAL_STOP"
  | "RUNNER_WIDE_TP"
  | "MTM_NO_TIGHT"
  | "RUNNER_MTM";

export interface FastTpVariantReport {
  reportOnly: true;
  diagnosticOnly: true;
  variantId: string;
  triggerR: number;
  partialFraction: number;
  runnerRule: FastTpRunnerRule;
  /** TRAIL distance (R) used, or null for non-trailing variants. */
  trailDistanceR: number | null;
  sampleSize: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
  avgHoldHours: number | null;
  p50HoldHours: number | null;
  p90HoldHours: number | null;
  /** Mean (real hold − counterfactual hold) on the closed subset, hours. */
  holdReductionHours: number | null;
  /** counterfactual netAvgR − real netAvgR on the closed subset. */
  expectancyDeltaR: number | null;
  /** Counterfactual context vs real (closed subset). */
  closedSampleSize: number;
  realNetAvgR: number | null;
  /** Real winners the variant also won but closed earlier. */
  winsAccelerated: number;
  /** Real winners whose tighter TP captured LESS than the real run-to-completion. */
  originalWinnersCutTooEarly: number;
  /** Real losers the tighter TP rescued (tight TP touched before the stop). */
  originalLosersSaved: number;
  /** Orders where tight-TP and stop fell in the same candle (1m-refined, conservative). */
  sameCandleAmbiguityCount: number;
  /** Runner exits via the trailing stop (TRAIL variants). */
  trailStopHitCount: number;
  /** Runner rode all the way to the original wide TP. */
  runnerToOriginalTargetCount: number;
  dataFailures: number;
  verdict: FastTpVerdict;
}

function _fmtRToken(r: number): string {
  return r.toFixed(2).replace(".", "_"); // 0.25 → "0_25"
}

/** Standard variant set from the audit spec. */
export function buildFastTpVariants(levels: number[], includePartials: boolean): FastTpVariant[] {
  const out: FastTpVariant[] = [];
  for (const r of levels) {
    if (Number.isFinite(r) && r > 0)
      out.push({ id: `TP_${_fmtRToken(r)}R_FULL`, triggerR: r, partialFraction: 0, runnerRule: "NONE" });
  }
  if (includePartials) {
    out.push({
      id: "TP_0_50R_PARTIAL_50_KEEP_ORIGINAL_RUNNER",
      triggerR: 0.5,
      partialFraction: 0.5,
      runnerRule: "KEEP_ORIGINAL",
    });
    out.push({
      id: "TP_0_50R_PARTIAL_50_MOVE_STOP_TO_BE",
      triggerR: 0.5,
      partialFraction: 0.5,
      runnerRule: "MOVE_STOP_TO_BE",
    });
    out.push({
      id: "TP_0_75R_PARTIAL_50_TRAIL",
      triggerR: 0.75,
      partialFraction: 0.5,
      runnerRule: "TRAIL",
    });
  }
  return out;
}

/**
 * Primary trail sweep: fixed base (first TP 0.75R, scale out 50%), runner trails at
 * a sweep of distances behind the favorable extreme. Answers "how tight can the
 * trail be before it gives back the runner's edge?"
 */
export function buildFastTpTrailSweepVariants(
  trailDistancesR: number[] = [0.25, 0.5, 0.75, 1.0, 1.25],
): FastTpVariant[] {
  return trailDistancesR
    .filter((d) => Number.isFinite(d) && d > 0)
    .map((d) => ({
      id: `TP_0_75R_PARTIAL_50_TRAIL_${_fmtRToken(d)}R`,
      triggerR: 0.75,
      partialFraction: 0.5,
      runnerRule: "TRAIL" as const,
      trailDistanceR: d,
    }));
}

/**
 * Secondary grid sweep: firstTP × partialFraction × trailDistance. Wider search for
 * the best trailing configuration. Defaults to the spec's 3×3×3 = 27 variants.
 */
export function buildFastTpTrailGridVariants(
  firstTPs: number[] = [0.5, 0.75, 1.0],
  partials: number[] = [0.33, 0.5, 0.67],
  trailDistancesR: number[] = [0.5, 0.75, 1.0],
): FastTpVariant[] {
  const out: FastTpVariant[] = [];
  for (const tp of firstTPs) {
    for (const p of partials) {
      for (const d of trailDistancesR) {
        if (!(tp > 0) || !(p > 0 && p < 1) || !(d > 0)) continue;
        out.push({
          id: `TP_${_fmtRToken(tp)}R_P${Math.round(p * 100)}_TRAIL_${_fmtRToken(d)}R`,
          triggerR: tp,
          partialFraction: p,
          runnerRule: "TRAIL",
          trailDistanceR: d,
        });
      }
    }
  }
  return out;
}

interface _FastTpSimResult {
  netR: number;
  holdSec: number;
  cfWin: boolean;
  sameCandleAmbiguity: boolean;
  exitKind: FastTpExitKind;
}

/**
 * Simulate ONE order under ONE fast-TP variant over precomputed 5m candles.
 * The client is only used for 1m same-candle ambiguity refinement.
 */
async function _simulateFastTpForOrder(
  order: PaperOrder,
  candles: PaperKlineTuple[],
  client: PaperResolverClient,
  variant: FastTpVariant,
  model: PaperExecutionModel,
  openedAtMs: number,
  endTimeMs: number,
): Promise<_FastTpSimResult | "DATA_FAILURE"> {
  const E = order.entryPrice;
  const S = order.stopLoss;
  const Twide = order.takeProfitLevels[0];
  const dir = order.direction;
  const risk = Math.abs(E - S);
  if (!(risk > 0)) return "DATA_FAILURE";

  // v2 exit-aware cost, matching what resolvePaperOrders now stores. These counterfactuals are
  // compared AGAINST the order's own stored netR (expectancyDeltaR = counterfactual − real), so a
  // v1 flat cost here would make the delta measure "policy change PLUS cost-model change". On a
  // maker-lane cohort that is a spurious −16bps/stopBps, several times the ±0.05R verdict
  // threshold. viaWalk=false: every branch below prices its own fills through `model`.
  const costTpLike = _computePaperExitCostR(order, "TP_LIKE", model, false);
  const costStopLike = _computePaperExitCostR(order, "STOP_LIKE", model, false);
  const costMtm = _computePaperExitCostR(order, "MARK_TO_MARKET", model, false);
  const sign = dir === "SHORT" ? -1 : 1; // favorable price direction
  const tightTP = E + sign * variant.triggerR * risk;
  const Ef = _entryFill(dir, E, model.entrySlippageBps);
  const frac = 1 - variant.partialFraction;

  let phase: 1 | 2 = 1;
  let realizedR = 0; // banked R from the partial leg (already weighted by partialFraction)
  let mfe = E; // most-favorable price seen (for TRAIL)
  let sameCandleAmbiguity = false;
  let lastClose: number | null = null;

  for (const c of candles) {
    const openMs = c[0];
    if (openMs < openedAtMs - CANDLE_MS) continue;
    if (openMs > endTimeMs) break;
    const high = Number(c[2]);
    const low = Number(c[3]);
    lastClose = Number(c[4]);
    const holdSec = Math.max(0, (openMs - openedAtMs) / 1000);
    mfe = dir === "SHORT" ? Math.min(mfe, low) : Math.max(mfe, high);

    if (phase === 1) {
      const tightHit = dir === "SHORT" ? low <= tightTP : high >= tightTP;
      const slHit = dir === "SHORT" ? high >= S : low <= S;
      let resolveTight = false;
      let resolveSL = false;
      if (tightHit && slHit) {
        sameCandleAmbiguity = true;
        const refined = await _resolve1mForPaper(client, order.symbol, openMs, dir, E, S, tightTP);
        if (refined === "TP") resolveTight = true;
        else resolveSL = true; // SL or null → conservative stop-first
      } else if (slHit) resolveSL = true;
      else if (tightHit) resolveTight = true;

      if (resolveSL) {
        const r = _rewardR(dir, Ef, _exitFill(dir, S, model.stopSlippageBps), risk);
        return {
          netR: r + costStopLike,
          holdSec,
          cfWin: r + costStopLike > 0,
          sameCandleAmbiguity,
          exitKind: "SL_FIRST",
        };
      }
      if (resolveTight) {
        const tightLegR = _rewardR(dir, Ef, _exitFill(dir, tightTP, model.tpSlippageBps), risk);
        if (variant.partialFraction <= 0) {
          return {
            netR: tightLegR + costTpLike,
            holdSec,
            cfWin: tightLegR + costTpLike > 0,
            sameCandleAmbiguity,
            exitKind: "TIGHT_TP_FULL",
          };
        }
        realizedR = variant.partialFraction * tightLegR;
        phase = 2;
        continue;
      }
      continue;
    }

    // ── phase 2: runner (fraction = frac) ──
    let runnerStop: number;
    if (variant.runnerRule === "MOVE_STOP_TO_BE") runnerStop = E;
    else if (variant.runnerRule === "TRAIL") {
      const trailDist = variant.trailDistanceR ?? FASTTP_TRAIL_DISTANCE_R;
      const trail = mfe - sign * trailDist * risk; // behind the favorable extreme
      runnerStop = dir === "SHORT" ? Math.min(E, trail) : Math.max(E, trail); // ratchet, floored at BE
    } else runnerStop = S; // KEEP_ORIGINAL

    const wideHit =
      Twide != null && Number.isFinite(Twide) && (dir === "SHORT" ? low <= Twide : high >= Twide);
    const stopHit = dir === "SHORT" ? high >= runnerStop : low <= runnerStop;

    let exitRunnerAt: number | null = null;
    let runnerIsTp = false;
    if (wideHit && stopHit) {
      sameCandleAmbiguity = true;
      const refined = await _resolve1mForPaper(client, order.symbol, openMs, dir, E, runnerStop, Twide!);
      if (refined === "TP") {
        exitRunnerAt = Twide!;
        runnerIsTp = true;
      } else {
        exitRunnerAt = runnerStop; // SL or null → conservative stop-first
      }
    } else if (stopHit) exitRunnerAt = runnerStop;
    else if (wideHit) {
      exitRunnerAt = Twide!;
      runnerIsTp = true;
    }

    if (exitRunnerAt != null) {
      const fill = _exitFill(dir, exitRunnerAt, runnerIsTp ? model.tpSlippageBps : model.stopSlippageBps);
      const runnerR = _rewardR(dir, Ef, fill, risk);
      const blended = realizedR + frac * runnerR;
      const exitKind: FastTpExitKind = runnerIsTp
        ? "RUNNER_WIDE_TP"
        : variant.runnerRule === "TRAIL"
          ? "RUNNER_TRAIL_STOP"
          : variant.runnerRule === "MOVE_STOP_TO_BE"
            ? "RUNNER_BE_STOP"
            : "RUNNER_ORIGINAL_STOP";
      // The runner leg dominates the blended R; charge on how the RUNNER exited (wide TP vs a
      // trail/BE/original stop), matching the resolver's TP_LIKE / STOP_LIKE split.
      const runnerCost = runnerIsTp ? costTpLike : costStopLike;
      return {
        netR: blended + runnerCost,
        holdSec,
        cfWin: blended + runnerCost > 0,
        sameCandleAmbiguity,
        exitKind,
      };
    }
  }

  // Unresolved by the horizon → mark to market at the last close.
  if (lastClose == null) return "DATA_FAILURE";
  const mtmR = _rewardR(dir, Ef, _exitFill(dir, lastClose, model.stopSlippageBps), risk);
  const holdSec = (endTimeMs - openedAtMs) / 1000;
  if (phase === 1)
    return {
      netR: mtmR + costMtm,
      holdSec,
      cfWin: mtmR + costMtm > 0,
      sameCandleAmbiguity,
      exitKind: "MTM_NO_TIGHT",
    };
  const blended = realizedR + frac * mtmR;
  return {
    netR: blended + costMtm,
    holdSec,
    cfWin: blended + costMtm > 0,
    sameCandleAmbiguity,
    exitKind: "RUNNER_MTM",
  };
}

/**
 * Pure counterfactual diagnostic. Re-prices the SAME orders under each fast-TP
 * variant. One candle fetch per order (shared across variants). Never mutates the
 * store or the real orders; returns DIAGNOSTIC-ONLY economics per variant.
 */
export async function buildFastTpTightDiagnostic(
  orders: PaperOrder[],
  client: PaperResolverClient,
  variants: FastTpVariant[],
  opts: { executionModel?: PaperExecutionModel; horizonHours?: number } = {},
): Promise<FastTpVariantReport[]> {
  const model = opts.executionModel ?? PAPER_EXECUTION_MODEL_IDEAL;
  const horizonMs = (opts.horizonHours ?? FASTTP_HORIZON_HOURS) * 3600 * 1000;
  const nowMs = Date.now();

  interface Acc {
    cfNetRs: number[];
    holdsSec: number[];
    closedCfNetRs: number[];
    closedRealNetRs: number[];
    holdReductionsH: number[];
    winsAccelerated: number;
    originalWinnersCutTooEarly: number;
    originalLosersSaved: number;
    sameCandleAmbiguityCount: number;
    trailStopHitCount: number;
    runnerToOriginalTargetCount: number;
    dataFailures: number;
  }
  const acc: Acc[] = variants.map(() => ({
    cfNetRs: [],
    holdsSec: [],
    closedCfNetRs: [],
    closedRealNetRs: [],
    holdReductionsH: [],
    winsAccelerated: 0,
    originalWinnersCutTooEarly: 0,
    originalLosersSaved: 0,
    sameCandleAmbiguityCount: 0,
    trailStopHitCount: 0,
    runnerToOriginalTargetCount: 0,
    dataFailures: 0,
  }));

  for (const o of orders) {
    const openedAtMs = new Date(o.openedAt).getTime();
    if (!Number.isFinite(openedAtMs)) {
      for (const a of acc) a.dataFailures += 1;
      continue;
    }
    const endTimeMs = Math.min(nowMs, openedAtMs + horizonMs);
    const startTime = openedAtMs - CANDLE_MS;
    // Paginated: see _timeboxOutcomeForOrder. A fast-TP horizon past ~83h of 5m candles would
    // otherwise be truncated at Binance's 1,000-row cap and scored on a partial path.
    let candles: PaperKlineTuple[];
    try {
      candles = await fetchPaperKlinesRange(client, o.symbol, "5m", startTime, endTimeMs);
    } catch {
      for (const a of acc) a.dataFailures += 1;
      continue;
    }
    if (!Array.isArray(candles) || candles.length === 0) {
      for (const a of acc) a.dataFailures += 1;
      continue;
    }

    const isClosed = o.paperStatus === "PAPER_CLOSED_WIN" || o.paperStatus === "PAPER_CLOSED_LOSS";
    const realWin = o.paperStatus === "PAPER_CLOSED_WIN";
    const realLoss = o.paperStatus === "PAPER_CLOSED_LOSS";
    const realNetR = typeof o.netR === "number" && Number.isFinite(o.netR) ? o.netR : null;
    const realHoldSec = (new Date(o.updatedAt).getTime() - openedAtMs) / 1000;

    for (let i = 0; i < variants.length; i += 1) {
      const res = await _simulateFastTpForOrder(
        o,
        candles,
        client,
        variants[i]!,
        model,
        openedAtMs,
        endTimeMs,
      );
      const a = acc[i]!;
      if (res === "DATA_FAILURE") {
        a.dataFailures += 1;
        continue;
      }
      a.cfNetRs.push(res.netR);
      a.holdsSec.push(res.holdSec);
      if (res.sameCandleAmbiguity) a.sameCandleAmbiguityCount += 1;
      if (res.exitKind === "RUNNER_TRAIL_STOP") a.trailStopHitCount += 1;
      if (res.exitKind === "RUNNER_WIDE_TP") a.runnerToOriginalTargetCount += 1;
      if (isClosed && realNetR != null) {
        a.closedCfNetRs.push(res.netR);
        a.closedRealNetRs.push(realNetR);
        if (Number.isFinite(realHoldSec)) a.holdReductionsH.push((realHoldSec - res.holdSec) / 3600);
        if (realWin && res.cfWin && res.holdSec < realHoldSec) a.winsAccelerated += 1;
        if (realWin && res.netR < realNetR) a.originalWinnersCutTooEarly += 1;
        if (realLoss && res.cfWin) a.originalLosersSaved += 1;
      }
    }
  }

  return variants.map((v, i) => {
    const a = acc[i]!;
    const econ = _economicsOfRs(a.cfNetRs);
    const real = _economicsOfRs(a.closedRealNetRs);
    const cfOnClosed = _economicsOfRs(a.closedCfNetRs);
    const expectancyDeltaR =
      cfOnClosed.netAvgR != null && real.netAvgR != null ? cfOnClosed.netAvgR - real.netAvgR : null;
    const mean = (xs: number[]) => (xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
    const p50 = _percentile(a.holdsSec, 0.5);
    const p90 = _percentile(a.holdsSec, 0.9);
    const avgHoldSec = mean(a.holdsSec);
    const closedSampleSize = a.closedRealNetRs.length;

    let verdict: FastTpVerdict;
    if (closedSampleSize < FASTTP_MIN_SAMPLE || expectancyDeltaR == null)
      verdict = "INSUFFICIENT_SAMPLE";
    else if (expectancyDeltaR >= FASTTP_PRESERVE_TOL_R) verdict = "PRESERVES_EXPECTANCY";
    else if (expectancyDeltaR >= FASTTP_GOOD_TOL_R) verdict = "GOOD_TRADEOFF";
    else if (expectancyDeltaR >= FASTTP_DEGRADE_TOL_R) verdict = "TRADEOFF";
    else verdict = "DEGRADES_EXPECTANCY";

    return {
      reportOnly: true,
      diagnosticOnly: true,
      variantId: v.id,
      triggerR: v.triggerR,
      partialFraction: v.partialFraction,
      runnerRule: v.runnerRule,
      trailDistanceR: v.trailDistanceR ?? null,
      sampleSize: a.cfNetRs.length,
      netAvgR: econ.netAvgR,
      pf: econ.pf,
      wr: econ.wr,
      avgHoldHours: avgHoldSec != null ? avgHoldSec / 3600 : null,
      p50HoldHours: p50 != null ? p50 / 3600 : null,
      p90HoldHours: p90 != null ? p90 / 3600 : null,
      holdReductionHours: mean(a.holdReductionsH),
      expectancyDeltaR,
      closedSampleSize,
      realNetAvgR: real.netAvgR,
      winsAccelerated: a.winsAccelerated,
      originalWinnersCutTooEarly: a.originalWinnersCutTooEarly,
      originalLosersSaved: a.originalLosersSaved,
      sameCandleAmbiguityCount: a.sameCandleAmbiguityCount,
      trailStopHitCount: a.trailStopHitCount,
      runnerToOriginalTargetCount: a.runnerToOriginalTargetCount,
      dataFailures: a.dataFailures,
      verdict,
    };
  });
}

/** Compact brief lines for the fast/tight-TP diagnostic. DIAGNOSTIC-ONLY. */
export function buildFastTpTightDiagnosticBriefLines(reports: FastTpVariantReport[]): string[] {
  const L: string[] = [];
  L.push(
    "   ── FAST/TIGHT-TP DIAGNOSTIC (DIAGNOSTIC-ONLY — counterfactual, excluded from headline) ──",
  );
  if (reports.length === 0) {
    L.push("   (no fast-TP diagnostic computed)");
    return L;
  }
  for (const r of reports) {
    const trail = r.trailDistanceR == null ? "" : `  trail=${r.trailDistanceR.toFixed(2)}R`;
    L.push(`   ${r.variantId}  verdict=${r.verdict}${trail}`);
    L.push(
      `      sample=${r.sampleSize} (closed=${r.closedSampleSize} dataFail=${r.dataFailures})` +
        `  net=${_r4(r.netAvgR)} PF=${_d2(r.pf)} WR=${_p1(r.wr)}  vs real-closed net=${_r4(r.realNetAvgR)}  ΔexpectancyR=${_r4(r.expectancyDeltaR)}`,
    );
    L.push(
      `      hold avg=${r.avgHoldHours == null ? "n/a" : r.avgHoldHours.toFixed(1) + "h"}` +
        ` p50=${r.p50HoldHours == null ? "n/a" : r.p50HoldHours.toFixed(1) + "h"}` +
        ` p90=${r.p90HoldHours == null ? "n/a" : r.p90HoldHours.toFixed(1) + "h"}` +
        ` holdReduction=${r.holdReductionHours == null ? "n/a" : r.holdReductionHours.toFixed(1) + "h"}`,
    );
    L.push(
      `      winsAccelerated=${r.winsAccelerated} winnersCutTooEarly=${r.originalWinnersCutTooEarly}` +
        ` losersSaved=${r.originalLosersSaved} sameCandleAmbiguity=${r.sameCandleAmbiguityCount}` +
        ` trailStopHit=${r.trailStopHitCount} runnerToOriginalTarget=${r.runnerToOriginalTargetCount}` +
        `  (real CG_WIDE exit untouched — diagnostic only)`,
    );
  }
  return L;
}

export interface FastTpRanking {
  bestByNetAvgR: string | null;
  bestByPF: string | null;
  bestByHoldReduction: string | null;
  bestBalancedTradeoff: string | null;
  /** balanced score per variant (variantId → score), for transparency. */
  balancedScores: Record<string, number>;
}

/**
 * Rank fast-TP variants. Balanced score (per spec):
 *   netAvgR*100 + PF*5 + holdReductionHours*2 − sameCandleAmbiguityCount.
 * PF is clamped to 10 in the balanced score so a no-loss Infinity PF cannot dominate;
 * bestByPF still reports the true (possibly Infinite) PF leader.
 */
export function rankFastTpReports(reports: FastTpVariantReport[]): FastTpRanking {
  const balancedScores: Record<string, number> = {};
  let bestNet: FastTpVariantReport | null = null;
  let bestPf: FastTpVariantReport | null = null;
  let bestHold: FastTpVariantReport | null = null;
  let bestBal: FastTpVariantReport | null = null;
  let bestBalScore = -Infinity;

  for (const r of reports) {
    if (r.netAvgR != null && (bestNet == null || r.netAvgR > (bestNet.netAvgR ?? -Infinity))) bestNet = r;
    if (r.pf != null && (bestPf == null || r.pf > (bestPf.pf ?? -Infinity))) bestPf = r;
    if (
      r.holdReductionHours != null &&
      (bestHold == null || r.holdReductionHours > (bestHold.holdReductionHours ?? -Infinity))
    )
      bestHold = r;

    const net = r.netAvgR ?? 0;
    const pfClamped = r.pf == null ? 0 : Math.min(r.pf, 10);
    const hr = r.holdReductionHours ?? 0;
    const score = net * 100 + pfClamped * 5 + hr * 2 - r.sameCandleAmbiguityCount;
    balancedScores[r.variantId] = Math.round(score * 100) / 100;
    if (score > bestBalScore) {
      bestBalScore = score;
      bestBal = r;
    }
  }

  return {
    bestByNetAvgR: bestNet?.variantId ?? null,
    bestByPF: bestPf?.variantId ?? null,
    bestByHoldReduction: bestHold?.variantId ?? null,
    bestBalancedTradeoff: bestBal?.variantId ?? null,
    balancedScores,
  };
}

/** Brief lines for the variant ranking. */
export function buildFastTpRankingBriefLines(
  reports: FastTpVariantReport[],
  ranking: FastTpRanking,
): string[] {
  const L: string[] = [];
  L.push("   ── FAST-TP RANKING ──");
  L.push(`      bestByNetAvgR=${ranking.bestByNetAvgR ?? "n/a"}`);
  L.push(`      bestByPF=${ranking.bestByPF ?? "n/a"}`);
  L.push(`      bestByHoldReduction=${ranking.bestByHoldReduction ?? "n/a"}`);
  L.push(`      bestBalancedTradeoff=${ranking.bestBalancedTradeoff ?? "n/a"}`);
  void reports;
  return L;
}

// ─── entry-quality / cohort diagnostic (DIAGNOSTIC-ONLY) ─────────────────────
//
// Pure store read (NO candle fetch): slices CG_WIDE closed-order economics by entry
// attributes to find which entries deserve admission, which are toxic, late, or only
// work in certain symbols/regimes. Report-only — never mutates the store, never feeds
// headline, never gates admission. Economics use REALIZED netR on closed (WIN/LOSS)
// orders; still-open orders only contribute an openCount per cohort.
//
// Note: scanAgeSec / candidateAgeSec are NOT persisted per order, so the latency
// dimension here is admissionDelaySec (createdAt − openedAt) — the one entry-latency
// signal the order actually carries. (Wiring scan/candidate age onto the order at
// admission time is a separate future change.)
//
// admissionDelayBucket is ALSO a label-leak axis, not just a latency one: openedAt is the
// observation instant the resolver anchors its candle walk on, while createdAt is when the
// label was written. A row in a high bucket had more price action resolvable before its own
// label existed. The bucket boundaries are unchanged; see BLOCK C of the latency corridor
// (resolvedBeforeDecisionCount) for the measured magnitude. The "skew(<0)" branch has never
// fired on real data — 29,968/29,968 testnet rows were positive on 2026-07-26.

/** Large-cap majors; everything else is treated as a high-beta alt. */
const COHORT_LARGE_CAP_SYMBOLS: ReadonlySet<string> = new Set([
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
]);

function _stopBucketFromBps(bps: number): string {
  if (!(bps > 0)) return "unknown";
  if (bps < 300) return "tight(<300)";
  if (bps < 600) return "mid(300-600)";
  if (bps < 900) return "wide(600-900)";
  return "very_wide(>=900)";
}

function _admissionDelayBucket(order: PaperOrder): string | null {
  // Same raw signed quantity the label-leak cohort reports — one source, no drift.
  const sec = _admissionDelaySec(order);
  if (sec === null) return null;
  if (sec < 0) return "skew(<0)";
  if (sec <= 60) return "<=60s";
  if (sec <= 180) return "60-180s";
  if (sec <= 300) return "180-300s";
  if (sec <= 600) return "300-600s";
  return ">600s";
}

function _hasReplayAllNegative(p: PaperOrderProvenance | null | undefined): boolean {
  if (!p) return false;
  const codes = [...(p.routeReasonCodes ?? []), ...(p.calibrationDiagnosisCodes ?? [])];
  return codes.some((c) => /ALL_REPLAY_VARIANTS_NEGATIVE/i.test(c));
}

/** Dimension extractors: order → cohort key (null = exclude from this dimension). */
const COHORT_EXTRACTORS: Record<string, (o: PaperOrder) => string | null> = {
  symbol: (o) => o.symbol,
  regime: (o) => o.regime ?? "unknown",
  direction: (o) => o.direction,
  hourOfDayUTC: (o) => {
    const h = new Date(o.openedAt).getUTCHours();
    return Number.isFinite(h) ? String(h).padStart(2, "0") + "h" : null;
  },
  dayOfWeekUTC: (o) => {
    const d = new Date(o.openedAt).getUTCDay();
    return Number.isFinite(d) ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]! : null;
  },
  stopBucket: (o) => o.provenance?.stopBucket ?? _stopBucketFromBps(o.plannedStopDistanceBps),
  admissionDelayBucket: (o) => _admissionDelayBucket(o),
  chaseRisk: (o) => o.provenance?.chaseRisk ?? "n/a",
  sourceConflict: (o) =>
    o.provenance?.sourceConflict == null ? "n/a" : o.provenance.sourceConflict ? "CONFLICT" : "clean",
  calibrationVerdict: (o) => o.provenance?.calibrationVerdict ?? "n/a",
  routeMode: (o) => o.provenance?.routeMode ?? "n/a",
  replayAllVariantsNegative: (o) => (_hasReplayAllNegative(o.provenance) ? "ALL_REPLAY_NEG" : "other"),
  capTier: (o) => (COHORT_LARGE_CAP_SYMBOLS.has(o.symbol) ? "LARGE_CAP" : "HIGH_BETA_ALT"),
};

export const ENTRY_COHORT_DIMENSIONS: readonly string[] = Object.keys(COHORT_EXTRACTORS);

export interface CohortStat {
  key: string;
  /** Closed (WIN/LOSS) orders in this cohort — the economics sample. */
  closed: number;
  /** Still-open orders in this cohort (not counted in economics). */
  openCount: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
  sumR: number;
}

export interface CohortDimension {
  dimension: string;
  cohorts: CohortStat[]; // sorted worst → best by netAvgR
}

export interface ToxicCohort {
  dimension: string;
  key: string;
  closed: number;
  netAvgR: number;
  sumR: number;
}

export interface EntryCohortDiagnosticReport {
  reportOnly: true;
  diagnosticOnly: true;
  totalClosed: number;
  totalOpen: number;
  baselineNetAvgR: number | null;
  baselinePF: number | null;
  baselineWR: number | null;
  dimensions: CohortDimension[];
  /** Cohorts with closed ≥ minSample and netAvgR < toxic threshold, worst (sumR) first. */
  toxicCohorts: ToxicCohort[];
}

function _cohortStat(key: string, nets: number[], openCount: number): CohortStat {
  const e = _economicsOfRs(nets);
  return {
    key,
    closed: nets.length,
    openCount,
    netAvgR: e.netAvgR,
    pf: e.pf,
    wr: e.wr,
    sumR: nets.reduce((s, v) => s + v, 0),
  };
}

/**
 * Pure entry-cohort breakdown. Slices realized closed-order economics by entry
 * attributes. Never mutates anything; report-only forensic output.
 */
export function buildEntryCohortDiagnostic(
  orders: PaperOrder[],
  opts: { dimensions?: string[]; minSampleForToxic?: number; toxicNetThreshold?: number } = {},
): EntryCohortDiagnosticReport {
  const minToxicN = opts.minSampleForToxic ?? 3;
  const toxicThresh = opts.toxicNetThreshold ?? -0.5;
  const dimNames = (opts.dimensions ?? ENTRY_COHORT_DIMENSIONS).filter((d) => d in COHORT_EXTRACTORS);

  const isClosedWithNet = (o: PaperOrder): boolean =>
    (o.paperStatus === "PAPER_CLOSED_WIN" || o.paperStatus === "PAPER_CLOSED_LOSS") &&
    typeof o.netR === "number" &&
    Number.isFinite(o.netR);
  const isOpen = (o: PaperOrder): boolean => !CLOSED_OR_TERMINAL_STATUSES.has(o.paperStatus);

  const baselineNets: number[] = [];
  let totalOpen = 0;
  for (const o of orders) {
    if (isClosedWithNet(o)) baselineNets.push(o.netR!);
    else if (isOpen(o)) totalOpen += 1;
  }
  const baseEcon = _economicsOfRs(baselineNets);

  const dimensions: CohortDimension[] = dimNames.map((name) => {
    const extractor = COHORT_EXTRACTORS[name]!;
    const map = new Map<string, { nets: number[]; open: number }>();
    for (const o of orders) {
      const key = extractor(o);
      if (key == null) continue;
      let g = map.get(key);
      if (!g) {
        g = { nets: [], open: 0 };
        map.set(key, g);
      }
      if (isClosedWithNet(o)) g.nets.push(o.netR!);
      else if (isOpen(o)) g.open += 1;
    }
    const cohorts = [...map.entries()]
      .map(([k, g]) => _cohortStat(k, g.nets, g.open))
      .sort((a, b) => (a.netAvgR ?? Infinity) - (b.netAvgR ?? Infinity));
    return { dimension: name, cohorts };
  });

  const toxicCohorts: ToxicCohort[] = [];
  for (const d of dimensions) {
    for (const c of d.cohorts) {
      if (c.closed >= minToxicN && c.netAvgR != null && c.netAvgR < toxicThresh) {
        toxicCohorts.push({
          dimension: d.dimension,
          key: c.key,
          closed: c.closed,
          netAvgR: c.netAvgR,
          sumR: c.sumR,
        });
      }
    }
  }
  toxicCohorts.sort((a, b) => a.sumR - b.sumR); // most damaging first

  return {
    reportOnly: true,
    diagnosticOnly: true,
    totalClosed: baselineNets.length,
    totalOpen,
    baselineNetAvgR: baseEcon.netAvgR,
    baselinePF: baseEcon.pf,
    baselineWR: baseEcon.wr,
    dimensions,
    toxicCohorts,
  };
}

/** Compact brief lines for the entry-cohort diagnostic. DIAGNOSTIC-ONLY. */
export function buildEntryCohortDiagnosticBriefLines(
  report: EntryCohortDiagnosticReport,
  opts: { maxPerDimension?: number } = {},
): string[] {
  const cap = opts.maxPerDimension ?? 8;
  const L: string[] = [];
  L.push("   ── ENTRY-QUALITY / COHORT DIAGNOSTIC (DIAGNOSTIC-ONLY — report-only, no admission gating) ──");
  L.push(
    `   baseline: closed=${report.totalClosed} open=${report.totalOpen}` +
      `  net=${_r4(report.baselineNetAvgR)} PF=${_d2(report.baselinePF)} WR=${_p1(report.baselineWR)}`,
  );
  const fmt = (c: CohortStat): string =>
    `${c.key}: n=${c.closed}${c.openCount ? `(+${c.openCount}o)` : ""} net=${_r4(c.netAvgR)} PF=${_d2(c.pf)} WR=${_p1(c.wr)} sumR=${_r4(c.sumR)}`;
  for (const d of report.dimensions) {
    L.push(`   • ${d.dimension} (${d.cohorts.length} cohorts):`);
    const shown = d.cohorts.length <= cap ? d.cohorts : d.cohorts.slice(0, Math.ceil(cap / 2));
    for (const c of shown) L.push(`      ${fmt(c)}`);
    if (d.cohorts.length > cap) {
      L.push(`      … +${d.cohorts.length - shown.length - Math.floor(cap / 2)} more …`);
      for (const c of d.cohorts.slice(-Math.floor(cap / 2))) L.push(`      ${fmt(c)}`);
    }
  }
  if (report.toxicCohorts.length > 0) {
    L.push(`   ⚠ toxicCohorts (closed≥3, netAvgR<-0.5, most damaging first):`);
    for (const t of report.toxicCohorts.slice(0, 12)) {
      L.push(`      ${t.dimension}=${t.key}: n=${t.closed} net=${_r4(t.netAvgR)} sumR=${_r4(t.sumR)}`);
    }
  } else {
    L.push(`   toxicCohorts: none (no cohort with closed≥3 & netAvgR<-0.5)`);
  }
  return L;
}

// ─── toxic-symbol gate simulation V1 (DIAGNOSTIC-ONLY) ───────────────────────
//
// Report-only "what if we'd filtered these entries out" simulation. Re-prices the
// CG_WIDE closed book under candidate ENTRY filters and reports the lift. It NEVER
// admits, mutates the store, activates a gate, touches headline, or goes live.
//
// HONESTY CAVEAT — most of these filters are IN-SAMPLE: the toxic symbol list and
// the net-negative threshold were derived from the very book being filtered, so a
// backtest "improvement" is partly survivorship/overfit. Structural filters (cap
// tier) generalize better than outcome-fitted ones. overfitRisk + recommendation
// encode this: nothing here is a green light to gate live — at most "test forward".

const TOXIC_EXACT_SYMBOLS: ReadonlySet<string> = new Set([
  "SEIUSDT",
  "WLDUSDT",
  "OPUSDT",
  "FETUSDT",
]);

export type ToxicGateId =
  | "EXCLUDE_EXACT_TOXIC_SYMBOLS"
  | "EXCLUDE_NET_NEG_SYMBOLS"
  | "LARGE_CAP_ONLY"
  | "EXCLUDE_HIGH_BETA_ALT"
  | "HYBRID_SAFE_FILTER";

export type ToxicGateOverfitRisk = "LOW" | "MEDIUM" | "HIGH";
export type ToxicGateRecommendation =
  | "DO_NOT_USE"
  | "WATCH"
  | "PROMISING"
  | "READY_FOR_FORWARD_PAPER";

export interface RemovedOrderRef {
  symbol: string;
  netR: number;
}

export interface ToxicGateReport {
  reportOnly: true;
  diagnosticOnly: true;
  gateId: ToxicGateId;
  description: string;
  // original (full book)
  originalClosed: number;
  originalNetAvgR: number | null;
  originalPF: number | null;
  originalWR: number | null;
  originalSumR: number;
  // filtered (retained book)
  filteredClosed: number;
  filteredNetAvgR: number | null;
  filteredPF: number | null;
  filteredWR: number | null;
  filteredSumR: number;
  // deltas
  tradesRemoved: number;
  winsSacrificed: number;
  lossesAvoided: number;
  netImprovementR: number; // filteredSumR − originalSumR (= −removedSumR)
  avgRImprovement: number; // filtered − original netAvgR
  pfImprovement: number | null; // null when either PF is non-finite
  wrChange: number | null;
  sampleRetentionPct: number;
  topRemovedWinners: RemovedOrderRef[];
  topAvoidedLosers: RemovedOrderRef[];
  overfitRisk: ToxicGateOverfitRisk;
  recommendation: ToxicGateRecommendation;
}

export interface ToxicSymbolGateDiagnosticReport {
  reportOnly: true;
  diagnosticOnly: true;
  totalClosed: number;
  gates: ToxicGateReport[];
  bestByNetImprovement: ToxicGateId | null;
  bestRecommendedGate: ToxicGateId | null;
}

function _provenancePositive(o: PaperOrder): boolean {
  const p = o.provenance;
  if (!p) return false;
  return (
    p.routeMode === "PROFIT_CANDIDATE" ||
    p.calibrationVerdict === "CALIBRATED_POSITIVE" ||
    p.primaryProfitEligible === true ||
    (typeof p.routeScore === "number" && p.routeScore > 0)
  );
}

interface _GateDef {
  id: ToxicGateId;
  description: string;
  baseOverfit: ToxicGateOverfitRisk;
  /** keep=true ⇒ entry retained. */
  keep: (o: PaperOrder, ctx: { netNegSymbols: ReadonlySet<string> }) => boolean;
}

const _TOXIC_GATE_DEFS: _GateDef[] = [
  {
    id: "EXCLUDE_EXACT_TOXIC_SYMBOLS",
    description: "drop SEI/WLD/OP/FET",
    baseOverfit: "MEDIUM",
    keep: (o) => !TOXIC_EXACT_SYMBOLS.has(o.symbol),
  },
  {
    id: "EXCLUDE_NET_NEG_SYMBOLS",
    description: "drop symbols with netAvgR<-0.5 & n>=5 (in-sample)",
    baseOverfit: "HIGH",
    keep: (o, ctx) => !ctx.netNegSymbols.has(o.symbol),
  },
  {
    id: "LARGE_CAP_ONLY",
    description: "keep only large-cap majors",
    baseOverfit: "LOW",
    keep: (o) => COHORT_LARGE_CAP_SYMBOLS.has(o.symbol),
  },
  {
    id: "EXCLUDE_HIGH_BETA_ALT",
    description: "drop all high-beta alts (≡ large-cap-only with binary capTier)",
    baseOverfit: "LOW",
    keep: (o) => COHORT_LARGE_CAP_SYMBOLS.has(o.symbol),
  },
  {
    id: "HYBRID_SAFE_FILTER",
    description: "drop exact toxic; keep alts only with positive provenance",
    baseOverfit: "MEDIUM",
    keep: (o) =>
      !TOXIC_EXACT_SYMBOLS.has(o.symbol) &&
      (COHORT_LARGE_CAP_SYMBOLS.has(o.symbol) || _provenancePositive(o)),
  },
];

function _bumpOverfit(r: ToxicGateOverfitRisk): ToxicGateOverfitRisk {
  return r === "LOW" ? "MEDIUM" : "HIGH";
}

function _gateRecommendation(
  filteredClosed: number,
  avgRImprovement: number,
  overfit: ToxicGateOverfitRisk,
  retentionPct: number,
): ToxicGateRecommendation {
  if (avgRImprovement <= 0) return "DO_NOT_USE";
  if (filteredClosed < 20) return "WATCH"; // too small to trust
  if (overfit === "LOW" && retentionPct >= 60 && avgRImprovement >= 0.1)
    return "READY_FOR_FORWARD_PAPER";
  if (overfit === "HIGH") return "WATCH"; // in-sample fit — must validate out-of-sample
  return "PROMISING";
}

const _RECO_RANK: Record<ToxicGateRecommendation, number> = {
  DO_NOT_USE: 0,
  WATCH: 1,
  PROMISING: 2,
  READY_FOR_FORWARD_PAPER: 3,
};

/**
 * Pure report-only entry-filter simulation. Re-prices the closed CG_WIDE book under
 * candidate symbol/cohort gates. Never mutates anything.
 */
export function buildToxicSymbolGateDiagnostic(
  orders: PaperOrder[],
  opts: { netNegMinSample?: number; netNegThreshold?: number } = {},
): ToxicSymbolGateDiagnosticReport {
  const netNegMin = opts.netNegMinSample ?? 5;
  const netNegThresh = opts.netNegThreshold ?? -0.5;

  const closed = orders.filter(
    (o) =>
      (o.paperStatus === "PAPER_CLOSED_WIN" || o.paperStatus === "PAPER_CLOSED_LOSS") &&
      typeof o.netR === "number" &&
      Number.isFinite(o.netR),
  );

  // per-symbol aggregate for the data-driven net-neg gate (in-sample by construction)
  const bySym = new Map<string, number[]>();
  for (const o of closed) {
    const arr = bySym.get(o.symbol) ?? [];
    arr.push(o.netR!);
    bySym.set(o.symbol, arr);
  }
  const netNegSymbols = new Set<string>();
  for (const [sym, nets] of bySym) {
    if (nets.length >= netNegMin) {
      const avg = nets.reduce((s, v) => s + v, 0) / nets.length;
      if (avg < netNegThresh) netNegSymbols.add(sym);
    }
  }

  const origEcon = _economicsOfRs(closed.map((o) => o.netR!));
  const origSum = closed.reduce((s, o) => s + o.netR!, 0);

  const gates: ToxicGateReport[] = _TOXIC_GATE_DEFS.map((def) => {
    const kept: PaperOrder[] = [];
    const removed: PaperOrder[] = [];
    for (const o of closed) {
      if (def.keep(o, { netNegSymbols })) kept.push(o);
      else removed.push(o);
    }
    const filtEcon = _economicsOfRs(kept.map((o) => o.netR!));
    const filtSum = kept.reduce((s, o) => s + o.netR!, 0);
    const winsSacrificed = removed.filter((o) => o.netR! > 0).length;
    const lossesAvoided = removed.filter((o) => o.netR! < 0).length;
    const retentionPct = closed.length > 0 ? (kept.length / closed.length) * 100 : 0;
    const avgRImprovement = (filtEcon.netAvgR ?? 0) - (origEcon.netAvgR ?? 0);
    const pfImprovement =
      filtEcon.pf != null &&
      Number.isFinite(filtEcon.pf) &&
      origEcon.pf != null &&
      Number.isFinite(origEcon.pf)
        ? (filtEcon.pf as number) - (origEcon.pf as number)
        : null;
    const wrChange =
      filtEcon.wr != null && origEcon.wr != null ? filtEcon.wr - origEcon.wr : null;

    let overfit = def.baseOverfit;
    if (retentionPct < 40) overfit = _bumpOverfit(overfit);

    const topRemovedWinners = removed
      .filter((o) => o.netR! > 0)
      .sort((a, b) => b.netR! - a.netR!)
      .slice(0, 5)
      .map((o) => ({ symbol: o.symbol, netR: o.netR! }));
    const topAvoidedLosers = removed
      .filter((o) => o.netR! < 0)
      .sort((a, b) => a.netR! - b.netR!)
      .slice(0, 5)
      .map((o) => ({ symbol: o.symbol, netR: o.netR! }));

    return {
      reportOnly: true,
      diagnosticOnly: true,
      gateId: def.id,
      description: def.description,
      originalClosed: closed.length,
      originalNetAvgR: origEcon.netAvgR,
      originalPF: origEcon.pf,
      originalWR: origEcon.wr,
      originalSumR: origSum,
      filteredClosed: kept.length,
      filteredNetAvgR: filtEcon.netAvgR,
      filteredPF: filtEcon.pf,
      filteredWR: filtEcon.wr,
      filteredSumR: filtSum,
      tradesRemoved: removed.length,
      winsSacrificed,
      lossesAvoided,
      netImprovementR: filtSum - origSum,
      avgRImprovement,
      pfImprovement,
      wrChange,
      sampleRetentionPct: retentionPct,
      topRemovedWinners,
      topAvoidedLosers,
      overfitRisk: overfit,
      recommendation: _gateRecommendation(kept.length, avgRImprovement, overfit, retentionPct),
    };
  });

  let bestByNet: ToxicGateReport | null = null;
  let bestReco: ToxicGateReport | null = null;
  for (const g of gates) {
    if (bestByNet == null || g.netImprovementR > bestByNet.netImprovementR) bestByNet = g;
    if (
      bestReco == null ||
      _RECO_RANK[g.recommendation] > _RECO_RANK[bestReco.recommendation] ||
      (_RECO_RANK[g.recommendation] === _RECO_RANK[bestReco.recommendation] &&
        g.netImprovementR > bestReco.netImprovementR)
    )
      bestReco = g;
  }

  return {
    reportOnly: true,
    diagnosticOnly: true,
    totalClosed: closed.length,
    gates,
    bestByNetImprovement: bestByNet?.gateId ?? null,
    bestRecommendedGate: bestReco?.gateId ?? null,
  };
}

/** Compact brief lines for the toxic-symbol gate simulation. DIAGNOSTIC-ONLY. */
export function buildToxicSymbolGateDiagnosticBriefLines(
  report: ToxicSymbolGateDiagnosticReport,
): string[] {
  const L: string[] = [];
  L.push(
    "   ── TOXIC-SYMBOL GATE SIM V1 (DIAGNOSTIC-ONLY — report-only, no active gate, in-sample) ──",
  );
  L.push(`   totalClosed=${report.totalClosed}`);
  for (const g of report.gates) {
    L.push(`   ${g.gateId}  recommendation=${g.recommendation}  overfitRisk=${g.overfitRisk}  (${g.description})`);
    L.push(
      `      original: n=${g.originalClosed} net=${_r4(g.originalNetAvgR)} PF=${_d2(g.originalPF)} WR=${_p1(g.originalWR)} sumR=${_r4(g.originalSumR)}`,
    );
    L.push(
      `      filtered: n=${g.filteredClosed} net=${_r4(g.filteredNetAvgR)} PF=${_d2(g.filteredPF)} WR=${_p1(g.filteredWR)} sumR=${_r4(g.filteredSumR)}  retention=${g.sampleRetentionPct.toFixed(0)}%`,
    );
    L.push(
      `      removed=${g.tradesRemoved} (winsSacrificed=${g.winsSacrificed} lossesAvoided=${g.lossesAvoided})` +
        `  netImprovementR=${_r4(g.netImprovementR)} avgRImprovement=${_r4(g.avgRImprovement)}` +
        ` ΔPF=${g.pfImprovement == null ? "n/a" : _d2(g.pfImprovement)} ΔWR=${g.wrChange == null ? "n/a" : _p1(g.wrChange)}`,
    );
  }
  L.push(`   bestByNetImprovement=${report.bestByNetImprovement ?? "n/a"}`);
  L.push(`   bestRecommendedGate=${report.bestRecommendedGate ?? "n/a"}`);
  L.push(`   ⚠ IN-SAMPLE: filters derived from this same book — validate forward before any real gate.`);
  return L;
}

// ─── signal-decay diagnostic V1 (DIAGNOSTIC-ONLY) ────────────────────────────
//
// Counterfactual ENTRY-TIME replay: does the CG_WIDE edge survive if admission is
// delayed or accelerated? Keeps the SAME symbol/direction/stop-TP GEOMETRY and exit
// rule; only shifts the entry timestamp by ±N minutes and re-prices the entry at the
// then-current price (1m candle), carrying the stop/TP at the same price-offsets.
//
// SAME isolation guarantees as the other replays: SAME orders, no admission, no store
// write, no force-close, no headline, no live. Fees + slippage use the shared model.
//
// Latency caveat: scanAge/candidateAge are not persisted per order, so the latency
// bucket breakdown uses admissionDelay (createdAt − openedAt). candidateAge buckets
// are omitted until that age is wired onto the order at admission time.

const DEFAULT_DECAY_OFFSETS_MIN = [-10, -5, -3, -1, 0, 1, 3, 5, 10];
const SIGNAL_DECAY_HORIZON_HOURS = 72;
const SIGNAL_DECAY_MIN_SAMPLE = 20;
const SIGNAL_DECAY_TOLERANT_R = -0.05; // delta ≥ this ⇒ tolerant
const SIGNAL_DECAY_MILD_R = -0.2; // delta ≥ this (and < tolerant) ⇒ mild

export type SignalDecayVerdict =
  | "LATENCY_TOLERANT"
  | "MILD_DECAY"
  | "SEVERE_DECAY"
  | "INSUFFICIENT_SAMPLE";

export interface SignalDecayOffsetReport {
  offsetMinutes: number;
  label: string;
  sampleSize: number;
  skipped: number;
  netAvgR: number | null;
  sumR: number;
  pf: number | null;
  wr: number | null;
  avgHoldHours: number | null;
  p50HoldHours: number | null;
  p90HoldHours: number | null;
  expectancyDeltaR: number | null; // vs ACTUAL
  decayPerMinuteR: number | null; // (offsetNet − actualNet)/offsetMinutes
  sameCandleAmbiguityCount: number;
  avgPriceDriftBps: number | null; // signed (newEntry − E)/E
  verdict: SignalDecayVerdict;
}

export interface SignalDecayBucket {
  dimension: string;
  key: string;
  sample: number;
  actualNetAvgR: number | null;
  lateNetAvgR: number | null;
  lateOffsetMinutes: number | null;
  decayPerMinuteR: number | null; // regression slope of netAvgR vs offset
}

export interface SignalDecayDiagnosticReport {
  reportOnly: true;
  diagnosticOnly: true;
  ordersConsidered: number;
  horizonHours: number;
  offsets: SignalDecayOffsetReport[];
  overallDecayPerMinuteR: number | null;
  latencyVerdict: SignalDecayVerdict;
  buckets: SignalDecayBucket[];
}

interface _DecaySim {
  netR: number;
  holdSec: number;
  driftBps: number;
  ambiguity: boolean;
}

/** Price at time t from 1m candles: covering candle close, else nearest at-or-before. */
function _priceAt1m(oneM: PaperKlineTuple[], t: number): number | null {
  let best: number | null = null;
  let bestOpen = -Infinity;
  for (const c of oneM) {
    const o = c[0];
    if (t >= o && t < o + 60_000) return Number(c[4]);
    if (o <= t && o > bestOpen) {
      bestOpen = o;
      best = Number(c[4]);
    }
  }
  return best;
}

function _linRegSlope(points: Array<[number, number]>): number | null {
  if (points.length < 2) return null;
  const n = points.length;
  const mx = points.reduce((s, p) => s + p[0], 0) / n;
  const my = points.reduce((s, p) => s + p[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of points) {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  return den > 0 ? num / den : null;
}

async function _simDecayOffset(
  order: PaperOrder,
  offsetMin: number,
  fiveM: PaperKlineTuple[],
  oneM: PaperKlineTuple[],
  client: PaperResolverClient,
  model: PaperExecutionModel,
  horizonMs: number,
  nowMs: number,
): Promise<_DecaySim | null> {
  const E = order.entryPrice;
  const S = order.stopLoss;
  const T = order.takeProfitLevels[0];
  const dir = order.direction;
  const risk = Math.abs(E - S);
  if (!(risk > 0) || T == null || !Number.isFinite(T)) return null;
  const openedAtMs = new Date(order.openedAt).getTime();
  if (!Number.isFinite(openedAtMs)) return null;

  const entryTimeMs = openedAtMs + offsetMin * 60_000;
  if (entryTimeMs > nowMs) return null; // can't enter in the future

  let newEntry: number;
  if (offsetMin === 0) newEntry = E;
  else {
    const p = _priceAt1m(oneM, entryTimeMs);
    if (p == null || !Number.isFinite(p)) return null; // no price path → skip
    newEntry = p;
  }
  const newStop = newEntry + (S - E); // preserve geometry (same price offsets)
  const newTP = newEntry + (T - E);
  const Ef = _entryFill(dir, newEntry, model.entrySlippageBps);
  // v2 exit-aware cost, matching what resolvePaperOrders now stores. These counterfactuals are
  // compared AGAINST the order's own stored netR (expectancyDeltaR = counterfactual − real), so a
  // v1 flat cost here would make the delta measure "policy change PLUS cost-model change". On a
  // maker-lane cohort that is a spurious −16bps/stopBps, several times the ±0.05R verdict
  // threshold. viaWalk=false: every branch below prices its own fills through `model`.
  const costTpLike = _computePaperExitCostR(order, "TP_LIKE", model, false);
  const costStopLike = _computePaperExitCostR(order, "STOP_LIKE", model, false);
  const costMtm = _computePaperExitCostR(order, "MARK_TO_MARKET", model, false);
  const driftBps = E !== 0 ? ((newEntry - E) / E) * 10_000 : 0;
  const endMs = Math.min(nowMs, entryTimeMs + horizonMs);

  let last: number | null = null;
  let amb = false;
  for (const c of fiveM) {
    const openMs = c[0];
    if (openMs < entryTimeMs - CANDLE_MS) continue;
    if (openMs > endMs) break;
    const high = Number(c[2]);
    const low = Number(c[3]);
    last = Number(c[4]);
    const slHit = dir === "SHORT" ? high >= newStop : low <= newStop;
    const tpHit = dir === "SHORT" ? low <= newTP : high >= newTP;
    const holdSec = Math.max(0, (openMs - entryTimeMs) / 1000);
    let exitAt: number | null = null;
    let isTp = false;
    if (slHit && tpHit) {
      amb = true;
      const refined = await _resolve1mForPaper(client, order.symbol, openMs, dir, newEntry, newStop, newTP);
      if (refined === "TP") {
        exitAt = newTP;
        isTp = true;
      } else exitAt = newStop; // SL or null → conservative stop-first
    } else if (slHit) exitAt = newStop;
    else if (tpHit) {
      exitAt = newTP;
      isTp = true;
    }
    if (exitAt != null) {
      const fill = _exitFill(dir, exitAt, isTp ? model.tpSlippageBps : model.stopSlippageBps);
      return {
        netR: _rewardR(dir, Ef, fill, risk) + (isTp ? costTpLike : costStopLike),
        holdSec,
        driftBps,
        ambiguity: amb,
      };
    }
  }
  if (last == null) return null; // no candles in window → skip
  const mtm = _rewardR(dir, Ef, _exitFill(dir, last, model.stopSlippageBps), risk);
  return { netR: mtm + costMtm, holdSec: (endMs - entryTimeMs) / 1000, driftBps, ambiguity: amb };
}

/**
 * Pure counterfactual entry-time decay diagnostic. Re-prices the SAME orders at
 * shifted entry timestamps. Never mutates the store; DIAGNOSTIC-ONLY economics.
 */
export async function buildSignalDecayDiagnostic(
  orders: PaperOrder[],
  client: PaperResolverClient,
  opts: {
    offsetsMinutes?: number[];
    executionModel?: PaperExecutionModel;
    horizonHours?: number;
    minSample?: number;
  } = {},
): Promise<SignalDecayDiagnosticReport> {
  const model = opts.executionModel ?? PAPER_EXECUTION_MODEL_IDEAL;
  const horizonMs = (opts.horizonHours ?? SIGNAL_DECAY_HORIZON_HOURS) * 3600 * 1000;
  const minSample = opts.minSample ?? SIGNAL_DECAY_MIN_SAMPLE;
  const nowMs = Date.now();
  const offsets = Array.from(new Set([...(opts.offsetsMinutes ?? DEFAULT_DECAY_OFFSETS_MIN), 0])).sort(
    (a, b) => a - b,
  );

  const per: Array<{ order: PaperOrder; byOffset: Map<number, _DecaySim | null> }> = [];
  for (const o of orders) {
    const openedAtMs = new Date(o.openedAt).getTime();
    if (!Number.isFinite(openedAtMs)) continue;
    const fiveStart = openedAtMs - 15 * 60_000;
    const fiveEnd = Math.min(nowMs, openedAtMs + horizonMs + 15 * 60_000);
    // Paginated: see _timeboxOutcomeForOrder. The 1m leg below stays a single call on purpose — its
    // window is a fixed ±11 minutes (30 rows), nowhere near the 1,000-row cap.
    let fiveM: PaperKlineTuple[];
    let oneM: PaperKlineTuple[];
    try {
      fiveM = await fetchPaperKlinesRange(client, o.symbol, "5m", fiveStart, fiveEnd);
      oneM = await client.getKlines(o.symbol, "1m", {
        startTime: openedAtMs - 11 * 60_000,
        endTime: openedAtMs + 11 * 60_000,
        limit: 30,
      });
    } catch {
      continue;
    }
    const byOffset = new Map<number, _DecaySim | null>();
    for (const off of offsets) {
      byOffset.set(off, await _simDecayOffset(o, off, fiveM ?? [], oneM ?? [], client, model, horizonMs, nowMs));
    }
    per.push({ order: o, byOffset });
  }

  const offsetEcon = (subset: typeof per, off: number) => {
    const nets: number[] = [];
    const holds: number[] = [];
    const drifts: number[] = [];
    let skipped = 0;
    let amb = 0;
    for (const p of subset) {
      const r = p.byOffset.get(off) ?? null;
      if (r == null) {
        skipped += 1;
        continue;
      }
      nets.push(r.netR);
      holds.push(r.holdSec);
      drifts.push(r.driftBps);
      if (r.ambiguity) amb += 1;
    }
    return { nets, holds, drifts, skipped, amb };
  };

  const actualAvg = _economicsOfRs(offsetEcon(per, 0).nets).netAvgR;

  const offsetReports: SignalDecayOffsetReport[] = offsets.map((off) => {
    const agg = offsetEcon(per, off);
    const econ = _economicsOfRs(agg.nets);
    const avgHoldSec = agg.holds.length ? agg.holds.reduce((s, v) => s + v, 0) / agg.holds.length : null;
    const p50 = _percentile(agg.holds, 0.5);
    const p90 = _percentile(agg.holds, 0.9);
    const expectancyDeltaR = econ.netAvgR != null && actualAvg != null ? econ.netAvgR - actualAvg : null;
    const decayPerMinuteR = off !== 0 && expectancyDeltaR != null ? expectancyDeltaR / off : null;
    let verdict: SignalDecayVerdict;
    if (agg.nets.length < minSample || expectancyDeltaR == null) verdict = "INSUFFICIENT_SAMPLE";
    else if (expectancyDeltaR >= SIGNAL_DECAY_TOLERANT_R) verdict = "LATENCY_TOLERANT";
    else if (expectancyDeltaR >= SIGNAL_DECAY_MILD_R) verdict = "MILD_DECAY";
    else verdict = "SEVERE_DECAY";
    return {
      offsetMinutes: off,
      label: off === 0 ? "ACTUAL" : off < 0 ? `EARLY_${-off}M` : `LATE_${off}M`,
      sampleSize: agg.nets.length,
      skipped: agg.skipped,
      netAvgR: econ.netAvgR,
      sumR: agg.nets.reduce((s, v) => s + v, 0),
      pf: econ.pf,
      wr: econ.wr,
      avgHoldHours: avgHoldSec != null ? avgHoldSec / 3600 : null,
      p50HoldHours: p50 != null ? p50 / 3600 : null,
      p90HoldHours: p90 != null ? p90 / 3600 : null,
      expectancyDeltaR,
      decayPerMinuteR,
      sameCandleAmbiguityCount: agg.amb,
      avgPriceDriftBps: agg.drifts.length ? agg.drifts.reduce((s, v) => s + v, 0) / agg.drifts.length : null,
      verdict,
    };
  });

  const overallDecayPerMinuteR = _linRegSlope(
    offsetReports.filter((r) => r.netAvgR != null).map((r) => [r.offsetMinutes, r.netAvgR as number]),
  );
  const maxLate = offsetReports.filter((r) => r.offsetMinutes > 0).at(-1);
  const latencyVerdict = maxLate?.verdict ?? "LATENCY_TOLERANT";

  // ── bucket breakdown ──
  const bucketDims: Array<{ dimension: string; key: (o: PaperOrder) => string | null }> = [
    { dimension: "symbol", key: (o) => o.symbol },
    { dimension: "toxicity", key: (o) => (TOXIC_EXACT_SYMBOLS.has(o.symbol) ? "TOXIC" : "NON_TOXIC") },
    { dimension: "capTier", key: (o) => (COHORT_LARGE_CAP_SYMBOLS.has(o.symbol) ? "LARGE_CAP" : "HIGH_BETA_ALT") },
    { dimension: "admissionDelayBucket", key: (o) => _admissionDelayBucket(o) },
  ];
  const buckets: SignalDecayBucket[] = [];
  const maxLateOff = maxLate?.offsetMinutes ?? null;
  for (const dim of bucketDims) {
    const groups = new Map<string, typeof per>();
    for (const p of per) {
      const k = dim.key(p.order);
      if (k == null) continue;
      const arr = groups.get(k) ?? [];
      arr.push(p);
      groups.set(k, arr);
    }
    for (const [key, subset] of groups) {
      const actualNet = _economicsOfRs(offsetEcon(subset, 0).nets).netAvgR;
      const lateNet = maxLateOff != null ? _economicsOfRs(offsetEcon(subset, maxLateOff).nets).netAvgR : null;
      const slope = _linRegSlope(
        offsets
          .map((off) => [off, _economicsOfRs(offsetEcon(subset, off).nets).netAvgR] as [number, number | null])
          .filter((pt): pt is [number, number] => pt[1] != null),
      );
      buckets.push({
        dimension: dim.dimension,
        key,
        sample: offsetEcon(subset, 0).nets.length,
        actualNetAvgR: actualNet,
        lateNetAvgR: lateNet,
        lateOffsetMinutes: maxLateOff,
        decayPerMinuteR: slope,
      });
    }
  }

  return {
    reportOnly: true,
    diagnosticOnly: true,
    ordersConsidered: per.length,
    horizonHours: opts.horizonHours ?? SIGNAL_DECAY_HORIZON_HOURS,
    offsets: offsetReports,
    overallDecayPerMinuteR,
    latencyVerdict,
    buckets,
  };
}

/** Compact brief lines for the signal-decay diagnostic. DIAGNOSTIC-ONLY. */
export function buildSignalDecayDiagnosticBriefLines(report: SignalDecayDiagnosticReport): string[] {
  const L: string[] = [];
  L.push("   ── SIGNAL-DECAY DIAGNOSTIC V1 (DIAGNOSTIC-ONLY — counterfactual entry-time replay) ──");
  L.push(
    `   ordersConsidered=${report.ordersConsidered} horizon=${report.horizonHours}h` +
      `  overallDecayPerMinuteR=${_r4(report.overallDecayPerMinuteR)}  latencyVerdict=${report.latencyVerdict}`,
  );
  for (const o of report.offsets) {
    L.push(
      `   ${o.label.padEnd(9)} n=${o.sampleSize}(skip=${o.skipped}) net=${_r4(o.netAvgR)} PF=${_d2(o.pf)} WR=${_p1(o.wr)}` +
        ` Δexp=${_r4(o.expectancyDeltaR)} decay/min=${_r4(o.decayPerMinuteR)} drift=${o.avgPriceDriftBps == null ? "n/a" : o.avgPriceDriftBps.toFixed(1) + "bps"}` +
        ` amb=${o.sameCandleAmbiguityCount} ${o.verdict}`,
    );
  }
  const nonSymbol = report.buckets.filter((b) => b.dimension !== "symbol");
  for (const b of nonSymbol) {
    L.push(
      `   • ${b.dimension}=${b.key}: n=${b.sample} actualNet=${_r4(b.actualNetAvgR)} lateNet=${_r4(b.lateNetAvgR)} decay/min=${_r4(b.decayPerMinuteR)}`,
    );
  }
  const symBuckets = report.buckets
    .filter((b) => b.dimension === "symbol" && b.decayPerMinuteR != null)
    .sort((a, b) => (a.decayPerMinuteR ?? 0) - (b.decayPerMinuteR ?? 0))
    .slice(0, 6);
  if (symBuckets.length > 0) {
    L.push(`   • most latency-sensitive symbols (worst decay/min first):`);
    for (const b of symBuckets) {
      L.push(`      ${b.key}: n=${b.sample} actualNet=${_r4(b.actualNetAvgR)} decay/min=${_r4(b.decayPerMinuteR)}`);
    }
  }
  L.push(`   (real CG_WIDE entries untouched — diagnostic only)`);
  return L;
}

// ─── regime × direction diagnostic V1 (DIAGNOSTIC-ONLY) ──────────────────────
//
// Pure store read: where does CG_WIDE actually work? Slices realized closed-order
// economics by regime / controllerMode / bias / direction / capTier / symbol and
// classifies each cohort. Report-only — never admits, mutates the store, gates, or
// goes live. ("bias" = provenance.kronosBias, the per-order external bias signal.)

export type RDConfidence = "INSUFFICIENT" | "WATCH" | "STRONG" | "TOXIC";
export type RDRecommendation =
  | "INSUFFICIENT_SAMPLE"
  | "KEEP_COLLECTING"
  | "PROMISING_FORWARD_PAPER"
  | "AVOID";

interface RDThresholds {
  minN: number;
  strongN: number;
  strongNet: number;
  strongPF: number;
  strongWR: number;
  toxicNet: number;
}
const RD_DEFAULT_THRESHOLDS: RDThresholds = {
  minN: 10,
  strongN: 20,
  strongNet: 0.3,
  strongPF: 2,
  strongWR: 0.6,
  toxicNet: -0.3,
};

export interface RDCohort {
  key: string;
  n: number;
  netAvgR: number | null;
  sumR: number;
  pf: number | null;
  wr: number | null;
  avgHoldHours: number | null;
  p50HoldHours: number | null;
  p90HoldHours: number | null;
  /** Number of losing closed trades in the cohort. */
  lossesContributed: number;
  /** Sum of negative R contributed by the cohort. */
  lossSumR: number;
  confidence: RDConfidence;
  recommendation: RDRecommendation;
}

export interface RDBreakdown {
  name: string;
  cohorts: RDCohort[];
}

export interface RegimeDirectionDiagnosticReport {
  reportOnly: true;
  diagnosticOnly: true;
  totalClosed: number;
  breakdowns: RDBreakdown[];
  conclusions: {
    bestRegimeDirection: string | null;
    worstRegimeDirection: string | null;
    hiddenLongCandidate: "YES" | "NO" | "INSUFFICIENT";
    bearishShortQuality: RDConfidence;
    mixedShortQuality: RDConfidence;
    largeCapShortQuality: RDConfidence;
    highBetaAltShortQuality: RDConfidence;
    suggestedForwardPaperGateCandidates: string[];
  };
}

function _rdStat(key: string, nets: number[], holdsH: number[], th: RDThresholds): RDCohort {
  const e = _economicsOfRs(nets);
  const n = nets.length;
  const sumR = nets.reduce((s, v) => s + v, 0);
  const lossSumR = nets.filter((v) => v < 0).reduce((s, v) => s + v, 0);
  const avgHoldHours = holdsH.length ? holdsH.reduce((s, v) => s + v, 0) / holdsH.length : null;

  let confidence: RDConfidence;
  if (n < th.minN) confidence = "INSUFFICIENT";
  else if (e.netAvgR != null && e.netAvgR < th.toxicNet) confidence = "TOXIC";
  else if (
    n >= th.strongN &&
    e.netAvgR != null &&
    e.netAvgR >= th.strongNet &&
    e.pf != null &&
    e.pf >= th.strongPF &&
    e.wr != null &&
    e.wr >= th.strongWR
  )
    confidence = "STRONG";
  else confidence = "WATCH";

  let recommendation: RDRecommendation;
  if (n < th.minN) recommendation = "INSUFFICIENT_SAMPLE";
  else if (confidence === "TOXIC") recommendation = "AVOID";
  else if (confidence === "STRONG") recommendation = "PROMISING_FORWARD_PAPER";
  else recommendation = "KEEP_COLLECTING";

  return {
    key,
    n,
    netAvgR: e.netAvgR,
    sumR,
    pf: e.pf,
    wr: e.wr,
    avgHoldHours,
    p50HoldHours: _percentile(holdsH, 0.5),
    p90HoldHours: _percentile(holdsH, 0.9),
    lossesContributed: nets.filter((v) => v < 0).length,
    lossSumR,
    confidence,
    recommendation,
  };
}

function _rdHoldHours(o: PaperOrder): number | null {
  const h = (new Date(o.updatedAt).getTime() - new Date(o.openedAt).getTime()) / 3_600_000;
  return Number.isFinite(h) && h >= 0 ? h : null;
}

/**
 * Pure regime × direction cohort diagnostic. Slices realized closed-order economics.
 * Never mutates anything; report-only forensic output.
 */
export function buildRegimeDirectionDiagnostic(
  orders: PaperOrder[],
  opts: { thresholds?: Partial<RDThresholds> } = {},
): RegimeDirectionDiagnosticReport {
  const th = { ...RD_DEFAULT_THRESHOLDS, ...opts.thresholds };
  const closed = orders.filter(
    (o) =>
      (o.paperStatus === "PAPER_CLOSED_WIN" || o.paperStatus === "PAPER_CLOSED_LOSS") &&
      typeof o.netR === "number" &&
      Number.isFinite(o.netR),
  );

  const regimeOf = (o: PaperOrder) => o.regime ?? "unknown";
  const biasOf = (o: PaperOrder) => o.provenance?.kronosBias ?? "n/a";
  const capOf = (o: PaperOrder) => (COHORT_LARGE_CAP_SYMBOLS.has(o.symbol) ? "LARGE_CAP" : "HIGH_BETA_ALT");
  const toxOf = (o: PaperOrder) => (TOXIC_EXACT_SYMBOLS.has(o.symbol) ? "TOXIC" : "NON_TOXIC");

  const mkCohorts = (keyFn: (o: PaperOrder) => string | null): RDCohort[] => {
    const map = new Map<string, { nets: number[]; holds: number[] }>();
    for (const o of closed) {
      const k = keyFn(o);
      if (k == null) continue;
      let g = map.get(k);
      if (!g) {
        g = { nets: [], holds: [] };
        map.set(k, g);
      }
      g.nets.push(o.netR!);
      const h = _rdHoldHours(o);
      if (h != null) g.holds.push(h);
    }
    return [...map.entries()]
      .map(([k, g]) => _rdStat(k, g.nets, g.holds, th))
      .sort((a, b) => (b.netAvgR ?? -Infinity) - (a.netAvgR ?? -Infinity));
  };

  const oneCohort = (key: string, filterFn: (o: PaperOrder) => boolean): RDCohort => {
    const sub = closed.filter(filterFn);
    return _rdStat(
      key,
      sub.map((o) => o.netR!),
      sub.map((o) => _rdHoldHours(o)).filter((v): v is number => v != null),
      th,
    );
  };

  const breakdowns: RDBreakdown[] = [
    { name: "regimeXdirection", cohorts: mkCohorts((o) => `${regimeOf(o)}|${o.direction}`) },
    { name: "controllerModeXdirection", cohorts: mkCohorts((o) => `${o.controllerMode}|${o.direction}`) },
    { name: "biasXdirection", cohorts: mkCohorts((o) => `${biasOf(o)}|${o.direction}`) },
    {
      name: "regimeXdirectionXcapTier",
      cohorts: mkCohorts((o) => `${regimeOf(o)}|${o.direction}|${capOf(o)}`),
    },
    {
      name: "regimeXdirectionXsymbol",
      cohorts: mkCohorts((o) => `${regimeOf(o)}|${o.direction}|${o.symbol}`),
    },
    {
      name: "toxicityByRegimeDirection",
      cohorts: mkCohorts((o) => `${toxOf(o)}|${regimeOf(o)}|${o.direction}`),
    },
    {
      name: "capTierByRegimeDirection",
      cohorts: mkCohorts((o) => `${capOf(o)}|${regimeOf(o)}|${o.direction}`),
    },
    { name: "longOnly", cohorts: mkCohorts((o) => (o.direction === "LONG" ? "LONG" : null)) },
    { name: "shortOnly", cohorts: mkCohorts((o) => (o.direction === "SHORT" ? "SHORT" : null)) },
  ];

  // ── conclusions ──
  const rXd = breakdowns.find((b) => b.name === "regimeXdirection")!.cohorts.filter((c) => c.n >= th.minN);
  const bestRegimeDirection = rXd.length > 0 ? rXd.reduce((a, b) => ((b.netAvgR ?? -Infinity) > (a.netAvgR ?? -Infinity) ? b : a)).key : null;
  const worstRegimeDirection = rXd.length > 0 ? rXd.reduce((a, b) => ((b.netAvgR ?? Infinity) < (a.netAvgR ?? Infinity) ? b : a)).key : null;

  const longCohort = oneCohort("LONG", (o) => o.direction === "LONG");
  const hiddenLongCandidate: "YES" | "NO" | "INSUFFICIENT" =
    longCohort.confidence === "INSUFFICIENT"
      ? "INSUFFICIENT"
      : longCohort.confidence === "STRONG"
        ? "YES"
        : "NO";

  const bearishShort = oneCohort("BEARISH|SHORT", (o) => o.direction === "SHORT" && /bear/i.test(regimeOf(o)));
  const mixedShort = oneCohort("MIXED|SHORT", (o) => o.direction === "SHORT" && /mix/i.test(regimeOf(o)));
  const largeCapShort = oneCohort("LARGE_CAP|SHORT", (o) => o.direction === "SHORT" && capOf(o) === "LARGE_CAP");
  const highBetaShort = oneCohort("HIGH_BETA_ALT|SHORT", (o) => o.direction === "SHORT" && capOf(o) === "HIGH_BETA_ALT");

  const suggestedSet = new Set<string>();
  for (const name of ["regimeXdirection", "capTierByRegimeDirection", "regimeXdirectionXcapTier"]) {
    for (const c of breakdowns.find((b) => b.name === name)!.cohorts) {
      if (c.recommendation === "PROMISING_FORWARD_PAPER") suggestedSet.add(c.key);
    }
  }
  if (largeCapShort.recommendation === "PROMISING_FORWARD_PAPER") suggestedSet.add(largeCapShort.key);
  if (bearishShort.recommendation === "PROMISING_FORWARD_PAPER") suggestedSet.add(bearishShort.key);

  return {
    reportOnly: true,
    diagnosticOnly: true,
    totalClosed: closed.length,
    breakdowns,
    conclusions: {
      bestRegimeDirection,
      worstRegimeDirection,
      hiddenLongCandidate,
      bearishShortQuality: bearishShort.confidence,
      mixedShortQuality: mixedShort.confidence,
      largeCapShortQuality: largeCapShort.confidence,
      highBetaAltShortQuality: highBetaShort.confidence,
      suggestedForwardPaperGateCandidates: [...suggestedSet].slice(0, 8),
    },
  };
}

/** Compact brief lines for the regime × direction diagnostic. DIAGNOSTIC-ONLY. */
export function buildRegimeDirectionDiagnosticBriefLines(
  report: RegimeDirectionDiagnosticReport,
  opts: { maxPerBreakdown?: number } = {},
): string[] {
  const cap = opts.maxPerBreakdown ?? 8;
  const L: string[] = [];
  L.push("   ── REGIME × DIRECTION DIAGNOSTIC V1 (DIAGNOSTIC-ONLY — report-only, no admission gating) ──");
  L.push(`   totalClosed=${report.totalClosed}`);
  const fmt = (c: RDCohort): string =>
    `${c.key}: n=${c.n} net=${_r4(c.netAvgR)} PF=${_d2(c.pf)} WR=${_p1(c.wr)} sumR=${_r4(c.sumR)}` +
    ` hold(p50=${c.p50HoldHours == null ? "n/a" : c.p50HoldHours.toFixed(1) + "h"})` +
    ` ${c.confidence}/${c.recommendation}`;
  for (const b of report.breakdowns) {
    L.push(`   • ${b.name} (${b.cohorts.length}):`);
    for (const c of b.cohorts.slice(0, cap)) L.push(`      ${fmt(c)}`);
    if (b.cohorts.length > cap) L.push(`      … +${b.cohorts.length - cap} more …`);
  }
  const k = report.conclusions;
  L.push("   ── CONCLUSIONS ──");
  L.push(`      bestRegimeDirection=${k.bestRegimeDirection ?? "n/a"}`);
  L.push(`      worstRegimeDirection=${k.worstRegimeDirection ?? "n/a"}`);
  L.push(`      hiddenLongCandidate=${k.hiddenLongCandidate}`);
  L.push(
    `      bearishShortQuality=${k.bearishShortQuality} mixedShortQuality=${k.mixedShortQuality}` +
      ` largeCapShortQuality=${k.largeCapShortQuality} highBetaAltShortQuality=${k.highBetaAltShortQuality}`,
  );
  L.push(
    `      suggestedForwardPaperGateCandidates=${k.suggestedForwardPaperGateCandidates.length ? k.suggestedForwardPaperGateCandidates.join(" ; ") : "none"}`,
  );
  return L;
}

// ─── forward-paper gate validation harness V1 (SHADOW LABEL — NOT an active gate) ─
//
// Stamps an out-of-sample shadow label on every NEW CG_WIDE paper order, then
// validates the proposed entry gate against the labeled book. This is NOT a gate:
// it NEVER blocks an order, changes admission, mutates headline metrics, creates
// real orders, enables live/micro-pilot, or writes shadow-positions.json. The label
// is additive report-only metadata persisted alongside the paper order; the existing
// CG_WIDE headline engine continues entirely unchanged (activeGateChange=NO).

export type ForwardGateDecision = "PASS" | "REJECT" | "INSUFFICIENT_CONTEXT";

export const FORWARD_GATE_ID = "NON_TOXIC_BEARISH_SHORT_V1";
export const FORWARD_GATE_VERSION = 1;
const FORWARD_GATE_CG_WIDE_LANE = "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE";
const FORWARD_GATE_MIN_OOS = 20; // labeled-closed sample below which we abstain
const FORWARD_GATE_READY_OOS = 50; // labeled-closed sample to consider promotion
const FORWARD_GATE_MIN_IMPROVEMENT_R = 0.1;

export interface ForwardGateEvaluation {
  forwardGateId: string;
  forwardGateVersion: number;
  forwardGateDecision: ForwardGateDecision;
  forwardGateReasons: string[];
  forwardGateCapTier: string | null;
  forwardGateIsToxicSymbol: boolean;
}

/**
 * Pure gate evaluator for NON_TOXIC_BEARISH_SHORT_V1. Never throws. Returns the
 * decision + reasons; callers decide whether to persist (label) or just report.
 */
export function evaluateForwardGate(input: {
  laneId: string | null | undefined;
  regime: string | null | undefined;
  direction: string | null | undefined;
  symbol: string | null | undefined;
}): ForwardGateEvaluation {
  const symbol = input.symbol ?? null;
  const regime = input.regime ?? null;
  const direction = input.direction ?? null;
  const laneId = input.laneId ?? null;
  const capTier = symbol ? (COHORT_LARGE_CAP_SYMBOLS.has(symbol) ? "LARGE_CAP" : "HIGH_BETA_ALT") : null;
  const isToxic = symbol ? TOXIC_EXACT_SYMBOLS.has(symbol) : false;
  const base = {
    forwardGateId: FORWARD_GATE_ID,
    forwardGateVersion: FORWARD_GATE_VERSION,
    forwardGateCapTier: capTier,
    forwardGateIsToxicSymbol: isToxic,
  };

  // INSUFFICIENT_CONTEXT when required metadata is missing.
  if (!symbol || !direction || !laneId || !regime) {
    return { ...base, forwardGateDecision: "INSUFFICIENT_CONTEXT", forwardGateReasons: ["MISSING_METADATA"] };
  }

  const reasons: string[] = [];
  if (laneId !== FORWARD_GATE_CG_WIDE_LANE) reasons.push("LANE_NOT_CG_WIDE");
  if (isToxic) reasons.push("TOXIC_SYMBOL");
  if (direction !== "SHORT") reasons.push("DIRECTION_NOT_SHORT");
  if (!/bear/i.test(regime)) reasons.push("REGIME_NOT_BEARISH");

  if (reasons.length === 0) {
    return { ...base, forwardGateDecision: "PASS", forwardGateReasons: ["NON_TOXIC_BEARISH_SHORT"] };
  }
  return { ...base, forwardGateDecision: "REJECT", forwardGateReasons: reasons };
}

/**
 * Additively stamp the forward-gate shadow label onto a NEW CG_WIDE paper order.
 * Only CG_WIDE-lane orders are labeled; everything else passes through untouched.
 * Never throws (admission must never break) and never changes any existing field.
 */
function _stampForwardGate(order: PaperOrder, now: string): PaperOrder {
  if (order.selectedLaneId !== FORWARD_GATE_CG_WIDE_LANE) return order;
  try {
    const e = evaluateForwardGate({
      laneId: order.selectedLaneId,
      regime: order.regime,
      direction: order.direction,
      symbol: order.symbol,
    });
    order.forwardGateId = e.forwardGateId;
    order.forwardGateVersion = e.forwardGateVersion;
    order.forwardGateDecision = e.forwardGateDecision;
    order.forwardGateReasons = e.forwardGateReasons;
    order.forwardGateEvaluatedAt = now;
    order.forwardGateCapTier = e.forwardGateCapTier;
    order.forwardGateIsToxicSymbol = e.forwardGateIsToxicSymbol;
  } catch {
    /* labeling must never break admission */
  }
  return order;
}

/** Exported test/diagnostic surface for the additive forward-gate stamper. */
export function stampForwardGateMetadata(order: PaperOrder, now: string): PaperOrder {
  return _stampForwardGate(order, now);
}

export type ForwardGateOOSConfidence =
  | "INSUFFICIENT"
  | "WATCH"
  | "PROMISING"
  | "READY_FOR_ACTIVE_PAPER_GATE";
export type ForwardGateRecommendation =
  | "KEEP_MEASURING"
  | "PROMOTE_TO_FORWARD_PAPER_BLOCKER"
  | "DO_NOT_USE";

export interface ForwardGateCohort {
  n: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
  sumR: number;
}

export interface ForwardGateSim {
  originalClosed: number;
  originalNetAvgR: number | null;
  originalPF: number | null;
  originalWR: number | null;
  originalSumR: number;
  passClosed: number;
  passNetAvgR: number | null;
  passPF: number | null;
  passWR: number | null;
  passSumR: number;
  tradesRemoved: number;
  winsSacrificed: number;
  lossesAvoided: number;
  netImprovementR: number;
  avgRImprovement: number;
  sampleRetentionPct: number;
}

export interface ForwardGateValidationReport {
  reportOnly: true;
  diagnosticOnly: true;
  /** ALWAYS "NO" — this harness never activates a gate. */
  activeGateChange: "NO";
  gateId: string;
  gateVersion: number;
  totalLabeled: number;
  closedLabeled: number;
  legacyUnlabeled: number;
  insufficientN: number;
  pass: ForwardGateCohort;
  reject: ForwardGateCohort;
  simulated: ForwardGateSim;
  oosConfidence: ForwardGateOOSConfidence;
  recommendation: ForwardGateRecommendation;
  /** Read-only in-sample reconstruction over legacy unlabeled orders. NOT persisted. */
  reconstructedInSample: { note: string; closed: number; simulated: ForwardGateSim };
}

const _closedWithNet = (o: PaperOrder): boolean =>
  (o.paperStatus === "PAPER_CLOSED_WIN" || o.paperStatus === "PAPER_CLOSED_LOSS") &&
  typeof o.netR === "number" &&
  Number.isFinite(o.netR);

function _fgCohort(orders: PaperOrder[]): ForwardGateCohort {
  const nets = orders.map((o) => o.netR!);
  const e = _economicsOfRs(nets);
  return { n: nets.length, netAvgR: e.netAvgR, pf: e.pf, wr: e.wr, sumR: nets.reduce((s, v) => s + v, 0) };
}

function _fgSim(closed: PaperOrder[], isPass: (o: PaperOrder) => boolean): ForwardGateSim {
  const orig = _fgCohort(closed);
  const passOrders = closed.filter(isPass);
  const removed = closed.filter((o) => !isPass(o));
  const pass = _fgCohort(passOrders);
  return {
    originalClosed: orig.n,
    originalNetAvgR: orig.netAvgR,
    originalPF: orig.pf,
    originalWR: orig.wr,
    originalSumR: orig.sumR,
    passClosed: pass.n,
    passNetAvgR: pass.netAvgR,
    passPF: pass.pf,
    passWR: pass.wr,
    passSumR: pass.sumR,
    tradesRemoved: removed.length,
    winsSacrificed: removed.filter((o) => o.netR! > 0).length,
    lossesAvoided: removed.filter((o) => o.netR! < 0).length,
    netImprovementR: pass.sumR - orig.sumR,
    avgRImprovement: (pass.netAvgR ?? 0) - (orig.netAvgR ?? 0),
    sampleRetentionPct: orig.n > 0 ? (pass.n / orig.n) * 100 : 0,
  };
}

/**
 * Validate the forward gate against the labeled paper book (OOS) plus a read-only
 * in-sample reconstruction over legacy orders. Pure — never mutates the store.
 */
export function buildForwardGateValidation(
  orders: PaperOrder[],
  opts: { gateId?: string } = {},
): ForwardGateValidationReport {
  const gateId = opts.gateId ?? FORWARD_GATE_ID;
  const cgWide = orders.filter((o) => o.selectedLaneId === FORWARD_GATE_CG_WIDE_LANE);
  const labeled = orders.filter((o) => o.forwardGateId === gateId && o.forwardGateDecision != null);
  const legacyUnlabeledOrders = cgWide.filter((o) => o.forwardGateId !== gateId);

  const labeledClosed = labeled.filter(_closedWithNet);
  const passClosed = labeledClosed.filter((o) => o.forwardGateDecision === "PASS");
  const rejectClosed = labeledClosed.filter((o) => o.forwardGateDecision === "REJECT");
  const insufficientN = labeledClosed.filter((o) => o.forwardGateDecision === "INSUFFICIENT_CONTEXT").length;

  const simulated = _fgSim(labeledClosed, (o) => o.forwardGateDecision === "PASS");

  // Read-only reconstruction over legacy unlabeled CG_WIDE closed orders (in-sample).
  const legacyClosed = legacyUnlabeledOrders.filter(_closedWithNet);
  const reconstructedSim = _fgSim(
    legacyClosed,
    (o) => evaluateForwardGate({ laneId: o.selectedLaneId, regime: o.regime, direction: o.direction, symbol: o.symbol }).forwardGateDecision === "PASS",
  );

  let oosConfidence: ForwardGateOOSConfidence;
  let recommendation: ForwardGateRecommendation;
  if (labeledClosed.length < FORWARD_GATE_MIN_OOS || passClosed.length < FORWARD_GATE_MIN_OOS) {
    oosConfidence = "INSUFFICIENT";
    recommendation = "KEEP_MEASURING";
  } else if (simulated.avgRImprovement <= 0) {
    oosConfidence = "WATCH";
    recommendation = "DO_NOT_USE";
  } else if (passClosed.length >= FORWARD_GATE_READY_OOS && simulated.avgRImprovement >= FORWARD_GATE_MIN_IMPROVEMENT_R) {
    oosConfidence = "READY_FOR_ACTIVE_PAPER_GATE";
    recommendation = "PROMOTE_TO_FORWARD_PAPER_BLOCKER";
  } else {
    oosConfidence = "PROMISING";
    recommendation = "KEEP_MEASURING";
  }

  return {
    reportOnly: true,
    diagnosticOnly: true,
    activeGateChange: "NO",
    gateId,
    gateVersion: FORWARD_GATE_VERSION,
    totalLabeled: labeled.length,
    closedLabeled: labeledClosed.length,
    legacyUnlabeled: legacyUnlabeledOrders.length,
    insufficientN,
    pass: _fgCohort(passClosed),
    reject: _fgCohort(rejectClosed),
    simulated,
    oosConfidence,
    recommendation,
    reconstructedInSample: {
      note: "LEGACY in-sample reconstruction — gate applied to pre-label orders, NOT persisted",
      closed: legacyClosed.length,
      simulated: reconstructedSim,
    },
  };
}

/** Compact Section-10-style brief lines for the forward gate harness. */
export function buildForwardGateValidationBriefLines(report: ForwardGateValidationReport): string[] {
  const s = report.simulated;
  const rc = report.reconstructedInSample.simulated;
  const L: string[] = [];
  L.push(`   forwardGate[${report.gateId}] (SHADOW LABEL — not an active gate):`);
  L.push(
    `      labeledClosed=${report.closedLabeled} legacyUnlabeled=${report.legacyUnlabeled} insufficient=${report.insufficientN}`,
  );
  L.push(
    `      passNet=${_r4(report.pass.netAvgR)} (n=${report.pass.n})  rejectNet=${_r4(report.reject.netAvgR)} (n=${report.reject.n})`,
  );
  L.push(
    `      simulatedImprovement: netImprovementR=${_r4(s.netImprovementR)} avgRImprovement=${_r4(s.avgRImprovement)}` +
      ` winsSacrificed=${s.winsSacrificed} lossesAvoided=${s.lossesAvoided} retention=${s.sampleRetentionPct.toFixed(0)}%`,
  );
  L.push(
    `      reconstructed(in-sample legacy): n=${report.reconstructedInSample.closed} passNet=${_r4(rc.passNetAvgR)}` +
      ` netImprovementR=${_r4(rc.netImprovementR)} (not persisted)`,
  );
  L.push(`      oosConfidence=${report.oosConfidence}  recommendation=${report.recommendation}  activeGateChange=NO`);
  return L;
}

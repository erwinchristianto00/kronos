/**
 * ADAPTIVE LANE ROUTER V1 (REPORT-ONLY)
 * Meta-controller that maps market regime → best candidate lane → permission
 * level. Pure read-only synthesis over existing evidence reports.
 *
 * HARD INVARIANTS (never violated by this module):
 *   - reportOnly: true on every report
 *   - liveBlocked: true            (never authorizes live trading)
 *   - microPilotAllowed: false     (never enables a micro pilot)
 *   - no I/O, no store writes, no behavior influence on any route/lane
 *
 * The router NEVER feeds back into the live-trading-gate blocker math or the
 * route promotion ladder. It is advisory display only.
 */

import type { RegimeDirectionControllerReport, RegimeDirectionMode } from "./regime-direction-controller.js";
import type { PostCutoverReport } from "./frozen-current-guard-post-cutover.js";
import {
  BULL_TREND_VARIANT_ID,
  MAX_DRAWDOWN_R_LIMIT,
  MAX_TOP_SYMBOL_SHARE,
  NET_STRONG_R,
  PAYOFF_STABLE,
  PF_STRONG,
  PROMOTION_MIN_FRESH,
  STABLE_MIN_FRESH,
  VARIANT_MATRIX_DEFINITIONS,
  WATCHABLE_MIN_FRESH,
  type ExactLaneContext,
  type CurrentGuardVariantMatrixReport,
} from "./current-guard-variant-matrix.js";
import type { LiveTradingGateReport } from "./live-trading-gate.js";
import type { PaperOrder } from "./paper-execution-router.js";
import { applySubFloorExclusionForDecisions } from "./paper-subfloor-exclusion.js";
import type { ShadowLaneScoreboard } from "./shadow-lane-scoreboard.js";

export const ADAPTIVE_LANE_ROUTER_LANE = "ADAPTIVE_LANE_ROUTER_V1" as const;
export const LONG_WIDE_PAPER_LANE_ID = "CG_LONG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE" as const;
export const BULL_TREND_PAPER_LANE_ID = `CG_LONG_VARIANT_MATRIX:${BULL_TREND_VARIANT_ID}` as const;

// ── public enums ──────────────────────────────────────────────────────────────

export type RouterPermission =
  | "NO_TRADE"
  | "SHADOW_ONLY"
  | "PAPER_ELIGIBLE"
  | "MICRO_PILOT_BLOCKED"
  | "LIVE_BLOCKED";

export type LaneMaturity =
  | "INSUFFICIENT"
  | "COLLECTING"
  | "WATCHABLE"
  | "STABLE_CANDIDATE"
  | "PROMOTION_CANDIDATE"
  | "REJECT";

export type RegimeFamily = "BEARISH" | "BULLISH" | "MIXED" | "CHOP" | "UNKNOWN";

export type LaneDirectionBias = "LONG" | "SHORT" | "NEUTRAL" | "UNKNOWN";

// ── candidate / ranked lane shapes ──────────────────────────────────────────────

export interface CandidateLane {
  laneId: string;
  source: string;
  directionBias: LaneDirectionBias;
  /** Regime family this lane carries evidence for; "ANY" = direction/regime-agnostic. */
  regimeFamily: RegimeFamily | "ANY";
  freshValid: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
  payoffRatio: number | null;
  oosAllPositive: boolean;
  plus10bpsPositive: boolean;
  /** Approx max drawdown in R (sign-agnostic; magnitude is used). */
  maxDrawdownR: number | null;
  /** Top-symbol PnL concentration as a fraction in [0,1]. */
  topSymbolShare: number | null;
  status: string;
  blockers: string[];
  /** True for W** controller-aligned parent / W*** filtered-edge negative lanes. */
  isLegacyNegative?: boolean;
}

export interface RankedCandidate {
  laneId: string;
  source: string;
  directionBias: LaneDirectionBias;
  regimeFamily: RegimeFamily | "ANY";
  freshValid: number;
  netAvgR: number | null;
  pf: number | null;
  payoffRatio: number | null;
  maturity: LaneMaturity;
  score: number;
  recommendable: boolean;
  regimeMatch: boolean;
  directionCompatible: boolean;
  rejectReasons: string[];
  /**
   * True when the lane has compelling net/PF statistics but OOS is not all
   * positive yet. High-upside but insufficiently confirmed — keep separate from
   * the primary advisory lane.
   */
  isExperimental: boolean;
  /**
   * True when the lane has at least one fresh-valid observation but already
   * fails the minimum economics gate (netAvgR>0, PF>1.2, plus10bps=true) and
   * is not experimental. Not selectable as primary advisory — surfaced in the
   * collectingWatchlist bucket for monitoring only.
   */
  isWatchlist: boolean;
}

export interface RegimePolicyEntry {
  regime: RegimeFamily;
  recommendedLaneId: string | null;
  permission: RouterPermission;
  note: string;
}

export interface AdaptiveLaneRouterReport {
  reportOnly: true;
  lane: typeof ADAPTIVE_LANE_ROUTER_LANE;
  generatedAt: string;
  currentRegime: string | null;
  regimeFamily: RegimeFamily;
  controllerMode: RegimeDirectionMode | string;
  /** The controller's graduated confidence for THIS report's regime read (HIGH/MEDIUM/LOW/DEGRADED),
   *  or null when the regime report is absent. Carried alongside controllerMode purely so downstream
   *  consumers that already persist controllerMode can persist the confidence that produced it —
   *  see paper-execution-router.ts's PaperOrder.controllerConfidence, which fed meta-label-gate.ts's
   *  controllerConf feature. That feature had 0% coverage (weight pinned to exactly 0.0000 across
   *  every refit) purely because this value was never threaded through, not because the signal is
   *  uninformative. Advisory/report-only like every other field on this report. */
  controllerConfidence: string | null;
  currentPermission: RouterPermission;
  selectedCurrentLane: string | null;
  selectedCurrentLaneReason: string;
  selectedCurrentLaneMaturity: LaneMaturity;
  perRegimePolicy: Record<RegimeFamily, RegimePolicyEntry>;
  rankedCandidates: RankedCandidate[];
  /** Lanes with compelling net/PF but OOS not fully confirmed — never selected as primary advisory. */
  experimentalUpsideCandidates: RankedCandidate[];
  /** Lanes that are still collecting but already show negative economics
   *  (netAvgR≤0, PF≤1.2, or plus10bps=false). Excluded from selection; shown
   *  in reports so operators know which lanes are trending negative early. */
  collectingWatchlist: RankedCandidate[];
  rejectedOrDeprioritizedLanes: RankedCandidate[];
  blockers: string[];
  nextRequiredEvidence: string[];
  warnings: string[];
  /**
   * When no direction-compatible lane exists for the current mode (e.g. no
   * LONG lane under LONG_ONLY), set to "COLLECT_LONG_EVIDENCE" or
   * "COLLECT_SHORT_EVIDENCE" as an advisory action hint.
   */
  collectionAction: string | null;
  /** Always true — the router never authorizes live trading. */
  liveBlocked: true;
  /** Always false — the router never enables a micro pilot. */
  microPilotAllowed: false;
}

// ── normalization helpers ───────────────────────────────────────────────────────

/** Map an arbitrary scan-regime string into a coarse regime family. */
export function normalizeRegimeFamily(raw: string | null | undefined): RegimeFamily {
  if (!raw) return "UNKNOWN";
  const s = raw.toLowerCase();
  if (s.includes("bear")) return "BEARISH";
  if (s.includes("bull")) return "BULLISH";
  if (s.includes("mix") || s.includes("rotat")) return "MIXED";
  if (s.includes("chop") || s.includes("range")) return "CHOP";
  return "UNKNOWN";
}

/** Whether a lane's direction is compatible with the active controller mode. */
export function directionCompatibleWithMode(
  bias: LaneDirectionBias,
  mode: RegimeDirectionMode | string,
): boolean {
  switch (mode) {
    case "LONG_ONLY":
      return bias === "LONG" || bias === "NEUTRAL";
    case "SHORT_ONLY":
      return bias === "SHORT" || bias === "NEUTRAL";
    case "BOTH_ALLOWED":
      return true;
    // VALIDATION_ONLY / NO_TRADE_CHOP / WAIT_* / UNKNOWN: nothing is paper/live
    // compatible, but lanes may still be surfaced as advisory candidates.
    default:
      return bias !== "UNKNOWN";
  }
}

function maturityRank(m: LaneMaturity): number {
  switch (m) {
    case "PROMOTION_CANDIDATE":
      return 4;
    case "STABLE_CANDIDATE":
      return 3;
    case "WATCHABLE":
      return 2;
    case "COLLECTING":
      return 1;
    case "INSUFFICIENT":
      return 0;
    case "REJECT":
      return -1;
  }
}

function drawdownAcceptable(maxDrawdownR: number | null): boolean {
  if (maxDrawdownR == null || !Number.isFinite(maxDrawdownR)) return true;
  return Math.abs(maxDrawdownR) <= MAX_DRAWDOWN_R_LIMIT;
}

function concentrationAcceptable(topSymbolShare: number | null): boolean {
  if (topSymbolShare == null || !Number.isFinite(topSymbolShare)) return true;
  return topSymbolShare <= MAX_TOP_SYMBOL_SHARE;
}

function isLegacyNegativeLane(lane: CandidateLane): boolean {
  if (lane.isLegacyNegative === true) return true;
  const id = (lane.laneId ?? "").toUpperCase();
  return (
    id.startsWith("W**") ||
    id.includes("FILTERED_EDGE") ||
    id.includes("FILTERED-EDGE") ||
    id.includes("CONTROLLER_ALIGNED") ||
    id.includes("CONTROLLER-ALIGNED")
  );
}

// ── maturity classification (pure) ──────────────────────────────────────────────

/**
 * Classify a candidate lane's maturity using the documented anti-overfit gates.
 * `infraReady` only matters for PROMOTION_CANDIDATE.
 */
export function classifyLaneMaturity(lane: CandidateLane, infraReady: boolean): LaneMaturity {
  if (isLegacyNegativeLane(lane)) return "REJECT";
  const st = (lane.status ?? "").toUpperCase();
  if (st === "REJECT" || st.includes("DEPRIORIT") || st.includes("NEGATIVE")) return "REJECT";

  const fv = lane.freshValid ?? 0;
  if (fv <= 0) return "INSUFFICIENT";
  if (fv < WATCHABLE_MIN_FRESH) return "COLLECTING";

  const netPos = (lane.netAvgR ?? -1) > 0;
  const pfStrong = (lane.pf ?? 0) > PF_STRONG;
  const plus10 = lane.plus10bpsPositive === true;
  const ddOk = drawdownAcceptable(lane.maxDrawdownR);
  const concOk = concentrationAcceptable(lane.topSymbolShare);

  // n>=50 but the core edge gates fail => negative/insufficient edge => REJECT.
  if (!netPos || !pfStrong || !plus10) return "REJECT";
  // Edge holds but concentration/drawdown not yet acceptable => keep COLLECTING.
  if (!concOk || !ddOk) return "COLLECTING";

  // WATCHABLE floor reached.
  if (fv >= STABLE_MIN_FRESH) {
    const stable =
      lane.oosAllPositive === true &&
      (lane.payoffRatio ?? 0) >= PAYOFF_STABLE &&
      (lane.netAvgR ?? 0) > NET_STRONG_R &&
      pfStrong &&
      plus10 &&
      ddOk;
    if (stable) {
      if (fv >= PROMOTION_MIN_FRESH && infraReady) return "PROMOTION_CANDIDATE";
      return "STABLE_CANDIDATE";
    }
  }
  return "WATCHABLE";
}

// ── scoring + ranking (pure) ─────────────────────────────────────────────────────

export interface LaneRankingContext {
  regimeFamily: RegimeFamily;
  controllerMode: RegimeDirectionMode | string;
  infraReady: boolean;
}

function scoreCandidate(lane: CandidateLane, ctx: LaneRankingContext): RankedCandidate {
  const maturity = classifyLaneMaturity(lane, ctx.infraReady);
  const regimeMatch = lane.regimeFamily === "ANY" || lane.regimeFamily === ctx.regimeFamily;
  const directionCompatible = directionCompatibleWithMode(lane.directionBias, ctx.controllerMode);
  const legacy = isLegacyNegativeLane(lane);

  const rejectReasons: string[] = [];
  if (legacy) rejectReasons.push("legacy negative lane (W** / W*** / filtered-edge)");
  if (maturity === "REJECT") rejectReasons.push("fails hard edge gates (netAvgR>0, PF>1.2, +10bps)");
  if (!directionCompatible)
    rejectReasons.push(`direction ${lane.directionBias} incompatible with mode ${ctx.controllerMode}`);

  const recommendable =
    !legacy && maturity !== "REJECT" && directionCompatible && maturityRank(maturity) >= 2;

  // Ranking priority (highest weight first):
  //  1 regime match  2 direction compat  3 maturity  4 OOS positive (stability gate)
  //  5 netAvgR  6 PF  7 payoffRatio  8 lower drawdown  9 lower concentration
  // OOS weight is 100 so a lane without full OOS confirmation can never outscore
  // a lower-net lane that has it — preserves stability-first ordering.
  const score =
    (regimeMatch ? 1000 : 0) +
    (directionCompatible ? 500 : 0) +
    maturityRank(maturity) * 80 +
    (lane.oosAllPositive ? 100 : 0) +
    (lane.netAvgR ?? 0) * 50 +
    (lane.pf ?? 0) * 10 +
    (lane.payoffRatio ?? 0) * 8 -
    Math.abs(lane.maxDrawdownR ?? 0) * 1 -
    (lane.topSymbolShare ?? 0) * 10;

  // Experimental: compelling stats (net/PF) but OOS not yet confirmed.
  // These lanes are surfaced separately and never selected as primary advisory.
  const hasCompellingStats = (lane.netAvgR ?? 0) > NET_STRONG_R && (lane.pf ?? 0) > PF_STRONG;
  const isExperimental =
    hasCompellingStats &&
    !lane.oosAllPositive &&
    maturity !== "REJECT" &&
    maturity !== "INSUFFICIENT";

  // Watchlist: has at least one observation but already shows negative economics.
  // Not experimental, not hard-rejected — monitoring bucket only.
  const hasEconomicSignal = (lane.freshValid ?? 0) > 0 && lane.netAvgR !== null;
  const failsMinEcon =
    hasEconomicSignal &&
    !((lane.netAvgR ?? 0) > 0 && (lane.pf ?? 0) > PF_STRONG && lane.plus10bpsPositive === true);
  const isWatchlist = !isExperimental && failsMinEcon && maturity !== "REJECT";

  return {
    laneId: lane.laneId,
    source: lane.source,
    directionBias: lane.directionBias,
    regimeFamily: lane.regimeFamily,
    freshValid: lane.freshValid,
    netAvgR: lane.netAvgR,
    pf: lane.pf,
    payoffRatio: lane.payoffRatio,
    maturity,
    score,
    recommendable,
    regimeMatch,
    directionCompatible,
    rejectReasons,
    isExperimental,
    isWatchlist,
  };
}

/**
 * Pure ranker. Partitions candidate lanes into four buckets, each sorted by
 * score descending:
 *   - ranked              : admissible, direction-compatible, OOS confirmed, passing min-econ gate
 *   - experimental        : admissible, direction-compatible, compelling stats but OOS unconfirmed
 *   - collectingWatchlist : admissible, direction-compatible, has data but failing min-econ gate
 *   - rejected            : REJECT maturity or direction-incompatible
 */
export function rankCandidateLanes(
  lanes: CandidateLane[],
  ctx: LaneRankingContext,
): {
  ranked: RankedCandidate[];
  experimental: RankedCandidate[];
  collectingWatchlist: RankedCandidate[];
  rejected: RankedCandidate[];
} {
  const scored = lanes.map((l) => scoreCandidate(l, ctx));
  const byScore = (a: RankedCandidate, b: RankedCandidate) => b.score - a.score;
  // Legacy negative lanes always classify to REJECT maturity, so the maturity
  // and direction-compat checks fully cover deprioritization.
  const isRejected = (c: RankedCandidate) => c.maturity === "REJECT" || !c.directionCompatible;
  const rejected = scored.filter(isRejected).sort(byScore);
  const notRejected = scored.filter((c) => !isRejected(c));
  // Experimental lanes have compelling stats but OOS not confirmed — keep
  // separate from the primary advisory bucket so they cannot be selected as the
  // primary advisory lane.
  const experimental = notRejected.filter((c) => c.isExperimental).sort(byScore);
  // Watchlist lanes have economic data but fail the min-econ gate and are not
  // experimental. Not selectable as primary advisory — monitoring only.
  const collectingWatchlist = notRejected
    .filter((c) => !c.isExperimental && c.isWatchlist)
    .sort(byScore);
  const ranked = notRejected
    .filter((c) => !c.isExperimental && !c.isWatchlist)
    .sort(byScore);
  return { ranked, experimental, collectingWatchlist, rejected };
}

// ── per-regime policy map ────────────────────────────────────────────────────────

const REGIME_PREF: Record<RegimeFamily, "LONG" | "SHORT" | null> = {
  BEARISH: "SHORT",
  BULLISH: "LONG",
  MIXED: null,
  CHOP: null,
  UNKNOWN: null,
};

function laneQualifiesForRegime(lane: RankedCandidate, regime: RegimeFamily): boolean {
  if (regime === "CHOP" || regime === "UNKNOWN") return false;
  const pref = REGIME_PREF[regime];
  if (pref === null) return lane.directionBias === "NEUTRAL"; // MIXED: neutral evidence only
  return lane.directionBias === pref || lane.directionBias === "NEUTRAL";
}

function buildRegimePolicyEntry(regime: RegimeFamily, ranked: RankedCandidate[]): RegimePolicyEntry {
  if (regime === "CHOP")
    return {
      regime,
      recommendedLaneId: null,
      permission: "NO_TRADE",
      note: "Choppy range — NO_TRADE; collect only if configured.",
    };
  if (regime === "UNKNOWN")
    return {
      regime,
      recommendedLaneId: null,
      permission: "NO_TRADE",
      note: "Unknown regime — diagnostic only, NO_TRADE.",
    };

  const qualifying = ranked.filter((l) => laneQualifiesForRegime(l, regime));
  const mature = qualifying.find((l) => maturityRank(l.maturity) >= 2);

  if (regime === "BULLISH") {
    if (mature)
      return {
        regime,
        recommendedLaneId: mature.laneId,
        permission: "SHADOW_ONLY",
        note: `Prefer LONG-compatible ${mature.laneId}; advisory shadow until STABLE + infra.`,
      };
    const collecting = qualifying[0] ?? null;
    if (collecting)
      return {
        regime,
        recommendedLaneId: collecting.laneId,
        permission: "SHADOW_ONLY",
        note: `Collect LONG OOS evidence in ${collecting.laneId}; paper diagnostic only until mature.`,
      };
    return {
      regime,
      recommendedLaneId: null,
      permission: "NO_TRADE",
      note: "No mature positive LONG lane — NO_TRADE / collect LONG evidence.",
    };
  }

  if (regime === "BEARISH") {
    const top = mature ?? qualifying[0] ?? null;
    if (mature)
      return {
        regime,
        recommendedLaneId: mature.laneId,
        permission: "SHADOW_ONLY",
        note: `Prefer SHORT-compatible ${mature.laneId}; advisory shadow until STABLE + infra.`,
      };
    return {
      regime,
      recommendedLaneId: top?.laneId ?? null,
      permission: top ? "SHADOW_ONLY" : "NO_TRADE",
      note: top
        ? `Strongest SHORT-compatible ${top.laneId} still ${top.maturity} (n<50) — shadow only.`
        : "No SHORT-compatible lane yet — collect evidence.",
    };
  }

  // MIXED: qualifying only contains NEUTRAL lanes. Also include bearish/SHORT
  // lanes as advisory (with a mismatch flag) so the map is still informative.
  const allForMixed = ranked.filter(
    (lane) =>
      lane.directionBias !== "UNKNOWN" &&
      (lane.regimeFamily === "ANY" || lane.regimeFamily === "MIXED"),
  );
  const mixedTop = (mature ?? qualifying[0]) || allForMixed[0] || null;
  return {
    regime,
    recommendedLaneId: mixedTop?.laneId ?? null,
    permission: mixedTop ? "SHADOW_ONLY" : "NO_TRADE",
    note:
      mixedTop && mixedTop.directionBias !== "NEUTRAL"
        ? `Advisory mismatch: ${mixedTop.laneId} is ${mixedTop.directionBias}-bias; MIXED = validation/shadow only — collect.`
        : "Mixed rotation — validation/shadow only; no live/paper without explicit positive mixed-regime evidence.",
  };
}

// ── current permission ───────────────────────────────────────────────────────────

/**
 * The live ceiling. TRUE = no lane may ever reach PAPER_ELIGIBLE; everything caps at SHADOW_ONLY.
 *
 * SAFETY INVARIANT: this can ONLY be lifted on TESTNET, and only with an explicit acknowledgement
 * token. Any non-testnet env (mainnet included) is ALWAYS blocked regardless of the token — the
 * live ceiling is hard there and cannot be flipped by an env var. Default (no env set) is blocked.
 * This preserves the original `const liveBlocked = true` behavior everywhere except a deliberately
 * configured testnet-live instance.
 */
export function resolveLiveBlocked(env: NodeJS.ProcessEnv = process.env): boolean {
  const tokenOk = env.LIVE_UNBLOCK_TESTNET === "I_UNDERSTAND_TESTNET_ORDERS";
  const isTestnet = (env.LIVE_BINANCE_ENV ?? "").trim().toLowerCase() === "testnet";
  return !(tokenOk && isTestnet);
}

function computeCurrentPermission(
  mode: RegimeDirectionMode | string,
  selected: RankedCandidate | null,
  infraReady: boolean,
): RouterPermission {
  const liveBlocked = resolveLiveBlocked(); // hard invariant unless testnet + explicit token

  if (mode === "NO_TRADE_CHOP" || mode === "UNKNOWN") return "NO_TRADE";
  if (mode === "VALIDATION_ONLY" || mode === "WAIT_RETEST_AFTER_DUMP" || mode === "WAIT_RETEST_AFTER_PUMP") {
    return selected ? "SHADOW_ONLY" : "NO_TRADE";
  }
  // LONG_ONLY / SHORT_ONLY / BOTH_ALLOWED
  // Even without a direction-compatible lane we stay in shadow-collecting mode,
  // not a hard NO_TRADE stop — the other-direction lanes keep collecting.
  if (!selected) return "SHADOW_ONLY";
  if (mode === "LONG_ONLY" && selected.directionBias === "LONG") return "SHADOW_ONLY";
  const mr = maturityRank(selected.maturity);
  if (mr >= 3 /* STABLE+ */ && infraReady && !liveBlocked) return "PAPER_ELIGIBLE"; // never while blocked
  if (mr >= 1 /* COLLECTING+ */) return "SHADOW_ONLY";
  return "NO_TRADE";
}

// ── candidate construction from evidence reports ─────────────────────────────────

function laneFromPostCutover(pc: PostCutoverReport): CandidateLane {
  return {
    laneId: "F_POST_CUTOVER",
    source: "POST_CUTOVER",
    // The current-guard post-cutover candidate is derived from the bearish-pressure
    // regime filter; classify SHORT so it is never selected as a LONG-compatible lane.
    directionBias: "SHORT",
    regimeFamily: "ANY",
    freshValid: pc.freshValid,
    netAvgR: pc.netAvgR,
    pf: pc.pf,
    wr: pc.wr,
    payoffRatio: null, // post-cutover report does not expose payoffRatio
    oosAllPositive: pc.allThreeSegmentsPositive,
    plus10bpsPositive: pc.plus10bpsStillPositive,
    maxDrawdownR: pc.approxMaxDrawdownR,
    topSymbolShare: pc.topSymbolPnlShare,
    status: pc.status,
    blockers: pc.blockers ?? [],
  };
}

function paperEvidenceForLane(
  laneId: string,
  orders: readonly PaperOrder[],
): Partial<CandidateLane> | null {
  // T1-b DECISION PATH (lane routing evidence) — gated, DEFAULT OFF. `stressedNetAvgR` below
  // divides by plannedStopDistanceBps, so sub-floor rows dominate the stress term as well as the
  // mean. With the flag off this is the caller's own array, unfiltered.
  const closed = applySubFloorExclusionForDecisions(orders)
    .filter(
      (order) =>
        order.selectedLaneId === laneId &&
        (order.paperStatus === "PAPER_CLOSED_WIN" || order.paperStatus === "PAPER_CLOSED_LOSS") &&
        typeof order.netR === "number" &&
        Number.isFinite(order.netR),
    )
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  if (closed.length === 0) return null;

  const nets = closed.map((order) => order.netR as number);
  const wins = nets.filter((value) => value > 0);
  const losses = nets.filter((value) => value < 0);
  const positive = wins.reduce((sum, value) => sum + value, 0);
  const negative = losses.reduce((sum, value) => sum + Math.abs(value), 0);
  const netAvgR = nets.reduce((sum, value) => sum + value, 0) / nets.length;
  const stressedNetAvgR = closed.reduce((sum, order) => {
    const stressR = order.plannedStopDistanceBps > 0 ? 10 / order.plannedStopDistanceBps : 0;
    return sum + (order.netR as number) - stressR;
  }, 0) / closed.length;
  const averageWin = wins.length > 0 ? positive / wins.length : 0;
  const averageLoss = losses.length > 0 ? negative / losses.length : 0;

  let cumulative = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const net of nets) {
    cumulative += net;
    peak = Math.max(peak, cumulative);
    maxDrawdownR = Math.max(maxDrawdownR, peak - cumulative);
  }

  const thirds = [0, 1, 2].map((index) => {
    const start = Math.floor((closed.length * index) / 3);
    const end = Math.floor((closed.length * (index + 1)) / 3);
    const slice = nets.slice(start, end);
    return slice.length > 0 ? slice.reduce((sum, value) => sum + value, 0) / slice.length : null;
  });
  const pnlBySymbol = new Map<string, number>();
  for (const order of closed) {
    pnlBySymbol.set(order.symbol, (pnlBySymbol.get(order.symbol) ?? 0) + (order.netR as number));
  }
  const positiveSymbolPnl = [...pnlBySymbol.values()].filter((value) => value > 0);
  const positiveTotal = positiveSymbolPnl.reduce((sum, value) => sum + value, 0);
  const topSymbolShare = positiveTotal > 0
    ? Math.max(...positiveSymbolPnl, 0) / positiveTotal
    : null;

  return {
    freshValid: closed.length,
    netAvgR,
    pf: negative > 0 ? positive / negative : positive > 0 ? Infinity : null,
    wr: wins.length / closed.length,
    payoffRatio: averageLoss > 0 ? averageWin / averageLoss : averageWin > 0 ? Infinity : null,
    oosAllPositive: closed.length >= 3 && thirds.every((value) => value !== null && value > 0),
    plus10bpsPositive: stressedNetAvgR > 0,
    maxDrawdownR,
    topSymbolShare,
    status: "COLLECTING",
    blockers: closed.length < WATCHABLE_MIN_FRESH
      ? [`paper OOS below WATCHABLE threshold (n=${closed.length}/${WATCHABLE_MIN_FRESH})`]
      : [],
  };
}

function lanesFromVariantMatrix(
  vm: CurrentGuardVariantMatrixReport,
  _paperOrders: readonly PaperOrder[],
): CandidateLane[] {
  const contextShape = (context: ExactLaneContext): Pick<CandidateLane, "directionBias" | "regimeFamily"> => {
    switch (context) {
      case "LONG_BULLISH": return { directionBias: "LONG", regimeFamily: "BULLISH" };
      case "SHORT_BEARISH": return { directionBias: "SHORT", regimeFamily: "BEARISH" };
      case "LONG_MIXED": return { directionBias: "LONG", regimeFamily: "MIXED" };
      case "SHORT_MIXED": return { directionBias: "SHORT", regimeFamily: "MIXED" };
    }
  };
  return vm.rows.flatMap((row) => {
    const definition = VARIANT_MATRIX_DEFINITIONS.find((candidate) => candidate.id === row.variantId);
    if (!definition) return [];
    return definition.applicableContexts.flatMap((context) => {
      const evidence = row.contextRows?.[context] ?? null;
      const shape = contextShape(context);
      const laneId = definition.longOnly
        ? `CG_LONG_VARIANT_MATRIX:${row.variantId}`
        : `CG_VARIANT_MATRIX:${row.variantId}`;
      // Fixed LONG-only research lanes pre-date the VM exact-context store. Their isolated paper
      // book is still a direction/regime-constrained observation source, so preserve it as a
      // compatibility bridge while generic geometries use only VM exact cohorts.
      const paperEvidence = definition.longOnly ? paperEvidenceForLane(laneId, _paperOrders) : null;
      if (!paperEvidence && evidence?.freshValid === 0 && !definition.longOnly) return [];
      return [{
        laneId,
        source: "VARIANT_MATRIX_EXACT_CONTEXT",
        ...shape,
        freshValid: paperEvidence?.freshValid ?? evidence?.freshValid ?? 0,
        netAvgR: paperEvidence?.netAvgR ?? evidence?.netAvgR ?? null,
        pf: paperEvidence?.pf ?? evidence?.pf ?? null,
        wr: paperEvidence?.wr ?? evidence?.wr ?? null,
        payoffRatio: paperEvidence?.payoffRatio ?? evidence?.payoffRatio ?? null,
        oosAllPositive: paperEvidence?.oosAllPositive ?? evidence?.allThreeOosPositive ?? false,
        plus10bpsPositive: paperEvidence?.plus10bpsPositive ?? evidence?.plus10bpsStillPositive ?? false,
        maxDrawdownR: paperEvidence?.maxDrawdownR ?? evidence?.approxMaxDrawdownR ?? null,
        topSymbolShare: paperEvidence?.topSymbolShare ?? evidence?.topSymbolPnlShare ?? null,
        status: paperEvidence?.status ?? evidence?.status ?? "COLLECTING",
        blockers: paperEvidence?.blockers ?? evidence?.blockers ?? ["missing exact-context evidence"],
      }];
    });
  });
}

function longPaperCollectionLane(paperOrders: readonly PaperOrder[]): CandidateLane {
  const paperEvidence = paperEvidenceForLane(LONG_WIDE_PAPER_LANE_ID, paperOrders);
  return {
    laneId: LONG_WIDE_PAPER_LANE_ID,
    source: "LONG_PAPER_DIAGNOSTIC",
    directionBias: "LONG",
    regimeFamily: "BULLISH",
    freshValid: paperEvidence?.freshValid ?? 0,
    netAvgR: paperEvidence?.netAvgR ?? null,
    pf: paperEvidence?.pf ?? null,
    wr: paperEvidence?.wr ?? null,
    payoffRatio: paperEvidence?.payoffRatio ?? null,
    oosAllPositive: paperEvidence?.oosAllPositive ?? false,
    plus10bpsPositive: paperEvidence?.plus10bpsPositive ?? false,
    maxDrawdownR: paperEvidence?.maxDrawdownR ?? null,
    topSymbolShare: paperEvidence?.topSymbolShare ?? null,
    status: paperEvidence?.status ?? "COLLECTING",
    blockers: paperEvidence?.blockers ?? ["LONG OOS evidence below WATCHABLE threshold (n<50)"],
  };
}

function legacyLanesFromScoreboard(sb: ShadowLaneScoreboard): CandidateLane[] {
  return sb.killedLanes.map((e) => ({
    laneId: e.laneId,
    source: "LEGACY_SCOREBOARD",
    directionBias: "UNKNOWN" as const,
    regimeFamily: "ANY" as const,
    freshValid: e.freshValidResolved,
    netAvgR: e.freshValidNetAvgR,
    pf: e.freshValidPF,
    wr: e.freshValidWR,
    payoffRatio: null,
    oosAllPositive: false,
    plus10bpsPositive: false,
    maxDrawdownR: null,
    topSymbolShare: null,
    status: "REJECT",
    blockers: e.killedReason ? [e.killedReason] : [],
    isLegacyNegative: true,
  }));
}

// ── main builder ─────────────────────────────────────────────────────────────────

export interface AdaptiveLaneRouterInputs {
  generatedAt: string;
  regimeReport: RegimeDirectionControllerReport | null;
  postCutoverReport?: PostCutoverReport;
  variantMatrixReport?: CurrentGuardVariantMatrixReport;
  gateReport: LiveTradingGateReport;
  scoreboardReport?: ShadowLaneScoreboard;
  /** Optional paper book used as the authoritative OOS source for LONG lanes. */
  paperOrders?: readonly PaperOrder[];
}

export function buildAdaptiveLaneRouterReport(
  inputs: AdaptiveLaneRouterInputs,
): AdaptiveLaneRouterReport {
  const { generatedAt, regimeReport, postCutoverReport, variantMatrixReport, gateReport } = inputs;

  const currentRegime = regimeReport?.currentRegime ?? null;
  const regimeFamily = normalizeRegimeFamily(currentRegime);
  const controllerMode: RegimeDirectionMode | string = regimeReport?.controllerMode ?? "UNKNOWN";
  const controllerConfidence: string | null = regimeReport?.confidence ?? null;

  const infraReady =
    gateReport.killSwitchReady === true &&
    gateReport.orderReconciliationReady === true &&
    gateReport.exchangeHealthReady === true;

  // Build candidate lanes from the evidence reports.
  const candidates: CandidateLane[] = [];
  if (postCutoverReport) candidates.push(laneFromPostCutover(postCutoverReport));
  const paperOrders = inputs.paperOrders ?? [];
  if (variantMatrixReport) candidates.push(...lanesFromVariantMatrix(variantMatrixReport, paperOrders));
  candidates.push(longPaperCollectionLane(paperOrders));
  if (inputs.scoreboardReport) candidates.push(...legacyLanesFromScoreboard(inputs.scoreboardReport));

  const { ranked, experimental, collectingWatchlist, rejected } = rankCandidateLanes(candidates, {
    regimeFamily,
    controllerMode,
    infraReady,
  });

  const selected = ranked[0] ?? null;

  // Advisory action when no direction-compatible lane exists under a direction-specific mode.
  const collectionAction: string | null =
    !selected && controllerMode === "LONG_ONLY"
      ? "COLLECT_LONG_EVIDENCE"
      : !selected && controllerMode === "SHORT_ONLY"
      ? "COLLECT_SHORT_EVIDENCE"
      : null;

  const currentPermission = computeCurrentPermission(controllerMode, selected, infraReady);
  const selectedCurrentLane = selected?.laneId ?? null;
  const selectedCurrentLaneMaturity: LaneMaturity = selected?.maturity ?? "INSUFFICIENT";
  const selectedCurrentLaneReason = selected
    ? `${selected.laneId}: top-ranked ${selected.directionBias} lane ` +
      `(compatible with ${controllerMode}); maturity=${selected.maturity}` +
      `, n=${selected.freshValid}; advisory ${currentPermission}.`
    : controllerMode === "LONG_ONLY"
    ? `No LONG-compatible lane is selectable yet; ${BULL_TREND_PAPER_LANE_ID} and ${LONG_WIDE_PAPER_LANE_ID} remain paper-diagnostic evidence collection only.`
    : controllerMode === "SHORT_ONLY"
    ? "No mature SHORT-compatible lane exists. Collecting SHORT evidence."
    : `No compatible candidate lane meets the WATCHABLE gates under mode ${controllerMode}; collecting evidence.`;

  // Per-regime policy is built from ALL advisory lanes (ranked + experimental +
  // non-REJECT rejected) so it is independent of the current controller mode
  // direction restriction.
  const allAdvisory = [...ranked, ...experimental, ...rejected].filter((c) => c.maturity !== "REJECT");

  const perRegimePolicy: Record<RegimeFamily, RegimePolicyEntry> = {
    BEARISH: buildRegimePolicyEntry("BEARISH", allAdvisory),
    BULLISH: buildRegimePolicyEntry("BULLISH", allAdvisory),
    MIXED: buildRegimePolicyEntry("MIXED", allAdvisory),
    CHOP: buildRegimePolicyEntry("CHOP", allAdvisory),
    UNKNOWN: buildRegimePolicyEntry("UNKNOWN", allAdvisory),
  };

  // Blockers (advisory). Live + micro stay hard-blocked, infra gates surfaced.
  const blockers: string[] = [
    "LIVE hard-blocked (liveBlocked=true) — router cannot authorize live trading.",
    "MICRO-PILOT disabled (microPilotAllowed=false).",
  ];
  const failingInfra: string[] = [];
  if (!gateReport.killSwitchReady) failingInfra.push("killSwitch");
  if (!gateReport.orderReconciliationReady) failingInfra.push("orderReconciliation");
  if (!gateReport.exchangeHealthReady) failingInfra.push("exchangeHealth");
  if (failingInfra.length > 0) blockers.push(`Infra gates FAIL: ${failingInfra.join(", ")}.`);
  if (selected) {
    const selCandidate = candidates.find((c) => c.laneId === selected.laneId);
    for (const b of (selCandidate?.blockers ?? []).slice(0, 2)) blockers.push(`${selected.laneId}: ${b}`);
  }

  // Next required evidence — scan ALL advisory lanes regardless of current mode.
  const nextRequiredEvidence: string[] = [];
  if (controllerMode === "LONG_ONLY" && selected?.directionBias === "LONG" && maturityRank(selected.maturity) < 2) {
    nextRequiredEvidence.push(
      `${selected.laneId}: collect bullish LONG paper OOS ${selected.freshValid}/${WATCHABLE_MIN_FRESH} -> WATCHABLE`,
    );
  } else if (collectionAction === "COLLECT_LONG_EVIDENCE") {
    nextRequiredEvidence.push("No LONG-compatible lane available — collect LONG evidence.");
  } else if (collectionAction === "COLLECT_SHORT_EVIDENCE") {
    nextRequiredEvidence.push("No SHORT-compatible lane available — collect SHORT evidence.");
  }
  for (const c of allAdvisory.slice(0, 3)) {
    const mr = maturityRank(c.maturity);
    if (mr >= 2) continue; // already WATCHABLE+
    if (c.freshValid < WATCHABLE_MIN_FRESH) {
      nextRequiredEvidence.push(`${c.laneId}: freshValid ${c.freshValid}/${WATCHABLE_MIN_FRESH} → WATCHABLE`);
    } else if (c.freshValid < STABLE_MIN_FRESH) {
      nextRequiredEvidence.push(`${c.laneId}: freshValid ${c.freshValid}/${STABLE_MIN_FRESH} → STABLE`);
    }
  }
  if (postCutoverReport && !postCutoverReport.allThreeSegmentsPositive) {
    nextRequiredEvidence.push("post-cutover: OOS thirds not all positive (need 3/3).");
  }
  if (nextRequiredEvidence.length === 0) {
    nextRequiredEvidence.push("Collect more fresh-valid observations; no lane is WATCHABLE yet.");
  }

  // Warnings.
  const warnings: string[] = ["All lanes report-only; router cannot authorize live/paper trading."];
  for (const w of regimeReport?.warnings ?? []) {
    if (w.toLowerCase().includes("cross-regime")) warnings.push(w);
  }
  // Direction / regime mismatch warnings.
  if (!selected && (controllerMode === "LONG_ONLY" || controllerMode === "SHORT_ONLY")) {
    const dir = controllerMode === "LONG_ONLY" ? "LONG" : "SHORT";
    warnings.push(
      `No ${dir}-compatible lane available under ${controllerMode}; CG/post-cutover lanes ` +
      `classified as bearish/SHORT evidence — regime mismatch with ${regimeFamily}.`,
    );
  }
  if (selected) {
    const pref = REGIME_PREF[regimeFamily];
    if (pref !== null && selected.directionBias !== "NEUTRAL" && selected.directionBias !== pref) {
      warnings.push(
        `Regime mismatch: selected lane bias=${selected.directionBias} vs ${regimeFamily} prefers ${pref}.`,
      );
    } else if (pref === null && selected.directionBias !== "NEUTRAL" && regimeFamily === "MIXED") {
      warnings.push(
        `Advisory lane ${selected.laneId} is ${selected.directionBias}-bias; MIXED regime expects neutral evidence — mismatch.`,
      );
    }
  }

  return {
    reportOnly: true,
    lane: ADAPTIVE_LANE_ROUTER_LANE,
    generatedAt,
    currentRegime,
    regimeFamily,
    controllerMode,
    controllerConfidence,
    currentPermission,
    selectedCurrentLane,
    selectedCurrentLaneReason,
    selectedCurrentLaneMaturity,
    perRegimePolicy,
    rankedCandidates: ranked,
    experimentalUpsideCandidates: experimental,
    collectingWatchlist,
    rejectedOrDeprioritizedLanes: rejected,
    blockers,
    nextRequiredEvidence,
    warnings,
    collectionAction,
    liveBlocked: true,
    microPilotAllowed: false,
  };
}

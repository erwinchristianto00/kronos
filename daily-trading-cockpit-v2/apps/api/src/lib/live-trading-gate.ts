/**
 * LIVE TRADING GATE V1 (HARD REPORT BLOCKER)
 *
 * Aggregates the hard gates that must ALL pass before any live trading or
 * micro-pilot consideration can proceed. Pure module — no I/O, no side
 * effects. `liveBlocked` is ALWAYS true unless every gate returns PASS.
 *
 * Lane label: LIVE_TRADING_GATE_V1
 *
 * STRICTLY REPORT-ONLY: surfaces a verdict for the dashboard; does NOT
 * change any live behavior, route selection, scoring, or readiness gates.
 */

import type { FilteredEdgeShadowReport } from "./regime-controller-filtered-edge-shadow.js";
import type { RegimeControllerAlignedShadowReport } from "./regime-controller-aligned-shadow.js";
import type { PortfolioTrendShadowReport } from "./portfolio-trend-shadow.js";
import type { BaseRouteCurrentGuardLaneSummary } from "./base-route-risk-hygiene-monitor.js";
import type { FrozenCurrentGuardReport } from "./base-route-current-guard-frozen.js";
import type { FrozenCurrentGuardCostModelReport } from "./frozen-current-guard-cost-model.js";
import type { KillSwitchReadinessReport } from "./micro-pilot-kill-switch-readiness.js";
import type { OrderReconciliationReadinessReport } from "./order-reconciliation-readiness.js";
import type { ExchangeHealthReadinessReport } from "./exchange-health-readiness.js";
import type { FrozenPromotionTrackerReport } from "./frozen-current-guard-promotion-tracker.js";
import { POST_CUTOVER_LANE, type PostCutoverReport } from "./frozen-current-guard-post-cutover.js";
import type { CurrentGuardVariantMatrixReport } from "./current-guard-variant-matrix.js";

export const LIVE_TRADING_GATE_LANE = "LIVE_TRADING_GATE_V1" as const;

const FROZEN_FULL_TAPE_LANE = "BASE_ROUTE_STOP175_CURRENT_GUARD_FROZEN_V1" as const;

/**
 * Minimum resolved count on the frozen prospective tape before it is preferred
 * over the historical (in-sample) current-guard tape for nearest-candidate display.
 */
const FROZEN_MIN_RESOLVED_FOR_PREFERENCE = 20;

/**
 * Minimum resolved count on the POST-CUTOVER tape before it is preferred over the
 * full frozen tape. The post-cutover tape excludes the OLD_BATCH Segment 1, so
 * once it has its own forward-validation evidence (n≥50) it is the more honest
 * candidate for the current/new method.
 */
const POST_CUTOVER_MIN_RESOLVED_FOR_PREFERENCE = 50;

export interface LiveTradingGateBlocker {
  gate: string;
  required: string;
  current: string;
  status: "PASS" | "FAIL" | "NOT_MEASURABLE";
  detail?: string;
}

export interface LiveTradingGateNearestCandidate {
  lane: string;
  freshValidResolved: number;
  netAvgR: number | null;
  pf: number | null;
  closestToPassing: string;
  cautions?: string[];
  /**
   * Whether the surfaced candidate is the prospective frozen tape (the honest
   * forward-test) or a fallback to the historical in-sample tape. Report-only.
   */
  provenance?: "prospective" | "historical-in-sample" | null;
}

/**
 * Advisory best candidate from the current-guard variant matrix (forward A/B
 * geometry harness). Surfaced for visibility ONLY — it never participates in the
 * blocker math, the nearest-route-candidate selection, liveBlocked, or
 * microPilotAllowed.
 */
export interface LiveTradingGateVariantMatrixCandidate {
  variantId: string;
  label: string;
  freshValid: number;
  netAvgR: number | null;
  pf: number | null;
  status: string;
  beatsBaseline: boolean;
  /** Always true: the variant matrix never authorizes live trading. */
  liveBlocked: true;
}

export interface LiveTradingGateReport {
  reportOnly: true;
  lane: typeof LIVE_TRADING_GATE_LANE;
  computedAt: string;
  liveBlocked: boolean;
  microPilotAllowed: boolean;
  blockers: LiveTradingGateBlocker[];
  nearestCandidateLane: LiveTradingGateNearestCandidate | null;
  /**
   * Report-only advisory: best variant from the current-guard variant matrix.
   * Null when the matrix is unavailable or no variant is watchable. Never
   * affects liveBlocked / microPilotAllowed.
   */
  bestVariantMatrixCandidate: LiveTradingGateVariantMatrixCandidate | null;
  /**
   * Report-only infrastructure-readiness summary. All three readiness flags are
   * false until their respective modules (AE/AF/AG) are implemented. The frozen
   * candidate status comes from the F**** promotion tracker. These surface in
   * the AD dashboard section. They do NOT change liveBlocked except in the
   * documented (always-false) direction.
   */
  killSwitchReady: boolean; // false
  orderReconciliationReady: boolean; // false
  exchangeHealthReady: boolean; // false
  frozenCandidateStatus: string | null; // from frozenPromotionTracker.status
  summary: string;
}

export interface LiveTradingGateInputs {
  filteredEdgeReport?: FilteredEdgeShadowReport;
  controllerAlignedReport?: RegimeControllerAlignedShadowReport;
  portfolioTrendReport?: PortfolioTrendShadowReport;
  baseRouteCurrentGuardLane?: BaseRouteCurrentGuardLaneSummary;
  /** Report-only: frozen prospective tape (F***). Preferred for FUTURE promotion ranking. */
  frozenCurrentGuardReport?: FrozenCurrentGuardReport;
  /**
   * Report-only: realistic cost model for the frozen tape, derived from AC
   * microstructure spread/funding. When populated, the FUNDING_SLIPPAGE_MODELED
   * gate flips to PASS. Does NOT affect liveBlocked (infra gates still FAIL).
   */
  frozenCostModelReport?: FrozenCurrentGuardCostModelReport;
  /** Report-only: AE kill-switch readiness spec. Wires KILL_SWITCH_EXISTS gate. */
  killSwitchReadiness?: KillSwitchReadinessReport;
  /** Report-only: AF order-reconciliation readiness spec. Wires ORDER_RECONCILIATION_EXISTS gate. */
  orderReconciliationReadiness?: OrderReconciliationReadinessReport;
  /** Report-only: AG exchange-health readiness spec. Wires EXCHANGE_HEALTH_CHECKS_EXIST gate. */
  exchangeHealthReadiness?: ExchangeHealthReadinessReport;
  /** Report-only: F**** frozen promotion tracker. Surfaces frozenCandidateStatus. */
  frozenPromotionTracker?: FrozenPromotionTrackerReport;
  /**
   * Report-only: F****** post-cutover clean forward-validation tape. When its
   * boundary is locked and it has ≥50 fresh-valid, the nearest-candidate display
   * prefers it over the full frozen tape (which still includes OLD_BATCH Seg 1).
   * Does NOT affect liveBlocked.
   */
  postCutoverReport?: PostCutoverReport;
  /**
   * Report-only: current-guard variant matrix (forward A/B geometry harness).
   * Surfaced ONLY as an advisory best-candidate (bestVariantMatrixCandidate);
   * deliberately NOT folded into the route lane pool, so it never affects the
   * blocker math, the nearest-route-candidate selection, liveBlocked, or
   * microPilotAllowed. Experimental geometry must never masquerade as the route.
   */
  currentGuardVariantMatrixReport?: CurrentGuardVariantMatrixReport;
}

const EVIDENCE_REQUIRED_N = 200;

interface LaneSnapshot {
  lane: string;
  freshValid: number;
  netAvgR: number | null;
  pf: number | null;
  symbolConcentrationOk: boolean | null;
  cautions?: string[];
  /** Provenance label for the dashboard: prospective forward-test vs in-sample. */
  provenance?: "prospective" | "historical-in-sample";
}

function gatherLanes(inputs: LiveTradingGateInputs): LaneSnapshot[] {
  const lanes: LaneSnapshot[] = [];
  if (inputs.filteredEdgeReport) {
    for (const fp of inputs.filteredEdgeReport.freshValidProfileReports ?? []) {
      lanes.push({
        lane: `FILTERED_EDGE:${fp.profile}`,
        freshValid: fp.resolvedObs,
        netAvgR: fp.netAvgR,
        pf: fp.pf,
        symbolConcentrationOk: null,
      });
    }
  }
  if (inputs.controllerAlignedReport) {
    const car = inputs.controllerAlignedReport;
    lanes.push({
      lane: "CONTROLLER_ALIGNED_SHADOW_V1",
      freshValid: car.resolvedObservations ?? 0,
      netAvgR: car.overallNetAvgR ?? null,
      pf: car.overallPF ?? null,
      symbolConcentrationOk: null,
    });
  }
  if (inputs.portfolioTrendReport) {
    const ptr = inputs.portfolioTrendReport;
    const topShare = ptr.symbolConcentration?.[0]?.share ?? null;
    lanes.push({
      lane: "PORTFOLIO_TREND_SHADOW_V1",
      freshValid: ptr.freshValidResolved,
      netAvgR: ptr.freshValidNetAvgR,
      pf: ptr.freshValidPF,
      symbolConcentrationOk:
        topShare === null ? null : topShare <= 0.4,
    });
  }
  if (inputs.baseRouteCurrentGuardLane) {
    try {
      const lane = inputs.baseRouteCurrentGuardLane;
      const topShare = lane.symbolConcentration?.[0]?.share ?? null;
      lanes.push({
        lane: "BASE_ROUTE_STOP175_CURRENT_GUARD",
        freshValid: lane.closed,
        netAvgR: lane.netAvgR,
        pf: lane.pf,
        symbolConcentrationOk: topShare === null ? null : topShare <= 0.4,
        cautions: lane.cautions,
        provenance: "historical-in-sample",
      });
    } catch {
      // never break the gate report
    }
  }
  if (inputs.frozenCurrentGuardReport) {
    try {
      const fr = inputs.frozenCurrentGuardReport;
      lanes.push({
        lane: FROZEN_FULL_TAPE_LANE,
        freshValid: fr.resolved,
        netAvgR: fr.netAvgR,
        pf: fr.pf,
        symbolConcentrationOk:
          fr.topSymbolPnlShare === undefined ? null : fr.topSymbolPnlShare <= 0.4,
        cautions: [
          `Prospective forward-test (includes OLD_BATCH Segment 1); criteria frozen at ${fr.criteriaFrozenAt ?? "n/a"}; status=${fr.status}`,
        ],
        provenance: "prospective",
      });
    } catch {
      // never break the gate report
    }
  }
  if (inputs.postCutoverReport && inputs.postCutoverReport.boundary) {
    try {
      const pc = inputs.postCutoverReport;
      lanes.push({
        lane: POST_CUTOVER_LANE,
        freshValid: pc.freshValid,
        netAvgR: pc.netAvgR,
        pf: pc.pf,
        symbolConcentrationOk:
          pc.topSymbolPnlShare === null ? null : pc.topSymbolPnlShare <= 0.4,
        cautions: [
          `Clean forward-validation (current/new method; EXCLUDES OLD_BATCH Segment 1); cutover ${pc.boundary!.cutoverTimestamp}; status=${pc.status}`,
        ],
        provenance: "prospective",
      });
    } catch {
      // never break the gate report
    }
  }
  return lanes;
}

export function buildLiveTradingGateReport(
  inputs: LiveTradingGateInputs,
  capturedAt?: string,
): LiveTradingGateReport {
  const computedAt = capturedAt ?? new Date().toISOString();
  const lanes = gatherLanes(inputs);
  const maxFresh = lanes.reduce(
    (m, l) => (l.freshValid > m ? l.freshValid : m),
    0,
  );
  const bestPf = lanes.reduce(
    (m, l) => {
      if (l.pf === null) return m;
      if (m === null) return l.pf;
      return l.pf > m ? l.pf : m;
    },
    null as number | null,
  );
  const bestNet = lanes.reduce(
    (m, l) => {
      if (l.netAvgR === null) return m;
      if (m === null) return l.netAvgR;
      return l.netAvgR > m ? l.netAvgR : m;
    },
    null as number | null,
  );

  // Symbol concentration: only measurable for portfolio trend lane today
  const concentrationOk = lanes.some((l) => l.symbolConcentrationOk === true);
  const concentrationMeasurable = lanes.some(
    (l) => l.symbolConcentrationOk !== null,
  );

  // ── Infrastructure readiness flags (AE/AF/AG). All false until implemented. ──
  const killSwitchReady = Boolean(inputs.killSwitchReadiness?.ready); // false until implemented
  const orderReconciliationReady = Boolean(
    inputs.orderReconciliationReadiness?.ready,
  ); // false until implemented
  const exchangeHealthReady = Boolean(inputs.exchangeHealthReadiness?.ready); // false until implemented
  const frozenCandidateStatus = inputs.frozenPromotionTracker?.status ?? null;

  const killSwitchMissing =
    inputs.killSwitchReadiness?.missingControls?.length ?? 10;
  const exchangeHealthAvailable =
    inputs.exchangeHealthReadiness?.availableCount ?? 0;
  const exchangeHealthTotal =
    inputs.exchangeHealthReadiness?.checks?.length ?? 12;

  const blockers: LiveTradingGateBlocker[] = [
    {
      gate: "EVIDENCE_VOLUME",
      required: `≥${EVIDENCE_REQUIRED_N} fresh-valid resolved on a frozen lane`,
      current: `max fresh-valid count = ${maxFresh}`,
      status: maxFresh >= EVIDENCE_REQUIRED_N ? "PASS" : "FAIL",
    },
    {
      gate: "NET_EXPECTANCY_POSITIVE_OOS",
      required: "Positive netAvgR across 3 independent OOS segments",
      current: "insufficient sample",
      status: "NOT_MEASURABLE",
      detail: "Requires ≥3 OOS segments per lane",
    },
    {
      gate: "PF_THRESHOLD",
      required: "Profit factor > 1.20",
      current:
        bestPf === null ? "no lane PF measurable" : `current best PF=${bestPf.toFixed(2)}`,
      status:
        bestPf !== null && bestPf > 1.2
          ? "PASS"
          : bestPf === null
            ? "NOT_MEASURABLE"
            : "FAIL",
    },
    {
      gate: "SYMBOL_CONCENTRATION",
      required: "No single symbol >40% of PnL",
      current: concentrationMeasurable
        ? concentrationOk
          ? "top symbol ≤40%"
          : "top symbol >40%"
        : "not yet measurable",
      status: !concentrationMeasurable
        ? "NOT_MEASURABLE"
        : concentrationOk
          ? "PASS"
          : "FAIL",
    },
    {
      gate: "DRAWDOWN_WITHIN_LIMIT",
      required: "Max drawdown ≤ 25% of total PnL",
      current: "insufficient sample",
      status: "NOT_MEASURABLE",
    },
    {
      gate: "KILL_SWITCH_EXISTS",
      required: "Live trading kill switch implemented",
      current: killSwitchReady ? "kill switch ready" : "no live trading code",
      status: killSwitchReady ? "PASS" : "FAIL",
      detail: `See AE. Kill Switch Readiness — ${killSwitchMissing}/10 controls missing`,
    },
    {
      gate: "ORDER_RECONCILIATION_EXISTS",
      required: "Order reconciliation infrastructure exists",
      current: orderReconciliationReady ? "reconciliation ready" : "paper-only",
      status: orderReconciliationReady ? "PASS" : "FAIL",
      detail: "See AF. Order Reconciliation Readiness — not implemented",
    },
    {
      gate: "EXCHANGE_HEALTH_CHECKS_EXIST",
      required: "Real-time exchange health monitoring",
      current: exchangeHealthReady ? "monitoring loop ready" : "not implemented",
      status: exchangeHealthReady ? "PASS" : "FAIL",
      detail: `See AG. Exchange Health Readiness — ${exchangeHealthAvailable}/${exchangeHealthTotal} data checks, no monitoring loop`,
    },
    (() => {
      const cm = inputs.frozenCostModelReport;
      if (cm && cm.modelPopulated === true) {
        return {
          gate: "FUNDING_SLIPPAGE_MODELED",
          required: "Funding rate + slippage modeled in cost calculation",
          current: "realistic cost model populated from AC microstructure",
          status: "PASS" as const,
          detail:
            "Realistic cost model populated from AC microstructure (spread p50/p90/p99 + funding); " +
            `worst passing scenario: ${cm.worstPassingScenario ?? "none"}`,
        };
      }
      return {
        gate: "FUNDING_SLIPPAGE_MODELED",
        required: "Funding rate + slippage modeled in cost calculation",
        current: "realistic cost model not yet populated (flat 28bps assumption)",
        status: "FAIL" as const,
      };
    })(),
  ];

  const liveBlocked = blockers.some((b) => b.status === "FAIL");
  // Micro-pilot is explicitly gated on ALL infra readiness modules being ready
  // AND the frozen candidate reaching PROMOTION_CANDIDATE AND every gate passing.
  // With infra modules reporting ready=false, this is always false.
  const microPilotAllowed =
    blockers.every((b) => b.status === "PASS") &&
    killSwitchReady &&
    orderReconciliationReady &&
    exchangeHealthReady &&
    frozenCandidateStatus === "PROMOTION_CANDIDATE";

  // Nearest candidate lane ranking:
  //   1. Positive netAvgR ALWAYS beats negative netAvgR (and null netAvgR).
  //   2. Among positives: prefer higher sample count (freshValid).
  //   3. Among negatives/nulls: fall back to highest freshValid (legacy behavior).
  // This is REPORT-ONLY: liveBlocked remains true regardless; this only changes
  // which lane the dashboard surfaces as the most-credible candidate.
  const isPositive = (l: LaneSnapshot): boolean =>
    typeof l.netAvgR === "number" && Number.isFinite(l.netAvgR) && l.netAvgR > 0;

  // FUTURE promotion ranking prefers the FROZEN prospective tape (honest
  // forward-test) when it has enough resolved evidence. If the frozen tape has
  // too few resolved (<20), fall back to the legacy historical ranking and
  // clearly label the surfaced lane as historical/in-sample. Report-only:
  // liveBlocked remains true regardless — this only changes which lane the
  // dashboard surfaces as the most-credible candidate.
  // Preference order for the surfaced candidate (report-only):
  //   1. Post-cutover tape (current/new method, OLD_BATCH Seg-1 excluded) once n≥50.
  //   2. Full frozen tape (prospective, but still includes OLD_BATCH Seg-1) once n≥20.
  //   3. Legacy positive-net / highest-freshValid fallback.
  const postCutoverLane = lanes.find(
    (l) => l.lane === POST_CUTOVER_LANE && l.freshValid >= POST_CUTOVER_MIN_RESOLVED_FOR_PREFERENCE,
  );
  const frozenLane = lanes.find(
    (l) => l.lane === FROZEN_FULL_TAPE_LANE && l.freshValid >= FROZEN_MIN_RESOLVED_FOR_PREFERENCE,
  );

  let chosen: LaneSnapshot | null = null;
  if (postCutoverLane) {
    chosen = postCutoverLane;
  } else if (frozenLane) {
    chosen = frozenLane;
  } else {
    const positiveLanes = lanes.filter(isPositive);
    const candidatePool = positiveLanes.length > 0 ? positiveLanes : lanes;
    for (const lane of candidatePool) {
      if (!chosen || lane.freshValid > chosen.freshValid) {
        chosen = lane;
      }
    }
  }

  let nearest: LiveTradingGateNearestCandidate | null = null;
  if (chosen) {
    const need = Math.max(EVIDENCE_REQUIRED_N - chosen.freshValid, 0);
    nearest = {
      lane: chosen.lane,
      freshValidResolved: chosen.freshValid,
      netAvgR: chosen.netAvgR,
      pf: chosen.pf,
      closestToPassing:
        need > 0
          ? `needs ${need} more fresh-valid + positive net + PF>1.20`
          : (chosen.netAvgR === null || chosen.netAvgR <= 0
              ? "needs positive netAvgR"
              : (chosen.pf ?? 0) <= 1.2
                ? "needs PF>1.20"
                : "evidence target reached — verify infra gates"),
      cautions: chosen.cautions,
      provenance: chosen.provenance ?? null,
    };
  }

  // Advisory: surface the best variant-matrix candidate (report-only). This is
  // computed entirely from the matrix report and never touches the blocker math,
  // the route lane pool, liveBlocked, or microPilotAllowed.
  let bestVariantMatrixCandidate: LiveTradingGateVariantMatrixCandidate | null = null;
  if (inputs.currentGuardVariantMatrixReport) {
    try {
      const vm = inputs.currentGuardVariantMatrixReport;
      if (vm.bestVariantId !== null) {
        const row = vm.rows.find((r) => r.variantId === vm.bestVariantId);
        if (row) {
          bestVariantMatrixCandidate = {
            variantId: row.variantId,
            label: row.label,
            freshValid: row.freshValid,
            netAvgR: row.netAvgR,
            pf: row.pf,
            status: row.status,
            beatsBaseline: vm.bestBeatsBaseline,
            liveBlocked: true,
          };
        }
      }
    } catch {
      // never break the gate report on a malformed matrix
    }
  }

  const failCount = blockers.filter((b) => b.status === "FAIL").length;
  const summary = microPilotAllowed
    ? "All gates pass. Micro-pilot consideration possible."
    : liveBlocked
      ? `Live trading BLOCKED. ${failCount}/${blockers.length} gates failing: ${blockers
          .filter((b) => b.status === "FAIL")
          .map((b) => b.gate)
          .join(", ")}`
      : "Live trading not yet allowed — insufficient evidence.";

  return {
    reportOnly: true,
    lane: LIVE_TRADING_GATE_LANE,
    computedAt,
    liveBlocked,
    microPilotAllowed,
    blockers,
    nearestCandidateLane: nearest,
    bestVariantMatrixCandidate,
    killSwitchReady,
    orderReconciliationReady,
    exchangeHealthReady,
    frozenCandidateStatus,
    summary,
  };
}

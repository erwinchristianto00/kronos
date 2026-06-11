/**
 * SHADOW LANE SCOREBOARD (REPORT-ONLY)
 *
 * Meta-view across all active shadow lanes (Filtered Edge profiles, Portfolio
 * Trend, Controller-Aligned). Surfaces Top-5 by net/PF/velocity, plus near-N20
 * and near-N30 lanes, killed lanes list, and promotion candidates.
 *
 * Lane label: SHADOW_LANE_SCOREBOARD_V1
 *
 * STRICTLY REPORT-ONLY: pure aggregator. No I/O. No influence on live
 * behavior. All numeric thresholds are static and documented inline.
 */

import type { FilteredEdgeShadowReport } from "./regime-controller-filtered-edge-shadow.js";
import type { RegimeControllerAlignedShadowReport } from "./regime-controller-aligned-shadow.js";
import type { PortfolioTrendShadowReport } from "./portfolio-trend-shadow.js";
import type { BaseRouteCurrentGuardLaneSummary } from "./base-route-risk-hygiene-monitor.js";
import type { FrozenCurrentGuardReport } from "./base-route-current-guard-frozen.js";
import type { CurrentGuardVariantMatrixReport } from "./current-guard-variant-matrix.js";

export type ShadowLaneStatus =
  | "COLLECTING"
  | "WATCHABLE"
  | "PROMOTION_CANDIDATE"
  | "KILLED";

export interface ShadowLaneScoreboardEntry {
  laneId: string;
  profileLabel: string;
  freshValidResolved: number;
  freshValidNetAvgR: number | null;
  freshValidPF: number | null;
  freshValidWR: number | null;
  totalResolved: number;
  admissionVelocityPerDay: number | null;
  resolvedVelocityPerDay: number | null;
  freshValidVelocityPerDay: number | null;
  collectionVelocityPerDay: number | null;
  etaToN20Days: number | null;
  etaToN30Days: number | null;
  status: ShadowLaneStatus;
  killedReason?: string;
  /** Optional cautions surfaced for candidate lanes (e.g. base route current guard) */
  cautions?: string[];
}

export interface ShadowLaneScoreboard {
  reportOnly: true;
  computedAt: string;
  top5ByFreshValidNet: ShadowLaneScoreboardEntry[];
  top5ByPF: ShadowLaneScoreboardEntry[];
  fastestCollecting: ShadowLaneScoreboardEntry[];
  nearN20: ShadowLaneScoreboardEntry[];
  nearN30: ShadowLaneScoreboardEntry[];
  killedLanes: ShadowLaneScoreboardEntry[];
  promotionCandidates: ShadowLaneScoreboardEntry[];
  /** Report-only candidate lanes sourced from the Base Route Risk Hygiene Monitor */
  candidateLanesFromBaseRoute: ShadowLaneScoreboardEntry[];
  allEntries: ShadowLaneScoreboardEntry[];
}

export interface ShadowLaneScoreboardInputs {
  filteredEdgeReport?: FilteredEdgeShadowReport;
  portfolioTrendReport?: PortfolioTrendShadowReport;
  controllerAlignedReport?: RegimeControllerAlignedShadowReport;
  baseRouteCurrentGuardLane?: BaseRouteCurrentGuardLaneSummary;
  /** Report-only: frozen prospective tape report (F***). Surfaced as a separate lane. */
  frozenCurrentGuardReport?: FrozenCurrentGuardReport;
  /**
   * Report-only: current-guard variant matrix (forward A/B geometry harness).
   * Each variant is surfaced as its own lane so geometry alternatives are never
   * conflated with the live route. Advisory only; never authorizes live trading.
   */
  currentGuardVariantMatrixReport?: CurrentGuardVariantMatrixReport;
}

const KILLED_LANES: ShadowLaneScoreboardEntry[] = [
  {
    laneId: "REGIME_CONTROLLER_ALIGNED_BEST_EXIT_SHADOW_V1",
    profileLabel: "REGIME_CONTROLLER_ALIGNED_BEST_EXIT_SHADOW_V1",
    freshValidResolved: 0,
    freshValidNetAvgR: null,
    freshValidPF: null,
    freshValidWR: null,
    totalResolved: 0,
    admissionVelocityPerDay: null,
    resolvedVelocityPerDay: null,
    freshValidVelocityPerDay: null,
    collectionVelocityPerDay: null,
    etaToN20Days: null,
    etaToN30Days: null,
    status: "KILLED",
    killedReason:
      "never created — exact path counterfactuals negative; promotion gate never opened",
  },
  {
    laneId: "EXIT_VARIANT:TP2_FULL_EXIT",
    profileLabel: "TP2_FULL_EXIT",
    freshValidResolved: 0,
    freshValidNetAvgR: null,
    freshValidPF: null,
    freshValidWR: null,
    totalResolved: 0,
    admissionVelocityPerDay: null,
    resolvedVelocityPerDay: null,
    freshValidVelocityPerDay: null,
    collectionVelocityPerDay: null,
    etaToN20Days: null,
    etaToN30Days: null,
    status: "KILLED",
    killedReason: "validation failed (exit extension counterfactual negative)",
  },
  {
    laneId: "EXIT_VARIANT:TP1_50_RUNNER_TP3",
    profileLabel: "TP1_50_RUNNER_TP3",
    freshValidResolved: 0,
    freshValidNetAvgR: null,
    freshValidPF: null,
    freshValidWR: null,
    totalResolved: 0,
    admissionVelocityPerDay: null,
    resolvedVelocityPerDay: null,
    freshValidVelocityPerDay: null,
    collectionVelocityPerDay: null,
    etaToN20Days: null,
    etaToN30Days: null,
    status: "KILLED",
    killedReason: "validation failed (runner variant counterfactual negative)",
  },
];

function classifyStatus(
  freshValid: number,
  netAvgR: number | null,
  pf: number | null,
): ShadowLaneStatus {
  if (
    freshValid >= 100 &&
    netAvgR !== null &&
    netAvgR > 0 &&
    pf !== null &&
    pf > 1.2
  ) {
    return "PROMOTION_CANDIDATE";
  }
  if (
    freshValid >= 20 &&
    netAvgR !== null &&
    netAvgR > 0 &&
    pf !== null &&
    pf > 1.0
  ) {
    return "WATCHABLE";
  }
  return "COLLECTING";
}

function buildEntry(
  laneId: string,
  profileLabel: string,
  freshValid: number,
  totalResolved: number,
  netAvgR: number | null,
  pf: number | null,
  wr: number | null,
  admissionVelocityPerDay: number | null,
  resolvedVelocityPerDay: number | null,
  freshValidVelocityPerDay: number | null,
): ShadowLaneScoreboardEntry {
  const status = classifyStatus(freshValid, netAvgR, pf);
  const collectionVelocityPerDay = admissionVelocityPerDay;
  const etaToN20Days =
    freshValidVelocityPerDay !== null && freshValidVelocityPerDay > 0 && freshValid < 20
      ? (20 - freshValid) / freshValidVelocityPerDay
      : freshValid >= 20
        ? 0
        : null;
  const etaToN30Days =
    freshValidVelocityPerDay !== null && freshValidVelocityPerDay > 0 && freshValid < 30
      ? (30 - freshValid) / freshValidVelocityPerDay
      : freshValid >= 30
        ? 0
        : null;
  return {
    laneId,
    profileLabel,
    freshValidResolved: freshValid,
    freshValidNetAvgR: netAvgR,
    freshValidPF: pf,
    freshValidWR: wr,
    totalResolved,
    admissionVelocityPerDay,
    resolvedVelocityPerDay,
    freshValidVelocityPerDay,
    collectionVelocityPerDay,
    etaToN20Days,
    etaToN30Days,
    status,
  };
}

export function buildShadowLaneScoreboard(
  inputs: ShadowLaneScoreboardInputs,
  capturedAt?: string,
): ShadowLaneScoreboard {
  const computedAt = capturedAt ?? new Date().toISOString();
  const entries: ShadowLaneScoreboardEntry[] = [];

  if (inputs.filteredEdgeReport) {
    for (const fp of inputs.filteredEdgeReport.freshValidProfileReports ?? []) {
      entries.push(
        buildEntry(
          `FILTERED_EDGE:${fp.profile}`,
          `FILTERED_EDGE:${fp.profile}`,
          fp.resolvedObs ?? 0,
          fp.resolvedObs ?? 0,
          fp.netAvgR,
          fp.pf,
          fp.wr,
          null,
          null,
          null,
        ),
      );
    }
  }
  if (inputs.controllerAlignedReport) {
    const car = inputs.controllerAlignedReport;
    entries.push(
      buildEntry(
        "CONTROLLER_ALIGNED_SHADOW_V1",
        "CONTROLLER_ALIGNED_SHADOW_V1",
        car.resolvedObservations ?? 0,
        car.resolvedObservations ?? 0,
        car.overallNetAvgR ?? null,
        car.overallPF ?? null,
        car.overallWR ?? null,
        null,
        null,
        null,
      ),
    );
  }
  if (inputs.portfolioTrendReport) {
    const ptr = inputs.portfolioTrendReport;
    entries.push(
      buildEntry(
        "PORTFOLIO_TREND_SHADOW_V1",
        "PORTFOLIO_TREND_SHADOW_V1",
        ptr.freshValidResolved,
        ptr.resolvedObs,
        ptr.freshValidNetAvgR,
        ptr.freshValidPF,
        ptr.freshValidWR,
        ptr.admissionVelocityPerDay,
        ptr.resolvedVelocityPerDay,
        ptr.freshValidVelocityPerDay,
      ),
    );
  }

  // Base Route Current-Guard candidate lane (report-only; sourced from F* monitor).
  const candidateLanesFromBaseRoute: ShadowLaneScoreboardEntry[] = [];
  if (inputs.baseRouteCurrentGuardLane) {
    try {
      const lane = inputs.baseRouteCurrentGuardLane;
      const mappedStatus: ShadowLaneStatus =
        lane.status === "REJECT"
          ? "KILLED"
          : lane.status === "PROMOTION_CANDIDATE"
            ? "PROMOTION_CANDIDATE"
            : lane.status === "WATCHABLE"
              ? "WATCHABLE"
              : "COLLECTING";
      const baseEntry: ShadowLaneScoreboardEntry = {
        laneId: "BASE_ROUTE_STOP175_CURRENT_GUARD",
        profileLabel: "BASE_ROUTE:CURRENT_GUARD",
        freshValidResolved: lane.closed,
        freshValidNetAvgR: lane.netAvgR,
        freshValidPF: lane.pf,
        freshValidWR: lane.wr,
        totalResolved: lane.closed,
        admissionVelocityPerDay: null,
        resolvedVelocityPerDay: null,
        freshValidVelocityPerDay: null,
        collectionVelocityPerDay: null,
        etaToN20Days: lane.closed >= 20 ? 0 : null,
        etaToN30Days: lane.closed >= 30 ? 0 : null,
        status: mappedStatus,
        killedReason: lane.status === "REJECT" ? lane.statusReason : undefined,
        cautions: lane.cautions,
      };
      entries.push(baseEntry);
      candidateLanesFromBaseRoute.push(baseEntry);
    } catch {
      // never break scoreboard if base-route lane summary is malformed
    }
  }

  // Base Route Current-Guard FROZEN prospective tape (report-only; sourced from F*** frozen report).
  // Surfaced as a SEPARATE lane so historical (in-sample) and prospective (forward-test)
  // evidence are never conflated.
  if (inputs.frozenCurrentGuardReport) {
    try {
      const fr = inputs.frozenCurrentGuardReport;
      const mappedStatus: ShadowLaneStatus =
        fr.status === "PROMOTION_CANDIDATE"
          ? "PROMOTION_CANDIDATE"
          : fr.status === "STABLE_CANDIDATE"
            ? "PROMOTION_CANDIDATE"
            : fr.status === "WATCHABLE"
              ? "WATCHABLE"
              : "COLLECTING";
      const frozenEntry: ShadowLaneScoreboardEntry = {
        laneId: "BASE_ROUTE_STOP175_CURRENT_GUARD_FROZEN_V1",
        profileLabel: "BASE_ROUTE:CURRENT_GUARD_FROZEN (prospective)",
        freshValidResolved: fr.freshValid,
        freshValidNetAvgR: fr.netAvgR,
        freshValidPF: fr.pf,
        freshValidWR: fr.wr,
        totalResolved: fr.resolved,
        admissionVelocityPerDay: null,
        resolvedVelocityPerDay: null,
        freshValidVelocityPerDay: null,
        collectionVelocityPerDay: null,
        etaToN20Days: fr.freshValid >= 20 ? 0 : null,
        etaToN30Days: fr.freshValid >= 30 ? 0 : null,
        status: mappedStatus,
        cautions: [`Prospective forward-test; criteria frozen at ${fr.criteriaFrozenAt ?? "n/a"}; status=${fr.status}`],
      };
      entries.push(frozenEntry);
      candidateLanesFromBaseRoute.push(frozenEntry);
    } catch {
      // never break scoreboard if frozen report is malformed
    }
  }

  // Current-Guard Variant Matrix (report-only; sourced from the forward A/B harness).
  // Each variant geometry is surfaced as its own lane so alternatives are never
  // conflated with the live route. Advisory only — these lanes never authorize
  // live trading (the AD gate keeps liveBlocked=true via its infra blockers).
  if (inputs.currentGuardVariantMatrixReport) {
    try {
      for (const row of inputs.currentGuardVariantMatrixReport.rows) {
        // Map the 5-state variant status onto the 4-state scoreboard status.
        // STABLE_CANDIDATE is treated as WATCHABLE here (conservative): only a
        // genuine PROMOTION_CANDIDATE surfaces in promotionCandidates, and even
        // that is advisory — the variant matrix can never reach it while infra
        // gates are unimplemented.
        const mappedStatus: ShadowLaneStatus =
          row.status === "REJECT"
            ? "KILLED"
            : row.status === "PROMOTION_CANDIDATE"
              ? "PROMOTION_CANDIDATE"
              : row.status === "STABLE_CANDIDATE" || row.status === "WATCHABLE"
                ? "WATCHABLE"
                : "COLLECTING";
        const cautions = [
          `Forward A/B geometry variant (${row.exitRule}/${row.fillMode}); report-only, never live`,
          ...(row.cautions ?? []),
        ];
        const vmEntry: ShadowLaneScoreboardEntry = {
          laneId: `CG_VARIANT_MATRIX:${row.variantId}`,
          profileLabel: `CG_VARIANT_MATRIX:${row.label}`,
          freshValidResolved: row.freshValid,
          freshValidNetAvgR: row.netAvgR,
          freshValidPF: row.pf,
          freshValidWR: row.wr,
          totalResolved: row.resolved,
          admissionVelocityPerDay: null,
          resolvedVelocityPerDay: null,
          freshValidVelocityPerDay: null,
          collectionVelocityPerDay: null,
          etaToN20Days: row.freshValid >= 20 ? 0 : null,
          etaToN30Days: row.freshValid >= 30 ? 0 : null,
          status: mappedStatus,
          killedReason: row.status === "REJECT" ? row.statusReason : undefined,
          cautions,
        };
        entries.push(vmEntry);
      }
    } catch {
      // never break scoreboard if the variant matrix report is malformed
    }
  }

  // Sorting helpers
  const byNet = [...entries]
    .filter((e) => e.freshValidNetAvgR !== null)
    .sort((a, b) => (b.freshValidNetAvgR ?? -Infinity) - (a.freshValidNetAvgR ?? -Infinity));
  const byPF = [...entries]
    .filter((e) => e.freshValidPF !== null)
    .sort((a, b) => (b.freshValidPF ?? -Infinity) - (a.freshValidPF ?? -Infinity));
  const byVelocity = [...entries]
    .filter((e) => e.collectionVelocityPerDay !== null)
    .sort(
      (a, b) =>
        (b.collectionVelocityPerDay ?? -Infinity) -
        (a.collectionVelocityPerDay ?? -Infinity),
    );
  const nearN20 = entries.filter(
    (e) => e.freshValidResolved >= 15 && e.freshValidResolved <= 19,
  );
  const nearN30 = entries.filter(
    (e) => e.freshValidResolved >= 25 && e.freshValidResolved <= 29,
  );
  const promotionCandidates = entries.filter(
    (e) => e.status === "PROMOTION_CANDIDATE",
  );

  // Killed lanes: static list plus any dynamically-killed candidates (e.g. base route in REJECT).
  const dynamicallyKilled = entries.filter((e) => e.status === "KILLED");
  const killedLanes: ShadowLaneScoreboardEntry[] = [...KILLED_LANES, ...dynamicallyKilled];

  return {
    reportOnly: true,
    computedAt,
    top5ByFreshValidNet: byNet.slice(0, 5),
    top5ByPF: byPF.slice(0, 5),
    fastestCollecting: byVelocity.slice(0, 5),
    nearN20,
    nearN30,
    killedLanes,
    promotionCandidates,
    candidateLanesFromBaseRoute,
    allEntries: entries,
  };
}

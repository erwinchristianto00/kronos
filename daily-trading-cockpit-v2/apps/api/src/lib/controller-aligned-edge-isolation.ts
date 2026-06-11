/**
 * Controller-Aligned Edge Isolation Report (REPORT-ONLY).
 *
 * Pure module — zero I/O, zero file writes. Takes resolved
 * ControllerAlignedShadowPosition[] as input and produces a
 * purely analytical report isolating edge contributors.
 *
 * reportOnly: true always set. Zero live behavior changes.
 */

import type { ControllerAlignedShadowPosition } from "./regime-controller-aligned-shadow.js";

// ─── Economics helper ─────────────────────────────────────────────────────────

export interface SubCohortEconomics {
  label: string;
  n: number;
  resolved: number;
  wins: number;
  losses: number;
  wr: number;          // wins / resolved
  netAvgR: number;     // mean of (grossR - costR) across resolved
  grossAvgR: number;   // mean of grossR
  avgCostR: number;
  pf: number;          // sumWinGrossR / abs(sumLossGrossR); Infinity if no losses
  avgWinGrossR: number | null;
  avgLossGrossR: number | null;
}

// ─── Prune suggestion ─────────────────────────────────────────────────────────

export type PruneSuggestionType =
  | "EXCLUDE_SYMBOL"
  | "COST_R_CAP"
  | "STOP_BUCKET_FILTER"
  | "SIGNAL_FILTER"
  | "REGIME_SUBFILTER"
  | "ROUTE_FILTER";

export interface PruneSuggestion {
  type: PruneSuggestionType;
  label: string;
  reason: string;
  affectedN: number;
  cohortNetAvgR: number;
}

// ─── Full isolation report ────────────────────────────────────────────────────

export interface ControllerAlignedEdgeIsolationReport {
  reportOnly: true;
  computedAt: string;
  inputN: number;              // total resolved valid observations fed in

  byControllerMode: SubCohortEconomics[];
  bySymbol: SubCohortEconomics[];
  byRoute: SubCohortEconomics[];          // key: entryVariant + "|" + exitVariant
  byStopBucket: SubCohortEconomics[];    // "80-100", "100-125", "125-150", "150-175", "175+"
  byCostBucket: SubCohortEconomics[];    // "≤0.10", "0.10-0.15", "0.15-0.20", ">0.20"
  bySourceConflict: SubCohortEconomics[];
  byLiveSourceConflict: SubCohortEconomics[];
  byKronosBias: SubCohortEconomics[];    // "LONG", "SHORT", "NEUTRAL", "UNKNOWN"
  byWhaleAgreement: SubCohortEconomics[];
  byRegimeFamily: SubCohortEconomics[];

  // ranked sub-cohorts
  bestSubCohorts: SubCohortEconomics[];   // n>=5, sorted by netAvgR desc
  worstSubCohorts: SubCohortEconomics[];  // n>=3, sorted by netAvgR asc

  // advisory filter suggestions (report-only)
  pruneSuggestions: PruneSuggestion[];

  // exact exit conclusion
  exitExtensionConclusion: "NO_POSITIVE_EXACT_EXIT" | "POSITIVE_EXACT_EXIT" | "INSUFFICIENT_DATA";
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function computeSubCohortEconomics(
  label: string,
  obs: ControllerAlignedShadowPosition[],
): SubCohortEconomics {
  const n = obs.length;
  const resolved = obs.length; // caller already filters to resolved

  const grossRs: number[] = [];
  const costRs: number[] = [];
  const netRs: number[] = [];
  const winGrossRs: number[] = [];
  const lossGrossRs: number[] = [];

  for (const o of obs) {
    const g = typeof o.grossR === "number" && Number.isFinite(o.grossR) ? o.grossR : 0;
    const c = typeof o.costR === "number" && Number.isFinite(o.costR) ? o.costR : 0;
    grossRs.push(g);
    costRs.push(c);
    netRs.push(g - c);
    if (g > 0) {
      winGrossRs.push(g);
    } else {
      lossGrossRs.push(g);
    }
  }

  const wins = winGrossRs.length;
  const losses = lossGrossRs.length;
  const wr = resolved > 0 ? wins / resolved : 0;
  const netAvgR = mean(netRs);
  const grossAvgR = mean(grossRs);
  const avgCostR = mean(costRs);
  const avgWinGrossR = wins > 0 ? mean(winGrossRs) : null;
  const avgLossGrossR = losses > 0 ? mean(lossGrossRs) : null;

  const sumWinGrossR = winGrossRs.reduce((s, v) => s + v, 0);
  const sumLossGrossR = lossGrossRs.reduce((s, v) => s + v, 0);
  const pf =
    losses === 0
      ? wins > 0
        ? Infinity
        : 0
      : sumWinGrossR / Math.abs(sumLossGrossR);

  return {
    label,
    n,
    resolved,
    wins,
    losses,
    wr,
    netAvgR,
    grossAvgR,
    avgCostR,
    pf,
    avgWinGrossR,
    avgLossGrossR,
  };
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = map.get(key) ?? [];
    group.push(item);
    map.set(key, group);
  }
  return map;
}

function buildCohorts(
  obs: ControllerAlignedShadowPosition[],
  keyFn: (o: ControllerAlignedShadowPosition) => string,
): SubCohortEconomics[] {
  const groups = groupBy(obs, keyFn);
  const result: SubCohortEconomics[] = [];
  for (const [label, items] of groups.entries()) {
    result.push(computeSubCohortEconomics(label, items));
  }
  return result;
}

function classifyRegimeFamily(regime: string | null | undefined): string {
  if (!regime) return "unknown";
  const lower = regime.toLowerCase();
  if (lower.includes("bullish")) return "bullish";
  if (lower.includes("bearish")) return "bearish";
  if (lower.includes("mixed") || lower.includes("chop") || lower.includes("range")) return "mixed";
  return "unknown";
}

function classifyStopBucket(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return "unknown";
  if (bps < 80) return "unknown";
  if (bps < 100) return "80-100";
  if (bps < 125) return "100-125";
  if (bps < 150) return "125-150";
  if (bps < 175) return "150-175";
  return "175+";
}

function classifyCostBucket(costR: number | null | undefined): string {
  if (costR === null || costR === undefined || !Number.isFinite(costR)) return "unknown";
  if (costR <= 0.10) return "≤0.10";
  if (costR <= 0.15) return "0.10-0.15";
  if (costR <= 0.20) return "0.15-0.20";
  return ">0.20";
}

function normalizeKronosBias(bias: string | null | undefined): string {
  if (!bias) return "UNKNOWN";
  const upper = bias.toUpperCase();
  if (upper === "LONG") return "LONG";
  if (upper === "SHORT") return "SHORT";
  if (upper === "NEUTRAL") return "NEUTRAL";
  return "UNKNOWN";
}

function normalizeWhaleAgreement(agreement: string | null | undefined): string {
  if (!agreement) return "UNKNOWN";
  const upper = agreement.toUpperCase();
  if (upper === "AGREES") return "AGREES";
  if (upper === "DISAGREES") return "DISAGREES";
  if (upper === "UNAVAILABLE") return "UNAVAILABLE";
  return "UNKNOWN";
}

// ─── Main builder ─────────────────────────────────────────────────────────────

export function buildControllerAlignedEdgeIsolationReport(
  observations: ControllerAlignedShadowPosition[],
  exitExtensionConclusion: ControllerAlignedEdgeIsolationReport["exitExtensionConclusion"],
  capturedAt?: string,
): ControllerAlignedEdgeIsolationReport {
  const computedAt = capturedAt ?? new Date().toISOString();

  // Filter to resolved valid observations only
  const validObs = observations.filter((o) => {
    if (o.status !== "CLOSED_WIN" && o.status !== "CLOSED_LOSS") return false;
    if (!(o.entryPrice > 0)) return false;
    if (!(o.stopLoss > 0)) return false;
    if (!Array.isArray(o.takeProfitLevels) || o.takeProfitLevels.length === 0) return false;
    if (typeof o.grossR !== "number" || !Number.isFinite(o.grossR)) return false;
    // Exclude FAILED_INVALID_GEOMETRY (checked via status above, but also check guard field)
    const anyObs = o as unknown as Record<string, unknown>;
    if (anyObs["guardPassedUnder"] === "FAILED_INVALID_GEOMETRY") return false;
    return true;
  });

  const inputN = validObs.length;

  // By controller mode
  const byControllerMode = buildCohorts(validObs, (o) => o.controllerMode ?? "UNKNOWN");
  byControllerMode.sort((a, b) => a.label.localeCompare(b.label));

  // By symbol
  const bySymbol = buildCohorts(validObs, (o) => o.symbol ?? "UNKNOWN");
  bySymbol.sort((a, b) => b.n - a.n);

  // By route: entryVariant + "|" + exitVariant
  const byRoute = buildCohorts(
    validObs,
    (o) => `${o.entryVariant ?? "UNKNOWN"} | ${o.exitVariant ?? "UNKNOWN"}`,
  );
  byRoute.sort((a, b) => b.n - a.n);

  // By stop bucket
  const byStopBucket = buildCohorts(validObs, (o) =>
    classifyStopBucket(o.stopDistanceBps),
  );
  byStopBucket.sort((a, b) => a.label.localeCompare(b.label));

  // By cost bucket
  const byCostBucket = buildCohorts(validObs, (o) => classifyCostBucket(o.costR));
  byCostBucket.sort((a, b) => a.label.localeCompare(b.label));

  // By source conflict — access via observation as generic record (field may not be on type)
  const bySourceConflict = buildCohorts(validObs, (o) => {
    const rec = o as unknown as Record<string, unknown>;
    if (!("sourceConflict" in rec)) return "sourceConflict=unknown";
    return `sourceConflict=${rec["sourceConflict"] === true ? "true" : "false"}`;
  });
  bySourceConflict.sort((a, b) => a.label.localeCompare(b.label));

  // By live source conflict
  const byLiveSourceConflict = buildCohorts(validObs, (o) => {
    const rec = o as unknown as Record<string, unknown>;
    if (!("liveSourceConflict" in rec)) return "liveSourceConflict=unknown";
    return `liveSourceConflict=${rec["liveSourceConflict"] === true ? "true" : "false"}`;
  });
  byLiveSourceConflict.sort((a, b) => a.label.localeCompare(b.label));

  // By Kronos bias
  const byKronosBias = buildCohorts(validObs, (o) => {
    const rec = o as unknown as Record<string, unknown>;
    const bias = rec["kronosBias"] as string | null | undefined;
    return normalizeKronosBias(bias);
  });
  byKronosBias.sort((a, b) => a.label.localeCompare(b.label));

  // By whale agreement
  const byWhaleAgreement = buildCohorts(validObs, (o) => {
    const rec = o as unknown as Record<string, unknown>;
    const agreement = rec["whaleAgreement"] as string | null | undefined;
    return normalizeWhaleAgreement(agreement);
  });
  byWhaleAgreement.sort((a, b) => a.label.localeCompare(b.label));

  // By regime family
  const byRegimeFamily = buildCohorts(validObs, (o) =>
    classifyRegimeFamily(o.marketRegimeAtOpen),
  );
  byRegimeFamily.sort((a, b) => a.label.localeCompare(b.label));

  // Collect all sub-cohorts for ranking (exclude byControllerMode and byRoute from ranking pool)
  const allSubCohorts: SubCohortEconomics[] = [
    ...bySymbol,
    ...byStopBucket,
    ...byCostBucket,
    ...bySourceConflict,
    ...byLiveSourceConflict,
    ...byKronosBias,
    ...byWhaleAgreement,
    ...byRegimeFamily,
  ];

  // Best: n >= 5, sorted by netAvgR desc, then pf desc, top 5
  const bestSubCohorts = allSubCohorts
    .filter((c) => c.n >= 5)
    .sort((a, b) => {
      const diff = b.netAvgR - a.netAvgR;
      if (diff !== 0) return diff;
      const pfA = Number.isFinite(a.pf) ? a.pf : 0;
      const pfB = Number.isFinite(b.pf) ? b.pf : 0;
      return pfB - pfA;
    })
    .slice(0, 5);

  // Worst: n >= 3, sorted by netAvgR asc, top 5
  const worstSubCohorts = allSubCohorts
    .filter((c) => c.n >= 3)
    .sort((a, b) => a.netAvgR - b.netAvgR)
    .slice(0, 5);

  // Prune suggestions
  const pruneSuggestions: PruneSuggestion[] = [];

  // EXCLUDE_SYMBOL: symbol where n >= 3 AND netAvgR < -0.10
  for (const sc of bySymbol) {
    if (sc.n >= 3 && sc.netAvgR < -0.10) {
      pruneSuggestions.push({
        type: "EXCLUDE_SYMBOL",
        label: sc.label,
        reason: `netAvgR=${sc.netAvgR.toFixed(4)}`,
        affectedN: sc.n,
        cohortNetAvgR: sc.netAvgR,
      });
    }
  }

  // COST_R_CAP: ">0.20" cost bucket with n >= 3 AND netAvgR < 0
  const highCostBucket = byCostBucket.find((c) => c.label === ">0.20");
  if (highCostBucket && highCostBucket.n >= 3 && highCostBucket.netAvgR < 0) {
    pruneSuggestions.push({
      type: "COST_R_CAP",
      label: ">0.20 costR",
      reason: `high cost bucket netAvgR=${highCostBucket.netAvgR.toFixed(4)}`,
      affectedN: highCostBucket.n,
      cohortNetAvgR: highCostBucket.netAvgR,
    });
  }

  // STOP_BUCKET_FILTER: "80-100" bucket with n >= 3 AND netAvgR < 0
  const tightStopBucket = byStopBucket.find((c) => c.label === "80-100");
  if (tightStopBucket && tightStopBucket.n >= 3 && tightStopBucket.netAvgR < 0) {
    pruneSuggestions.push({
      type: "STOP_BUCKET_FILTER",
      label: "80-100 stopBps",
      reason: `tight stop bucket netAvgR=${tightStopBucket.netAvgR.toFixed(4)}`,
      affectedN: tightStopBucket.n,
      cohortNetAvgR: tightStopBucket.netAvgR,
    });
  }

  // SIGNAL_FILTER: sourceConflict=true is worse than sourceConflict=false
  {
    const noConflict = bySourceConflict.find((c) => c.label === "sourceConflict=false");
    const withConflict = bySourceConflict.find((c) => c.label === "sourceConflict=true");
    if (withConflict && withConflict.n >= 3 && noConflict && withConflict.netAvgR < noConflict.netAvgR) {
      pruneSuggestions.push({
        type: "SIGNAL_FILTER",
        label: "sourceConflict=true",
        reason: `netAvgR=${withConflict.netAvgR.toFixed(4)} < noConflict ${noConflict.netAvgR.toFixed(4)}`,
        affectedN: withConflict.n,
        cohortNetAvgR: withConflict.netAvgR,
      });
    }
  }

  // SIGNAL_FILTER: liveSourceConflict=true is worse than liveSourceConflict=false
  {
    const noLiveConflict = byLiveSourceConflict.find((c) => c.label === "liveSourceConflict=false");
    const withLiveConflict = byLiveSourceConflict.find((c) => c.label === "liveSourceConflict=true");
    if (withLiveConflict && withLiveConflict.n >= 3 && noLiveConflict && withLiveConflict.netAvgR < noLiveConflict.netAvgR) {
      pruneSuggestions.push({
        type: "SIGNAL_FILTER",
        label: "liveSourceConflict=true",
        reason: `netAvgR=${withLiveConflict.netAvgR.toFixed(4)} < noLiveConflict ${noLiveConflict.netAvgR.toFixed(4)}`,
        affectedN: withLiveConflict.n,
        cohortNetAvgR: withLiveConflict.netAvgR,
      });
    }
  }

  // SIGNAL_FILTER: any Kronos bias with n >= 3 AND netAvgR < -0.10
  for (const kb of byKronosBias) {
    if (kb.n >= 3 && kb.netAvgR < -0.10) {
      pruneSuggestions.push({
        type: "SIGNAL_FILTER",
        label: `kronosBias=${kb.label}`,
        reason: `netAvgR=${kb.netAvgR.toFixed(4)}`,
        affectedN: kb.n,
        cohortNetAvgR: kb.netAvgR,
      });
    }
  }

  return {
    reportOnly: true,
    computedAt,
    inputN,
    byControllerMode,
    bySymbol,
    byRoute,
    byStopBucket,
    byCostBucket,
    bySourceConflict,
    byLiveSourceConflict,
    byKronosBias,
    byWhaleAgreement,
    byRegimeFamily,
    bestSubCohorts,
    worstSubCohorts,
    pruneSuggestions,
    exitExtensionConclusion,
  };
}

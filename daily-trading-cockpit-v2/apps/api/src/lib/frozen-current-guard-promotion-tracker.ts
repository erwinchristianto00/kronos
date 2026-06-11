/**
 * F**** FROZEN CURRENT-GUARD PROMOTION TRACKER — REPORT-ONLY
 *
 * Consumes the frozen prospective tape report (F***) plus the realistic cost
 * model report (F*** evidence-quality upgrade) and produces a forward-looking
 * promotion-readiness tracker. It describes what would need to be TRUE before
 * the frozen lane could even be DISCUSSED for a micro-pilot — it implements no
 * live trading, changes no admission/route logic, and never influences live
 * behavior.
 *
 * STRICTLY REPORT-ONLY & PURE:
 *  - Zero I/O. No singletons, no file access, no network.
 *  - Reads from already-built report structures only; never mutates inputs.
 *  - reportOnly: true always set.
 *  - Status is advisory; no consumer is allowed to gate live behavior on it.
 */

import type {
  FrozenCurrentGuardObservation,
  FrozenCurrentGuardReport,
} from "./base-route-current-guard-frozen.js";
import type { FrozenCurrentGuardCostModelReport } from "./frozen-current-guard-cost-model.js";

export const FROZEN_PROMOTION_TRACKER_LANE =
  "BASE_ROUTE_STOP175_CURRENT_GUARD_FROZEN_V1" as const;

/** Acceptable rolling-drawdown magnitude (R) for PROMOTION_CANDIDATE. */
const MAX_DRAWDOWN_R_LIMIT = 5;
/** Maximum top-symbol PnL share for PROMOTION_CANDIDATE. */
const MAX_TOP_SYMBOL_SHARE = 0.4;

export type PromotionTrackerStatus =
  | "COLLECTING"
  | "WATCHABLE"
  | "STABILITY_BLOCKED"
  | "STABLE_CANDIDATE"
  | "PROMOTION_CANDIDATE"
  | "REJECT";

export interface RollingWindowStat {
  window: string; // "last_10" | "last_20" | "last_50"
  n: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
}

export interface FrozenPromotionTrackerReport {
  reportOnly: true;
  laneId: typeof FROZEN_PROMOTION_TRACKER_LANE;
  computedAt: string;

  freshValid: number;
  resolvedPerDay: number | null;
  freshValidPerDay: number | null;
  etaToN100Days: number | null;
  etaToN100Date: string | null;
  etaToN200Days: number | null;
  etaToN200Date: string | null;

  rolling: RollingWindowStat[]; // last_10, last_20, last_50

  oosSegmentsAllPositive: boolean;
  weakestSegment: { label: string; netAvgR: number | null } | null;
  positiveSegmentCount: number;

  approxMaxDrawdownR: number | null;
  maxAdverseStreak: number | null;

  plus10bpsStillPositive: boolean;
  topSymbolPnlShare: number | null;

  status: PromotionTrackerStatus;
  statusReason: string;
  promotionBlockers: string[];
  killWarning: string | null; // set when rolling net turns negative

  cautions: string[];
}

// ─── numeric helpers ────────────────────────────────────────────────────────

function finiteNumbers(values: Array<number | null | undefined>): number[] {
  return values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

function mean(values: Array<number | null | undefined>): number | null {
  const finite = finiteNumbers(values);
  if (finite.length === 0) return null;
  return finite.reduce((s, v) => s + v, 0) / finite.length;
}

function profitFactor(grosses: Array<number | null | undefined>): number | null {
  let winSum = 0;
  let lossSum = 0;
  for (const g of grosses) {
    if (typeof g !== "number" || !Number.isFinite(g)) continue;
    if (g > 0) winSum += g;
    else if (g < 0) lossSum += Math.abs(g);
  }
  if (lossSum === 0) return winSum > 0 ? Infinity : null;
  return winSum / lossSum;
}

/** PF clamped for serialization: Infinity becomes null. */
function pfFinite(grosses: Array<number | null | undefined>): number | null {
  const pf = profitFactor(grosses);
  return pf === Infinity ? null : pf;
}

function winRate(grosses: Array<number | null | undefined>): number | null {
  const finite = finiteNumbers(grosses);
  if (finite.length === 0) return null;
  return finite.filter((g) => g > 0).length / finite.length;
}

/**
 * Compute a rolling-window stat over the LAST `size` observations (the inputs
 * are assumed time-ordered ascending by closedAt). netAvgR uses netR; PF/WR use
 * grossR (mirrors the frozen report's own conventions).
 */
function rollingWindow(
  label: string,
  obs: FrozenCurrentGuardObservation[],
  size: number,
): RollingWindowStat {
  const slice = obs.slice(Math.max(0, obs.length - size));
  return {
    window: label,
    n: slice.length,
    netAvgR: mean(slice.map((o) => o.netR)),
    pf: pfFinite(slice.map((o) => o.grossR)),
    wr: winRate(slice.map((o) => o.grossR)),
  };
}

/**
 * Approximate max drawdown (in R) over the time-ordered netR sequence, using a
 * running cumulative-sum peak-to-trough. Also returns the longest adverse
 * (negative-netR) streak length. Returns nulls when no finite netR observed.
 */
function drawdownAndStreak(
  obs: FrozenCurrentGuardObservation[],
): { drawdownR: number | null; streak: number | null } {
  const nets = obs
    .map((o) => o.netR)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nets.length === 0) return { drawdownR: null, streak: null };
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  let curStreak = 0;
  let maxStreak = 0;
  for (const n of nets) {
    cum += n;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
    if (n < 0) {
      curStreak += 1;
      if (curStreak > maxStreak) maxStreak = curStreak;
    } else {
      curStreak = 0;
    }
  }
  return { drawdownR: maxDd, streak: maxStreak };
}

// ─── builder ──────────────────────────────────────────────────────────────────

export function buildFrozenPromotionTrackerReport(
  frozen: FrozenCurrentGuardReport,
  costModel: FrozenCurrentGuardCostModelReport | undefined,
  capturedAt?: string,
): FrozenPromotionTrackerReport {
  const computedAt = capturedAt ?? new Date().toISOString();

  const freshValid = typeof frozen.freshValid === "number" ? frozen.freshValid : 0;
  const netAvgR = frozen.netAvgR;
  const pf = frozen.pf;

  const resolvedObs = Array.isArray(frozen.resolvedObservations)
    ? frozen.resolvedObservations
    : [];

  // ── rolling windows ──────────────────────────────────────────────────────
  const rolling: RollingWindowStat[] = [
    rollingWindow("last_10", resolvedObs, 10),
    rollingWindow("last_20", resolvedObs, 20),
    rollingWindow("last_50", resolvedObs, 50),
  ];
  const last10 = rolling[0]!;
  const last20 = rolling[1]!;

  // ── OOS stability ────────────────────────────────────────────────────────
  const oosSegmentsAllPositive = frozen.oosWatch?.allSegmentsPositive === true;
  const positiveSegmentCount = frozen.oosWatch?.positiveSegmentCount ?? 0;
  const weakestSegment = frozen.oosWatch?.weakestSegment ?? null;

  // ── drawdown / concentration / cost stress ───────────────────────────────
  const { drawdownR: approxMaxDrawdownR, streak: maxAdverseStreak } =
    drawdownAndStreak(resolvedObs);

  const topSymbolPnlShare =
    typeof frozen.topSymbolPnlShare === "number" ? frozen.topSymbolPnlShare : null;

  // +10bps still positive: prefer the realistic cost model scenario; fall back
  // to the frozen report's own cost-sensitivity table.
  const plus10bpsStillPositive = (() => {
    if (costModel) {
      const s = costModel.scenarios.find((sc) => sc.scenario === "plus_10bps_slippage");
      if (s) return s.pass === true;
    }
    const cs = frozen.costSensitivity?.find((r) => r.scenario === "plus_10bps_slippage");
    if (cs) return cs.stillPositive === true;
    return false;
  })();

  const drawdownAcceptable =
    approxMaxDrawdownR === null || Math.abs(approxMaxDrawdownR) <= MAX_DRAWDOWN_R_LIMIT;
  const concentrationOk =
    topSymbolPnlShare === null || topSymbolPnlShare <= MAX_TOP_SYMBOL_SHARE;

  const netPositive = typeof netAvgR === "number" && Number.isFinite(netAvgR) && netAvgR > 0;
  const netStrong = typeof netAvgR === "number" && Number.isFinite(netAvgR) && netAvgR > 0.05;
  const pfStrong = typeof pf === "number" && Number.isFinite(pf) && pf > 1.2;

  // ── status rules (evaluate in order) ──────────────────────────────────────
  let status: PromotionTrackerStatus;
  let statusReason: string;

  const promotionGatesMet =
    freshValid >= 200 &&
    oosSegmentsAllPositive &&
    netStrong &&
    pfStrong &&
    plus10bpsStillPositive &&
    drawdownAcceptable &&
    concentrationOk;
  const stableGatesMet =
    freshValid >= 100 && netStrong && pfStrong && oosSegmentsAllPositive && plus10bpsStillPositive;

  if (typeof netAvgR === "number" && Number.isFinite(netAvgR) && netAvgR <= 0) {
    status = "REJECT";
    statusReason = `netAvgR=${netAvgR.toFixed(4)} ≤ 0 — no edge; rejected for promotion.`;
  } else if (netPositive && !oosSegmentsAllPositive) {
    status = "STABILITY_BLOCKED";
    statusReason =
      `netAvgR=${(netAvgR as number).toFixed(4)}>0 but OOS thirds not all positive ` +
      `(${positiveSegmentCount}/3 positive, weakest=${weakestSegment?.label ?? "n/a"}) — STABILITY_BLOCKED.`;
  } else if (promotionGatesMet) {
    status = "PROMOTION_CANDIDATE";
    statusReason =
      `freshValid=${freshValid}≥200, netAvgR=${(netAvgR as number).toFixed(4)}>0.05, PF=${(pf as number).toFixed(2)}>1.20, ` +
      `all 3 OOS positive, +10bps positive, drawdown acceptable, top symbol share≤${(MAX_TOP_SYMBOL_SHARE * 100).toFixed(0)}%.`;
  } else if (stableGatesMet) {
    status = "STABLE_CANDIDATE";
    statusReason =
      `freshValid=${freshValid}≥100, netAvgR=${(netAvgR as number).toFixed(4)}>0.05, PF=${(pf as number).toFixed(2)}>1.20, ` +
      `all 3 OOS positive, +10bps positive.`;
  } else if (freshValid >= 50 && netPositive && pfStrong) {
    status = "WATCHABLE";
    statusReason = `freshValid=${freshValid}≥50, netAvgR=${(netAvgR as number).toFixed(4)}>0, PF=${(pf as number).toFixed(2)}>1.20.`;
  } else {
    status = "COLLECTING";
    const netStr =
      typeof netAvgR === "number" && Number.isFinite(netAvgR) ? `, netAvgR=${netAvgR.toFixed(4)}` : "";
    statusReason = `freshValid=${freshValid}${netStr} — collecting prospective evidence; below WATCHABLE bar.`;
  }

  // ── kill warning ──────────────────────────────────────────────────────────
  let killWarning: string | null = null;
  const rl10Neg = last10.netAvgR !== null && last10.netAvgR < 0;
  const rl20Neg = last20.netAvgR !== null && last20.netAvgR < 0;
  if (rl10Neg || rl20Neg) {
    const x = last10.netAvgR === null ? "n/a" : last10.netAvgR.toFixed(4);
    const y = last20.netAvgR === null ? "n/a" : last20.netAvgR.toFixed(4);
    killWarning =
      `Rolling net turned negative (last_10=${x}, last_20=${y}) — edge may be decaying; monitor closely.`;
  }

  // ── promotion blockers (what's missing to reach PROMOTION_CANDIDATE) ──────
  const promotionBlockers: string[] = [];
  if (freshValid < 200) {
    promotionBlockers.push(`SAMPLE_SIZE: freshValid=${freshValid}, need ≥200.`);
  }
  if (!oosSegmentsAllPositive) {
    promotionBlockers.push(
      `OOS_STABILITY: ${positiveSegmentCount}/3 OOS segments positive (weakest=${weakestSegment?.label ?? "n/a"}); need all 3 positive.`,
    );
  }
  if (!netStrong) {
    const netStr =
      typeof netAvgR === "number" && Number.isFinite(netAvgR) ? netAvgR.toFixed(4) : "n/a";
    promotionBlockers.push(`NET_EXPECTANCY: netAvgR=${netStr}, need >0.05.`);
  }
  if (!pfStrong) {
    const pfStr = typeof pf === "number" && Number.isFinite(pf) ? pf.toFixed(2) : "n/a";
    promotionBlockers.push(`PROFIT_FACTOR: PF=${pfStr}, need >1.20.`);
  }
  if (!plus10bpsStillPositive) {
    promotionBlockers.push("COST_STRESS: +10bps slippage scenario not net positive.");
  }
  if (!drawdownAcceptable) {
    const ddStr = approxMaxDrawdownR === null ? "n/a" : approxMaxDrawdownR.toFixed(2);
    promotionBlockers.push(`DRAWDOWN: approxMaxDrawdownR=${ddStr}R, need |dd|≤${MAX_DRAWDOWN_R_LIMIT}R.`);
  }
  if (!concentrationOk) {
    const shStr = topSymbolPnlShare === null ? "n/a" : `${(topSymbolPnlShare * 100).toFixed(1)}%`;
    promotionBlockers.push(`CONCENTRATION: top symbol share=${shStr}, need ≤${(MAX_TOP_SYMBOL_SHARE * 100).toFixed(0)}%.`);
  }

  // ── cautions ──────────────────────────────────────────────────────────────
  const cautions: string[] = [
    "Report-only forward-test tracker; no live behavior is gated on this status.",
    "Promotion status reaching PROMOTION_CANDIDATE is necessary but NOT sufficient for a micro-pilot — infra readiness (kill switch / order reconciliation / exchange health) must also be implemented.",
  ];
  if (killWarning) cautions.push(killWarning);
  if (!costModel || costModel.modelPopulated !== true) {
    cautions.push("Realistic cost model not fully populated; +10bps check uses fallback cost-sensitivity table.");
  }

  return {
    reportOnly: true,
    laneId: FROZEN_PROMOTION_TRACKER_LANE,
    computedAt,
    freshValid,
    resolvedPerDay: frozen.velocity?.resolvedPerDay ?? null,
    freshValidPerDay: frozen.velocity?.freshValidPerDay ?? null,
    etaToN100Days: frozen.velocity?.etaToN100Days ?? null,
    etaToN100Date: frozen.velocity?.etaToN100Date ?? null,
    etaToN200Days: frozen.velocity?.etaToN200Days ?? null,
    etaToN200Date: frozen.velocity?.etaToN200Date ?? null,
    rolling,
    oosSegmentsAllPositive,
    weakestSegment,
    positiveSegmentCount,
    approxMaxDrawdownR,
    maxAdverseStreak,
    plus10bpsStillPositive,
    topSymbolPnlShare,
    status,
    statusReason,
    promotionBlockers,
    killWarning,
    cautions,
  };
}

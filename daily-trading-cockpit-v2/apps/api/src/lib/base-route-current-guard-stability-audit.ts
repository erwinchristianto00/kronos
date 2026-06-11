/**
 * BASE ROUTE CURRENT-GUARD STABILITY AUDIT (F**) — REPORT-ONLY
 *
 * Deep stability audit of the BASE_ROUTE_STOP175_CURRENT_GUARD lane. Determines
 * whether the (small, high-PF) current-guard tape is a real emerging edge or a
 * fragile slice / noise artifact.
 *
 * Lane label: BASE_ROUTE_STOP175_CURRENT_GUARD (audit verdict appended)
 *
 * STRICTLY REPORT-ONLY:
 *  - PURE module. Zero I/O. No singletons, no file access.
 *  - No live behavior, admission, route selection, or readiness influence.
 *  - reportOnly: true always set.
 *
 * All thresholds are static and documented inline.
 */

/**
 * Minimal per-closed-position shape consumed by the stability audit and the
 * frozen prospective tape. Extracted from the current-guard tape by the
 * Base Route Risk Hygiene Monitor.
 */
export interface CurrentGuardClosedPosition {
  symbol: string;
  direction: "LONG" | "SHORT";
  grossR: number;
  netR: number;
  costR: number;
  regime: string | null;
  entryVariant: string | null;
  exitVariant: string | null;
  policyVersion: string | null;
  openedAt: string;
  closedAt: string;
  /** Optional — when populated, used for stop-bucket breakdown in OOS segment forensics. */
  stopDistanceBps?: number | null;
}

export type StabilityVerdict =
  | "STABLE_CANDIDATE"
  | "PROMISING_BUT_UNSTABLE"
  | "RECENCY_ONLY"
  | "SYMBOL_CONCENTRATED"
  | "COST_SENSITIVE"
  | "REJECTED_BY_STABILITY";

export interface SegmentStats {
  label: string;
  n: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  pf: number | null;
  wr: number | null;
}

export interface CostSensitivityRow {
  scenario: string;
  roundTripBps: number;
  netAvgR: number | null;
  pf: number | null;
  stillPositive: boolean;
}

export interface BreakdownRow {
  key: string;
  n: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
  pnlShare: number;
}

export interface BaseRouteCurrentGuardStabilityReport {
  reportOnly: true;
  laneId: "BASE_ROUTE_STOP175_CURRENT_GUARD";
  computedAt: string;

  // top-line
  closed: number;
  open: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  avgCostR: number | null;
  pf: number | null;
  wr: number | null;

  // temporal splits
  earlyHalf: SegmentStats | null;
  lateHalf: SegmentStats | null;
  last10: SegmentStats | null;
  last20: SegmentStats | null;
  last30: SegmentStats | null;
  dailyBreakdown: SegmentStats[];

  // OOS approximation — split closed (by closedAt time order) into 3 equal segments
  oosSegments: [SegmentStats, SegmentStats, SegmentStats] | null;
  allThreeSegmentsPositive: boolean;

  // dimensional breakdowns
  byRegime: BreakdownRow[];
  bySymbol: BreakdownRow[];
  byEntryVariant: BreakdownRow[];
  byExitVariant: BreakdownRow[];
  byDirection: BreakdownRow[];
  byPolicyVersion: BreakdownRow[];

  // concentration & risk
  topSymbolPnlShare: number;
  topSymbol: string | null;
  maxAdverseStreak: number | null;
  approxMaxDrawdownR: number | null;

  // cost stress
  costSensitivity: CostSensitivityRow[];

  // verdict
  verdict: StabilityVerdict;
  verdictReasons: string[];
  cautions: string[];
}

/**
 * Representative stop distance (bps) used to translate an added-bps cost stress
 * scenario into an additional cost expressed in R. We assume a representative
 * stop distance of 200bps when per-position stop distance is unavailable to the
 * audit (the current-guard tape only carries costR/grossR/netR per close).
 *   extraCostR = extraRoundTripBps / AVERAGE_STOP_BPS
 * This is an approximation, documented in the report scenario labels.
 */
const AVERAGE_STOP_BPS = 200;

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
  const wins = finite.filter((g) => g > 0).length;
  return wins / finite.length;
}

function toMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function segmentOf(label: string, slice: CurrentGuardClosedPosition[]): SegmentStats {
  return {
    label,
    n: slice.length,
    netAvgR: mean(slice.map((p) => p.netR)),
    grossAvgR: mean(slice.map((p) => p.grossR)),
    pf: pfFinite(slice.map((p) => p.grossR)),
    wr: winRate(slice.map((p) => p.grossR)),
  };
}

function breakdown(
  positions: CurrentGuardClosedPosition[],
  keyFn: (p: CurrentGuardClosedPosition) => string,
  totalAbsGrossPnl: number,
): BreakdownRow[] {
  const map = new Map<string, CurrentGuardClosedPosition[]>();
  for (const p of positions) {
    const key = keyFn(p);
    const arr = map.get(key) ?? [];
    arr.push(p);
    map.set(key, arr);
  }
  return Array.from(map.entries())
    .map(([key, arr]) => {
      const absGross = finiteNumbers(arr.map((p) => p.grossR)).reduce((s, v) => s + Math.abs(v), 0);
      return {
        key,
        n: arr.length,
        netAvgR: mean(arr.map((p) => p.netR)),
        pf: pfFinite(arr.map((p) => p.grossR)),
        wr: winRate(arr.map((p) => p.grossR)),
        pnlShare: totalAbsGrossPnl > 0 ? absGross / totalAbsGrossPnl : 0,
      };
    })
    .sort((a, b) => b.n - a.n);
}

/**
 * Cost sensitivity: recompute netAvgR for each scenario by adding an extra cost
 * (in R) on top of the existing per-position costR. We never reduce the existing
 * realized cost — we only stress upward.
 *
 *   netR_scenario = grossR - costR_base - extraCostR
 *   extraCostR    = extraRoundTripBps / AVERAGE_STOP_BPS
 *
 * The "default" scenario uses the existing realized netR directly (no extra).
 */
function buildCostSensitivity(positions: CurrentGuardClosedPosition[]): CostSensitivityRow[] {
  const scenarioNet = (extraRoundTripBps: number): { net: number | null; pf: number | null } => {
    const extraCostR = extraRoundTripBps / AVERAGE_STOP_BPS;
    const adjustedNet: number[] = [];
    const adjustedGross: number[] = [];
    for (const p of positions) {
      if (typeof p.grossR !== "number" || !Number.isFinite(p.grossR)) continue;
      const baseCost = typeof p.costR === "number" && Number.isFinite(p.costR) ? p.costR : 0;
      adjustedNet.push(p.grossR - baseCost - extraCostR);
      // gross less the additional cost is the basis for a stressed PF
      adjustedGross.push(p.grossR - extraCostR);
    }
    return {
      net: mean(adjustedNet),
      pf: pfFinite(adjustedGross),
    };
  };

  const rows: CostSensitivityRow[] = [];

  // default — existing realized netR / grossR (no extra cost)
  {
    const net = mean(positions.map((p) => p.netR));
    const pf = pfFinite(positions.map((p) => p.grossR));
    rows.push({
      scenario: "default",
      roundTripBps: 0,
      netAvgR: net,
      pf,
      stillPositive: net !== null && net > 0,
    });
  }

  // realistic_taker — ~10bps round-trip added (2x taker fee approximation)
  {
    const { net, pf } = scenarioNet(10);
    rows.push({
      scenario: "realistic_taker",
      roundTripBps: 10,
      netAvgR: net,
      pf,
      stillPositive: net !== null && net > 0,
    });
  }

  // plus_5bps_slippage — treat 5bps as round-trip added cost
  {
    const { net, pf } = scenarioNet(5);
    rows.push({
      scenario: "plus_5bps_slippage",
      roundTripBps: 5,
      netAvgR: net,
      pf,
      stillPositive: net !== null && net > 0,
    });
  }

  // plus_10bps_slippage — treat 10bps as round-trip added cost
  {
    const { net, pf } = scenarioNet(10);
    rows.push({
      scenario: "plus_10bps_slippage",
      roundTripBps: 10,
      netAvgR: net,
      pf,
      stillPositive: net !== null && net > 0,
    });
  }

  // funding_adjusted_placeholder — realistic_taker (10bps) + flat 2bps funding placeholder
  {
    const { net, pf } = scenarioNet(12);
    rows.push({
      scenario: "funding_adjusted_placeholder",
      roundTripBps: 12,
      netAvgR: net,
      pf,
      stillPositive: net !== null && net > 0,
    });
  }

  return rows;
}

function maxConsecutiveLossStreak(sorted: CurrentGuardClosedPosition[]): number | null {
  if (sorted.length === 0) return null;
  let max = 0;
  let cur = 0;
  for (const p of sorted) {
    if (typeof p.grossR === "number" && Number.isFinite(p.grossR) && p.grossR < 0) {
      cur += 1;
      if (cur > max) max = cur;
    } else {
      cur = 0;
    }
  }
  return max;
}

/** Approximate max drawdown of the running cumulative netR equity curve. */
function approxMaxDrawdownR(sorted: CurrentGuardClosedPosition[]): number | null {
  const nets = sorted
    .map((p) => p.netR)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nets.length === 0) return null;
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const n of nets) {
    cum += n;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

function dayKey(iso: string): string {
  const ms = toMs(iso);
  if (ms === 0) return "UNKNOWN";
  return new Date(ms).toISOString().slice(0, 10);
}

export function buildBaseRouteCurrentGuardStabilityReport(
  closedPositions: CurrentGuardClosedPosition[],
  openCount: number,
  capturedAt?: string,
): BaseRouteCurrentGuardStabilityReport {
  const computedAt = capturedAt ?? new Date().toISOString();
  const positions = Array.isArray(closedPositions) ? closedPositions : [];
  const closed = positions.length;

  // time-ordered by closedAt (falling back to openedAt)
  const sorted = [...positions].sort((a, b) => {
    const am = toMs(a.closedAt) || toMs(a.openedAt);
    const bm = toMs(b.closedAt) || toMs(b.openedAt);
    return am - bm;
  });

  // top-line
  const netAvgR = mean(positions.map((p) => p.netR));
  const grossAvgR = mean(positions.map((p) => p.grossR));
  const avgCostR = mean(positions.map((p) => p.costR));
  const pf = pfFinite(positions.map((p) => p.grossR));
  const wr = winRate(positions.map((p) => p.grossR));

  const totalAbsGrossPnl = finiteNumbers(positions.map((p) => p.grossR)).reduce(
    (s, v) => s + Math.abs(v),
    0,
  );

  // temporal halves
  let earlyHalf: SegmentStats | null = null;
  let lateHalf: SegmentStats | null = null;
  if (sorted.length >= 2) {
    const mid = Math.floor(sorted.length / 2);
    earlyHalf = segmentOf("early_half", sorted.slice(0, mid));
    lateHalf = segmentOf("late_half", sorted.slice(mid));
  }

  const last10 = sorted.length > 0 ? segmentOf("last_10", sorted.slice(-10)) : null;
  const last20 = sorted.length > 0 ? segmentOf("last_20", sorted.slice(-20)) : null;
  const last30 = sorted.length > 0 ? segmentOf("last_30", sorted.slice(-30)) : null;

  // daily breakdown
  const dayMap = new Map<string, CurrentGuardClosedPosition[]>();
  for (const p of sorted) {
    const k = dayKey(p.closedAt || p.openedAt);
    const arr = dayMap.get(k) ?? [];
    arr.push(p);
    dayMap.set(k, arr);
  }
  const dailyBreakdown = Array.from(dayMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, arr]) => segmentOf(`day_${day}`, arr));

  // OOS thirds (time-ordered)
  let oosSegments: [SegmentStats, SegmentStats, SegmentStats] | null = null;
  if (sorted.length >= 3) {
    const third = Math.floor(sorted.length / 3);
    // distribute remainder to the last segment so all closes are covered
    const seg1 = sorted.slice(0, third);
    const seg2 = sorted.slice(third, third * 2);
    const seg3 = sorted.slice(third * 2);
    oosSegments = [
      segmentOf("segment_1", seg1),
      segmentOf("segment_2", seg2),
      segmentOf("segment_3", seg3),
    ];
  }
  const allThreeSegmentsPositive =
    oosSegments !== null &&
    oosSegments.every((s) => s.netAvgR !== null && s.netAvgR > 0);

  // dimensional breakdowns
  const byRegime = breakdown(positions, (p) => p.regime ?? "UNKNOWN", totalAbsGrossPnl);
  const bySymbol = breakdown(positions, (p) => p.symbol, totalAbsGrossPnl);
  const byEntryVariant = breakdown(positions, (p) => p.entryVariant ?? "unknown", totalAbsGrossPnl);
  const byExitVariant = breakdown(positions, (p) => p.exitVariant ?? "unknown", totalAbsGrossPnl);
  const byDirection = breakdown(positions, (p) => p.direction, totalAbsGrossPnl);
  const byPolicyVersion = breakdown(positions, (p) => p.policyVersion ?? "unknown", totalAbsGrossPnl);

  // symbol concentration (by abs gross PnL share)
  const sortedBySymbolShare = [...bySymbol].sort((a, b) => b.pnlShare - a.pnlShare);
  const topSymbolPnlShare = sortedBySymbolShare[0]?.pnlShare ?? 0;
  const topSymbol = sortedBySymbolShare[0]?.key ?? null;

  const maxAdverseStreak = maxConsecutiveLossStreak(sorted);
  const drawdown = approxMaxDrawdownR(sorted);

  // cost sensitivity
  const costSensitivity = buildCostSensitivity(positions);
  const plus5 = costSensitivity.find((r) => r.scenario === "plus_5bps_slippage");

  // ─── verdict (evaluate in order) ──────────────────────────────────────────
  const verdictReasons: string[] = [];
  let verdict: StabilityVerdict;

  const earlyNet = earlyHalf?.netAvgR ?? null;
  const lateNet = lateHalf?.netAvgR ?? null;
  const plus5Net = plus5?.netAvgR ?? null;

  if (netAvgR !== null && netAvgR <= 0) {
    verdict = "REJECTED_BY_STABILITY";
    verdictReasons.push(`netAvgR=${netAvgR.toFixed(4)} ≤ 0 — no edge to stabilize`);
  } else if (plus5Net !== null && plus5Net <= 0) {
    verdict = "COST_SENSITIVE";
    verdictReasons.push(
      `edge disappears under +5bps cost stress (net=${plus5Net.toFixed(4)} ≤ 0)`,
    );
  } else if (topSymbolPnlShare > 0.4) {
    verdict = "SYMBOL_CONCENTRATED";
    verdictReasons.push(
      `top symbol ${topSymbol} contributes ${(topSymbolPnlShare * 100).toFixed(1)}% of |gross PnL| (>40%)`,
    );
  } else if (earlyNet !== null && earlyNet <= 0 && lateNet !== null && lateNet > 0) {
    verdict = "RECENCY_ONLY";
    verdictReasons.push(
      `all gains are recent: early half net=${earlyNet.toFixed(4)} ≤ 0, late half net=${lateNet.toFixed(4)} > 0`,
    );
  } else if (
    closed >= 100 &&
    netAvgR !== null &&
    netAvgR > 0.05 &&
    pf !== null &&
    pf > 1.2 &&
    allThreeSegmentsPositive === true &&
    topSymbolPnlShare <= 0.4 &&
    plus5Net !== null &&
    plus5Net > 0
  ) {
    verdict = "STABLE_CANDIDATE";
    verdictReasons.push(
      `closed=${closed}≥100, netAvgR=${netAvgR.toFixed(4)}>0.05, PF=${pf.toFixed(2)}>1.20, all 3 OOS segments positive, top symbol share=${(topSymbolPnlShare * 100).toFixed(1)}%≤40%, survives +5bps`,
    );
  } else {
    verdict = "PROMISING_BUT_UNSTABLE";
    const why: string[] = [];
    if (closed < 100) why.push(`sample too small (closed=${closed}<100)`);
    if (netAvgR !== null && netAvgR <= 0.05) why.push(`netAvgR=${netAvgR.toFixed(4)}≤0.05`);
    if (pf !== null && pf <= 1.2) why.push(`PF=${pf.toFixed(2)}≤1.20`);
    if (!allThreeSegmentsPositive) why.push("not all 3 OOS segments positive");
    verdictReasons.push(
      `net positive but does not yet meet STABLE_CANDIDATE bar${why.length > 0 ? ` (${why.join("; ")})` : ""}`,
    );
  }

  // ─── cautions ─────────────────────────────────────────────────────────────
  const cautions: string[] = [];
  if (closed < 200) {
    cautions.push(`Small sample: closed=${closed} (need ≥200 for promotion-grade evidence)`);
  }
  if (earlyNet !== null && lateNet !== null && !(earlyNet > 0 && lateNet > 0)) {
    cautions.push(
      `Early/late divergence: early=${earlyNet.toFixed(4)}R late=${lateNet.toFixed(4)}R`,
    );
  }
  if (topSymbolPnlShare > 0.4 && topSymbol) {
    cautions.push(
      `Symbol concentration: ${topSymbol} at ${(topSymbolPnlShare * 100).toFixed(1)}% of |gross PnL|`,
    );
  }
  if (plus5Net !== null && plus5Net <= 0) {
    cautions.push("Cost sensitivity: edge does not survive +5bps slippage stress");
  }
  if (pf !== null && pf > 2.0 && closed < 100) {
    cautions.push(`PF=${pf.toFixed(2)} on n=${closed} may be noise (high PF on small sample)`);
  }
  if (maxAdverseStreak !== null && maxAdverseStreak >= 5) {
    cautions.push(`Max adverse streak: ${maxAdverseStreak} consecutive losses observed`);
  }

  return {
    reportOnly: true,
    laneId: "BASE_ROUTE_STOP175_CURRENT_GUARD",
    computedAt,
    closed,
    open: openCount,
    netAvgR,
    grossAvgR,
    avgCostR,
    pf,
    wr,
    earlyHalf,
    lateHalf,
    last10,
    last20,
    last30,
    dailyBreakdown,
    oosSegments,
    allThreeSegmentsPositive,
    byRegime,
    bySymbol: sortedBySymbolShare,
    byEntryVariant,
    byExitVariant,
    byDirection,
    byPolicyVersion,
    topSymbolPnlShare,
    topSymbol,
    maxAdverseStreak,
    approxMaxDrawdownR: drawdown,
    costSensitivity,
    verdict,
    verdictReasons,
    cautions,
  };
}

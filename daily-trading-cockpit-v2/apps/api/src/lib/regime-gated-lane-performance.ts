/**
 * Regime-gated lane performance (report-only analysis).
 *
 * The testnet live engine only executes a lane when the regime estimator allows that direction
 * (don't short a bull, don't long a bear). This re-scores EVERY measured VM-variant lane the same
 * way — over the observations we ALREADY have — so we can see, per lane, whether regime-gating the
 * execution would have IMPROVED it, without waiting weeks to re-accrue. Pure: caller passes the
 * observations; nothing is mutated or executed.
 *
 * The gate keeps an observation only if the regime estimated from its entry regime ALLOWS its
 * direction: estimated MIXED/unknown → kept (can't gate); estimated direction == obs direction →
 * kept; estimated OPPOSITE → dropped (the counter-regime trade that wouldn't have been taken).
 */
export interface RgObservation {
  variantId: string;
  direction: "LONG" | "SHORT";
  regime: string | null;
  netR: number | null;
}

/**
 * Direction implied by a regime label, mirroring the lane-selector regime estimator's regime-text
 * branch (the only part the gate needs). Self-contained on purpose: this analysis must run on the
 * main-branch instance, whose lane-selector predates `estimateLaneSelectorV2Regime`. Order matters —
 * MIXED is checked first so "Mixed rotation" doesn't fall through to a directional match.
 */
export function estimateRegimeDirection(regime: string | null): "LONG" | "SHORT" | "MIXED" | null {
  const r = (regime ?? "").toLowerCase();
  if (!r) return null;
  if (/mixed|rotation|chop|range|sideways|neutral|unknown/.test(r)) return "MIXED";
  if (/bull|long/.test(r)) return "LONG";
  if (/bear|short/.test(r)) return "SHORT";
  return null;
}

export function regimeAllowsObservation(obs: { regime: string | null; direction: "LONG" | "SHORT" }): boolean {
  const dir = estimateRegimeDirection(obs.regime);
  if (dir === null || dir === "MIXED") return true; // can't gate a mixed/unknown regime → keep
  return dir === obs.direction; // keep only same-direction; drop counter-regime
}

export interface LanePerf {
  n: number;
  wins: number;
  netAvgR: number;
  winRate: number;
  profitFactor: number | null; // null when there are no losses
  totalR: number;
}

function perf(rs: number[]): LanePerf {
  const n = rs.length;
  if (n === 0) return { n: 0, wins: 0, netAvgR: 0, winRate: 0, profitFactor: null, totalR: 0 };
  const wins = rs.filter((r) => r > 0).length;
  const grossWin = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const totalR = rs.reduce((a, b) => a + b, 0);
  return {
    n,
    wins,
    netAvgR: totalR / n,
    winRate: wins / n,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    totalR,
  };
}

export interface RegimeGatedLaneRow {
  variantId: string;
  raw: LanePerf;
  gated: LanePerf;
  filteredOut: number; // counter-regime obs the gate removed
  deltaNetAvgR: number; // gated − raw
  verdict: "IMPROVED" | "WORSENED" | "FLAT" | "INSUFFICIENT";
}

export interface RegimeGatedLaneReport {
  totalObs: number;
  totalGatedOut: number;
  lanes: RegimeGatedLaneRow[];
}

const MIN_GATED_N = 15; // below this the gated read is noise, not a verdict

export function buildRegimeGatedLaneReport(observations: RgObservation[]): RegimeGatedLaneReport {
  const resolved = observations.filter(
    (o) => o.netR != null && Number.isFinite(o.netR) && (o.direction === "LONG" || o.direction === "SHORT"),
  );
  const byLane = new Map<string, RgObservation[]>();
  for (const o of resolved) {
    const list = byLane.get(o.variantId);
    if (list) list.push(o);
    else byLane.set(o.variantId, [o]);
  }
  let totalGatedOut = 0;
  const lanes: RegimeGatedLaneRow[] = [];
  for (const [variantId, list] of byLane) {
    const raw = perf(list.map((o) => o.netR!));
    const gatedList = list.filter((o) => regimeAllowsObservation(o));
    const gated = perf(gatedList.map((o) => o.netR!));
    const filteredOut = raw.n - gated.n;
    totalGatedOut += filteredOut;
    const delta = gated.netAvgR - raw.netAvgR;
    const verdict: RegimeGatedLaneRow["verdict"] =
      gated.n < MIN_GATED_N ? "INSUFFICIENT" : delta > 0.01 ? "IMPROVED" : delta < -0.01 ? "WORSENED" : "FLAT";
    lanes.push({ variantId, raw, gated, filteredOut, deltaNetAvgR: delta, verdict });
  }
  lanes.sort((a, b) => b.raw.n - a.raw.n);
  return { totalObs: resolved.length, totalGatedOut, lanes };
}

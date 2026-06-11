/**
 * Exit Variant Counterfactuals for REGIME_CONTROLLER_ALIGNED_SHADOW_V1.
 *
 * REPORT-ONLY. Pure module — no I/O, no side effects, no imports from store.
 *
 * Statistical approximation: assumes that if TP1 was reached (CLOSED_WIN),
 * TP2/TP3 would also have been reached eventually (worst-case: same candle).
 * Losses (SL hit before any TP) are unchanged across all variants.
 * WR is identical across all variants because entry and stop are unchanged.
 *
 * Label as "statistical approximation" in all outputs.
 *
 * Direction inference: stopLoss < entryPrice → LONG; stopLoss > entryPrice → SHORT.
 * Explicit `direction` field takes precedence if provided.
 */

export type ExitVariantLabel =
  | "TP1_FULL_EXIT"
  | "TP2_FULL_EXIT"
  | "TP1_50_TP2_50"
  | "TP1_50_RUNNER_TP3";

export interface ExitVariantResult {
  variantLabel: ExitVariantLabel;
  resolvedN: number;
  winN: number;
  lossN: number;
  /** winN / resolvedN */
  WR: number | null;
  avgWinGrossR: number | null;
  /** Always ≈ -1.0 across all variants (SL fires at -1R regardless of TP target). */
  avgLossGrossR: number | null;
  avgGrossR: number | null;
  avgCostR: number | null;
  avgNetR: number | null;
  PF: number | null;
  /** avgWinGrossR / |avgLossGrossR| */
  payoffRatio: number | null;
  /** Human-readable note explaining the approximation and any fallbacks used. */
  note: string;
}

export interface ExitVariantCounterfactualReport {
  reportOnly: true;
  /** Top-level caveat about the statistical approximation methodology. */
  approximationNote: string;
  variants: ExitVariantResult[];
  bestByNetAvgR: ExitVariantLabel | null;
  bestByPF: ExitVariantLabel | null;
  byMode: Array<{
    controllerMode: string;
    variants: ExitVariantResult[];
  }>;
}

// ─── Input observation type (subset of ControllerAlignedShadowPosition) ───────

export interface ExitCounterfactualObservation {
  status: string;
  entryPrice: number;
  stopLoss: number;
  takeProfitLevels: number[];
  costR: number | null;
  grossR: number | null;
  netR: number | null;
  controllerMode: string;
  /** Optional: explicit direction. If omitted, inferred from stopLoss vs entryPrice. */
  direction?: "LONG" | "SHORT" | string | null;
  /** Optional: stopDistanceBps used to derive costR when costR field is null. */
  stopDistanceBps?: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function inferDirection(obs: ExitCounterfactualObservation): "LONG" | "SHORT" {
  if (obs.direction === "LONG" || obs.direction === "SHORT") return obs.direction;
  // Infer: LONG has stop below entry, SHORT has stop above entry
  return obs.stopLoss < obs.entryPrice ? "LONG" : "SHORT";
}

/**
 * Compute grossR for a single TP level given observation geometry.
 * Returns 0 if stopDist <= 0 (degenerate geometry).
 */
function computeTpGrossR(
  tp: number,
  entryPrice: number,
  stopLoss: number,
  direction: "LONG" | "SHORT",
): number {
  const stopDist =
    direction === "LONG"
      ? entryPrice - stopLoss
      : stopLoss - entryPrice;
  if (stopDist <= 0) return 0;
  return direction === "LONG"
    ? (tp - entryPrice) / stopDist
    : (entryPrice - tp) / stopDist;
}

/**
 * Derive costR for an observation.
 * Priority: observation.costR → derive from stopDistanceBps (14bps per side × 2) → 0.
 */
function deriveCostR(obs: ExitCounterfactualObservation): number {
  if (typeof obs.costR === "number" && Number.isFinite(obs.costR)) return obs.costR;
  if (typeof obs.stopDistanceBps === "number" && obs.stopDistanceBps > 0) {
    return (14 * 2) / obs.stopDistanceBps;
  }
  return 0;
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function computePF(netRs: number[]): number | null {
  const positiveSum = netRs.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const negativeSum = netRs.filter((v) => v < 0).reduce((s, v) => s + v, 0);
  if (positiveSum === 0 || negativeSum === 0) return null;
  return positiveSum / Math.abs(negativeSum);
}

// ─── Per-variant grossR computation ───────────────────────────────────────────

interface VariantGrossR {
  TP1_FULL_EXIT: number;
  TP2_FULL_EXIT: number;
  TP1_50_TP2_50: number;
  TP1_50_RUNNER_TP3: number;
  tp2Fallback: boolean;
  tp3Fallback: boolean;
}

/**
 * Compute alternative grossR values for a CLOSED_WIN observation.
 * Falls back tp2 → tp1, tp3 → tp2 when levels are missing.
 */
function winVariantGrossR(obs: ExitCounterfactualObservation): VariantGrossR {
  const dir = inferDirection(obs);
  const entry = obs.entryPrice;
  const stop = obs.stopLoss;
  const tp1 = obs.takeProfitLevels[0] ?? entry; // degenerate fallback
  const rawTp2 = obs.takeProfitLevels[1];
  const rawTp3 = obs.takeProfitLevels[2];

  const tp2Fallback = rawTp2 === undefined;
  const tp3Fallback = rawTp3 === undefined;
  const tp2 = rawTp2 ?? tp1;
  const tp3 = rawTp3 ?? tp2;

  const tp1R = computeTpGrossR(tp1, entry, stop, dir);
  const tp2R = computeTpGrossR(tp2, entry, stop, dir);
  const tp3R = computeTpGrossR(tp3, entry, stop, dir);

  return {
    TP1_FULL_EXIT: tp1R,
    TP2_FULL_EXIT: tp2R,
    TP1_50_TP2_50: 0.5 * tp1R + 0.5 * tp2R,
    TP1_50_RUNNER_TP3: 0.5 * tp1R + 0.5 * tp3R,
    tp2Fallback,
    tp3Fallback,
  };
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

interface ObsForVariant {
  grossR: number; // variant-specific grossR
  costR: number;
  isWin: boolean;
}

function aggregateVariant(
  label: ExitVariantLabel,
  obsRows: ObsForVariant[],
  note: string,
): ExitVariantResult {
  const wins = obsRows.filter((r) => r.isWin);
  const losses = obsRows.filter((r) => !r.isWin);
  const resolvedN = obsRows.length;
  const winN = wins.length;
  const lossN = losses.length;
  const WR = resolvedN > 0 ? winN / resolvedN : null;

  const avgWinGrossR = avg(wins.map((r) => r.grossR));
  const avgLossGrossR = avg(losses.map((r) => r.grossR));
  const avgCostR = avg(obsRows.map((r) => r.costR));
  const avgGrossR = avg(obsRows.map((r) => r.grossR));

  const netRs = obsRows.map((r) => r.grossR - r.costR);
  const avgNetR = avg(netRs);
  const PF = computePF(netRs);

  const payoffRatio =
    avgWinGrossR !== null && avgLossGrossR !== null && avgLossGrossR !== 0
      ? avgWinGrossR / Math.abs(avgLossGrossR)
      : null;

  return {
    variantLabel: label,
    resolvedN,
    winN,
    lossN,
    WR,
    avgWinGrossR,
    avgLossGrossR,
    avgCostR,
    avgNetR,
    avgGrossR,
    PF,
    payoffRatio,
    note,
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

const VARIANT_LABELS: ExitVariantLabel[] = [
  "TP1_FULL_EXIT",
  "TP2_FULL_EXIT",
  "TP1_50_TP2_50",
  "TP1_50_RUNNER_TP3",
];

const APPROXIMATION_NOTE =
  "Statistical approximation — WR identical across variants (entry/stop unchanged); " +
  "only avgWinR differs. Does not account for TP2 being missed in some TP1-hit candles. " +
  "Loss outcomes (SL hit) are always -1.0R regardless of TP target.";

/**
 * Build exit variant counterfactuals from resolved controller-aligned shadow observations.
 *
 * Requires >= 2 resolved (CLOSED_WIN or CLOSED_LOSS) observations.
 * Returns a report with reportOnly: true.
 */
export function buildExitVariantCounterfactuals(
  observations: ExitCounterfactualObservation[],
): ExitVariantCounterfactualReport {
  // Only CLOSED_WIN and CLOSED_LOSS are used for economics
  const resolved = observations.filter(
    (o) => o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS",
  );

  const emptyReport: ExitVariantCounterfactualReport = {
    reportOnly: true,
    approximationNote: APPROXIMATION_NOTE,
    variants: [],
    bestByNetAvgR: null,
    bestByPF: null,
    byMode: [],
  };

  if (resolved.length < 2) return emptyReport;

  // Build per-label obs rows across all resolved observations
  const rowsByLabel: Record<ExitVariantLabel, ObsForVariant[]> = {
    TP1_FULL_EXIT: [],
    TP2_FULL_EXIT: [],
    TP1_50_TP2_50: [],
    TP1_50_RUNNER_TP3: [],
  };

  let anyTp2Fallback = false;
  let anyTp3Fallback = false;

  for (const obs of resolved) {
    const costR = deriveCostR(obs);
    if (obs.status === "CLOSED_WIN") {
      const vr = winVariantGrossR(obs);
      if (vr.tp2Fallback) anyTp2Fallback = true;
      if (vr.tp3Fallback) anyTp3Fallback = true;
      for (const label of VARIANT_LABELS) {
        rowsByLabel[label].push({ grossR: vr[label], costR, isWin: true });
      }
    } else {
      // CLOSED_LOSS: all variants give -1.0 grossR (SL hit before any TP)
      for (const label of VARIANT_LABELS) {
        rowsByLabel[label].push({ grossR: -1.0, costR, isWin: false });
      }
    }
  }

  // Build notes per variant
  function buildNote(label: ExitVariantLabel): string {
    const parts: string[] = ["Statistical approx"];
    if (label === "TP2_FULL_EXIT" && anyTp2Fallback) {
      parts.push("some obs had no TP2 — fell back to TP1");
    }
    if (
      (label === "TP1_50_RUNNER_TP3" || label === "TP1_50_TP2_50") &&
      anyTp2Fallback
    ) {
      parts.push("some obs had no TP2 — fell back to TP1");
    }
    if (label === "TP1_50_RUNNER_TP3" && anyTp3Fallback) {
      parts.push("some obs had no TP3 — fell back to TP2");
    }
    return parts.join("; ");
  }

  const variants: ExitVariantResult[] = VARIANT_LABELS.map((label) =>
    aggregateVariant(label, rowsByLabel[label], buildNote(label)),
  );

  // Best by avgNetR (highest)
  const validByNetR = variants.filter((v) => v.avgNetR !== null);
  const bestByNetAvgR: ExitVariantLabel | null =
    validByNetR.length > 0
      ? (validByNetR.reduce((best, v) =>
          (v.avgNetR as number) > (best.avgNetR as number) ? v : best,
        ).variantLabel)
      : null;

  // Best by PF (highest)
  const validByPF = variants.filter((v) => v.PF !== null);
  const bestByPF: ExitVariantLabel | null =
    validByPF.length > 0
      ? (validByPF.reduce((best, v) =>
          (v.PF as number) > (best.PF as number) ? v : best,
        ).variantLabel)
      : null;

  // byMode breakdown
  const modeSet = new Set(resolved.map((o) => o.controllerMode));
  const byMode: ExitVariantCounterfactualReport["byMode"] = [];

  for (const mode of [...modeSet].sort()) {
    const modeObs = resolved.filter((o) => o.controllerMode === mode);
    if (modeObs.length < 1) continue;

    const modeRowsByLabel: Record<ExitVariantLabel, ObsForVariant[]> = {
      TP1_FULL_EXIT: [],
      TP2_FULL_EXIT: [],
      TP1_50_TP2_50: [],
      TP1_50_RUNNER_TP3: [],
    };

    let modeAnyTp2Fallback = false;
    let modeAnyTp3Fallback = false;

    for (const obs of modeObs) {
      const costR = deriveCostR(obs);
      if (obs.status === "CLOSED_WIN") {
        const vr = winVariantGrossR(obs);
        if (vr.tp2Fallback) modeAnyTp2Fallback = true;
        if (vr.tp3Fallback) modeAnyTp3Fallback = true;
        for (const label of VARIANT_LABELS) {
          modeRowsByLabel[label].push({ grossR: vr[label], costR, isWin: true });
        }
      } else {
        for (const label of VARIANT_LABELS) {
          modeRowsByLabel[label].push({ grossR: -1.0, costR, isWin: false });
        }
      }
    }

    function buildModeNote(label: ExitVariantLabel): string {
      const parts: string[] = ["Statistical approx"];
      if (label === "TP2_FULL_EXIT" && modeAnyTp2Fallback) {
        parts.push("some obs had no TP2 — fell back to TP1");
      }
      if (
        (label === "TP1_50_RUNNER_TP3" || label === "TP1_50_TP2_50") &&
        modeAnyTp2Fallback
      ) {
        parts.push("some obs had no TP2 — fell back to TP1");
      }
      if (label === "TP1_50_RUNNER_TP3" && modeAnyTp3Fallback) {
        parts.push("some obs had no TP3 — fell back to TP2");
      }
      return parts.join("; ");
    }

    byMode.push({
      controllerMode: mode,
      variants: VARIANT_LABELS.map((label) =>
        aggregateVariant(label, modeRowsByLabel[label], buildModeNote(label)),
      ),
    });
  }

  return {
    reportOnly: true,
    approximationNote: APPROXIMATION_NOTE,
    variants,
    bestByNetAvgR,
    bestByPF,
    byMode,
  };
}

import type { ProfitRouteReasonCode, ScannerDiagnostics } from "./types.js";
import type { ProfitRouteInput, ProfitRouteDecision } from "./profit-routing.js";

export type { ScannerDiagnostics };

const POSITIVE_LABELS: Partial<Record<ProfitRouteReasonCode, string>> = {
  POSITIVE_NET_EVIDENCE: "Positive expected net R from evidence",
  SYMBOL_NET_POSITIVE: "Symbol historical net R positive",
  KRONOS_AGREES: "Kronos bias agrees with trade direction",
  WHALE_AGREES: "Whale flow agrees with trade direction",
  RUNNER_OK: "Runner exit viable",
  TP1_PROFITABLE_AFTER_COST: "TP1 profitable after costs in ≥50% of closes",
  PROFITABLE_REPLAY_CHOICE: "Replay-backed combo shows positive net R",
  TOXIC_VARIANT_OVERRIDDEN_BY_SYMBOL: "Toxic entry overridden by strong symbol performance",
};

const NEGATIVE_LABELS: Partial<Record<ProfitRouteReasonCode, string>> = {
  NEGATIVE_NET_EVIDENCE: "Negative expected net R",
  NO_EVIDENCE: "No replay or heuristic evidence yet",
  EARLY_SAMPLE: "Sample size too small (early tier, <30 resolved)",
  ALL_REPLAY_VARIANTS_NEGATIVE: "All replay combos for this entry are negative",
  SYMBOL_NET_NEGATIVE: "Symbol historical net R is negative",
  SIDE_NET_NEGATIVE: "Direction side net R deeply negative (≤−0.15)",
  TOXIC_VARIANT: "Entry variant is toxic (ema20_pullback)",
  KRONOS_HORIZON_CONFLICT: "Kronos 1h/4h horizon conflict detected",
  KRONOS_DISAGREES: "Kronos bias disagrees with trade direction",
  WHALE_DISAGREES: "Whale flow disagrees with trade direction",
  RUNNER_BLOCKED_BY_HORIZON_CONFLICT: "Runner exit blocked by horizon conflict",
  RUNNER_REQUIRES_POSITIVE_NET: "Runner exit requires positive net R",
  COST_R_HIGH: "Cost drag high relative to stop distance (≥0.45R)",
  STOP_TOO_TIGHT: "Stop too tight (<18bps)",
  TP1_NOT_PROFITABLE_AFTER_COST: "TP1 not profitable after costs in most closes",
};

const NEGATIVE_WEIGHTS: Partial<Record<ProfitRouteReasonCode, number>> = {
  TOXIC_VARIANT: 40,
  ALL_REPLAY_VARIANTS_NEGATIVE: 30,
  NEGATIVE_NET_EVIDENCE: 25,
  NO_EVIDENCE: 12,
  EARLY_SAMPLE: 18,
  SYMBOL_NET_NEGATIVE: 15,
  SIDE_NET_NEGATIVE: 12,
  KRONOS_HORIZON_CONFLICT: 10,
  RUNNER_BLOCKED_BY_HORIZON_CONFLICT: 10,
  KRONOS_DISAGREES: 8,
  RUNNER_REQUIRES_POSITIVE_NET: 8,
  WHALE_DISAGREES: 6,
  COST_R_HIGH: 6,
  STOP_TOO_TIGHT: 5,
  TP1_NOT_PROFITABLE_AFTER_COST: 5,
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

export function computeScannerDiagnostics(
  input: ProfitRouteInput,
  decision: ProfitRouteDecision,
): ScannerDiagnostics {
  // routeScore ≈ +60 at best, −100+ at worst; map to 0–100 similarity
  const profitCandidateSimilarityScore = Math.round(clamp(50 + decision.routeScore * 0.5, 0, 100));

  const codes = decision.routeReasonCodes;

  let rawRisk = 0;
  for (const code of codes) rawRisk += NEGATIVE_WEIGHTS[code] ?? 0;
  const researchRiskScore = Math.round(clamp(rawRisk, 0, 100));

  const topPositiveEvidence = codes
    .filter((c) => POSITIVE_LABELS[c])
    .map((c) => POSITIVE_LABELS[c]!)
    .slice(0, 3);

  const topNegativeEvidence = codes
    .filter((c) => NEGATIVE_LABELS[c])
    .map((c) => NEGATIVE_LABELS[c]!)
    .slice(0, 3);

  const closestPathToProfitCandidate = deriveClosestPath(input, decision);

  return {
    profitCandidateSimilarityScore,
    researchRiskScore,
    topPositiveEvidence,
    topNegativeEvidence,
    closestPathToProfitCandidate,
  };
}

function deriveClosestPath(input: ProfitRouteInput, decision: ProfitRouteDecision): string {
  const { routeMode, routeReasonCodes: codes } = decision;

  if (routeMode === "PROFIT_CANDIDATE") {
    return "Already routed as profit candidate.";
  }

  if (codes.includes("TOXIC_VARIANT")) {
    const resolved = input.symbolStats?.resolved ?? 0;
    const netR = input.symbolStats?.netAvgR;
    if (resolved < 5) {
      return `Need ≥5 resolved symbol trades (${resolved} so far) with net R ≥ +0.05 to override toxic entry variant.`;
    }
    return `Symbol net R is ${netR != null ? netR.toFixed(2) : "unknown"}R — needs ≥ +0.05 to override toxic entry variant.`;
  }

  if (codes.includes("ALL_REPLAY_VARIANTS_NEGATIVE")) {
    const net = input.expectedNetR;
    if (net !== null && net >= -0.05) {
      return `Near breakeven (${net.toFixed(2)}R); collecting evidence. Needs positive replay data to promote.`;
    }
    return `All replay combos for ${input.selectedEntryVariant} negative. Needs new positive trade data or a different entry variant.`;
  }

  if (codes.includes("NO_EVIDENCE")) {
    return "No evidence yet. Needs ≥1 resolved shadow trade to evaluate.";
  }

  if (codes.includes("NEGATIVE_NET_EVIDENCE")) {
    const net = input.expectedNetR;
    return `Expected net R is ${net != null ? net.toFixed(2) : "unknown"}R. Needs to turn positive from replay or heuristic data.`;
  }

  if (codes.includes("EARLY_SAMPLE")) {
    const sz =
      input.variantCombo?.resolved ??
      input.entryVariantStats?.resolved ??
      0;
    return `Early sample (${sz} resolved). Needs ≥30 resolved to leave early tier.`;
  }

  if (codes.includes("SIDE_NET_NEGATIVE")) {
    return `${input.direction} side net R is deeply negative. Wait for side recovery or focus on the other direction.`;
  }

  if (routeMode === "DATA_COLLECTION") {
    const net = input.expectedNetR;
    if (net !== null && net > 0) {
      return "Evidence turning positive — promote when sample exits early tier (≥30 resolved).";
    }
    return "Collecting evidence. Needs positive expected net R with ≥30 resolved samples.";
  }

  return "Borderline on net R evidence. Needs more resolved trades to move to profit route.";
}

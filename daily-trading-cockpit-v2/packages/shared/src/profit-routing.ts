import type {
  ExecutionEntryVariant,
  ProfitRouteMode,
  ProfitRouteReasonCode,
  ShadowPositionVariant,
  ShadowVariantStats,
  VariantCombinationStats,
  VariantConfidenceTier,
} from "./types.js";

export interface SymbolPerformanceSummary {
  symbol: string;
  netAvgR: number | null;
  resolved: number;
}

export interface SidePerformanceSummary {
  side: "LONG" | "SHORT";
  netAvgR: number | null;
  resolved: number;
}

export interface KronosRoutingFields {
  bias?: "LONG" | "SHORT" | "NEUTRAL" | "UNAVAILABLE";
  selectedBias?: "LONG" | "SHORT" | "NEUTRAL" | "UNAVAILABLE";
  confidenceBucket?: "STRONG" | "MEDIUM" | "WEAK" | "NONE" | string;
  horizonConflict?: boolean;
}

export interface WhaleRoutingFields {
  available: boolean;
  agrees: boolean;
  disagrees: boolean;
}

export interface CostDiagnosticFields {
  costR: number | null;
  spreadR: number | null;
  feeSlippageR: number | null;
  stopDistanceBps: number | null;
}

export interface ProfitRouteInput {
  symbol: string;
  direction: "LONG" | "SHORT";
  selectedEntryVariant: ExecutionEntryVariant;
  selectedExitVariant: ShadowPositionVariant;
  expectedNetR: number | null;
  expectedGrossR: number | null;
  variantConfidenceTier: VariantConfidenceTier;
  symbolStats: SymbolPerformanceSummary | null;
  sideStats: SidePerformanceSummary | null;
  variantCombo: VariantCombinationStats | null;
  allReplayCombosForVariant: VariantCombinationStats[];
  entryVariantStats: ShadowVariantStats | null;
  exitVariantStats: ShadowVariantStats | null;
  kronos: KronosRoutingFields;
  whale: WhaleRoutingFields;
  cost: CostDiagnosticFields;
  profitableTp1Rate?: number | null;
  runnerSuccessRate?: number | null;
  selectionSource: "replay" | "heuristic_fallback";
  /** Calibration-adjusted expectancy; when provided, routing prefers this over `expectedNetR`. */
  calibratedExpectedNetR?: number | null;
  /** Only conservative, direct-combo evidence has routing authority. */
  canonicalRoutingNetR?: number | null;
  calibrationVerdict?:
    | "RAW_EDGE_NOT_VALIDATED"
    | "CALIBRATED_POSITIVE"
    | "CALIBRATED_NEGATIVE"
    | "INSUFFICIENT_SAMPLE";
  calibrationSampleSize?: number;
  calibrationDiagnosisCodes?: string[];
  /**
   * Optional current-policy admission fingerprint. Older callers may omit this and keep the
   * historical routing behavior; buildVariantSelection always supplies it for new observations.
   */
  profitAdmission?: {
    chaseRisk: "LOW" | "MEDIUM" | "HIGH";
    riskReward: number | null;
  };
}

export interface ProfitRouteDecision {
  routeMode: ProfitRouteMode;
  routeScore: number;
  routeDiagnosticScore: number;
  routeReasonCodes: ProfitRouteReasonCode[];
  routeExplanation: string;
  primaryProfitEligible: boolean;
  researchReason: string | null;
  dataCollectionReason: string | null;
}

const TOXIC_ENTRY_VARIANTS: ExecutionEntryVariant[] = ["ema20_pullback_entry"];
const RUNNER_EXITS: ShadowPositionVariant[] = [
  "tp1_50_tp2_runner",
  "tp1_70_runner30",
  "trail_after_tp1",
  "kronos_runner_exit",
];

const COST_R_HIGH_THRESHOLD = 0.45;
const STOP_TOO_TIGHT_BPS = 18;
// POST_CALIBRATION evidence: stopDistanceBps < 100 → 0% win rate, -1.66R avg,
// inflated projected RR is a false-edge artefact of the tiny stop denominator.
const ULTRA_TIGHT_STOP_BPS = 100;
// 2026-07-10 post-calibration audit (2,636 honest closes): the only robust geometry cohort was
// LOW chase + stop >=500bps + RR 5-8. Narrower stops and RR outside this band remain observable,
// but may not be labelled primary profit candidates until fresh evidence disproves this guard.
const PROFIT_STOP_FLOOR_BPS = 500;
const PROFIT_RR_MIN = 5;
const PROFIT_RR_MAX = 8;
const SYMBOL_POSITIVE_NET_R = 0.05;
const SYMBOL_NEGATIVE_NET_R = -0.05;
const SIDE_DEEPLY_NEGATIVE_NET_R = -0.15;
const ACCEPTABLE_RUNNER_SUCCESS = 0.2;

// Toxic variant override requires a higher bar than generic symbol-positive:
// must have ≥15 resolved AND netAvgR ≥ 0.10 to escape RESEARCH_ONLY.
// This prevents ema20_pullback from being promoted on thin early positive evidence.
const TOXIC_VARIANT_MIN_RESOLVED = 15;
const TOXIC_VARIANT_MIN_NET_R = 0.10;

function isToxicVariant(v: ExecutionEntryVariant): boolean {
  return TOXIC_ENTRY_VARIANTS.includes(v);
}

function isRunnerExit(v: ShadowPositionVariant): boolean {
  return RUNNER_EXITS.includes(v);
}

function allReplayVariantsNegative(combos: VariantCombinationStats[]): boolean {
  if (combos.length === 0) return false;
  const resolved = combos.filter((c) => c.resolved > 0);
  if (resolved.length === 0) return false;
  return resolved.every((c) => (c.netAvgR ?? Number.NEGATIVE_INFINITY) <= 0);
}

export function computeProfitRoute(input: ProfitRouteInput): ProfitRouteDecision {
  const codes: ProfitRouteReasonCode[] = [];
  let score = 0;
  const explanationParts: string[] = [];

  // New planner calls always provide canonicalRoutingNetR.  Keep the legacy
  // argument behavior for historical/audit callers that predate this field.
  const net = input.canonicalRoutingNetR === undefined ? input.expectedNetR : input.canonicalRoutingNetR;
  if (net === null) {
    codes.push("NO_EVIDENCE");
    score -= 10;
  } else if (net > 0) {
    codes.push("POSITIVE_NET_EVIDENCE");
    score += Math.min(net * 100, 60);
  } else if (net < 0) {
    codes.push("NEGATIVE_NET_EVIDENCE");
    score -= Math.min(Math.abs(net) * 100, 60);
  } else {
    codes.push("NEUTRAL_NET_EVIDENCE");
  }

  if (input.variantConfidenceTier === "early") {
    codes.push("EARLY_SAMPLE");
    score -= 15;
  }

  // Aggregated replay rows are diagnostic only. They must not classify a
  // different selected combo as toxic or profitable.
  const replayNegative =
    input.variantCombo !== null &&
    input.variantCombo.resolved >= TOXIC_VARIANT_MIN_RESOLVED &&
    (input.variantCombo.netAvgR ?? Number.POSITIVE_INFINITY) < 0;
  if (replayNegative) {
    codes.push("ALL_REPLAY_VARIANTS_NEGATIVE");
    score -= 25;
  }

  const symbolPositive =
    input.symbolStats !== null &&
    input.symbolStats.resolved >= 5 &&
    (input.symbolStats.netAvgR ?? 0) >= SYMBOL_POSITIVE_NET_R;
  const symbolNegative =
    input.symbolStats !== null &&
    input.symbolStats.resolved >= 5 &&
    (input.symbolStats.netAvgR ?? 0) <= SYMBOL_NEGATIVE_NET_R;
  if (symbolPositive) {
    codes.push("SYMBOL_NET_POSITIVE");
    score += 12;
  }
  if (symbolNegative) {
    codes.push("SYMBOL_NET_NEGATIVE");
    score -= 12;
  }

  const sideDeeplyNegative =
    input.sideStats !== null &&
    input.sideStats.resolved >= 5 &&
    (input.sideStats.netAvgR ?? 0) <= SIDE_DEEPLY_NEGATIVE_NET_R;
  if (sideDeeplyNegative) {
    codes.push("SIDE_NET_NEGATIVE");
    score -= 10;
  }

  const toxic =
    isToxicVariant(input.selectedEntryVariant) &&
    input.variantCombo !== null &&
    input.variantCombo.resolved >= TOXIC_VARIANT_MIN_RESOLVED &&
    (input.variantCombo.netAvgR ?? Number.POSITIVE_INFINITY) <= -TOXIC_VARIANT_MIN_NET_R;
  let toxicOverridden = false;
  if (toxic) {
    // Override requires stronger symbol evidence than generic symbolPositive:
    // need TOXIC_VARIANT_MIN_RESOLVED (15) samples AND net R ≥ TOXIC_VARIANT_MIN_NET_R (0.10).
    const symbolStronglyPositive =
      input.symbolStats !== null &&
      input.symbolStats.resolved >= TOXIC_VARIANT_MIN_RESOLVED &&
      (input.symbolStats.netAvgR ?? 0) >= TOXIC_VARIANT_MIN_NET_R;
    if (symbolStronglyPositive) {
      codes.push("TOXIC_VARIANT_OVERRIDDEN_BY_SYMBOL");
      toxicOverridden = true;
    } else {
      codes.push("TOXIC_VARIANT");
      score -= 30;
    }
  }

  if (input.kronos.horizonConflict) {
    codes.push("KRONOS_HORIZON_CONFLICT");
    score -= 8;
  }
  const kronosBias = input.kronos.selectedBias ?? input.kronos.bias;
  if (kronosBias && (kronosBias === "LONG" || kronosBias === "SHORT")) {
    if (kronosBias === input.direction) codes.push("KRONOS_AGREES");
    else codes.push("KRONOS_DISAGREES");
  }

  if (input.whale.available) {
    if (input.whale.agrees) codes.push("WHALE_AGREES");
    else if (input.whale.disagrees) codes.push("WHALE_DISAGREES");
  }

  const runner = isRunnerExit(input.selectedExitVariant);
  if (runner) {
    const positiveNet = net !== null && net > 0;
    const runnerSuccessOk =
      input.runnerSuccessRate === null ||
      input.runnerSuccessRate === undefined ||
      input.runnerSuccessRate >= ACCEPTABLE_RUNNER_SUCCESS;
    if (input.kronos.horizonConflict) {
      codes.push("RUNNER_BLOCKED_BY_HORIZON_CONFLICT");
      score -= 12;
    } else if (!positiveNet) {
      codes.push("RUNNER_REQUIRES_POSITIVE_NET");
      score -= 8;
    } else if (!runnerSuccessOk) {
      codes.push("RUNNER_REQUIRES_POSITIVE_NET");
      score -= 4;
    } else {
      codes.push("RUNNER_OK");
      score += 4;
    }
  }

  if (input.cost.costR !== null && input.cost.costR >= COST_R_HIGH_THRESHOLD) {
    codes.push("COST_R_HIGH");
    score -= 6;
  }
  if (input.cost.stopDistanceBps !== null && input.cost.stopDistanceBps < STOP_TOO_TIGHT_BPS) {
    codes.push("STOP_TOO_TIGHT");
    score -= 4;
  }

  const tp1Rate = input.profitableTp1Rate ?? null;
  if (tp1Rate !== null) {
    if (tp1Rate >= 0.5) codes.push("TP1_PROFITABLE_AFTER_COST");
    else if (tp1Rate <= 0.2) codes.push("TP1_NOT_PROFITABLE_AFTER_COST");
  }

  if (input.selectionSource === "replay" && net !== null && net > 0) {
    codes.push("PROFITABLE_REPLAY_CHOICE");
    score += 6;
  }

  // Final route decision (deterministic, ordered checks)
  let routeMode: ProfitRouteMode;
  let researchReason: string | null = null;
  let dataCollectionReason: string | null = null;

  if (toxic && !toxicOverridden) {
    routeMode = "RESEARCH_ONLY";
    researchReason =
      "Entry variant is known toxic by replay net R; require symbol-specific positive evidence to upgrade.";
  } else if (replayNegative) {
    routeMode = net !== null && net >= -0.05 ? "DATA_COLLECTION" : "RESEARCH_ONLY";
    if (routeMode === "RESEARCH_ONLY") {
      researchReason = "All replay variants for this combo show negative net R.";
    } else {
      dataCollectionReason = "All replay variants negative but expected net near breakeven; collect evidence only.";
    }
  } else if (net === null) {
    routeMode = "DATA_COLLECTION";
    dataCollectionReason = "No replay/heuristic evidence yet; shadow only.";
  } else if (net < 0) {
    routeMode = "RESEARCH_ONLY";
    researchReason = `Expected net R ${net.toFixed(2)} is negative; not a profit route.`;
  } else if (
    input.direction === "LONG" &&
    sideDeeplyNegative &&
    !(symbolPositive && net > 0)
  ) {
    routeMode = "DATA_COLLECTION";
    dataCollectionReason =
      "LONG side net is deeply negative without symbol-specific positive evidence; collect more data.";
  } else if (input.variantConfidenceTier === "early") {
    routeMode = "DATA_COLLECTION";
    dataCollectionReason = "Variant sample is early; collect more before promoting to profit route.";
  } else if (net > 0) {
    routeMode = "PROFIT_CANDIDATE";
  } else {
    routeMode = "DATA_COLLECTION";
    dataCollectionReason = "Neutral evidence; collect more.";
  }

  // SHORT broader DATA_COLLECTION near breakeven
  if (
    routeMode === "RESEARCH_ONLY" &&
    input.direction === "SHORT" &&
    net !== null &&
    net >= -0.05 &&
    !toxic
  ) {
    routeMode = "DATA_COLLECTION";
    researchReason = null;
    dataCollectionReason = "SHORT near breakeven; collect rather than research-only.";
  }

  // CALIBRATION GATE
  // Prevent PROFIT_CANDIDATE promotion when calibration evidence contradicts the
  // raw heuristic. Demote to DATA_COLLECTION (never block shadow collection)
  // when any of these hold:
  //   - calibratedExpectedNetR ≤ 0
  //   - calibrationVerdict = RAW_EDGE_NOT_VALIDATED
  //   - HEURISTIC_OVERCONFIDENT diagnosis with calibration sample ≥ 5
  // The gate intentionally never escalates to RESEARCH_ONLY — DATA_COLLECTION
  // keeps the shadow stream learning from the trade.
  if (routeMode === "PROFIT_CANDIDATE") {
    const calibrated = input.calibratedExpectedNetR ?? null;
    const verdict = input.calibrationVerdict;
    const calibSample = input.calibrationSampleSize ?? 0;
    const hasOverconfidenceFlag =
      (input.calibrationDiagnosisCodes ?? []).includes("HEURISTIC_OVERCONFIDENT") &&
      calibSample >= 5;
    const calibratedNegative = calibrated !== null && calibrated <= 0;
    if (calibratedNegative || verdict === "RAW_EDGE_NOT_VALIDATED" || hasOverconfidenceFlag) {
      codes.push("CALIBRATION_BLOCKS_PROMOTION");
      routeMode = "DATA_COLLECTION";
      dataCollectionReason =
        verdict === "RAW_EDGE_NOT_VALIDATED"
          ? `Calibration verdict RAW_EDGE_NOT_VALIDATED (sample ${calibSample}); keep collecting evidence.`
          : hasOverconfidenceFlag
          ? `Calibration flagged HEURISTIC_OVERCONFIDENT (sample ${calibSample}); demoting from profit route.`
          : `Calibrated expected net R ${calibrated?.toFixed(2)} ≤ 0; raw heuristic not validated by realized evidence.`;
    }
  }

  // A profit route needs observed cost/stop geometry. Missing values are not
  // zero-cost evidence and may continue only as data collection.
  if (routeMode === "PROFIT_CANDIDATE" && input.canonicalRoutingNetR !== undefined && (input.cost.costR === null || input.cost.stopDistanceBps === null)) {
    codes.push("NO_EVIDENCE");
    routeMode = "DATA_COLLECTION";
    dataCollectionReason = "Required cost or stop-geometry evidence is unavailable.";
  }

  // ULTRA-TIGHT STOP CREDIBILITY GUARD
  // stopDistanceBps < 100: POST_CALIBRATION evidence shows 0% win rate, -1.66R avg net R,
  // and inflated projected RR driven by tight-stop denominator, not genuine upside.
  // Demotes PROFIT_CANDIDATE → DATA_COLLECTION. Never loosens RESEARCH_ONLY or DATA_COLLECTION.
  const hasUltraTightStop =
    input.cost.stopDistanceBps !== null &&
    Number.isFinite(input.cost.stopDistanceBps) &&
    input.cost.stopDistanceBps < ULTRA_TIGHT_STOP_BPS;

  if (hasUltraTightStop) {
    codes.push("STOP_DISTANCE_ULTRA_TIGHT");
    if (routeMode === "PROFIT_CANDIDATE") {
      routeMode = "DATA_COLLECTION";
      dataCollectionReason =
        "Ultra-tight stop geometry (<100 bps) is not eligible for primary profit routing; collect evidence only.";
    }
    // RESEARCH_ONLY and DATA_COLLECTION are preserved — this guard never loosens a stricter mode.
  }

  // PROFIT-FOCUSED ADMISSION GUARD
  // This only demotes PROFIT_CANDIDATE -> DATA_COLLECTION. Every rejected fingerprint keeps
  // collecting, so the guard can be revised from new OOS evidence instead of freezing research.
  if (routeMode === "PROFIT_CANDIDATE" && input.profitAdmission) {
    const stopDistanceBps = input.cost.stopDistanceBps;
    const riskReward = input.profitAdmission.riskReward;
    if (input.profitAdmission.chaseRisk !== "LOW") {
      codes.push("PROFIT_ENTRY_CHASED");
      routeMode = "DATA_COLLECTION";
      dataCollectionReason =
        `Entry chase is ${input.profitAdmission.chaseRisk}; current profit evidence requires LOW chase.`;
    } else if (!(stopDistanceBps !== null && Number.isFinite(stopDistanceBps) && stopDistanceBps >= PROFIT_STOP_FLOOR_BPS)) {
      codes.push("PROFIT_STOP_BELOW_EVIDENCE_FLOOR");
      routeMode = "DATA_COLLECTION";
      dataCollectionReason =
        `Stop geometry ${stopDistanceBps?.toFixed(1) ?? "n/a"}bps is below the current 500bps profit-evidence floor.`;
    } else if (!(riskReward !== null && Number.isFinite(riskReward) && riskReward >= PROFIT_RR_MIN && riskReward <= PROFIT_RR_MAX)) {
      codes.push("PROFIT_RR_OUTSIDE_EVIDENCE_BAND");
      routeMode = "DATA_COLLECTION";
      dataCollectionReason =
        `Risk/reward ${riskReward?.toFixed(2) ?? "n/a"} is outside the current 5-8 profit-evidence band.`;
    }
  }

  const primaryProfitEligible = routeMode === "PROFIT_CANDIDATE";

  explanationParts.push(`route=${routeMode}`);
  if (net !== null) explanationParts.push(`netR=${net.toFixed(2)}`);
  explanationParts.push(`tier=${input.variantConfidenceTier}`);
  explanationParts.push(`codes=${codes.join("|")}`);
  if (researchReason) explanationParts.push(`research=${researchReason}`);
  if (dataCollectionReason) explanationParts.push(`dataCollection=${dataCollectionReason}`);
  const routeExplanation = explanationParts.join(" ");

  return {
    routeMode,
    routeScore: Math.round(score * 100) / 100,
    routeDiagnosticScore: Math.round(score * 100) / 100,
    routeReasonCodes: codes,
    routeExplanation,
    primaryProfitEligible,
    researchReason,
    dataCollectionReason,
  };
}

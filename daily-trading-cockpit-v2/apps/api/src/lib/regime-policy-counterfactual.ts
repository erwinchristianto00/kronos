import type { Direction, StrategyExperienceRecord } from "@dtc/shared";

export type CounterfactualEvidenceEra = "POST_CALIBRATION" | "ALL_TIME";
export type RegimeScenarioCode =
  | "BASELINE_ALL"
  | "KEEP_ONLY_BEARISH_EXPANSION"
  | "EXCLUDE_BULLISH_EXPANSION"
  | "KEEP_ONLY_BEARISH_EXPANSION_AND_SHORT"
  | "EXCLUDE_BULLISH_EXPANSION_LONG"
  | "KEEP_ONLY_REGIME_DIRECTION_ALIGNED"
  | "EXCLUDE_REGIME_DIRECTION_OPPOSED"
  | "KEEP_ONLY_BEARISH_SHORT_OR_NEUTRAL_REGIME";
export type CounterfactualInterpretation =
  | "STRONGLY_IMPROVES"
  | "MODESTLY_IMPROVES"
  | "NO_CLEAR_CHANGE"
  | "WORSENS"
  | "TOO_FEW_SAMPLES";
export type CounterfactualCaution =
  | "SMALL_SAMPLE"
  | "WATCHABLE"
  | "STRONG_SIGNAL"
  | "UNSUPPORTED_SCENARIO";
export type CounterfactualLikelyFutureAction =
  | "TIGHTEN_IN_BULLISH_EXPANSION"
  | "FAVOR_BEARISH_SHORT_CONTEXT"
  | "DO_NOT_USE_REGIME_AS_GATE_YET"
  | "AUDIT_FURTHER";
export type CounterfactualPatchStatus = "WATCH" | "AUDIT_DEEPER" | "READY_FOR_PATCH_DISCUSSION";
export type CounterfactualConfidence = "LOW" | "MEDIUM" | "HIGH";

export interface CounterfactualBaseline {
  closedCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  tp1ProfitableRate: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
}

export interface RegimePolicyScenarioResult {
  scenarioCode: RegimeScenarioCode;
  label: string;
  includedCount: number;
  excludedCount: number;
  remainingSharePct: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  tp1ProfitableRate: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  deltaNetAvgRVsBaseline: number | null;
  deltaPFVsBaseline: number | null;
  deltaSLRateVsBaseline: number | null;
  interpretation: CounterfactualInterpretation;
  caution: CounterfactualCaution;
  supported: boolean;
}

export interface RegimePolicyHypothesis {
  title: string;
  basedOnScenario: RegimeScenarioCode;
  evidenceSummary: string;
  likelyFutureAction: CounterfactualLikelyFutureAction;
  confidence: CounterfactualConfidence;
  patchStatus: CounterfactualPatchStatus;
  doesNotImplementNow: true;
}

export interface RegimePolicyCounterfactualReport {
  generatedAt: string;
  evidenceEra: CounterfactualEvidenceEra;
  totalResolvedExperienceRecords: number;
  baseline: CounterfactualBaseline;
  scenarios: RegimePolicyScenarioResult[];
  bestImprovingScenario: RegimePolicyScenarioResult | null;
  policyHypotheses: RegimePolicyHypothesis[];
  notes: string[];
}

export interface RegimePolicyCounterfactualInput {
  evidenceEra?: CounterfactualEvidenceEra;
}

interface ScenarioDefinition {
  scenarioCode: RegimeScenarioCode;
  label: string;
  isSupported: (records: StrategyExperienceRecord[]) => boolean;
  include: (record: StrategyExperienceRecord) => boolean;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function avgFinite(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) return null;
  return round4(finite.reduce((sum, value) => sum + value, 0) / finite.length);
}

function profitFactorOf(records: StrategyExperienceRecord[]): number | null {
  const wins = records.map((record) => record.outcome.realizedNetR).filter((value): value is number => typeof value === "number" && value > 0);
  const losses = records.map((record) => record.outcome.realizedNetR).filter((value): value is number => typeof value === "number" && value < 0);
  const winSum = wins.reduce((sum, value) => sum + value, 0);
  const lossAbs = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  if (lossAbs === 0) return null;
  return round4(winSum / lossAbs);
}

function winRateOf(records: StrategyExperienceRecord[]): number | null {
  if (records.length === 0) return null;
  return round4(records.filter((record) => (record.outcome.realizedNetR ?? 0) > 0).length / records.length);
}

function tp1ProfitableRateOf(records: StrategyExperienceRecord[]): number | null {
  if (records.length === 0) return null;
  return round4(records.filter((record) => record.outcome.tp1Hit === true && (record.outcome.realizedNetR ?? 0) > 0).length / records.length);
}

function slRateOf(records: StrategyExperienceRecord[]): number | null {
  if (records.length === 0) return null;
  return round4(records.filter((record) => record.outcome.slHit === true).length / records.length);
}

function filterByEra(records: StrategyExperienceRecord[], era: CounterfactualEvidenceEra): StrategyExperienceRecord[] {
  if (era === "ALL_TIME") return records;
  return records.filter((record) => (record.context.evidenceEra ?? record.outcome.evidenceEra) === "POST_CALIBRATION");
}

function deriveMarketRegime(record: StrategyExperienceRecord): string | null {
  const value = record.context.marketRegime;
  if (!value) return null;
  const upper = String(value).toUpperCase();
  if (upper.includes("BULL")) return "BULLISH_EXPANSION";
  if (upper.includes("BEAR")) return "BEARISH_EXPANSION";
  if (upper.includes("SIDE") || upper.includes("RANGE") || upper.includes("CHOP")) return "SIDEWAYS";
  if (upper.includes("MIX")) return "MIXED";
  return upper;
}

function directionOf(record: StrategyExperienceRecord): Exclude<Direction, "NEUTRAL"> {
  return record.context.direction;
}

function baselineOf(records: StrategyExperienceRecord[]): CounterfactualBaseline {
  const winners = records.filter((record) => (record.outcome.realizedNetR ?? 0) > 0);
  const losers = records.filter((record) => (record.outcome.realizedNetR ?? 0) < 0);
  return {
    closedCount: records.length,
    netAvgR: avgFinite(records.map((record) => record.outcome.realizedNetR)),
    grossAvgR: avgFinite(records.map((record) => record.outcome.realizedGrossR)),
    profitFactor: profitFactorOf(records),
    winRate: winRateOf(records),
    tp1ProfitableRate: tp1ProfitableRateOf(records),
    slRate: slRateOf(records),
    avgWinR: avgFinite(winners.map((record) => record.outcome.realizedNetR)),
    avgLossR: avgFinite(losers.map((record) => record.outcome.realizedNetR)),
  };
}

function hasNeutralLikeRegime(records: StrategyExperienceRecord[]): boolean {
  return records.some((record) => {
    const regime = deriveMarketRegime(record);
    return regime === "SIDEWAYS" || regime === "MIXED";
  });
}

const SCENARIOS: ScenarioDefinition[] = [
  {
    scenarioCode: "BASELINE_ALL",
    label: "Baseline all",
    isSupported: () => true,
    include: () => true,
  },
  {
    scenarioCode: "KEEP_ONLY_BEARISH_EXPANSION",
    label: "Keep only bearish expansion",
    isSupported: (records) => records.some((record) => deriveMarketRegime(record) === "BEARISH_EXPANSION"),
    include: (record) => deriveMarketRegime(record) === "BEARISH_EXPANSION",
  },
  {
    scenarioCode: "EXCLUDE_BULLISH_EXPANSION",
    label: "Exclude bullish expansion",
    isSupported: (records) => records.some((record) => deriveMarketRegime(record) === "BULLISH_EXPANSION"),
    include: (record) => deriveMarketRegime(record) !== "BULLISH_EXPANSION",
  },
  {
    scenarioCode: "KEEP_ONLY_BEARISH_EXPANSION_AND_SHORT",
    label: "Keep only bearish expansion and short",
    isSupported: (records) => records.some((record) => deriveMarketRegime(record) === "BEARISH_EXPANSION" && directionOf(record) === "SHORT"),
    include: (record) => deriveMarketRegime(record) === "BEARISH_EXPANSION" && directionOf(record) === "SHORT",
  },
  {
    scenarioCode: "EXCLUDE_BULLISH_EXPANSION_LONG",
    label: "Exclude bullish expansion long",
    isSupported: (records) => records.some((record) => deriveMarketRegime(record) === "BULLISH_EXPANSION" && directionOf(record) === "LONG"),
    include: (record) => !(deriveMarketRegime(record) === "BULLISH_EXPANSION" && directionOf(record) === "LONG"),
  },
  {
    scenarioCode: "KEEP_ONLY_REGIME_DIRECTION_ALIGNED",
    label: "Keep only regime-direction aligned",
    isSupported: (records) => records.some((record) => {
      const regime = deriveMarketRegime(record);
      return (regime === "BULLISH_EXPANSION" && directionOf(record) === "LONG") || (regime === "BEARISH_EXPANSION" && directionOf(record) === "SHORT");
    }),
    include: (record) => {
      const regime = deriveMarketRegime(record);
      return (regime === "BULLISH_EXPANSION" && directionOf(record) === "LONG") || (regime === "BEARISH_EXPANSION" && directionOf(record) === "SHORT");
    },
  },
  {
    scenarioCode: "EXCLUDE_REGIME_DIRECTION_OPPOSED",
    label: "Exclude regime-direction opposed",
    isSupported: (records) => records.some((record) => {
      const regime = deriveMarketRegime(record);
      return (regime === "BULLISH_EXPANSION" && directionOf(record) === "SHORT") || (regime === "BEARISH_EXPANSION" && directionOf(record) === "LONG");
    }),
    include: (record) => {
      const regime = deriveMarketRegime(record);
      return !((regime === "BULLISH_EXPANSION" && directionOf(record) === "SHORT") || (regime === "BEARISH_EXPANSION" && directionOf(record) === "LONG"));
    },
  },
  {
    scenarioCode: "KEEP_ONLY_BEARISH_SHORT_OR_NEUTRAL_REGIME",
    label: "Keep only bearish short or neutral regime",
    isSupported: (records) => hasNeutralLikeRegime(records),
    include: (record) => {
      const regime = deriveMarketRegime(record);
      if (regime === "SIDEWAYS" || regime === "MIXED") return true;
      return regime === "BEARISH_EXPANSION" && directionOf(record) === "SHORT";
    },
  },
];

function interpretationOf(deltaNetAvgRVsBaseline: number | null, includedCount: number, supported: boolean): CounterfactualInterpretation {
  if (!supported || includedCount < 10) return "TOO_FEW_SAMPLES";
  if ((deltaNetAvgRVsBaseline ?? 0) >= 0.3 && includedCount >= 20) return "STRONGLY_IMPROVES";
  if ((deltaNetAvgRVsBaseline ?? 0) >= 0.15 && includedCount >= 15) return "MODESTLY_IMPROVES";
  if ((deltaNetAvgRVsBaseline ?? 0) <= -0.15) return "WORSENS";
  return "NO_CLEAR_CHANGE";
}

function cautionOf(includedCount: number, supported: boolean): CounterfactualCaution {
  if (!supported) return "UNSUPPORTED_SCENARIO";
  if (includedCount < 10) return "SMALL_SAMPLE";
  if (includedCount < 30) return "WATCHABLE";
  return "STRONG_SIGNAL";
}

function scenarioOf(def: ScenarioDefinition, records: StrategyExperienceRecord[], baseline: CounterfactualBaseline): RegimePolicyScenarioResult {
  const supported = def.isSupported(records);
  const included = supported ? records.filter(def.include) : [];
  const excludedCount = records.length - included.length;
  const scenarioBaseline = baselineOf(included);
  return {
    scenarioCode: def.scenarioCode,
    label: def.label,
    includedCount: included.length,
    excludedCount,
    remainingSharePct: records.length === 0 ? 0 : round4(included.length / records.length),
    netAvgR: scenarioBaseline.netAvgR,
    grossAvgR: scenarioBaseline.grossAvgR,
    profitFactor: scenarioBaseline.profitFactor,
    winRate: scenarioBaseline.winRate,
    tp1ProfitableRate: scenarioBaseline.tp1ProfitableRate,
    slRate: scenarioBaseline.slRate,
    avgWinR: scenarioBaseline.avgWinR,
    avgLossR: scenarioBaseline.avgLossR,
    deltaNetAvgRVsBaseline: scenarioBaseline.netAvgR !== null && baseline.netAvgR !== null ? round4(scenarioBaseline.netAvgR - baseline.netAvgR) : null,
    deltaPFVsBaseline: scenarioBaseline.profitFactor !== null && baseline.profitFactor !== null ? round4(scenarioBaseline.profitFactor - baseline.profitFactor) : null,
    deltaSLRateVsBaseline: scenarioBaseline.slRate !== null && baseline.slRate !== null ? round4(scenarioBaseline.slRate - baseline.slRate) : null,
    interpretation: interpretationOf(
      scenarioBaseline.netAvgR !== null && baseline.netAvgR !== null ? scenarioBaseline.netAvgR - baseline.netAvgR : null,
      included.length,
      supported,
    ),
    caution: cautionOf(included.length, supported),
    supported,
  };
}

function confidenceOf(scenario: RegimePolicyScenarioResult): CounterfactualConfidence {
  if (scenario.caution === "STRONG_SIGNAL") return "HIGH";
  if (scenario.caution === "WATCHABLE") return "MEDIUM";
  return "LOW";
}

function patchStatusOf(scenario: RegimePolicyScenarioResult): CounterfactualPatchStatus {
  if (
    scenario.interpretation === "STRONGLY_IMPROVES" &&
    scenario.caution === "STRONG_SIGNAL"
  ) return "READY_FOR_PATCH_DISCUSSION";
  if (
    scenario.interpretation === "STRONGLY_IMPROVES" ||
    scenario.interpretation === "MODESTLY_IMPROVES" ||
    scenario.interpretation === "WORSENS"
  ) return scenario.includedCount >= 15 ? "AUDIT_DEEPER" : "WATCH";
  return "WATCH";
}

function likelyActionOf(scenario: RegimePolicyScenarioResult): CounterfactualLikelyFutureAction {
  if (scenario.scenarioCode === "EXCLUDE_BULLISH_EXPANSION" || scenario.scenarioCode === "EXCLUDE_BULLISH_EXPANSION_LONG") {
    return "TIGHTEN_IN_BULLISH_EXPANSION";
  }
  if (
    scenario.scenarioCode === "KEEP_ONLY_BEARISH_EXPANSION_AND_SHORT" ||
    scenario.scenarioCode === "KEEP_ONLY_BEARISH_SHORT_OR_NEUTRAL_REGIME"
  ) {
    return "FAVOR_BEARISH_SHORT_CONTEXT";
  }
  if (scenario.interpretation === "NO_CLEAR_CHANGE" || scenario.interpretation === "TOO_FEW_SAMPLES") {
    return "DO_NOT_USE_REGIME_AS_GATE_YET";
  }
  return "AUDIT_FURTHER";
}

function buildPolicyHypotheses(scenarios: RegimePolicyScenarioResult[]): RegimePolicyHypothesis[] {
  const interesting = scenarios.filter((scenario) =>
    scenario.scenarioCode !== "BASELINE_ALL" &&
    scenario.supported &&
    (
      scenario.interpretation === "STRONGLY_IMPROVES" ||
      scenario.interpretation === "MODESTLY_IMPROVES" ||
      scenario.interpretation === "WORSENS"
    ),
  );

  const hypotheses = interesting.map((scenario): RegimePolicyHypothesis => ({
    title:
      scenario.interpretation === "WORSENS"
        ? `${scenario.label} worsens realized outcomes`
        : `${scenario.label} improves realized outcomes`,
    basedOnScenario: scenario.scenarioCode,
    evidenceSummary: `n=${scenario.includedCount}, netAvgR=${scenario.netAvgR?.toFixed(4) ?? "n/a"}, delta=${scenario.deltaNetAvgRVsBaseline?.toFixed(4) ?? "n/a"}, PF=${scenario.profitFactor?.toFixed(2) ?? "n/a"}, SL=${scenario.slRate !== null ? (scenario.slRate * 100).toFixed(0) + "%" : "n/a"}.`,
    likelyFutureAction: likelyActionOf(scenario),
    confidence: confidenceOf(scenario),
    patchStatus: patchStatusOf(scenario),
    doesNotImplementNow: true,
  }));

  if (hypotheses.length > 0) return hypotheses.slice(0, 5);
  return [{
    title: "Regime evidence is still advisory only",
    basedOnScenario: "BASELINE_ALL",
    evidenceSummary: "Current regime slices may be informative, but they are not enough by themselves to justify an adaptive gate patch.",
    likelyFutureAction: "DO_NOT_USE_REGIME_AS_GATE_YET",
    confidence: "LOW",
    patchStatus: "WATCH",
    doesNotImplementNow: true,
  }];
}

export function buildRegimePolicyCounterfactualReport(
  records: StrategyExperienceRecord[],
  opts: RegimePolicyCounterfactualInput = {},
  now: Date = new Date(),
): RegimePolicyCounterfactualReport {
  const evidenceEra = opts.evidenceEra ?? "POST_CALIBRATION";
  const filtered = filterByEra(records, evidenceEra);
  const baseline = baselineOf(filtered);
  const scenarios = SCENARIOS.map((def) => scenarioOf(def, filtered, baseline));
  const bestImprovingScenario = [...scenarios]
    .filter((scenario) => scenario.scenarioCode !== "BASELINE_ALL" && scenario.supported && (scenario.deltaNetAvgRVsBaseline ?? Number.NEGATIVE_INFINITY) > 0)
    .sort((left, right) => (right.deltaNetAvgRVsBaseline ?? Number.NEGATIVE_INFINITY) - (left.deltaNetAvgRVsBaseline ?? Number.NEGATIVE_INFINITY))[0] ?? null;

  return {
    generatedAt: now.toISOString(),
    evidenceEra,
    totalResolvedExperienceRecords: filtered.length,
    baseline,
    scenarios,
    bestImprovingScenario,
    policyHypotheses: buildPolicyHypotheses(scenarios),
    notes: [
      "Counterfactual scenarios are advisory only and do not change routing, promotion thresholds, or execution.",
      "A counterfactual improvement only shows which regime-aware gate ideas deserve deeper audit.",
    ],
  };
}

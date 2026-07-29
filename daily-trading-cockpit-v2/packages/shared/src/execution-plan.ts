import type {
  Candidate,
  ExecutionEntryVariant,
  PerformanceStats,
  ProfitRouteMode,
  ShadowPositionVariant,
  ShadowVariantStats,
  VariantCombinationStats,
  VariantConfidenceTier,
  VariantSelectionSnapshot,
} from "./types.js";
import { buildTradePlan } from "./trade-plan.js";
import { computeProfitRoute } from "./profit-routing.js";
import { computeScannerDiagnostics } from "./scanner-diagnostics.js";
import {
  computeCalibratedExpectedR,
  emptyCalibrationEvidence,
  type CalibrationEvidence,
} from "./calibrated-expectancy.js";
import {
  CURRENT_DECISION_POLICY_VERSION,
  CURRENT_EVIDENCE_ERA,
  hasCurrentPostFixPolicyStamp,
} from "./evidence-era.js";
import { EVIDENCE_POLICY_VERSION, EXECUTION_POLICY_VERSION, MIN_EXECUTION_RR, resolveEndToEndCorrectnessDeploymentAt } from "./policy-versions.js";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function toTier(resolved: number): VariantConfidenceTier {
  if (resolved > 100) return "usable";
  if (resolved >= 30) return "provisional";
  return "early";
}

function entryMid(candidate: Candidate): number | null {
  if (!candidate.entryZone) return null;
  return (candidate.entryZone[0] + candidate.entryZone[1]) / 2;
}

function entryDriftPct(candidate: Candidate, anchor: number | null): number | null {
  if (anchor === null || !Number.isFinite(anchor) || anchor <= 0) return null;
  return round(((candidate.indicators.fiveMinute.latestClose - anchor) / anchor) * 100, 2);
}

function entryDriftAtr(candidate: Candidate, anchor: number | null): number | null {
  const atr = candidate.indicators.fiveMinute.atr14;
  if (anchor === null || !Number.isFinite(anchor) || !Number.isFinite(atr) || atr <= 0) return null;
  return round(Math.abs(candidate.indicators.fiveMinute.latestClose - anchor) / atr, 2);
}

function sampleWeight(stats: ShadowVariantStats | null): number {
  if (!stats || stats.resolved <= 0) return 0.2;
  if (stats.resolved > 100) return 1;
  if (stats.resolved >= 30) return 0.8;
  return 0.5;
}

function variantScore(stats: ShadowVariantStats | null, preferProfit = false): number {
  if (!stats) return -999;
  const net = stats.avgNetRResult ?? -0.2;
  const gross = stats.avgGrossRResult ?? net;
  const tp1 = stats.profitableTp1Rate ?? 0;
  const pf = stats.profitFactor ?? (net > 0 ? 1.2 : 0.8);
  const sample = sampleWeight(stats);
  return round(net * 100 * 0.55 + gross * 100 * 0.1 + tp1 * 100 * (preferProfit ? 0.2 : 0.1) + pf * 8 + stats.resolved * 0.05 + sample * 10, 2);
}

function shadowVariants(perf: PerformanceStats | null): ShadowVariantStats[] {
  return perf?.windows["1h"].shadowVariants ?? [];
}

function findShadowVariant(perf: PerformanceStats | null, key: string): ShadowVariantStats | null {
  return shadowVariants(perf).find((variant) => variant.key === key) ?? null;
}

function entryVariantMap(): Array<{ key: ExecutionEntryVariant; shadowKey: ShadowVariantStats["key"]; label: string }> {
  return [
    { key: "base_current_entry", shadowKey: "base_current", label: "Base current entry" },
    { key: "fib_382_entry", shadowKey: "fib_382_entry", label: "Fib 0.382 entry" },
    { key: "fib_500_entry", shadowKey: "fib_500_entry", label: "Fib 0.500 entry" },
    { key: "fib_618_entry", shadowKey: "fib_618_entry", label: "Fib 0.618 entry" },
    { key: "vwap_retest_entry", shadowKey: "vwap_retest_entry", label: "VWAP retest entry" },
    { key: "ema20_pullback_entry", shadowKey: "ema20_pullback_entry", label: "EMA20 pullback entry" },
    { key: "no_chase_atr_entry", shadowKey: "no_chase_atr_entry", label: "No-chase ATR entry" },
  ];
}

function exitVariantMap(): Array<{ key: ShadowPositionVariant; shadowKey: ShadowVariantStats["key"] | null; label: string }> {
  return [
    { key: "tp1_full_exit", shadowKey: "tp1_fast_exit", label: "TP1 full exit" },
    { key: "tp1_50_tp2_runner", shadowKey: "tp1_50_tp2_runner", label: "TP1 50% + TP2 runner" },
    { key: "tp1_70_runner30", shadowKey: null, label: "TP1 70% + runner 30%" },
    { key: "trail_after_tp1", shadowKey: "trail_after_tp1", label: "Trail after TP1" },
    { key: "kronos_runner_exit", shadowKey: "kronos_runner_exit", label: "Kronos runner exit" },
    { key: "kronos_flip_exit", shadowKey: "kronos_flip_exit", label: "Kronos flip exit" },
    { key: "whale_conflict_exit", shadowKey: "whale_conflict_exit", label: "Whale conflict exit" },
    { key: "vwap_loss_exit", shadowKey: null, label: "VWAP / EMA loss exit" },
  ];
}

function costDiagnostics(candidate: Candidate, entryPrice: number | null, perf: PerformanceStats | null) {
  const stop = candidate.stopLoss;
  if (entryPrice === null || stop === null || entryPrice <= 0) {
    return { costR: null, spreadR: null, feeSlippageR: null, stopDistanceBps: null };
  }
  const riskPct = (Math.abs(entryPrice - stop) / entryPrice) * 100;
  if (!Number.isFinite(riskPct) || riskPct <= 0) {
    return { costR: null, spreadR: null, feeSlippageR: null, stopDistanceBps: null };
  }
  const feeSlippagePct = (perf?.executionCost.roundTripCostBps ?? 28) / 100;
  const spreadPct = candidate.spread.percent;
  if (spreadPct === null || !Number.isFinite(spreadPct) || spreadPct < 0) {
    return { costR: null, spreadR: null, feeSlippageR: null, stopDistanceBps: null };
  }
  const feeSlippageR = round(feeSlippagePct / riskPct, 2);
  const spreadR = round(spreadPct / riskPct, 2);
  return {
    costR: round(feeSlippageR + spreadR, 2),
    spreadR,
    feeSlippageR,
    stopDistanceBps: round(riskPct * 100, 2),
  };
}

export type ChaseRiskLevel = "LOW" | "MEDIUM" | "HIGH";

export function computeChaseRisk(candidate: Candidate): ChaseRiskLevel {
  const mid = entryMid(candidate);
  const driftAtr = entryDriftAtr(candidate, mid);
  if (driftAtr === null) return "MEDIUM";
  if (driftAtr > 1) return "HIGH";
  if (driftAtr > 0.5) return "MEDIUM";
  return "LOW";
}

function statsAvgNet(stats: ShadowVariantStats | null): number | null {
  if (!stats || stats.resolved <= 0) return null;
  return stats.avgNetRResult ?? null;
}

function isReplayDeeplyNegative(stats: ShadowVariantStats | null, threshold = -0.1): boolean {
  if (!stats || stats.resolved < 5) return false;
  const net = statsAvgNet(stats);
  return net !== null && net <= threshold;
}

function isReplayPositive(stats: ShadowVariantStats | null): boolean {
  if (!stats || stats.resolved < 5) return false;
  const net = statsAvgNet(stats);
  return net !== null && net > 0;
}

export function chooseEntryVariant(candidate: Candidate, perf: PerformanceStats | null, chaseRisk: ChaseRiskLevel) {
  const maps = entryVariantMap();
  const price = candidate.indicators.fiveMinute.latestClose;
  const fib = candidate.fibonacci;
  const mid = entryMid(candidate);
  const driftAtr = entryDriftAtr(candidate, mid);
  const scored = maps.map((mapping) => {
    const stats = mapping.shadowKey ? findShadowVariant(perf, mapping.shadowKey) : null;
    let geometry = 0;
    switch (mapping.key) {
      case "base_current_entry":
        geometry = candidate.entryZone && price >= candidate.entryZone[0] && price <= candidate.entryZone[1] ? 18 : 8;
        break;
      case "fib_382_entry": {
        const dist = Math.abs(price - fib.retracement382) / price;
        geometry = Math.max(0, 22 - dist * 300);
        if (dist <= 0.01 && !isReplayDeeplyNegative(stats)) geometry += 6;
        break;
      }
      case "fib_500_entry": {
        const dist = Math.abs(price - fib.retracement500) / price;
        geometry = Math.max(0, 26 - dist * 300);
        if (dist <= 0.01 && !isReplayDeeplyNegative(stats)) geometry += 8;
        break;
      }
      case "fib_618_entry":
        geometry = Math.max(0, 20 - Math.abs(price - fib.retracement618) / price * 300);
        break;
      case "vwap_retest_entry": {
        const dist = Math.abs(price - candidate.indicators.fiveMinute.vwap) / price;
        geometry = Math.max(0, 24 - dist * 300);
        if (dist <= 0.01 && !isReplayDeeplyNegative(stats)) geometry += 6;
        break;
      }
      case "ema20_pullback_entry":
        geometry = Math.max(0, 22 - Math.abs(price - candidate.indicators.fiveMinute.ema20) / price * 300);
        break;
      case "no_chase_atr_entry": {
        // Chase risk should NOT reward this as primary entry unless replay evidence is positive.
        // Previous logic gave 26 points when drift > 1 (chase risk high), which made this the
        // dominant entry pick at high drift and led to systematic RESEARCH_ONLY routing.
        // The negative penalty must exceed variantScore(null) = -999 to ensure other variants win.
        const replayPositive = isReplayPositive(stats);
        if (driftAtr === null) {
          geometry = 4;
        } else if (driftAtr > 1) {
          geometry = replayPositive ? 12 : -1500;
        } else if (driftAtr > 0.5) {
          geometry = replayPositive ? 8 : 0;
        } else {
          geometry = 10;
        }
        break;
      }
    }
    return {
      ...mapping,
      stats,
      score: variantScore(stats) + geometry,
    };
  }).sort((a, b) => b.score - a.score);
  return scored[0]!;
}

export function chooseExitVariant(candidate: Candidate, perf: PerformanceStats | null, chaseRisk: ChaseRiskLevel) {
  const maps = exitVariantMap();
  const tradePlan = buildTradePlan(candidate);
  const lowVolume = (candidate.volume.volumeRatio5m ?? 0) < 1;
  const whaleAgrees =
    (candidate.finalDirection === "LONG" && candidate.whale.signal === "BULLISH") ||
    (candidate.finalDirection === "SHORT" && candidate.whale.signal === "BEARISH");
  const whaleDisagrees =
    (candidate.finalDirection === "LONG" && candidate.whale.signal === "BEARISH") ||
    (candidate.finalDirection === "SHORT" && candidate.whale.signal === "BULLISH");
  const kronosStrongAgree =
    (candidate.selectedKronosBias ?? candidate.kronosBias) === candidate.finalDirection &&
    (candidate.kronosConfidenceBucket === "STRONG" || candidate.kronosConfidenceBucket === "MEDIUM") &&
    !candidate.horizonConflict;
  const shortHorizonOnly = candidate.finalDirection === "LONG"
    ? (candidate.expectedReturn1h ?? 0) > 0 && (candidate.expectedReturn4h ?? 0) < 0
    : (candidate.expectedReturn1h ?? 0) < 0 && (candidate.expectedReturn4h ?? 0) > 0;
  const horizonConflict = !!candidate.horizonConflict || shortHorizonOnly;
  const sourceAgreement = (whaleAgrees ? 1 : 0) + (kronosStrongAgree ? 1 : 0);
  const weakSourceAgreement = sourceAgreement === 0;

  // Pre-scan runner replay performance — used to bump tp1_full_exit when runners look bad.
  const runnerShadowKeys: Array<ShadowVariantStats["key"]> = ["tp1_50_tp2_runner", "kronos_runner_exit", "trail_after_tp1"];
  const runnerStats = runnerShadowKeys.map((k) => findShadowVariant(perf, k)).filter((s): s is ShadowVariantStats => s !== null);
  const runnersDeeplyNegative =
    runnerStats.length > 0 &&
    runnerStats.every((s) => s.resolved >= 5 && (s.avgNetRResult ?? 0) <= -0.15);

  const scored = maps.map((mapping) => {
    const stats = mapping.shadowKey ? findShadowVariant(perf, mapping.shadowKey) : null;
    const replayNetNeg = isReplayDeeplyNegative(stats, -0.05);
    let geometry = 0;
    switch (mapping.key) {
      case "tp1_full_exit":
        geometry = lowVolume ? 18 : 8;
        if (runnersDeeplyNegative) geometry += 14;
        break;
      case "tp1_50_tp2_runner":
        if (horizonConflict || replayNetNeg || chaseRisk === "HIGH") geometry = -1500;
        else if (kronosStrongAgree && whaleAgrees) geometry = 18;
        else if (weakSourceAgreement) geometry = 2;
        else geometry = 10;
        break;
      case "tp1_70_runner30":
        if (horizonConflict || replayNetNeg) geometry = -1500;
        else if (kronosStrongAgree && !whaleDisagrees) geometry = 16;
        else geometry = 6;
        break;
      case "trail_after_tp1":
        if (horizonConflict || replayNetNeg) geometry = -1500;
        else if (tradePlan.runnerAllowed) geometry = 14;
        else geometry = 5;
        break;
      case "kronos_runner_exit": {
        // Block when: horizon conflict, replay netR negative, high chase risk, or weak source agreement.
        // Large penalty overrides variantScore advantage from any non-null stats.
        const block = horizonConflict || replayNetNeg || chaseRisk === "HIGH" || weakSourceAgreement;
        if (block) geometry = -1500;
        else if (kronosStrongAgree && whaleAgrees) geometry = 22;
        else if (kronosStrongAgree) geometry = 8;
        else geometry = 0;
        break;
      }
      case "kronos_flip_exit":
        geometry = candidate.kronosBias !== "UNAVAILABLE" ? 14 : 2;
        break;
      case "whale_conflict_exit":
        geometry = whaleDisagrees ? 18 : 4;
        break;
      case "vwap_loss_exit":
        geometry = lowVolume ? 14 : 6;
        break;
    }
    return { ...mapping, stats, score: variantScore(stats, true) + geometry };
  }).sort((a, b) => b.score - a.score);
  if (horizonConflict) {
    return scored.find((item) =>
      item.key === "tp1_full_exit" ||
      item.key === "kronos_flip_exit" ||
      item.key === "whale_conflict_exit" ||
      item.key === "vwap_loss_exit"
    ) ?? scored[0]!;
  }
  return scored[0]!;
}

function replayCombinationCandidates(candidate: Candidate, perf: PerformanceStats | null): VariantCombinationStats[] {
  if (!perf) return [];
  return perf.windows["1h"].variantCombinations.filter((combo) => {
    if (combo.filled <= 0 || combo.resolved <= 0 || (combo.netAvgR ?? Number.NEGATIVE_INFINITY) <= Number.NEGATIVE_INFINITY) return false;
    if (combo.entryVariant.startsWith("fib_") && !candidate.fibonacci) return false;
    if (combo.entryVariant === "vwap_retest_entry" && !Number.isFinite(candidate.indicators.fiveMinute.vwap)) return false;
    if (combo.entryVariant === "ema20_pullback_entry" && !Number.isFinite(candidate.indicators.fiveMinute.ema20)) return false;
    return true;
  });
}

function replayCombinationScore(candidate: Candidate, combo: VariantCombinationStats): number {
  let score = (combo.netAvgR ?? -0.25) * 100;
  score += combo.profitFactor ?? 0;
  score += combo.attempted > 0 ? (combo.filled / combo.attempted) * 100 : 0;
  const price = candidate.indicators.fiveMinute.latestClose;
  switch (combo.entryVariant) {
    case "base_current_entry":
      score += candidate.entryZone && price >= candidate.entryZone[0] && price <= candidate.entryZone[1] ? 12 : 4;
      break;
    case "fib_382_entry":
      score += Math.max(0, 12 - (Math.abs(price - candidate.fibonacci.retracement382) / price) * 300);
      break;
    case "fib_500_entry":
      score += Math.max(0, 14 - (Math.abs(price - candidate.fibonacci.retracement500) / price) * 300);
      break;
    case "fib_618_entry":
      score += Math.max(0, 12 - (Math.abs(price - candidate.fibonacci.retracement618) / price) * 300);
      break;
    case "vwap_retest_entry":
      score += Math.max(0, 14 - (Math.abs(price - candidate.indicators.fiveMinute.vwap) / price) * 300);
      break;
    case "ema20_pullback_entry":
      score += Math.max(0, 14 - (Math.abs(price - candidate.indicators.fiveMinute.ema20) / price) * 300);
      break;
    case "no_chase_atr_entry":
      score += 8;
      break;
  }
  const whaleAgrees =
    (candidate.finalDirection === "LONG" && candidate.whale.signal === "BULLISH") ||
    (candidate.finalDirection === "SHORT" && candidate.whale.signal === "BEARISH");
  const kronosAgrees =
    (candidate.selectedKronosBias ?? candidate.kronosBias) === candidate.finalDirection &&
    (candidate.kronosConfidenceBucket === "STRONG" || candidate.kronosConfidenceBucket === "MEDIUM") &&
    !candidate.horizonConflict;
  if (combo.exitVariant === "kronos_runner_exit" && kronosAgrees && (combo.netAvgR ?? 0) > 0) score += 10;
  if (combo.exitVariant === "whale_conflict_exit" && candidate.whale.available) score += whaleAgrees ? -2 : 4;
  if (combo.exitVariant === "trail_after_tp1" && (candidate.riskReward ?? 0) >= MIN_EXECUTION_RR) score += 4;
  return round(score, 2);
}

function entryPrecision(candidate: Candidate, anchor: number | null) {
  const explanations: string[] = [];
  const price = candidate.indicators.fiveMinute.latestClose;
  const driftPct = entryDriftPct(candidate, anchor);
  const driftAtr = entryDriftAtr(candidate, anchor);
  if (candidate.entryZone) {
    explanations.push(`current price ${price.toFixed(4)} vs entry zone ${candidate.entryZone[0].toFixed(4)}-${candidate.entryZone[1].toFixed(4)}`);
  }
  if (driftPct !== null) explanations.push(`entry drift ${driftPct.toFixed(2)}%`);
  if (driftAtr !== null) explanations.push(`entry drift ${driftAtr.toFixed(2)} ATR`);
  const fibMatches = ([
    ["0.382", candidate.fibonacci.retracement382],
    ["0.5", candidate.fibonacci.retracement500],
    ["0.618", candidate.fibonacci.retracement618],
  ] as Array<[string, number]>)
    .filter(([, level]) => Math.abs(price - level) / price <= 0.01)
    .map(([label]) => label);
  if (fibMatches.length) explanations.push(`near Fib ${fibMatches.join("/")}`);
  const nearLevels = [];
  if (Math.abs(price - candidate.indicators.fiveMinute.vwap) / price <= 0.01) nearLevels.push("VWAP");
  if (Math.abs(price - candidate.indicators.fiveMinute.ema20) / price <= 0.01) nearLevels.push("EMA20");
  if (Math.abs(price - candidate.indicators.fiveMinute.support) / price <= 0.01) nearLevels.push("support");
  if (Math.abs(price - candidate.indicators.fiveMinute.resistance) / price <= 0.01) nearLevels.push("resistance");
  if (nearLevels.length) explanations.push(`near ${nearLevels.join("/")}`);
  const chaseRisk = driftAtr === null ? "MEDIUM" : driftAtr > 1 ? "HIGH" : driftAtr > 0.5 ? "MEDIUM" : "LOW";
  explanations.push(chaseRisk === "HIGH" ? "chase risk high" : chaseRisk === "MEDIUM" ? "chase risk moderate" : "chase risk low");
  return { driftPct, driftAtr, explanations, chaseRisk: chaseRisk as "LOW" | "MEDIUM" | "HIGH" };
}

function exitPrecision(candidate: Candidate, exitVariant: ShadowPositionVariant) {
  const parts: string[] = [];
  const whaleAgrees =
    (candidate.finalDirection === "LONG" && candidate.whale.signal === "BULLISH") ||
    (candidate.finalDirection === "SHORT" && candidate.whale.signal === "BEARISH");
  const kronosSupport =
    candidate.kronosBias === candidate.finalDirection &&
    (candidate.kronosConfidenceBucket === "STRONG" || candidate.kronosConfidenceBucket === "MEDIUM");
  parts.push(exitVariant === "tp1_full_exit" ? "TP1 action: full exit" : "TP1 action: partial and manage runner");
  parts.push(exitVariant === "tp1_full_exit" ? "breakeven move not needed" : "move SL to breakeven after TP1");
  parts.push(kronosSupport && whaleAgrees ? "runner allowed" : "runner only if follow-through confirms");
  parts.push("runner invalidation on Kronos flip, whale conflict, or VWAP/EMA loss");
  if (candidate.kronosBias !== "UNAVAILABLE") parts.push("Kronos flip exit active when forecast loses alignment");
  if (candidate.whale.available) parts.push("Whale conflict exit active when flow flips against direction");
  parts.push("VWAP/EMA loss exit protects continuation failure");
  return parts;
}

export function buildVariantSelection(
  candidate: Candidate,
  perf: PerformanceStats | null,
  calibration: CalibrationEvidence | null = null,
): VariantSelectionSnapshot {
  // Historical/mixed performance is retained for audit only. New decisions
  // require an explicit post-fix cohort before any replay statistic can affect
  // geometry selection, expected R, calibration, or routing.
  const performanceEligible = hasCurrentPostFixPolicyStamp(perf);
  const decisionPerf = performanceEligible ? perf : null;
  const chaseRiskUpFront = computeChaseRisk(candidate);
  const entry = chooseEntryVariant(candidate, decisionPerf, chaseRiskUpFront);
  const exit = chooseExitVariant(candidate, decisionPerf, chaseRiskUpFront);
  const entryStats = entry.stats;
  const exitStats = exit.stats;
  // Geometry selection is heuristic and current-context only. Historical combo
  // evidence evaluates this exact choice; it must never choose the geometry.
  const selectedEntryVariant = entry.key;
  const selectedExitVariant = exit.key;
  const directCombo = replayCombinationCandidates(candidate, decisionPerf).find(
    (combo) => combo.entryVariant === selectedEntryVariant && combo.exitVariant === selectedExitVariant,
  ) ?? null;
  const hasDirectEvidence = directCombo !== null && directCombo.resolved > 0 && Number.isFinite(directCombo.netAvgR);
  const expectedGrossR = hasDirectEvidence ? directCombo.grossAvgR : null;
  const expectedNetR = hasDirectEvidence ? directCombo.netAvgR : null;
  const sampleSize = hasDirectEvidence ? directCombo.resolved : 0;
  const tier = hasDirectEvidence ? directCombo.sampleTier : "early";
  const anchor =
    selectedEntryVariant === "base_current_entry"
      ? candidate.indicators.fiveMinute.latestClose
      : selectedEntryVariant === "fib_382_entry"
        ? candidate.fibonacci.retracement382
        : selectedEntryVariant === "fib_500_entry"
          ? candidate.fibonacci.retracement500
          : selectedEntryVariant === "fib_618_entry"
            ? candidate.fibonacci.retracement618
            : selectedEntryVariant === "vwap_retest_entry"
              ? candidate.indicators.fiveMinute.vwap
              : selectedEntryVariant === "ema20_pullback_entry"
                ? candidate.indicators.fiveMinute.ema20
                : entryMid(candidate);
  // Cost assumptions are part of the evidence contract too. A mixed legacy
  // performance record may remain visible in the UI, but must not influence a
  // post-fix decision; use the canonical configured fallback until a homogeneous
  // post-fix cohort exists.
  const costs = costDiagnostics(candidate, anchor, decisionPerf);
  const precision = entryPrecision(candidate, anchor);
  const exitDetails = exitPrecision(candidate, selectedExitVariant);
  const structurallyBadCost = (costs.costR ?? 0) >= 0.45;
  const netEdgeAfterCost = expectedNetR;

  const symbolStat = (decisionPerf?.windows["1h"].bySymbol ?? []).find((s) => s.symbol === candidate.symbol) ?? null;
  const sideKey: "LONG" | "SHORT" =
    candidate.finalDirection === "SHORT" ? "SHORT" : "LONG";
  const sideStat = decisionPerf?.windows["1h"].byDirection?.[sideKey] ?? null;
  const allReplayCombosForVariant = (decisionPerf?.windows["1h"].variantCombinations ?? []).filter(
    (combo) => combo.entryVariant === selectedEntryVariant,
  );
  const whaleAgrees =
    (candidate.finalDirection === "LONG" && candidate.whale.signal === "BULLISH") ||
    (candidate.finalDirection === "SHORT" && candidate.whale.signal === "BEARISH");
  const whaleDisagrees =
    (candidate.finalDirection === "LONG" && candidate.whale.signal === "BEARISH") ||
    (candidate.finalDirection === "SHORT" && candidate.whale.signal === "BULLISH");
  // Calibration step: debias the heuristic expectedNetR using historical
  // realized R from shadow data. Pure function — adjustment is bounded and
  // the raw fields are kept verbatim in the snapshot for transparency.
  const calibrationEvidence: CalibrationEvidence = calibration ?? emptyCalibrationEvidence();
  const calibrationResult = computeCalibratedExpectedR({
    rawExpectedGrossR: expectedGrossR,
    rawExpectedNetR: expectedNetR,
    selectedEntryVariant,
    selectedExitVariant,
    symbol: candidate.symbol,
    direction: sideKey,
    selectionSource: "heuristic_fallback",
    evidence: calibrationEvidence,
  });
  const conservativeNetR =
    hasDirectEvidence && sampleSize >= 30 && expectedNetR !== null
      ? calibrationResult.calibratedExpectedNetR ?? expectedNetR
      : null;

  const routeDecision = computeProfitRoute({
    symbol: candidate.symbol,
    direction: sideKey,
    selectedEntryVariant,
    selectedExitVariant,
    expectedNetR,
    expectedGrossR,
    variantConfidenceTier: tier,
    symbolStats: symbolStat
      ? { symbol: symbolStat.symbol, netAvgR: symbolStat.avgNetRResult, resolved: symbolStat.resolved }
      : null,
    sideStats: sideStat
      ? { side: sideKey, netAvgR: sideStat.avgNetRResult, resolved: sideStat.resolved }
      : null,
    variantCombo: hasDirectEvidence ? directCombo : null,
    allReplayCombosForVariant,
    entryVariantStats: entryStats,
    exitVariantStats: exitStats,
    kronos: {
      bias: candidate.kronosBias ?? undefined,
      selectedBias: candidate.selectedKronosBias ?? undefined,
      confidenceBucket: candidate.kronosConfidenceBucket ?? undefined,
      horizonConflict: candidate.horizonConflict ?? false,
    },
    whale: {
      available: candidate.whale.available,
      agrees: whaleAgrees,
      disagrees: whaleDisagrees,
    },
    cost: {
      costR: costs.costR,
      spreadR: costs.spreadR,
      feeSlippageR: costs.feeSlippageR,
      stopDistanceBps: costs.stopDistanceBps,
    },
    profitableTp1Rate: hasDirectEvidence && directCombo.resolved > 0 ? directCombo.profitableTp1 / directCombo.resolved : null,
    runnerSuccessRate: hasDirectEvidence ? directCombo.runnerSuccessRate : null,
    selectionSource: "heuristic_fallback",
    calibratedExpectedNetR: calibrationResult.calibratedExpectedNetR,
    canonicalRoutingNetR: conservativeNetR,
    calibrationVerdict: calibrationResult.calibrationVerdict,
    calibrationSampleSize: calibrationResult.calibrationSampleSize,
    calibrationDiagnosisCodes: calibrationResult.calibrationDiagnosisCodes,
    profitAdmission: {
      chaseRisk: precision.chaseRisk,
      riskReward: candidate.riskReward,
    },
  });
  const routeMode: ProfitRouteMode = routeDecision.routeMode;
  const diagnostics = computeScannerDiagnostics(
    {
      symbol: candidate.symbol,
      direction: sideKey,
      selectedEntryVariant,
      selectedExitVariant,
      expectedNetR,
      expectedGrossR,
      variantConfidenceTier: tier,
      symbolStats: symbolStat ? { symbol: symbolStat.symbol, netAvgR: symbolStat.avgNetRResult, resolved: symbolStat.resolved } : null,
      sideStats: sideStat ? { side: sideKey, netAvgR: sideStat.avgNetRResult, resolved: sideStat.resolved } : null,
      variantCombo: hasDirectEvidence ? directCombo : null,
      allReplayCombosForVariant,
      entryVariantStats: entryStats,
      exitVariantStats: exitStats,
      kronos: {
        bias: candidate.kronosBias ?? undefined,
        selectedBias: candidate.selectedKronosBias ?? undefined,
        confidenceBucket: candidate.kronosConfidenceBucket ?? undefined,
        horizonConflict: candidate.horizonConflict ?? false,
      },
      whale: { available: candidate.whale.available, agrees: whaleAgrees, disagrees: whaleDisagrees },
      cost: { costR: costs.costR, spreadR: costs.spreadR, feeSlippageR: costs.feeSlippageR, stopDistanceBps: costs.stopDistanceBps },
      profitableTp1Rate: hasDirectEvidence && directCombo.resolved > 0 ? directCombo.profitableTp1 / directCombo.resolved : null,
      runnerSuccessRate: hasDirectEvidence ? directCombo.runnerSuccessRate : null,
      selectionSource: "heuristic_fallback",
    },
    routeDecision,
  );
  const reason = [
    `${entry.label} and ${exit.label} selected from geometry plus heuristic variant evidence.`,
    expectedNetR !== null ? `direct selected-combo net R ${expectedNetR.toFixed(2)} with ${sampleSize} resolved samples.` : `no direct evidence exists for the selected combo, so keep this paper/shadow only.`,
    structurallyBadCost ? `cost drag is high at ${(costs.costR ?? 0).toFixed(2)}R because stop distance is only ${(costs.stopDistanceBps ?? 0).toFixed(2)}bps; cost is diagnostic because expected net R already includes execution cost.` : `cost drag ${(costs.costR ?? 0).toFixed(2)}R is included in net edge.`,
  ].join(" ");

  return {
    selectedEntryVariant,
    selectedExitVariant,
    expectedGrossR,
    expectedNetR,
    netEdgeAfterCost,
    profitFactor: hasDirectEvidence ? directCombo.profitFactor : null,
    fillRate: hasDirectEvidence && directCombo.attempted > 0 ? round((directCombo.filled / directCombo.attempted) * 100, 2) : null,
    noFillRate: hasDirectEvidence && directCombo.attempted > 0 ? round((directCombo.noFill / directCombo.attempted) * 100, 2) : null,
    costR: costs.costR,
    spreadR: costs.spreadR,
    feeSlippageR: costs.feeSlippageR,
    stopDistanceBps: costs.stopDistanceBps,
    variantSampleSize: sampleSize,
    variantConfidenceTier: tier,
    routeMode,
    routeScore: routeDecision.routeScore,
    routeDiagnosticScore: routeDecision.routeDiagnosticScore,
    routeReasonCodes: routeDecision.routeReasonCodes,
    routeExplanation: routeDecision.routeExplanation,
    primaryProfitEligible: routeDecision.primaryProfitEligible,
    researchReason: routeDecision.researchReason,
    dataCollectionReason: routeDecision.dataCollectionReason,
    diagnostics,
    rawExpectedNetR: calibrationResult.rawExpectedNetR,
    calibratedExpectedNetR: calibrationResult.calibratedExpectedNetR,
    conservativeNetR,
    canonicalRoutingNetR: conservativeNetR,
    heuristicSelectionScore: round(entry.score + exit.score, 2),
    calibrationPenaltyR: calibrationResult.calibrationPenaltyR,
    calibrationConfidence: calibrationResult.calibrationConfidence,
    calibrationSampleSize: calibrationResult.calibrationSampleSize,
    calibrationSourceUsed: calibrationResult.calibrationSourceUsed,
    calibrationDiagnosisCodes: calibrationResult.calibrationDiagnosisCodes,
    calibrationVerdict: calibrationResult.calibrationVerdict,
    calibrationExplanation: calibrationResult.calibrationExplanation,
    evidenceEra: CURRENT_EVIDENCE_ERA,
    decisionPolicyVersion: CURRENT_DECISION_POLICY_VERSION,
    executionPolicyVersion: EXECUTION_POLICY_VERSION,
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    policyDeploymentAt: resolveEndToEndCorrectnessDeploymentAt() ?? undefined,
    selectionSource: "heuristic_fallback",
    costAssumption: `1h replay uses ${decisionPerf ? `${decisionPerf.executionCost.roundTripCostBps}bps round-trip` : "configured round-trip costs"}${candidate.spread.percent !== null ? ` + ${candidate.spread.percent.toFixed(4)}% spread` : ""}`,
    selectionReason: reason,
    entryDriftPct: precision.driftPct,
    entryDriftAtr: precision.driftAtr,
    entryQualityExplanation: precision.explanations,
    exitPlanExplanation: exitDetails,
    chaseRisk: precision.chaseRisk,
  };
}

export function buildVariantCombinationTable(perf: PerformanceStats | null): VariantCombinationStats[] {
  if (!perf) return [];
  if (perf.windows["1h"].variantCombinations.length > 0) {
    return [...perf.windows["1h"].variantCombinations]
      .sort((left, right) => {
        const netDiff = (right.netAvgR ?? Number.NEGATIVE_INFINITY) - (left.netAvgR ?? Number.NEGATIVE_INFINITY);
        if (netDiff !== 0) return netDiff;
        return right.filled - left.filled;
      });
  }
  const entries = entryVariantMap();
  const exits = exitVariantMap();
  return entries.flatMap((entry) =>
    exits.map((exit) => {
      const entryStats = findShadowVariant(perf, entry.shadowKey);
      const exitStats = exit.shadowKey ? findShadowVariant(perf, exit.shadowKey) : null;
      const resolved = Math.min(entryStats?.resolved ?? 0, exitStats?.resolved ?? 0);
      const profitableTp1 = Math.round(((entryStats?.profitableTp1Hit ?? 0) + (exitStats?.profitableTp1Hit ?? 0)) / 2);
      const sl = Math.round(((entryStats?.slHit ?? 0) + (exitStats?.slHit ?? 0)) / 2);
      const grossAvgR =
        entryStats?.avgGrossRResult !== null || exitStats?.avgGrossRResult !== null
          ? round((((entryStats?.avgGrossRResult ?? 0) * sampleWeight(entryStats)) + ((exitStats?.avgGrossRResult ?? 0) * sampleWeight(exitStats))) / Math.max(sampleWeight(entryStats) + sampleWeight(exitStats), 0.0001), 2)
          : null;
      const netAvgR =
        entryStats?.avgNetRResult !== null || exitStats?.avgNetRResult !== null
          ? round((((entryStats?.avgNetRResult ?? 0) * sampleWeight(entryStats)) + ((exitStats?.avgNetRResult ?? 0) * sampleWeight(exitStats))) / Math.max(sampleWeight(entryStats) + sampleWeight(exitStats), 0.0001), 2)
          : null;
      const profitFactor =
        entryStats?.profitFactor !== null || exitStats?.profitFactor !== null
          ? round((((entryStats?.profitFactor ?? 1) * sampleWeight(entryStats)) + ((exitStats?.profitFactor ?? 1) * sampleWeight(exitStats))) / Math.max(sampleWeight(entryStats) + sampleWeight(exitStats), 0.0001), 2)
          : null;
      return {
        entryVariant: entry.key,
        exitVariant: exit.key,
        attempted: Math.max(entryStats?.signals ?? 0, exitStats?.signals ?? 0),
        filled: resolved,
        noFill: 0,
        resolved,
        validResolved: resolved,
        tp1: Math.round(((entryStats?.tp1Hit ?? 0) + (exitStats?.tp1Hit ?? 0)) / 2),
        tp2: Math.round(((entryStats?.tp2Hit ?? 0) + (exitStats?.tp2Hit ?? 0)) / 2),
        tp3: Math.round(((entryStats?.tp3Hit ?? 0) + (exitStats?.tp3Hit ?? 0)) / 2),
        profitableTp1,
        sl,
        winRate: resolved > 0 ? profitableTp1 / resolved : 0,
        grossAvgR,
        netAvgR,
        profitFactor,
        avgWinR: null,
        avgLossR: null,
        expectancyPerTrade: netAvgR,
        runnerSuccessRate: 0,
        sampleTier: toTier(resolved),
        ambiguousSameCandleCount: 0,
      };
    }),
  )
    .filter((combo) => combo.resolved > 0 || combo.netAvgR !== null)
    .sort((a, b) => (b.netAvgR ?? Number.NEGATIVE_INFINITY) - (a.netAvgR ?? Number.NEGATIVE_INFINITY));
}

import type { StrategyExperienceRecord } from "@dtc/shared";

/**
 * UNIVERSE ROTATION INTELLIGENCE (Phase 2E.1)
 *
 * Read-only advisory engine that analyzes which symbols contribute most positively
 * or negatively to realized performance, classifies symbols for rotation pressure
 * vs core observation, extracts promising/toxic fingerprints, and assesses external
 * discovery readiness — without changing any trading behavior.
 *
 * Does NOT change:
 *   - symbol universe or scanner ranking / Top-10 selection
 *   - opportunity / confidence / danger scoring
 *   - routeMode decisions or variant selection
 *   - shadow fill, close, cost, or calibration logic
 *   - live readiness, symbol quarantine, trade caps
 *   - stop / TP geometry
 *
 * The output is intended for human review only.
 */

// ─── Evidence era ──────────────────────────────────────────────────────────────

export type UniverseRotationEvidenceEra = "POST_CALIBRATION" | "ALL_TIME";

// ─── Sample tier ──────────────────────────────────────────────────────────────

export type RotationSampleTier = "EMPTY" | "TOO_EARLY" | "EARLY" | "WATCHABLE" | "EVALUABLE";

// ─── Verdicts ─────────────────────────────────────────────────────────────────

export type SymbolRotationVerdict =
  | "INSUFFICIENT_EVIDENCE"
  | "EARLY_PROMISING"
  | "WATCHABLE_PROMISING"
  | "MIXED"
  | "EARLY_DRAG"
  | "WATCHABLE_DRAG"
  | "TOXIC_PRESSURE";

// ─── Pressure level ───────────────────────────────────────────────────────────

export type RotationPressureLevel = "LOW" | "MODERATE" | "HIGH";

// ─── Confidence and patch types ───────────────────────────────────────────────

export type FingerprintConfidence = "LOW" | "MEDIUM" | "HIGH";

export type RotationPatchAction =
  | "AUDIT_TOXIC_SYMBOL_DEEPER"
  | "WATCH_PROMISING_SYMBOL_ACCUMULATE"
  | "AUDIT_DIRECTION_SPECIFIC_DRAG"
  | "NO_ACTION_YET";

export type RotationPatchStatus = "WATCH" | "AUDIT_DEEPER";

// ─── Report interfaces ────────────────────────────────────────────────────────

export interface SymbolRotationAssessment {
  symbol: string;
  closedCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  slRate: number | null;
  tp1ProfitableRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  sampleTier: RotationSampleTier;
  rotationPressureScore: number;
  rotationPressureLevel: RotationPressureLevel;
  verdict: SymbolRotationVerdict;
  directions: Array<"LONG" | "SHORT">;
  reasons: string[];
}

export interface SymbolDirectionRotationAssessment {
  symbol: string;
  direction: "LONG" | "SHORT";
  closedCount: number;
  netAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  slRate: number | null;
  sampleTier: RotationSampleTier;
  verdict: SymbolRotationVerdict;
  rotationPressureScore: number;
}

export interface UniverseContributionSummary {
  totalSymbols: number;
  totalClosedCount: number;
  overallNetAvgR: number | null;
  overallProfitFactor: number | null;
  positiveContributorCount: number;
  negativeContributorCount: number;
  topContributor: { symbol: string; netAvgR: number; closedCount: number } | null;
  worstContributor: { symbol: string; netAvgR: number; closedCount: number } | null;
  symbolsAboveAvg: number;
  symbolsBelowAvg: number;
}

export interface RotationFingerprint {
  type: "PROMISING" | "TOXIC";
  pattern: string;
  exampleSymbol: string;
  exampleDirection: "LONG" | "SHORT" | null;
  exampleNetAvgR: number | null;
  sampleCount: number;
  confidence: FingerprintConfidence;
  interpretation: string;
}

export interface RotationPatchHypothesis {
  title: string;
  evidenceSummary: string;
  likelyFutureAction: RotationPatchAction;
  confidence: FingerprintConfidence;
  patchStatus: RotationPatchStatus;
  doesNotImplementNow: true;
}

export interface UniverseRotationReadiness {
  advisoryEngineReady: boolean;
  readyForUniverseInfluence: false;
  readyForExternalCandidateSearch: false;
  reasons: string[];
}

export interface UniverseRotationIntelligenceReport {
  generatedAt: string;
  evidenceEra: UniverseRotationEvidenceEra;
  metadata: {
    resolvedExperienceRecordCount: number;
    symbolCount: number;
    symbolsWithAtLeast5Closes: number;
    symbolsWithAtLeast15Closes: number;
    symbolsWithAtLeast30Closes: number;
  };
  symbolAssessments: SymbolRotationAssessment[];
  symbolDirectionAssessments: SymbolDirectionRotationAssessment[];
  universeContributionSummary: UniverseContributionSummary;
  coreObservationCandidates: SymbolRotationAssessment[];
  rotationPressureCandidates: SymbolRotationAssessment[];
  promisingFingerprints: RotationFingerprint[];
  toxicFingerprints: RotationFingerprint[];
  patchHypotheses: RotationPatchHypothesis[];
  readiness: UniverseRotationReadiness;
  answerCards: Array<{ question: string; answer: string }>;
  notes: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function r4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

function avgFinite(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (finite.length === 0) return null;
  return r4(finite.reduce((sum, v) => sum + v, 0) / finite.length);
}

function classifySampleTier(count: number): RotationSampleTier {
  if (count <= 0) return "EMPTY";
  if (count < 5) return "TOO_EARLY";
  if (count < 15) return "EARLY";
  if (count < 30) return "WATCHABLE";
  return "EVALUABLE";
}

function sampleWeightOf(tier: RotationSampleTier): number {
  switch (tier) {
    case "EMPTY": return 0;
    case "TOO_EARLY": return 0.2;
    case "EARLY": return 0.4;
    case "WATCHABLE": return 0.7;
    case "EVALUABLE": return 1.0;
  }
}

function profitFactorOf(records: StrategyExperienceRecord[]): number | null {
  const netRs = records
    .map((r) => r.outcome.realizedNetR)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const winSum = netRs.filter((v) => v > 0).reduce((sum, v) => sum + v, 0);
  const lossAbs = Math.abs(netRs.filter((v) => v < 0).reduce((sum, v) => sum + v, 0));
  if (lossAbs === 0) return null;
  return r4(winSum / lossAbs);
}

// Rotation pressure: 0 = no pressure (excellent performance) → 100 = max pressure (terrible performance).
// This is the inverse of rawPerformanceScore: bad netAvgR / PF / slRate drives score up.
function rawRotationPressureOf(input: {
  netAvgR: number | null;
  profitFactor: number | null;
  slRate: number | null;
}): number {
  let score = 50;
  if (input.netAvgR !== null) {
    const capped = Math.max(-0.5, Math.min(0.5, input.netAvgR));
    // negative netAvgR → score above 50; positive → below 50
    score -= (capped / 0.5) * 25;
  }
  if (input.profitFactor !== null) {
    const pf = input.profitFactor;
    if (pf < 1.0) {
      score += Math.min(20, ((1.0 - pf) / 1.0) * 20);
    } else if (pf >= 1.2) {
      score -= Math.min(20, ((pf - 1.2) / 1.8) * 20);
    }
  }
  if (input.slRate !== null) {
    if (input.slRate > 0.4) {
      score += Math.min(15, ((input.slRate - 0.4) / 0.6) * 15);
    } else {
      score -= Math.min(15, ((0.4 - input.slRate) / 0.4) * 15);
    }
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

// Blend raw pressure toward neutral (50) proportional to sample weight.
function rotationPressureScoreOf(
  netAvgR: number | null,
  profitFactor: number | null,
  slRate: number | null,
  tier: RotationSampleTier,
): number {
  const raw = rawRotationPressureOf({ netAvgR, profitFactor, slRate });
  const weight = sampleWeightOf(tier);
  return Math.round(50 + (raw - 50) * weight);
}

// HIGH requires WATCHABLE or EVALUABLE tier (≥15 closes).
function rotationPressureLevelOf(score: number, tier: RotationSampleTier): RotationPressureLevel {
  if (tier === "EMPTY" || tier === "TOO_EARLY") return "LOW";
  if (tier === "EARLY") {
    return score >= 65 ? "MODERATE" : "LOW";
  }
  if (score >= 70) return "HIGH";
  if (score >= 55) return "MODERATE";
  return "LOW";
}

function symbolRotationVerdictOf(
  count: number,
  netAvgR: number | null,
  profitFactor: number | null,
  slRate: number | null,
): SymbolRotationVerdict {
  if (count === 0 || netAvgR === null) return "INSUFFICIENT_EVIDENCE";
  if (count < 5) return "INSUFFICIENT_EVIDENCE";
  // null PF = all wins (no losses) — treat as non-blocking for promising verdicts
  const pfOk = (threshold: number) => profitFactor === null || profitFactor > threshold;
  const pfBad = (threshold: number) => profitFactor !== null && profitFactor < threshold;
  const sl = slRate ?? 0;
  if (count < 15) {
    if (netAvgR > 0.10 && pfOk(1.0)) return "EARLY_PROMISING";
    if (netAvgR < -0.10 || sl > 0.60) return "EARLY_DRAG";
    return "MIXED";
  }
  if (count < 30) {
    if (netAvgR > 0.15 && pfOk(1.2) && sl < 0.40) return "WATCHABLE_PROMISING";
    if (netAvgR < -0.15 || pfBad(0.5)) return "WATCHABLE_DRAG";
    return "MIXED";
  }
  if (netAvgR > 0.15 && pfOk(1.2)) return "WATCHABLE_PROMISING";
  if (netAvgR < -0.15 || pfBad(0.5)) return "TOXIC_PRESSURE";
  return "MIXED";
}

// ─── Era filtering ────────────────────────────────────────────────────────────

function filterByEra(
  records: StrategyExperienceRecord[],
  era: UniverseRotationEvidenceEra,
): StrategyExperienceRecord[] {
  if (era === "ALL_TIME") return records;
  return records.filter(
    (r) => (r.context.evidenceEra ?? r.outcome.evidenceEra) === "POST_CALIBRATION",
  );
}

// ─── Symbol assessment ────────────────────────────────────────────────────────

function buildSymbolAssessment(
  symbol: string,
  records: StrategyExperienceRecord[],
): SymbolRotationAssessment {
  const closedCount = records.length;
  const netRs = records
    .map((r) => r.outcome.realizedNetR)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const grossRs = records
    .map((r) => r.outcome.realizedGrossR)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  const winners = records.filter((r) => (r.outcome.realizedNetR ?? 0) > 0);
  const losers = records.filter((r) => (r.outcome.realizedNetR ?? 0) < 0);

  const netAvgR = avgFinite(netRs);
  const grossAvgR = avgFinite(grossRs);
  const winRate = closedCount > 0 ? r4(winners.length / closedCount) : null;
  const pf = profitFactorOf(records);
  const slCount = records.filter(
    (r) => r.outcome.slHit === true || r.outcome.closeReason === "SL" || r.outcome.closeReason === "BREAKEVEN",
  ).length;
  const slRate = closedCount > 0 ? r4(slCount / closedCount) : null;
  const tp1ProfitCount = records.filter(
    (r) => r.outcome.tp1Hit === true && (r.outcome.realizedNetR ?? 0) > 0,
  ).length;
  const tp1ProfitableRate = closedCount > 0 ? r4(tp1ProfitCount / closedCount) : null;
  const avgWinR = avgFinite(winners.map((r) => r.outcome.realizedNetR));
  const avgLossR = avgFinite(losers.map((r) => r.outcome.realizedNetR));

  const dirSet = new Set(records.map((r) => r.context.direction));
  const directions = ([...dirSet] as Array<"LONG" | "SHORT">).sort();

  const tier = classifySampleTier(closedCount);
  const pressureScore = rotationPressureScoreOf(netAvgR, pf, slRate, tier);
  const pressureLevel = rotationPressureLevelOf(pressureScore, tier);
  const verdict = symbolRotationVerdictOf(closedCount, netAvgR, pf, slRate);

  const reasons: string[] = [];
  if (closedCount === 0) {
    reasons.push("No closed trades for this symbol yet.");
  } else {
    if (netAvgR !== null) reasons.push(`Net avg R: ${netAvgR.toFixed(4)} over ${closedCount} closes.`);
    if (pf !== null) reasons.push(`Profit factor: ${pf.toFixed(2)} (>1.2 = baseline good).`);
    if (slRate !== null) reasons.push(`SL rate: ${(slRate * 100).toFixed(0)}% (baseline ≤40%).`);
    if (tier === "TOO_EARLY" || tier === "EARLY") {
      reasons.push("Sample below 15 closes — directional signal only, not confirmation-grade.");
    } else if (tier === "EVALUABLE") {
      reasons.push("Sample 30+ closes — verdict is confirmation-grade.");
    }
  }

  return {
    symbol,
    closedCount,
    netAvgR,
    grossAvgR,
    profitFactor: pf,
    winRate,
    slRate,
    tp1ProfitableRate,
    avgWinR,
    avgLossR,
    sampleTier: tier,
    rotationPressureScore: pressureScore,
    rotationPressureLevel: pressureLevel,
    verdict,
    directions,
    reasons,
  };
}

// ─── Symbol-direction assessment ──────────────────────────────────────────────

function buildSymbolDirectionAssessment(
  symbol: string,
  direction: "LONG" | "SHORT",
  records: StrategyExperienceRecord[],
): SymbolDirectionRotationAssessment {
  const closedCount = records.length;
  const netRs = records
    .map((r) => r.outcome.realizedNetR)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  const winners = records.filter((r) => (r.outcome.realizedNetR ?? 0) > 0);
  const netAvgR = avgFinite(netRs);
  const winRate = closedCount > 0 ? r4(winners.length / closedCount) : null;
  const pf = profitFactorOf(records);
  const slCount = records.filter(
    (r) => r.outcome.slHit === true || r.outcome.closeReason === "SL" || r.outcome.closeReason === "BREAKEVEN",
  ).length;
  const slRate = closedCount > 0 ? r4(slCount / closedCount) : null;

  const tier = classifySampleTier(closedCount);
  const pressureScore = rotationPressureScoreOf(netAvgR, pf, slRate, tier);
  const verdict = symbolRotationVerdictOf(closedCount, netAvgR, pf, slRate);

  return {
    symbol,
    direction,
    closedCount,
    netAvgR,
    profitFactor: pf,
    winRate,
    slRate,
    sampleTier: tier,
    verdict,
    rotationPressureScore: pressureScore,
  };
}

// ─── Universe contribution summary ───────────────────────────────────────────

function buildUniverseContributionSummary(
  symbolAssessments: SymbolRotationAssessment[],
  filteredRecords: StrategyExperienceRecord[],
): UniverseContributionSummary {
  const allNetRs = filteredRecords
    .map((r) => r.outcome.realizedNetR)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  const overallNetAvgR = allNetRs.length > 0
    ? r4(allNetRs.reduce((sum, v) => sum + v, 0) / allNetRs.length)
    : null;

  const winSum = allNetRs.filter((v) => v > 0).reduce((sum, v) => sum + v, 0);
  const lossAbs = Math.abs(allNetRs.filter((v) => v < 0).reduce((sum, v) => sum + v, 0));
  const overallProfitFactor = lossAbs === 0 ? null : r4(winSum / lossAbs);

  const meaningful = symbolAssessments.filter((s) => s.closedCount >= 5 && s.netAvgR !== null);
  const positive = meaningful.filter((s) => (s.netAvgR ?? 0) > 0);
  const negative = meaningful.filter((s) => (s.netAvgR ?? 0) < 0);

  const topContributor = positive.length > 0
    ? [...positive].sort((a, b) => (b.netAvgR ?? 0) - (a.netAvgR ?? 0))[0]!
    : null;
  const worstContributor = negative.length > 0
    ? [...negative].sort((a, b) => (a.netAvgR ?? 0) - (b.netAvgR ?? 0))[0]!
    : null;

  const totalClosedCount = symbolAssessments.reduce((sum, s) => sum + s.closedCount, 0);
  const symbolsAboveAvg = overallNetAvgR !== null
    ? meaningful.filter((s) => (s.netAvgR ?? 0) > overallNetAvgR).length
    : 0;
  const symbolsBelowAvg = overallNetAvgR !== null
    ? meaningful.filter((s) => (s.netAvgR ?? 0) < overallNetAvgR).length
    : 0;

  return {
    totalSymbols: symbolAssessments.length,
    totalClosedCount,
    overallNetAvgR,
    overallProfitFactor,
    positiveContributorCount: positive.length,
    negativeContributorCount: negative.length,
    topContributor: topContributor
      ? { symbol: topContributor.symbol, netAvgR: topContributor.netAvgR!, closedCount: topContributor.closedCount }
      : null,
    worstContributor: worstContributor
      ? { symbol: worstContributor.symbol, netAvgR: worstContributor.netAvgR!, closedCount: worstContributor.closedCount }
      : null,
    symbolsAboveAvg,
    symbolsBelowAvg,
  };
}

// ─── Fingerprints ─────────────────────────────────────────────────────────────

function buildPromisingFingerprints(
  sdAssessments: SymbolDirectionRotationAssessment[],
): RotationFingerprint[] {
  const candidates = sdAssessments
    .filter((s) => s.closedCount >= 5 && (s.netAvgR ?? 0) > 0.10)
    .sort((a, b) => (b.netAvgR ?? 0) - (a.netAvgR ?? 0))
    .slice(0, 3);

  return candidates.map((c) => {
    const confidence: FingerprintConfidence = c.sampleTier === "EVALUABLE" ? "MEDIUM" : "LOW";
    return {
      type: "PROMISING" as const,
      pattern: `${c.direction} trades on ${c.symbol} show sustained positive R contribution`,
      exampleSymbol: c.symbol,
      exampleDirection: c.direction,
      exampleNetAvgR: c.netAvgR,
      sampleCount: c.closedCount,
      confidence,
      interpretation:
        `${c.symbol} ${c.direction} has netAvgR=${c.netAvgR?.toFixed(4)} over ${c.closedCount} closes. ` +
        `This symbol-direction combination contributes positively to overall universe performance. ` +
        `Confidence is ${confidence} — ` +
        `${c.sampleTier === "EVALUABLE" ? "sample is 30+ closes, confirmation-grade" : "sample below 30 closes, directional signal only"}. ` +
        `Advisory only — no universe or routing change is justified.`,
    };
  });
}

function buildToxicFingerprints(
  sdAssessments: SymbolDirectionRotationAssessment[],
): RotationFingerprint[] {
  const candidates = sdAssessments
    .filter((s) => s.closedCount >= 5 && (s.netAvgR ?? 0) < -0.10)
    .sort((a, b) => (a.netAvgR ?? 0) - (b.netAvgR ?? 0))
    .slice(0, 3);

  return candidates.map((c) => {
    const confidence: FingerprintConfidence = c.sampleTier === "EVALUABLE" ? "MEDIUM" : "LOW";
    return {
      type: "TOXIC" as const,
      pattern: `${c.direction} trades on ${c.symbol} show consistent negative R contribution`,
      exampleSymbol: c.symbol,
      exampleDirection: c.direction,
      exampleNetAvgR: c.netAvgR,
      sampleCount: c.closedCount,
      confidence,
      interpretation:
        `${c.symbol} ${c.direction} has netAvgR=${c.netAvgR?.toFixed(4)} over ${c.closedCount} closes. ` +
        `This symbol-direction combination is a net drag on universe performance. ` +
        `Confidence is ${confidence} — ` +
        `${c.sampleTier === "EVALUABLE" ? "sample is 30+ closes, verdict is confirmation-grade" : "sample below 30 closes, directional signal only"}. ` +
        `Advisory only — no universe rotation action is justified today.`,
    };
  });
}

// ─── Patch hypotheses ─────────────────────────────────────────────────────────

function buildPatchHypotheses(
  symbolAssessments: SymbolRotationAssessment[],
  sdAssessments: SymbolDirectionRotationAssessment[],
  summary: UniverseContributionSummary,
): RotationPatchHypothesis[] {
  const hypotheses: RotationPatchHypothesis[] = [];

  // 1. TOXIC_PRESSURE symbol — warrants deeper audit
  const toxicSymbol = symbolAssessments.find((s) => s.verdict === "TOXIC_PRESSURE");
  if (toxicSymbol) {
    hypotheses.push({
      title: `Audit whether ${toxicSymbol.symbol} should remain in observed universe`,
      evidenceSummary:
        `${toxicSymbol.symbol} has verdict=TOXIC_PRESSURE: netAvgR=${toxicSymbol.netAvgR?.toFixed(4)}, ` +
        `PF=${toxicSymbol.profitFactor?.toFixed(2)}, SL=${((toxicSymbol.slRate ?? 0) * 100).toFixed(0)}%, ` +
        `${toxicSymbol.closedCount} closes (${toxicSymbol.sampleTier}). ` +
        `This symbol is a persistent drag at confirmation-grade sample size. ` +
        `No universe change is implemented — advisory observation only.`,
      likelyFutureAction: "AUDIT_TOXIC_SYMBOL_DEEPER",
      confidence: "LOW",
      patchStatus: "AUDIT_DEEPER",
      doesNotImplementNow: true,
    });
  }

  // 2. Direction-specific divergence (one direction promising, the other dragging)
  const symbolsWithBothDirections = symbolAssessments.filter((s) => s.directions.length === 2);
  for (const sym of symbolsWithBothDirections) {
    const longAssess = sdAssessments.find((sd) => sd.symbol === sym.symbol && sd.direction === "LONG");
    const shortAssess = sdAssessments.find((sd) => sd.symbol === sym.symbol && sd.direction === "SHORT");
    if (!longAssess || !shortAssess) continue;

    const promisingVerdicts: SymbolRotationVerdict[] = ["EARLY_PROMISING", "WATCHABLE_PROMISING"];
    const draggingVerdicts: SymbolRotationVerdict[] = ["EARLY_DRAG", "WATCHABLE_DRAG", "TOXIC_PRESSURE"];

    const longPromising = promisingVerdicts.includes(longAssess.verdict);
    const shortDragging = draggingVerdicts.includes(shortAssess.verdict);
    const shortPromising = promisingVerdicts.includes(shortAssess.verdict);
    const longDragging = draggingVerdicts.includes(longAssess.verdict);

    if ((longPromising && shortDragging) || (shortPromising && longDragging)) {
      const badDir = longDragging ? "LONG" : "SHORT";
      const badAssess = badDir === "LONG" ? longAssess : shortAssess;
      hypotheses.push({
        title: `Investigate ${sym.symbol} ${badDir} direction as a potential drag source`,
        evidenceSummary:
          `${sym.symbol} shows direction-specific divergence. ${badDir} shows drag: ` +
          `netAvgR=${badAssess.netAvgR?.toFixed(4)}, ${badAssess.closedCount} closes, verdict=${badAssess.verdict}. ` +
          `Other direction is promising. This is early advisory signal — no direction-level action is justified.`,
        likelyFutureAction: "AUDIT_DIRECTION_SPECIFIC_DRAG",
        confidence: "LOW",
        patchStatus: "WATCH",
        doesNotImplementNow: true,
      });
      break;
    }
  }

  // 3. WATCHABLE_DRAG approaching threshold (if no TOXIC_PRESSURE already flagged)
  if (!hypotheses.some((h) => h.likelyFutureAction === "AUDIT_TOXIC_SYMBOL_DEEPER")) {
    const watchableDrag = symbolAssessments.find((s) => s.verdict === "WATCHABLE_DRAG");
    if (watchableDrag) {
      hypotheses.push({
        title: `Monitor ${watchableDrag.symbol} for sustained drag — evidence approaching threshold`,
        evidenceSummary:
          `${watchableDrag.symbol} has verdict=WATCHABLE_DRAG: netAvgR=${watchableDrag.netAvgR?.toFixed(4)}, ` +
          `${watchableDrag.closedCount} closes. Approaching TOXIC_PRESSURE threshold (30+ closes required). ` +
          `Continue accumulating evidence before any action.`,
        likelyFutureAction: "AUDIT_TOXIC_SYMBOL_DEEPER",
        confidence: "LOW",
        patchStatus: "WATCH",
        doesNotImplementNow: true,
      });
    }
  }

  // 4. Promising symbol — watch for accumulation
  const promisingSymbol = symbolAssessments.find((s) =>
    s.verdict === "EARLY_PROMISING" || s.verdict === "WATCHABLE_PROMISING",
  );
  if (promisingSymbol) {
    hypotheses.push({
      title: `Watch ${promisingSymbol.symbol} as a core observation candidate — accumulate evidence`,
      evidenceSummary:
        `${promisingSymbol.symbol} has verdict=${promisingSymbol.verdict}: netAvgR=${promisingSymbol.netAvgR?.toFixed(4)}, ` +
        `${promisingSymbol.closedCount} closes (${promisingSymbol.sampleTier}). ` +
        `Continue accumulating evidence. No preferential routing or allocation change justified.`,
      likelyFutureAction: "WATCH_PROMISING_SYMBOL_ACCUMULATE",
      confidence: "LOW",
      patchStatus: "WATCH",
      doesNotImplementNow: true,
    });
  }

  // Fallback
  if (hypotheses.length === 0) {
    hypotheses.push({
      title: "No specific universe rotation concern detected at current sample size",
      evidenceSummary:
        `With ${summary.totalClosedCount} total closes across ${summary.totalSymbols} symbols, ` +
        `no individual symbol shows a strong enough pattern to generate a specific rotation hypothesis. ` +
        `Continue accumulating evidence. Revisit when any symbol reaches ≥15 closes.`,
      likelyFutureAction: "NO_ACTION_YET",
      confidence: "LOW",
      patchStatus: "WATCH",
      doesNotImplementNow: true,
    });
  }

  return hypotheses;
}

// ─── Readiness ────────────────────────────────────────────────────────────────

function buildReadiness(
  symbolCount: number,
  symbolsWithAtLeast5Closes: number,
  symbolsWithAtLeast15Closes: number,
): UniverseRotationReadiness {
  const reasons: string[] = [];

  if (symbolsWithAtLeast15Closes < 3) {
    reasons.push(
      `Only ${symbolsWithAtLeast15Closes} symbol(s) have ≥15 closes — need ≥3 for stable rotation intelligence`,
    );
  }
  if (symbolsWithAtLeast5Closes < 5) {
    reasons.push(
      `Only ${symbolsWithAtLeast5Closes} symbol(s) have ≥5 closes — universe sample too thin for rotation pressure conclusions`,
    );
  }
  reasons.push(
    "readyForUniverseInfluence is always false — this engine is permanently advisory-only in Phase 2E.1",
  );
  reasons.push(
    "readyForExternalCandidateSearch is always false — external discovery logic is reserved for Phase 2E.2",
  );

  return {
    advisoryEngineReady: symbolCount > 0,
    readyForUniverseInfluence: false,
    readyForExternalCandidateSearch: false,
    reasons,
  };
}

// ─── Answer cards ─────────────────────────────────────────────────────────────

function buildAnswerCards(
  symbolAssessments: SymbolRotationAssessment[],
  sdAssessments: SymbolDirectionRotationAssessment[],
  summary: UniverseContributionSummary,
  readiness: UniverseRotationReadiness,
): Array<{ question: string; answer: string }> {
  // 1. Which symbols show strongest rotation pressure?
  const highPressure = symbolAssessments
    .filter((s) => s.rotationPressureLevel !== "LOW" && s.closedCount >= 5)
    .sort((a, b) => b.rotationPressureScore - a.rotationPressureScore)
    .slice(0, 3);

  // 2. Core observation candidates
  const coreObs = symbolAssessments.filter(
    (s) => s.verdict === "EARLY_PROMISING" || s.verdict === "WATCHABLE_PROMISING",
  );

  // 3. Direction-divergent symbols (both directions present, ≥10 closes each direction)
  const dirDivergent = symbolAssessments.filter((s) => {
    if (s.directions.length < 2) return false;
    const longA = sdAssessments.find((sd) => sd.symbol === s.symbol && sd.direction === "LONG");
    const shortA = sdAssessments.find((sd) => sd.symbol === s.symbol && sd.direction === "SHORT");
    return longA && shortA && longA.closedCount >= 5 && shortA.closedCount >= 5;
  });

  return [
    {
      question: "Which symbols show the strongest rotation pressure right now?",
      answer: highPressure.length === 0
        ? `No symbol currently shows MODERATE or HIGH rotation pressure (minimum 5 closes required). ` +
          `${summary.totalSymbols} symbols tracked, ${summary.totalClosedCount} total closes. ` +
          `Continue accumulating evidence.`
        : highPressure
            .map((s) => `${s.symbol}: score=${s.rotationPressureScore}/100 (${s.rotationPressureLevel}), verdict=${s.verdict}, netAvgR=${s.netAvgR?.toFixed(4)}, n=${s.closedCount}`)
            .join("; ") +
          `. These are advisory observations only — no universe change is justified.`,
    },
    {
      question: "Which symbols are core observation candidates worth keeping close?",
      answer: coreObs.length === 0
        ? `No symbol has reached EARLY_PROMISING or WATCHABLE_PROMISING verdict yet. ` +
          `${summary.positiveContributorCount + summary.negativeContributorCount} symbols have ≥5 closes. ` +
          `Continue accumulating evidence.`
        : coreObs
            .map((s) => `${s.symbol}: verdict=${s.verdict}, netAvgR=${s.netAvgR?.toFixed(4)}, n=${s.closedCount} (${s.sampleTier})`)
            .join("; ") +
          `. These symbols show early promising evidence — advisory only.`,
    },
    {
      question: "Is the universe as a whole contributing net positive R?",
      answer: summary.overallNetAvgR === null
        ? `Insufficient resolved data to compute overall universe netAvgR. ` +
          `${summary.totalClosedCount} total closes across ${summary.totalSymbols} symbols.`
        : summary.overallNetAvgR > 0
        ? `Yes. Overall universe netAvgR=${summary.overallNetAvgR.toFixed(4)} across ${summary.totalClosedCount} closes. ` +
          `${summary.positiveContributorCount} symbols contribute positively vs ${summary.negativeContributorCount} negatively (among symbols with ≥5 closes).`
        : `No. Overall universe netAvgR=${summary.overallNetAvgR.toFixed(4)} across ${summary.totalClosedCount} closes. ` +
          `${summary.negativeContributorCount} symbols drag performance vs ${summary.positiveContributorCount} contributing positively (among symbols with ≥5 closes).`,
    },
    {
      question: "Are there direction-specific drag patterns worth noting?",
      answer: dirDivergent.length === 0
        ? `No symbol yet has both LONG and SHORT directions with ≥5 closes each to flag direction-specific patterns. ` +
          `Continue accumulating evidence.`
        : `${dirDivergent.length} symbol(s) have both LONG and SHORT evidence: ` +
          dirDivergent
            .slice(0, 3)
            .map((s) => `${s.symbol} (overall verdict=${s.verdict}, netAvgR=${s.netAvgR?.toFixed(4)})`)
            .join(", ") +
          `. Review symbol-direction assessments for direction-specific breakdowns. Advisory only.`,
    },
    {
      question: "What would Phase 2E.2 investigate that Phase 2E.1 does not?",
      answer:
        `Phase 2E.1 is read-only and advisory — it measures symbol contribution patterns but does not change the universe. ` +
        `Phase 2E.2 (not yet built) would add: ` +
        `(1) systematic external candidate discovery using promising fingerprints applied to new symbols, ` +
        `(2) dynamic universe boundary recommendations based on TOXIC_PRESSURE evidence, ` +
        `(3) route-specific fingerprint transfer — using patterns from known symbols to search for new candidates. ` +
        `None of this is implemented. readyForUniverseInfluence=${readiness.readyForUniverseInfluence}, ` +
        `readyForExternalCandidateSearch=${readiness.readyForExternalCandidateSearch}.`,
    },
  ];
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function buildUniverseRotationIntelligenceReport(
  records: StrategyExperienceRecord[],
  opts: { evidenceEra?: UniverseRotationEvidenceEra } = {},
  now: Date = new Date(),
): UniverseRotationIntelligenceReport {
  const evidenceEra = opts.evidenceEra ?? "POST_CALIBRATION";
  const generatedAt = now.toISOString();

  const filtered = filterByEra(records, evidenceEra);

  // Group by symbol
  const symbolGroups = new Map<string, StrategyExperienceRecord[]>();
  for (const rec of filtered) {
    const symbol = rec.context.symbol;
    const list = symbolGroups.get(symbol) ?? [];
    list.push(rec);
    symbolGroups.set(symbol, list);
  }

  const symbolAssessments: SymbolRotationAssessment[] = [];
  for (const [symbol, list] of symbolGroups) {
    symbolAssessments.push(buildSymbolAssessment(symbol, list));
  }
  symbolAssessments.sort((a, b) => b.rotationPressureScore - a.rotationPressureScore);

  // Group by symbol + direction
  const sdGroups = new Map<
    string,
    { symbol: string; direction: "LONG" | "SHORT"; records: StrategyExperienceRecord[] }
  >();
  for (const rec of filtered) {
    const key = `${rec.context.symbol}|${rec.context.direction}`;
    const existing = sdGroups.get(key) ?? {
      symbol: rec.context.symbol,
      direction: rec.context.direction as "LONG" | "SHORT",
      records: [],
    };
    existing.records.push(rec);
    sdGroups.set(key, existing);
  }

  const symbolDirectionAssessments: SymbolDirectionRotationAssessment[] = [];
  for (const { symbol, direction, records: list } of sdGroups.values()) {
    symbolDirectionAssessments.push(buildSymbolDirectionAssessment(symbol, direction, list));
  }
  symbolDirectionAssessments.sort((a, b) => b.rotationPressureScore - a.rotationPressureScore);

  const universeContributionSummary = buildUniverseContributionSummary(symbolAssessments, filtered);

  const coreObservationCandidates = symbolAssessments
    .filter((s) => s.verdict === "EARLY_PROMISING" || s.verdict === "WATCHABLE_PROMISING")
    .sort((a, b) => (b.netAvgR ?? 0) - (a.netAvgR ?? 0))
    .slice(0, 5);

  const rotationPressureCandidates = symbolAssessments
    .filter((s) => s.verdict === "EARLY_DRAG" || s.verdict === "WATCHABLE_DRAG" || s.verdict === "TOXIC_PRESSURE")
    .sort((a, b) => b.rotationPressureScore - a.rotationPressureScore)
    .slice(0, 5);

  const promisingFingerprints = buildPromisingFingerprints(symbolDirectionAssessments);
  const toxicFingerprints = buildToxicFingerprints(symbolDirectionAssessments);
  const patchHypotheses = buildPatchHypotheses(symbolAssessments, symbolDirectionAssessments, universeContributionSummary);

  const symbolsWithAtLeast5Closes = symbolAssessments.filter((s) => s.closedCount >= 5).length;
  const symbolsWithAtLeast15Closes = symbolAssessments.filter((s) => s.closedCount >= 15).length;
  const symbolsWithAtLeast30Closes = symbolAssessments.filter((s) => s.closedCount >= 30).length;

  const readiness = buildReadiness(symbolAssessments.length, symbolsWithAtLeast5Closes, symbolsWithAtLeast15Closes);
  const answerCards = buildAnswerCards(symbolAssessments, symbolDirectionAssessments, universeContributionSummary, readiness);

  return {
    generatedAt,
    evidenceEra,
    metadata: {
      resolvedExperienceRecordCount: filtered.length,
      symbolCount: symbolAssessments.length,
      symbolsWithAtLeast5Closes,
      symbolsWithAtLeast15Closes,
      symbolsWithAtLeast30Closes,
    },
    symbolAssessments,
    symbolDirectionAssessments,
    universeContributionSummary,
    coreObservationCandidates,
    rotationPressureCandidates,
    promisingFingerprints,
    toxicFingerprints,
    patchHypotheses,
    readiness,
    answerCards,
    notes: [
      "Universe Rotation Intelligence is read-only. It does NOT change the symbol universe, scanner ranking, routing, execution, stop/TP behavior, or live readiness.",
      "Sample tiers: EMPTY=0, TOO_EARLY=1–4, EARLY=5–14, WATCHABLE=15–29, EVALUABLE=30+ closes.",
      "Rotation pressure score: 0 (no pressure, great performance) to 100 (max pressure, poor performance). Weighted by sample tier.",
      "Rotation pressure level: EARLY tier can reach MODERATE but never HIGH. HIGH requires WATCHABLE or EVALUABLE tier (≥15 closes).",
      "Verdict ladder: INSUFFICIENT_EVIDENCE → EARLY_PROMISING / EARLY_DRAG → WATCHABLE_PROMISING / WATCHABLE_DRAG → TOXIC_PRESSURE (30+ closes required for TOXIC_PRESSURE).",
      "Fingerprints extracted from symbol-direction combos with ≥5 closes and netAvgR above/below ±0.10. Confidence LOW until EVALUABLE (30+).",
      "All patch hypotheses have doesNotImplementNow=true and patchStatus WATCH or AUDIT_DEEPER.",
      "readyForUniverseInfluence and readyForExternalCandidateSearch are always false in Phase 2E.1.",
      "Phase 2E.2 (not yet built) would add external candidate discovery, dynamic universe boundaries, and fingerprint transfer.",
    ],
  };
}

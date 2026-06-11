import type { StrategyExperienceRecord } from "@dtc/shared";

import type { AdaptiveProfitPolicyCandidate } from "./adaptive-profit-policy.js";
import type { SymbolRouteSuitabilityReport } from "./symbol-route-suitability.js";
import type { TechnicalStopTpCredibilityReport } from "./technical-stop-tp-credibility.js";
import type { UniverseRotationIntelligenceReport } from "./universe-rotation-intelligence.js";

export type EvidenceConsensusVerdict =
  | "HIGH_CONSENSUS"
  | "MODERATE_CONSENSUS"
  | "MIXED"
  | "CONFLICTED"
  | "INSUFFICIENT_CONTEXT";

export interface EvidenceConsensusAssessment {
  evidenceConsensusScore: number;
  evidenceConsensusVerdict: EvidenceConsensusVerdict;
  positiveEvidenceCount: number;
  negativeEvidenceCount: number;
  conflictingEvidenceCount: number;
  missingEvidenceCount: number;
  keyConsensusReasons: string[];
  keyConflictReasons: string[];
}

export interface EvidenceConsensusInputs {
  candidate: AdaptiveProfitPolicyCandidate;
  candidateRecords: StrategyExperienceRecord[];
  symbolRouteSuitability: SymbolRouteSuitabilityReport;
  universeRotation: UniverseRotationIntelligenceReport;
  technicalStopTpCredibility: TechnicalStopTpCredibilityReport;
}

const MIN_CONTEXT_COVERAGE = 0.5;

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function routeLabel(candidate: AdaptiveProfitPolicyCandidate): string | null {
  if (!candidate.route || !candidate.exitPolicy) return null;
  return `${candidate.route} + ${candidate.exitPolicy}`;
}

function regimeDirectionIsAligned(candidate: AdaptiveProfitPolicyCandidate): boolean | null {
  if (!candidate.dominantRegime || candidate.direction === "MIXED") return null;
  if (candidate.dominantRegime === "BEARISH_EXPANSION") return candidate.direction === "SHORT";
  if (candidate.dominantRegime === "BULLISH_EXPANSION") return candidate.direction === "LONG";
  return null;
}

function fieldCoverage<T>(
  records: StrategyExperienceRecord[],
  getter: (record: StrategyExperienceRecord) => T | null | undefined,
): { populated: T[]; coverage: number } {
  const populated = records
    .map(getter)
    .filter((value): value is T => value !== null && value !== undefined);
  return {
    populated,
    coverage: records.length === 0 ? 0 : populated.length / records.length,
  };
}

function deriveSourceConflict(record: StrategyExperienceRecord): boolean | null {
  const bias = record.context.selectedKronosBias ?? record.context.kronosBias1h;
  const whale = record.context.whaleAgreement;
  if (!bias || !whale || bias === "UNAVAILABLE" || whale === "UNAVAILABLE") return null;
  const kronosAligned = bias === record.context.direction;
  const whaleAligned = whale === "AGREES";
  return kronosAligned !== whaleAligned;
}

export function buildEvidenceConsensusAssessment({
  candidate,
  candidateRecords,
  symbolRouteSuitability,
  universeRotation,
  technicalStopTpCredibility,
}: EvidenceConsensusInputs): EvidenceConsensusAssessment {
  let positiveEvidenceCount = 0;
  let negativeEvidenceCount = 0;
  let conflictingEvidenceCount = 0;
  let missingEvidenceCount = 0;
  const keyConsensusReasons: string[] = [];
  const keyConflictReasons: string[] = [];

  const alignedRegime = regimeDirectionIsAligned(candidate);
  if (alignedRegime === true) {
    positiveEvidenceCount += 1;
    keyConsensusReasons.push("Direction aligns with dominant market regime.");
  } else if (alignedRegime === false) {
    conflictingEvidenceCount += 1;
    keyConflictReasons.push("Direction conflicts with dominant market regime.");
  } else {
    missingEvidenceCount += 1;
  }

  const directionalAlignment = fieldCoverage(candidateRecords, (record) => record.context.directionalAlignmentLabel);
  if (directionalAlignment.coverage >= MIN_CONTEXT_COVERAGE) {
    const alignedCount = directionalAlignment.populated.filter((value) => value === "ALIGNED").length;
    const conflictedCount = directionalAlignment.populated.filter((value) => value === "CONFLICTED").length;
    if (alignedCount / directionalAlignment.populated.length >= 0.6) {
      positiveEvidenceCount += 1;
      keyConsensusReasons.push("Trend alignment is mostly supportive inside the lane.");
    } else if (conflictedCount / directionalAlignment.populated.length >= 0.4) {
      conflictingEvidenceCount += 1;
      keyConflictReasons.push("Trend alignment is materially conflicted inside the lane.");
    } else {
      conflictingEvidenceCount += 1;
      keyConflictReasons.push("Trend alignment is mixed rather than clean.");
    }
  } else {
    missingEvidenceCount += 1;
  }

  const horizonConflict = fieldCoverage(candidateRecords, (record) => record.context.horizonConflict);
  if (horizonConflict.coverage >= MIN_CONTEXT_COVERAGE) {
    const trueRate = horizonConflict.populated.filter(Boolean).length / horizonConflict.populated.length;
    if (trueRate <= 0.4) {
      positiveEvidenceCount += 1;
      keyConsensusReasons.push("Horizon conflict is usually absent inside the lane.");
    } else {
      conflictingEvidenceCount += 1;
      keyConflictReasons.push("Horizon conflict is materially present inside the lane.");
    }
  } else {
    missingEvidenceCount += 1;
  }

  const sourceConflict = fieldCoverage(candidateRecords, deriveSourceConflict);
  if (sourceConflict.coverage >= MIN_CONTEXT_COVERAGE) {
    const trueRate = sourceConflict.populated.filter(Boolean).length / sourceConflict.populated.length;
    if (trueRate <= 0.4) {
      positiveEvidenceCount += 1;
      keyConsensusReasons.push("Source conflict is usually absent inside the lane.");
    } else {
      conflictingEvidenceCount += 1;
      keyConflictReasons.push("Source conflict is materially present inside the lane.");
    }
  } else {
    missingEvidenceCount += 1;
  }

  if (candidate.sourceType === "CORE" && candidate.symbolScope !== "ALL_SYMBOLS") {
    const routeCandidate = symbolRouteSuitability.candidateAssessments.find((assessment) =>
      assessment.symbol === candidate.symbolScope &&
      assessment.direction === candidate.direction &&
      assessment.selectedEntryVariant === candidate.route &&
      assessment.selectedExitVariant === candidate.exitPolicy);
    if (routeCandidate) {
      if (["EARLY_PROMISING", "WATCHABLE_PROMISING", "EVALUABLE_PROMISING"].includes(routeCandidate.localVerdict)) {
        positiveEvidenceCount += 1;
        keyConsensusReasons.push(`Symbol-route suitability is supportive (${routeCandidate.localVerdict}).`);
      } else if (
        ["EARLY_TOXIC", "WATCHABLE_WEAK", "EVALUABLE_TOXIC"].includes(routeCandidate.localVerdict) &&
        (routeCandidate.netAvgR ?? 0) < 0
      ) {
        negativeEvidenceCount += 1;
        keyConflictReasons.push(`Symbol-route suitability is adverse (${routeCandidate.localVerdict}).`);
      } else {
        missingEvidenceCount += 1;
      }
    } else {
      missingEvidenceCount += 1;
    }

    const rotationAssessment = universeRotation.symbolDirectionAssessments.find((assessment) =>
      assessment.symbol === candidate.symbolScope &&
      assessment.direction === candidate.direction);
    if (rotationAssessment) {
      if (["EARLY_PROMISING", "WATCHABLE_PROMISING"].includes(rotationAssessment.verdict)) {
        positiveEvidenceCount += 1;
        keyConsensusReasons.push(`Universe contribution is supportive (${rotationAssessment.verdict}).`);
      } else if (["EARLY_DRAG", "WATCHABLE_DRAG", "TOXIC_PRESSURE"].includes(rotationAssessment.verdict)) {
        negativeEvidenceCount += 1;
        keyConflictReasons.push(`Universe contribution is adverse (${rotationAssessment.verdict}).`);
      } else {
        missingEvidenceCount += 1;
      }
    } else {
      missingEvidenceCount += 1;
    }
  } else if (candidate.sourceType === "CORE") {
    const heterogeneity = routeLabel(candidate)
      ? symbolRouteSuitability.routeHeterogeneity.find((assessment) => assessment.routeCombo === routeLabel(candidate))
      : null;
    if (heterogeneity?.verdict === "SYMBOL_SENSITIVE") {
      conflictingEvidenceCount += 1;
      keyConflictReasons.push("Route is symbol-sensitive across observed slices.");
    } else if (heterogeneity?.verdict === "BROADLY_PROMISING") {
      positiveEvidenceCount += 1;
      keyConsensusReasons.push("Route is broadly promising across observed slices.");
    } else if (heterogeneity?.verdict === "BROADLY_WEAK") {
      negativeEvidenceCount += 1;
      keyConflictReasons.push("Route is broadly weak across observed slices.");
    } else {
      missingEvidenceCount += 1;
    }
  } else {
    if (candidate.validityFlags.includes("VALID_POST_FIX_V2_ONLY")) {
      positiveEvidenceCount += 1;
      keyConsensusReasons.push("External lane uses valid post-fix V2 overlay tape only.");
    } else {
      conflictingEvidenceCount += 1;
      keyConflictReasons.push("External lane lacks valid post-fix-only tape.");
    }
    if (candidate.credibility === "CLEAN_EVALUABLE" || candidate.credibility === "CLEAN_WATCHABLE" || candidate.credibility === "CLEAN_EARLY") {
      positiveEvidenceCount += 1;
      keyConsensusReasons.push(`External overlay evidence is interpretable (${candidate.credibility}).`);
    } else {
      negativeEvidenceCount += 1;
      keyConflictReasons.push(`External overlay evidence is not clean (${candidate.credibility}).`);
    }
  }

  const matchingRoute = routeLabel(candidate)
    ? technicalStopTpCredibility.routeAssessments.find((assessment) => assessment.routeLabel === routeLabel(candidate))
    : null;
  if (
    candidate.sourceType === "CORE" &&
    technicalStopTpCredibility.realizedPathCoveragePct >= MIN_CONTEXT_COVERAGE &&
    matchingRoute &&
    matchingRoute.closedWithPathCount >= 3
  ) {
    if (matchingRoute.routeVerdict === "CLEANER_GEOMETRY_EARLY") {
      positiveEvidenceCount += 1;
      keyConsensusReasons.push("Stop/TP route geometry is cleaner in available path evidence.");
    } else if (
      matchingRoute.routeVerdict === "STOP_STRESS_ELEVATED" ||
      matchingRoute.routeVerdict === "LOSER_MISSED_EXCURSION_ELEVATED"
    ) {
      negativeEvidenceCount += 1;
      keyConflictReasons.push(`Stop/TP route geometry is adverse (${matchingRoute.routeVerdict}).`);
    } else if (matchingRoute.routeVerdict === "MIXED") {
      conflictingEvidenceCount += 1;
      keyConflictReasons.push("Stop/TP route geometry is mixed.");
    } else {
      missingEvidenceCount += 1;
    }
  } else {
    missingEvidenceCount += 1;
  }

  const observedEvidenceCount = positiveEvidenceCount + negativeEvidenceCount + conflictingEvidenceCount;
  const evidenceConsensusScore = clampScore(
    50 +
    positiveEvidenceCount * 12 -
    negativeEvidenceCount * 12 -
    conflictingEvidenceCount * 16,
  );
  const evidenceConsensusVerdict: EvidenceConsensusVerdict =
    observedEvidenceCount < 2
      ? "INSUFFICIENT_CONTEXT"
      : conflictingEvidenceCount >= 2 || negativeEvidenceCount >= 2
        ? "CONFLICTED"
        : conflictingEvidenceCount >= 1 || negativeEvidenceCount >= 1
          ? "MIXED"
          : positiveEvidenceCount >= 4
            ? "HIGH_CONSENSUS"
            : positiveEvidenceCount >= 2
              ? "MODERATE_CONSENSUS"
              : "INSUFFICIENT_CONTEXT";

  return {
    evidenceConsensusScore,
    evidenceConsensusVerdict,
    positiveEvidenceCount,
    negativeEvidenceCount,
    conflictingEvidenceCount,
    missingEvidenceCount,
    keyConsensusReasons,
    keyConflictReasons,
  };
}

import type { StrategyExperienceRecord, ResolvedTradeOutcomeSnapshot } from "@dtc/shared";

// ─── Evidence era ─────────────────────────────────────────────────────────────

export type TechnicalStopTpEvidenceEra = "POST_CALIBRATION" | "ALL_TIME";

// ─── Sample tier ──────────────────────────────────────────────────────────────

export type StopTpSampleTier = "EMPTY" | "TOO_EARLY" | "EARLY" | "WATCHABLE" | "EVALUABLE";

function classifySampleTier(n: number): StopTpSampleTier {
  if (n === 0) return "EMPTY";
  if (n <= 2) return "TOO_EARLY";
  if (n <= 9) return "EARLY";
  if (n <= 29) return "WATCHABLE";
  return "EVALUABLE";
}

// ─── Verdict types ────────────────────────────────────────────────────────────

export type StopSurvivalVerdict =
  | "INSUFFICIENT_PATH_DATA"
  | "WINNERS_REQUIRE_BREATHING_ROOM"
  | "WINNERS_SHOW_LOW_ADVERSE_STRESS"
  | "MIXED_EARLY";

export type FavorableExcursionVerdict =
  | "INSUFFICIENT_PATH_DATA"
  | "LOSERS_SHOW_LITTLE_FAVORABLE_EXCURSION"
  | "LOSERS_SHOW_MISSED_FAVORABLE_EXCURSION"
  | "MIXED_EARLY";

export type CaptureEfficiencyVerdict =
  | "INSUFFICIENT_PATH_DATA"
  | "TP_CAPTURE_LOOKS_CONSERVATIVE"
  | "TP_CAPTURE_LOOKS_REASONABLE"
  | "MIXED_EARLY";

export type RouteVerdict =
  | "INSUFFICIENT_PATH_DATA"
  | "STOP_STRESS_ELEVATED"
  | "LOSER_MISSED_EXCURSION_ELEVATED"
  | "TP_CAPTURE_CONSERVATIVE"
  | "CLEANER_GEOMETRY_EARLY"
  | "MIXED";

export type SliceLocalVerdict =
  | "INSUFFICIENT_PATH_DATA"
  | "EARLY_STOP_STRESS"
  | "EARLY_MISSED_FAVORABLE_EXCURSION"
  | "EARLY_CLEANER_GEOMETRY"
  | "MIXED";

export type PatchHypothesisAction =
  | "AUDIT_WIDER_TECHNICAL_INVALIDATION"
  | "AUDIT_FASTER_OR_PARTIAL_TP_CAPTURE"
  | "AUDIT_ROUTE_SPECIFIC_STOP_MODEL"
  | "AUDIT_SYMBOL_DIRECTION_SPECIFIC_GEOMETRY"
  | "NO_PATCH_YET";

export type PatchConfidence = "LOW" | "MEDIUM" | "HIGH";
export type PatchStatus = "WATCH" | "AUDIT_DEEPER" | "READY_FOR_PATCH_DISCUSSION";

// ─── Report types ─────────────────────────────────────────────────────────────

export interface BaselinePathMetrics {
  closedCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  avgWinnerMfeR: number | null;
  avgWinnerMaeR: number | null;
  avgLoserMfeR: number | null;
  avgLoserMaeR: number | null;
  avgRealizedGrossR: number | null;
}

export interface StopSurvivalProfile {
  pathSampleCount: number;
  winnerPathCount: number;
  avgWinnerMaeR: number | null;
  medianWinnerMaeR: number | null;
  pctWinnersMaeGte0_25R: number | null;
  pctWinnersMaeGte0_50R: number | null;
  pctWinnersMaeGte0_75R: number | null;
  pctWinnersMaeGte0_90R: number | null;
  verdict: StopSurvivalVerdict;
  interpretation: string;
}

export interface FavorableExcursionProfile {
  pathSampleCount: number;
  loserPathCount: number;
  avgLoserMfeR: number | null;
  medianLoserMfeR: number | null;
  pctLosersMfeGte0_25R: number | null;
  pctLosersMfeGte0_50R: number | null;
  pctLosersMfeGte0_75R: number | null;
  pctLosersMfeGte1_00R: number | null;
  verdict: FavorableExcursionVerdict;
  interpretation: string;
}

export interface CaptureEfficiencyProfile {
  pathSampleCount: number;
  winnerPathCount: number;
  avgWinnerMfeR: number | null;
  avgWinnerGrossRealizedR: number | null;
  avgWinnerNetRealizedR: number | null;
  avgWinnerMfeMinusGrossRealizedR: number | null;
  avgGrossCapturePctOfMfe: number | null;
  pctWinnersMfeAtLeast1_5xRealizedGrossR: number | null;
  pctWinnersMfeAtLeast2_0xRealizedGrossR: number | null;
  verdict: CaptureEfficiencyVerdict;
  interpretation: string;
}

export interface TechnicalStopTpRouteAssessment {
  routeLabel: string;
  entryVariant: string | null;
  exitVariant: string | null;
  closedWithPathCount: number;
  winCountWithPath: number;
  lossCountWithPath: number;
  netAvgR: number | null;
  avgWinnerMaeR: number | null;
  avgLoserMfeR: number | null;
  avgWinnerMfeR: number | null;
  avgWinnerGrossRealizedR: number | null;
  pctWinnersMaeGte0_50R: number | null;
  pctLosersMfeGte0_50R: number | null;
  captureEfficiencyHint: string;
  stopCredibilityHint: string;
  pathSampleTier: StopTpSampleTier;
  routeVerdict: RouteVerdict;
}

export interface TechnicalStopTpSliceAssessment {
  symbol: string;
  direction: string;
  routeLabel: string;
  closedWithPathCount: number;
  netAvgR: number | null;
  avgWinnerMaeR: number | null;
  avgLoserMfeR: number | null;
  avgWinnerMfeR: number | null;
  captureEfficiencyHint: string;
  stopCredibilityHint: string;
  localVerdict: SliceLocalVerdict;
}

export interface TechnicalStopTpPatchHypothesis {
  title: string;
  evidenceSummary: string;
  likelyFutureAction: PatchHypothesisAction;
  confidence: PatchConfidence;
  patchStatus: PatchStatus;
  doesNotImplementNow: true;
}

export interface TechnicalStopTpReadiness {
  advisoryEngineReady: boolean;
  readyForBehaviorInfluence: false;
  reasons: string[];
}

export interface TechnicalStopTpCredibilityReport {
  generatedAt: string;
  evidenceEra: TechnicalStopTpEvidenceEra;
  totalResolvedExperienceRecords: number;
  recordsWithRealizedPath: number;
  recordsWithoutRealizedPath: number;
  realizedPathCoveragePct: number;
  baselinePathMetrics: BaselinePathMetrics | null;
  stopSurvivalProfile: StopSurvivalProfile;
  favorableExcursionProfile: FavorableExcursionProfile;
  captureEfficiencyProfile: CaptureEfficiencyProfile;
  routeAssessments: TechnicalStopTpRouteAssessment[];
  symbolDirectionAssessments: TechnicalStopTpSliceAssessment[];
  patchHypotheses: TechnicalStopTpPatchHypothesis[];
  readiness: TechnicalStopTpReadiness;
  answerCards: Array<{ question: string; answer: string }>;
  notes: string[];
}

// ─── Internal path record ──────────────────────────────────────────────────────

interface PathRecord {
  isWin: boolean;
  isLoss: boolean;
  maeR: number;
  mfeR: number;
  realizedGrossR: number | null;
  realizedNetR: number | null;
  entryVariant: string | null;
  exitVariant: string | null;
  routeLabel: string;
  symbol: string;
  direction: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function r4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function meanNum(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return r4(xs.reduce((a, b) => a + b, 0) / xs.length);
}

function medianNum(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? r4((sorted[mid - 1]! + sorted[mid]!) / 2)
    : r4(sorted[mid]!);
}

function pctAbove(xs: number[], threshold: number): number | null {
  if (xs.length === 0) return null;
  return r4(xs.filter((v) => v >= threshold).length / xs.length);
}

function routeLabelFrom(entry: string | null | undefined, exit: string | null | undefined): string {
  return `${entry ?? "UNKNOWN_ENTRY"} + ${exit ?? "UNKNOWN_EXIT"}`;
}

function isPathAvailable(outcome: ResolvedTradeOutcomeSnapshot): boolean {
  if (outcome.realizedPathAvailable === true) return true;
  const mae = outcome.maeR ?? outcome.maxAdverseExcursionR;
  const mfe = outcome.mfeR ?? outcome.maxFavorableExcursionR;
  return (
    mae !== null && mae !== undefined && Number.isFinite(mae) &&
    mfe !== null && mfe !== undefined && Number.isFinite(mfe)
  );
}

function getMae(outcome: ResolvedTradeOutcomeSnapshot): number {
  return outcome.maeR ?? outcome.maxAdverseExcursionR ?? 0;
}

function getMfe(outcome: ResolvedTradeOutcomeSnapshot): number {
  return outcome.mfeR ?? outcome.maxFavorableExcursionR ?? 0;
}

// ─── Era filtering ────────────────────────────────────────────────────────────

function filterByEra(
  records: StrategyExperienceRecord[],
  era: TechnicalStopTpEvidenceEra,
): StrategyExperienceRecord[] {
  if (era === "ALL_TIME") return records;
  return records.filter(
    (r) => (r.context.evidenceEra ?? r.outcome.evidenceEra) === "POST_CALIBRATION",
  );
}

// ─── Build path records ───────────────────────────────────────────────────────

function buildPathRecords(records: StrategyExperienceRecord[]): PathRecord[] {
  const out: PathRecord[] = [];
  for (const r of records) {
    if (!isPathAvailable(r.outcome)) continue;
    const label = r.outcome.winnerLabel;
    const isWin = label === "WIN";
    const isLoss = label === "LOSS";
    if (!isWin && !isLoss) continue; // skip BREAKEVEN for excursion profiles
    const entry = r.context.selectedEntryVariant ?? r.outcome.selectedEntryVariant ?? null;
    const exit = r.context.selectedExitVariant ?? r.outcome.selectedExitVariant ?? null;
    out.push({
      isWin,
      isLoss,
      maeR: getMae(r.outcome),
      mfeR: getMfe(r.outcome),
      realizedGrossR: r.outcome.realizedGrossR ?? null,
      realizedNetR: r.outcome.realizedNetR ?? null,
      entryVariant: entry ? String(entry) : null,
      exitVariant: exit ? String(exit) : null,
      routeLabel: routeLabelFrom(entry ? String(entry) : null, exit ? String(exit) : null),
      symbol: r.outcome.symbol,
      direction: r.outcome.direction,
    });
  }
  return out;
}

// ─── Baseline path metrics ────────────────────────────────────────────────────

function buildBaselinePathMetrics(
  allRecords: StrategyExperienceRecord[],
  pathRecords: PathRecord[],
): BaselinePathMetrics | null {
  if (pathRecords.length === 0) return null;

  const winners = pathRecords.filter((r) => r.isWin);
  const losers = pathRecords.filter((r) => r.isLoss);
  const netRs = pathRecords.map((r) => r.realizedNetR ?? 0);
  const grossRs = pathRecords.map((r) => r.realizedGrossR ?? 0);
  const winNetRs = winners.map((r) => r.realizedNetR ?? 0);
  const lossNetRs = losers.map((r) => r.realizedNetR ?? 0);

  const totalWinR = winNetRs.reduce((a, b) => a + b, 0);
  const totalLossR = Math.abs(lossNetRs.reduce((a, b) => a + b, 0));
  const profitFactor = totalLossR === 0 ? null : r4(totalWinR / totalLossR);

  // SL rate from original records that have path
  const pathOriginals = allRecords.filter((r) => isPathAvailable(r.outcome) && r.outcome.winnerLabel !== "BREAKEVEN");
  const slCount = pathOriginals.filter(
    (r) => r.outcome.closeReason === "SL" || r.outcome.slHit === true,
  ).length;

  return {
    closedCount: pathRecords.length,
    netAvgR: meanNum(netRs),
    grossAvgR: meanNum(grossRs),
    profitFactor,
    winRate: pathRecords.length === 0 ? null : r4(winners.length / pathRecords.length),
    slRate: pathRecords.length === 0 ? null : r4(slCount / pathRecords.length),
    avgWinR: winners.length === 0 ? null : r4(totalWinR / winners.length),
    avgLossR: losers.length === 0 ? null : r4(-totalLossR / losers.length),
    avgWinnerMfeR: meanNum(winners.map((r) => r.mfeR)),
    avgWinnerMaeR: meanNum(winners.map((r) => r.maeR)),
    avgLoserMfeR: meanNum(losers.map((r) => r.mfeR)),
    avgLoserMaeR: meanNum(losers.map((r) => r.maeR)),
    avgRealizedGrossR: meanNum(grossRs),
  };
}

// ─── Stop survival profile ────────────────────────────────────────────────────

function buildStopSurvivalProfile(pathRecords: PathRecord[]): StopSurvivalProfile {
  const winners = pathRecords.filter((r) => r.isWin);
  const maeVals = winners.map((r) => r.maeR);

  const avgWinnerMaeR = meanNum(maeVals);
  const medianWinnerMaeR = medianNum(maeVals);
  const pct025 = pctAbove(maeVals, 0.25);
  const pct050 = pctAbove(maeVals, 0.50);
  const pct075 = pctAbove(maeVals, 0.75);
  const pct090 = pctAbove(maeVals, 0.90);

  let verdict: StopSurvivalVerdict;
  let interpretation: string;

  if (winners.length < 3) {
    verdict = "INSUFFICIENT_PATH_DATA";
    interpretation = `Only ${winners.length} winning records with path data. Need at least 3 to profile stop survival behavior.`;
  } else {
    const avg = avgWinnerMaeR ?? 0;
    const highStress = (pct075 ?? 0) > 0.2;
    const moderateStress = (pct050 ?? 0) > 0.25;
    if (highStress) {
      verdict = "WINNERS_REQUIRE_BREATHING_ROOM";
      interpretation =
        `${((pct075 ?? 0) * 100).toFixed(0)}% of winners survive >0.75R adverse excursion before winning. ` +
        `Average winner MAE is ${avg.toFixed(3)}R. Overly tight stops may prematurely exit trades that would have recovered. ` +
        `This is early advisory signal only — path sample is ${winners.length} winners.`;
    } else if (moderateStress) {
      verdict = "WINNERS_REQUIRE_BREATHING_ROOM";
      interpretation =
        `${((pct050 ?? 0) * 100).toFixed(0)}% of winners survive >0.50R adverse excursion before winning. ` +
        `Average winner MAE is ${avg.toFixed(3)}R. Route may need some breathing room in stop placement. ` +
        `Advisory only — ${winners.length} winners with path data.`;
    } else if (avg < 0.20) {
      verdict = "WINNERS_SHOW_LOW_ADVERSE_STRESS";
      interpretation =
        `Average winner MAE is ${avg.toFixed(3)}R, and few winners experience >0.50R drawdown before winning. ` +
        `Current stop geometry appears compatible with observed winning path behavior. ` +
        `Advisory only — ${winners.length} winners with path data.`;
    } else {
      verdict = "MIXED_EARLY";
      interpretation =
        `Average winner MAE is ${avg.toFixed(3)}R. Results are mixed — some winners absorb notable adverse excursion, ` +
        `others do not. Continue accumulating path data for clearer signal. Sample: ${winners.length} winners.`;
    }
  }

  return {
    pathSampleCount: pathRecords.length,
    winnerPathCount: winners.length,
    avgWinnerMaeR,
    medianWinnerMaeR,
    pctWinnersMaeGte0_25R: pct025,
    pctWinnersMaeGte0_50R: pct050,
    pctWinnersMaeGte0_75R: pct075,
    pctWinnersMaeGte0_90R: pct090,
    verdict,
    interpretation,
  };
}

// ─── Favorable excursion profile ──────────────────────────────────────────────

function buildFavorableExcursionProfile(pathRecords: PathRecord[]): FavorableExcursionProfile {
  const losers = pathRecords.filter((r) => r.isLoss);
  const mfeVals = losers.map((r) => r.mfeR);

  const avgLoserMfeR = meanNum(mfeVals);
  const medianLoserMfeR = medianNum(mfeVals);
  const pct025 = pctAbove(mfeVals, 0.25);
  const pct050 = pctAbove(mfeVals, 0.50);
  const pct075 = pctAbove(mfeVals, 0.75);
  const pct100 = pctAbove(mfeVals, 1.00);

  let verdict: FavorableExcursionVerdict;
  let interpretation: string;

  if (losers.length < 3) {
    verdict = "INSUFFICIENT_PATH_DATA";
    interpretation = `Only ${losers.length} losing records with path data. Need at least 3 to profile favorable excursion behavior.`;
  } else {
    const avg = avgLoserMfeR ?? 0;
    const highMissed = (pct075 ?? 0) > 0.2;
    const moderateMissed = (pct050 ?? 0) > 0.25;
    if (highMissed) {
      verdict = "LOSERS_SHOW_MISSED_FAVORABLE_EXCURSION";
      interpretation =
        `${((pct075 ?? 0) * 100).toFixed(0)}% of losing trades showed >0.75R favorable excursion before failing. ` +
        `Average loser MFE is ${avg.toFixed(3)}R. These trades go meaningfully in-direction before reversing — ` +
        `possible TP placement mismatch, exit timing issue, or route instability. ` +
        `Advisory only — ${losers.length} losers with path data.`;
    } else if (moderateMissed) {
      verdict = "LOSERS_SHOW_MISSED_FAVORABLE_EXCURSION";
      interpretation =
        `${((pct050 ?? 0) * 100).toFixed(0)}% of losing trades showed >0.50R favorable excursion before failing. ` +
        `Average loser MFE is ${avg.toFixed(3)}R. Some losing trades show nontrivial favorable moves before they reverse. ` +
        `Advisory only — ${losers.length} losers with path data.`;
    } else if (avg < 0.15) {
      verdict = "LOSERS_SHOW_LITTLE_FAVORABLE_EXCURSION";
      interpretation =
        `Average loser MFE is ${avg.toFixed(3)}R — losers show little favorable movement before failing. ` +
        `This pattern is consistent with clean directional failure rather than a TP/exit timing problem. ` +
        `Advisory only — ${losers.length} losers with path data.`;
    } else {
      verdict = "MIXED_EARLY";
      interpretation =
        `Average loser MFE is ${avg.toFixed(3)}R. Results are mixed. Some losers show favorable moves before failing, ` +
        `others do not. Continue accumulating path data. Sample: ${losers.length} losers.`;
    }
  }

  return {
    pathSampleCount: pathRecords.length,
    loserPathCount: losers.length,
    avgLoserMfeR,
    medianLoserMfeR,
    pctLosersMfeGte0_25R: pct025,
    pctLosersMfeGte0_50R: pct050,
    pctLosersMfeGte0_75R: pct075,
    pctLosersMfeGte1_00R: pct100,
    verdict,
    interpretation,
  };
}

// ─── Capture efficiency profile ───────────────────────────────────────────────

function buildCaptureEfficiencyProfile(pathRecords: PathRecord[]): CaptureEfficiencyProfile {
  const winners = pathRecords.filter((r) => r.isWin && r.realizedGrossR !== null);
  const mfeVals = winners.map((r) => r.mfeR);
  const grossVals = winners.map((r) => r.realizedGrossR ?? 0);
  const netVals = winners.map((r) => r.realizedNetR ?? 0);

  const avgWinnerMfeR = meanNum(mfeVals);
  const avgWinnerGrossRealizedR = meanNum(grossVals);
  const avgWinnerNetRealizedR = meanNum(netVals);

  const mfeMinusGross = winners.map((r) => r.mfeR - (r.realizedGrossR ?? 0));
  const avgWinnerMfeMinusGrossRealizedR = meanNum(mfeMinusGross);

  // Capture pct of MFE: grossR / mfeR per winner (where mfeR > 0)
  const captureRatios = winners
    .filter((r) => r.mfeR > 0)
    .map((r) => r.realizedGrossR !== null ? (r.realizedGrossR / r.mfeR) : null)
    .filter((v): v is number => v !== null && Number.isFinite(v) && v >= 0);
  const avgGrossCapturePctOfMfe = meanNum(captureRatios);

  // Pct of winners where MFE was ≥ 1.5× and 2.0× realized gross
  const mfe1_5 = winners.filter(
    (r) => r.realizedGrossR !== null && r.realizedGrossR > 0 && r.mfeR >= r.realizedGrossR * 1.5,
  );
  const mfe2_0 = winners.filter(
    (r) => r.realizedGrossR !== null && r.realizedGrossR > 0 && r.mfeR >= r.realizedGrossR * 2.0,
  );

  const pctMfe1_5 = winners.length > 0 ? r4(mfe1_5.length / winners.length) : null;
  const pctMfe2_0 = winners.length > 0 ? r4(mfe2_0.length / winners.length) : null;

  let verdict: CaptureEfficiencyVerdict;
  let interpretation: string;

  if (winners.length < 3) {
    verdict = "INSUFFICIENT_PATH_DATA";
    interpretation = `Only ${winners.length} winning records with path + realized R data. Need at least 3 to profile capture efficiency.`;
  } else {
    const capturePct = avgGrossCapturePctOfMfe ?? 1;
    const mfeIsWide = (pctMfe1_5 ?? 0) > 0.4;
    if (mfeIsWide && capturePct < 0.7) {
      verdict = "TP_CAPTURE_LOOKS_CONSERVATIVE";
      interpretation =
        `Average capture of MFE is ${(capturePct * 100).toFixed(0)}%. ` +
        `${((pctMfe1_5 ?? 0) * 100).toFixed(0)}% of winners had MFE at least 1.5× realized gross R — ` +
        `the market moved significantly further than current TP1 captured. ` +
        `This may indicate conservative TP placement or route-specific exit geometry that leaves favorable extension uncaptured. ` +
        `Advisory only — this is a future design signal, not a patch recommendation.`;
    } else if (capturePct >= 0.7) {
      verdict = "TP_CAPTURE_LOOKS_REASONABLE";
      interpretation =
        `Average capture of MFE is ${(capturePct * 100).toFixed(0)}%. ` +
        `Winners generally capture a reasonable share of available favorable movement. ` +
        `${((pctMfe1_5 ?? 0) * 100).toFixed(0)}% had MFE ≥ 1.5× realized gross R. ` +
        `Advisory only — ${winners.length} winners with path data.`;
    } else {
      verdict = "MIXED_EARLY";
      interpretation =
        `Average capture of MFE is ${(capturePct * 100).toFixed(0)}%. Mixed results — ` +
        `${((pctMfe1_5 ?? 0) * 100).toFixed(0)}% of winners had MFE ≥ 1.5× realized gross R. ` +
        `Continue accumulating path data. Sample: ${winners.length} winners.`;
    }
  }

  return {
    pathSampleCount: pathRecords.length,
    winnerPathCount: winners.length,
    avgWinnerMfeR,
    avgWinnerGrossRealizedR,
    avgWinnerNetRealizedR,
    avgWinnerMfeMinusGrossRealizedR,
    avgGrossCapturePctOfMfe,
    pctWinnersMfeAtLeast1_5xRealizedGrossR: pctMfe1_5,
    pctWinnersMfeAtLeast2_0xRealizedGrossR: pctMfe2_0,
    verdict,
    interpretation,
  };
}

// ─── Route-level assessments ──────────────────────────────────────────────────

function buildRouteAssessments(pathRecords: PathRecord[]): TechnicalStopTpRouteAssessment[] {
  const grouped = new Map<string, PathRecord[]>();
  for (const r of pathRecords) {
    const arr = grouped.get(r.routeLabel) ?? [];
    arr.push(r);
    grouped.set(r.routeLabel, arr);
  }

  const assessments: TechnicalStopTpRouteAssessment[] = [];
  for (const [label, recs] of grouped) {
    const wins = recs.filter((r) => r.isWin);
    const losses = recs.filter((r) => r.isLoss);
    const tier = classifySampleTier(recs.length);

    const avgWinnerMaeR = meanNum(wins.map((r) => r.maeR));
    const avgLoserMfeR = meanNum(losses.map((r) => r.mfeR));
    const avgWinnerMfeR = meanNum(wins.map((r) => r.mfeR));
    const avgWinnerGrossRealizedR = meanNum(
      wins.filter((r) => r.realizedGrossR !== null).map((r) => r.realizedGrossR!),
    );
    const netRs = recs.map((r) => r.realizedNetR ?? 0);
    const netAvgR = meanNum(netRs);

    const pctWinnersMaeGte050 = wins.length > 0
      ? pctAbove(wins.map((r) => r.maeR), 0.5)
      : null;
    const pctLosersMfeGte050 = losses.length > 0
      ? pctAbove(losses.map((r) => r.mfeR), 0.5)
      : null;

    // Hints
    const stopCredibilityHint = avgWinnerMaeR === null
      ? "n/a"
      : avgWinnerMaeR > 0.5
      ? `Winners avg MAE=${avgWinnerMaeR.toFixed(3)}R — breathing room needed`
      : `Winners avg MAE=${avgWinnerMaeR.toFixed(3)}R — low stop stress`;

    // Capture efficiency hint
    let captureEfficiencyHint = "n/a";
    if (avgWinnerMfeR !== null && avgWinnerGrossRealizedR !== null && avgWinnerGrossRealizedR > 0) {
      const ratio = avgWinnerMfeR / avgWinnerGrossRealizedR;
      captureEfficiencyHint = ratio > 1.5
        ? `MFE=${avgWinnerMfeR.toFixed(3)}R vs gross=${avgWinnerGrossRealizedR.toFixed(3)}R (MFE ${ratio.toFixed(1)}× realized — conservative TP?)`
        : `MFE=${avgWinnerMfeR.toFixed(3)}R vs gross=${avgWinnerGrossRealizedR.toFixed(3)}R (reasonable capture)`;
    }

    // Route verdict — only emit strong verdicts if EARLY or better
    let routeVerdict: RouteVerdict = "INSUFFICIENT_PATH_DATA";
    if (tier !== "EMPTY" && tier !== "TOO_EARLY") {
      const stopStress = (pctWinnersMaeGte050 ?? 0) > 0.3 && wins.length >= 3;
      const missedExcursion = (pctLosersMfeGte050 ?? 0) > 0.3 && losses.length >= 3;
      const captureGap = avgWinnerMfeR !== null && avgWinnerGrossRealizedR !== null
        && avgWinnerGrossRealizedR > 0 && avgWinnerMfeR > avgWinnerGrossRealizedR * 1.5
        && wins.length >= 3;
      if (stopStress && missedExcursion) {
        routeVerdict = "MIXED";
      } else if (stopStress) {
        routeVerdict = "STOP_STRESS_ELEVATED";
      } else if (missedExcursion) {
        routeVerdict = "LOSER_MISSED_EXCURSION_ELEVATED";
      } else if (captureGap) {
        routeVerdict = "TP_CAPTURE_CONSERVATIVE";
      } else {
        routeVerdict = "CLEANER_GEOMETRY_EARLY";
      }
    }

    const first = recs[0];
    assessments.push({
      routeLabel: label,
      entryVariant: first?.entryVariant ?? null,
      exitVariant: first?.exitVariant ?? null,
      closedWithPathCount: recs.length,
      winCountWithPath: wins.length,
      lossCountWithPath: losses.length,
      netAvgR,
      avgWinnerMaeR,
      avgLoserMfeR,
      avgWinnerMfeR,
      avgWinnerGrossRealizedR,
      pctWinnersMaeGte0_50R: pctWinnersMaeGte050,
      pctLosersMfeGte0_50R: pctLosersMfeGte050,
      captureEfficiencyHint,
      stopCredibilityHint,
      pathSampleTier: tier,
      routeVerdict,
    });
  }

  return assessments.sort((a, b) => (a.netAvgR ?? 0) - (b.netAvgR ?? 0));
}

// ─── Symbol-direction-route assessments ──────────────────────────────────────

function buildSymbolDirectionAssessments(
  pathRecords: PathRecord[],
): TechnicalStopTpSliceAssessment[] {
  const grouped = new Map<string, PathRecord[]>();
  for (const r of pathRecords) {
    const key = `${r.symbol}|${r.direction}|${r.routeLabel}`;
    const arr = grouped.get(key) ?? [];
    arr.push(r);
    grouped.set(key, arr);
  }

  const assessments: TechnicalStopTpSliceAssessment[] = [];
  for (const [, recs] of grouped) {
    if (recs.length === 0) continue;
    const wins = recs.filter((r) => r.isWin);
    const losses = recs.filter((r) => r.isLoss);
    const first = recs[0]!;

    const avgWinnerMaeR = meanNum(wins.map((r) => r.maeR));
    const avgLoserMfeR = meanNum(losses.map((r) => r.mfeR));
    const avgWinnerMfeR = meanNum(wins.map((r) => r.mfeR));
    const avgWinnerGrossR = meanNum(
      wins.filter((r) => r.realizedGrossR !== null).map((r) => r.realizedGrossR!),
    );
    const netAvgR = meanNum(recs.map((r) => r.realizedNetR ?? 0));

    const stopCredibilityHint = avgWinnerMaeR === null
      ? "n/a"
      : avgWinnerMaeR > 0.5
      ? `Avg winner MAE=${avgWinnerMaeR.toFixed(3)}R`
      : `Avg winner MAE=${avgWinnerMaeR.toFixed(3)}R (low)`;

    let captureEfficiencyHint = "n/a";
    if (avgWinnerMfeR !== null && avgWinnerGrossR !== null && avgWinnerGrossR > 0) {
      const ratio = avgWinnerMfeR / avgWinnerGrossR;
      captureEfficiencyHint = `MFE/gross ratio=${ratio.toFixed(2)}`;
    }

    // Only emit non-trivial verdicts if n >= 3
    let localVerdict: SliceLocalVerdict = "INSUFFICIENT_PATH_DATA";
    if (recs.length >= 3) {
      const highStopStress = (avgWinnerMaeR ?? 0) > 0.5 && wins.length >= 2;
      const highMissedExcursion = (avgLoserMfeR ?? 0) > 0.5 && losses.length >= 2;
      const cleanerGeometry = (avgWinnerMaeR ?? Infinity) < 0.20 && (avgLoserMfeR ?? Infinity) < 0.15;
      if (highStopStress && highMissedExcursion) {
        localVerdict = "MIXED";
      } else if (highStopStress) {
        localVerdict = "EARLY_STOP_STRESS";
      } else if (highMissedExcursion) {
        localVerdict = "EARLY_MISSED_FAVORABLE_EXCURSION";
      } else if (cleanerGeometry) {
        localVerdict = "EARLY_CLEANER_GEOMETRY";
      } else {
        localVerdict = "MIXED";
      }
    }

    assessments.push({
      symbol: first.symbol,
      direction: first.direction,
      routeLabel: first.routeLabel,
      closedWithPathCount: recs.length,
      netAvgR,
      avgWinnerMaeR,
      avgLoserMfeR,
      avgWinnerMfeR,
      captureEfficiencyHint,
      stopCredibilityHint,
      localVerdict,
    });
  }

  // Sort: concerns first (stop stress / missed excursion), then cleaner
  const concernVerdicts: SliceLocalVerdict[] = [
    "EARLY_STOP_STRESS",
    "EARLY_MISSED_FAVORABLE_EXCURSION",
    "MIXED",
  ];
  return assessments.sort((a, b) => {
    const aIsConcern = concernVerdicts.includes(a.localVerdict) ? 0 : 1;
    const bIsConcern = concernVerdicts.includes(b.localVerdict) ? 0 : 1;
    if (aIsConcern !== bIsConcern) return aIsConcern - bIsConcern;
    return b.closedWithPathCount - a.closedWithPathCount;
  });
}

// ─── Patch hypotheses ─────────────────────────────────────────────────────────

function buildPatchHypotheses(
  pathRecords: PathRecord[],
  stopProfile: StopSurvivalProfile,
  excursionProfile: FavorableExcursionProfile,
  captureProfile: CaptureEfficiencyProfile,
  routeAssessments: TechnicalStopTpRouteAssessment[],
): TechnicalStopTpPatchHypothesis[] {
  const hypotheses: TechnicalStopTpPatchHypothesis[] = [];
  const n = pathRecords.length;

  // 1. Stop stress — winners absorbing >0.5R adverse excursion
  if (stopProfile.verdict === "WINNERS_REQUIRE_BREATHING_ROOM") {
    const pct = ((stopProfile.pctWinnersMaeGte0_50R ?? 0) * 100).toFixed(0);
    hypotheses.push({
      title: "Evaluate technically-informed stop placement vs fixed bps floor",
      evidenceSummary:
        `${pct}% of winners with path data survive >0.50R adverse excursion before winning. ` +
        `Avg winner MAE=${stopProfile.avgWinnerMaeR?.toFixed(3)}R. ` +
        `This is early signal that some routes may need stop geometry informed by realized noise tolerance ` +
        `rather than a static bps floor. Sample: ${stopProfile.winnerPathCount} winners.`,
      likelyFutureAction: "AUDIT_WIDER_TECHNICAL_INVALIDATION",
      confidence: stopProfile.winnerPathCount >= 10 ? "LOW" : "LOW",
      patchStatus: "WATCH",
      doesNotImplementNow: true,
    });
  }

  // 2. Missed favorable excursion in losers
  if (excursionProfile.verdict === "LOSERS_SHOW_MISSED_FAVORABLE_EXCURSION") {
    const pct = ((excursionProfile.pctLosersMfeGte0_50R ?? 0) * 100).toFixed(0);
    hypotheses.push({
      title: "Investigate partial or earlier TP capture for routes with high loser MFE",
      evidenceSummary:
        `${pct}% of losing trades with path data showed >0.50R favorable excursion before failing. ` +
        `Avg loser MFE=${excursionProfile.avgLoserMfeR?.toFixed(3)}R. ` +
        `Possible TP placement mismatch or route instability. ` +
        `Sample: ${excursionProfile.loserPathCount} losers.`,
      likelyFutureAction: "AUDIT_FASTER_OR_PARTIAL_TP_CAPTURE",
      confidence: "LOW",
      patchStatus: "WATCH",
      doesNotImplementNow: true,
    });
  }

  // 3. TP capture conservative
  if (captureProfile.verdict === "TP_CAPTURE_LOOKS_CONSERVATIVE") {
    const capturePct = captureProfile.avgGrossCapturePctOfMfe !== null
      ? `${(captureProfile.avgGrossCapturePctOfMfe * 100).toFixed(0)}%`
      : "unknown";
    hypotheses.push({
      title: "Audit whether current TP geometry leaves systematic favorable extension uncaptured",
      evidenceSummary:
        `Average capture of available MFE is ${capturePct}. ` +
        `${((captureProfile.pctWinnersMfeAtLeast1_5xRealizedGrossR ?? 0) * 100).toFixed(0)}% of winners had MFE ≥1.5× realized gross R. ` +
        `This pattern suggests TP may be too conservative relative to available favorable path. ` +
        `Sample: ${captureProfile.winnerPathCount} winners.`,
      likelyFutureAction: "AUDIT_FASTER_OR_PARTIAL_TP_CAPTURE",
      confidence: "LOW",
      patchStatus: "WATCH",
      doesNotImplementNow: true,
    });
  }

  // 4. Route-specific geometry concerns
  const routeWithStopStress = routeAssessments.find(
    (r) => r.routeVerdict === "STOP_STRESS_ELEVATED" && r.closedWithPathCount >= 5,
  );
  if (routeWithStopStress) {
    hypotheses.push({
      title: `Evaluate route-specific stop model for ${routeWithStopStress.routeLabel}`,
      evidenceSummary:
        `Route ${routeWithStopStress.routeLabel} shows elevated stop stress: ` +
        `${((routeWithStopStress.pctWinnersMaeGte0_50R ?? 0) * 100).toFixed(0)}% of winners absorb >0.50R MAE. ` +
        `avg winner MAE=${routeWithStopStress.avgWinnerMaeR?.toFixed(3)}R. ` +
        `Path sample: ${routeWithStopStress.closedWithPathCount}.`,
      likelyFutureAction: "AUDIT_ROUTE_SPECIFIC_STOP_MODEL",
      confidence: "LOW",
      patchStatus: n >= 30 ? "AUDIT_DEEPER" : "WATCH",
      doesNotImplementNow: true,
    });
  }

  // Fallback when no specific concerns yet
  if (hypotheses.length === 0) {
    hypotheses.push({
      title: "No specific stop/TP geometry concern detected at current path sample size",
      evidenceSummary:
        `With ${n} path-available records, no individual profile (stop survival, loser excursion, TP capture) ` +
        `shows a strong enough pattern to generate a specific hypothesis. ` +
        `Continue accumulating MAE/MFE path data. Revisit at ≥30 path-available records per route.`,
      likelyFutureAction: "NO_PATCH_YET",
      confidence: "LOW",
      patchStatus: "WATCH",
      doesNotImplementNow: true,
    });
  }

  return hypotheses;
}

// ─── Readiness ────────────────────────────────────────────────────────────────

function buildReadiness(
  pathCoverage: number,
  pathCount: number,
  routeAssessments: TechnicalStopTpRouteAssessment[],
): TechnicalStopTpReadiness {
  const reasons: string[] = [];

  if (pathCoverage < 0.8) {
    reasons.push(
      `Realized path coverage is ${(pathCoverage * 100).toFixed(1)}% — must reach ≥80% before behavior influence is justifiable`,
    );
  }
  if (pathCount < 50) {
    reasons.push(
      `Only ${pathCount} path-available records — need ≥50 before route-level conclusions are stable`,
    );
  }
  const evaluableRoutes = routeAssessments.filter((r) => r.pathSampleTier === "EVALUABLE").length;
  if (evaluableRoutes === 0) {
    reasons.push(
      "No route has ≥30 path-available records — cross-route stability cannot yet be established",
    );
  }
  reasons.push("readyForBehaviorInfluence is always false — this engine is permanently advisory-only in Phase 2D.1");

  return {
    advisoryEngineReady: pathCount > 0,
    readyForBehaviorInfluence: false,
    reasons,
  };
}

// ─── Answer cards ─────────────────────────────────────────────────────────────

function buildAnswerCards(
  stopProfile: StopSurvivalProfile,
  excursionProfile: FavorableExcursionProfile,
  captureProfile: CaptureEfficiencyProfile,
  pathCount: number,
  totalRecords: number,
  coveragePct: number,
): Array<{ question: string; answer: string }> {
  const cards: Array<{ question: string; answer: string }> = [];

  // 1. Stop survival
  cards.push({
    question: "How much adverse excursion do winning trades typically survive before they win?",
    answer: stopProfile.verdict === "INSUFFICIENT_PATH_DATA"
      ? `Insufficient path data: ${stopProfile.winnerPathCount} winners with MAE/MFE tracked out of ${totalRecords} resolved records (${(coveragePct * 100).toFixed(1)}% path coverage). Accumulate more forward MAE/MFE data.`
      : stopProfile.interpretation,
  });

  // 2. Favorable excursion in losers
  cards.push({
    question: "How much favorable excursion do losing trades show before failing?",
    answer: excursionProfile.verdict === "INSUFFICIENT_PATH_DATA"
      ? `Insufficient path data: ${excursionProfile.loserPathCount} losers with MAE/MFE tracked. Accumulate more forward MAE/MFE data.`
      : excursionProfile.interpretation,
  });

  // 3. TP capture
  cards.push({
    question: "When winners win, does current TP behavior capture a reasonable share of available favorable movement?",
    answer: captureProfile.verdict === "INSUFFICIENT_PATH_DATA"
      ? `Insufficient path data: ${captureProfile.winnerPathCount} winners with both MFE and realized R available. Accumulate more forward data.`
      : captureProfile.interpretation,
  });

  // 4. Are stops likely too fragile?
  cards.push({
    question: "Are current stops likely too fragile relative to route-specific path behavior?",
    answer: pathCount < 3
      ? `Insufficient path data (${pathCount} path-available records) to assess stop fragility. Collect more forward MAE/MFE tracking.`
      : stopProfile.verdict === "WINNERS_REQUIRE_BREATHING_ROOM"
      ? `Early signal suggests stops may be fragile for some routes: ${stopProfile.interpretation} This is advisory only — no behavior change is justified at current sample size (${pathCount} path records).`
      : `No strong fragility signal detected yet. ${stopProfile.interpretation} This is advisory only.`,
  });

  // 5. What would Phase 2D.2 do?
  cards.push({
    question: "What is NOT proven yet, and what would Phase 2D.2 investigate?",
    answer:
      `Current path coverage is ${(coveragePct * 100).toFixed(1)}% (${pathCount} of ${totalRecords} resolved records). ` +
      `All current findings are advisory only. ` +
      `Phase 2D.2 would investigate: (1) route-specific technical invalidation levels derived from realized path behavior, ` +
      `(2) TP capture alternatives calibrated to route-specific MFE distributions, ` +
      `(3) a realized-path counterfactual simulator comparing fixed vs technical stop geometries. ` +
      `None of this has been implemented. No stop, TP, routing, or execution behavior changes are justified today.`,
  });

  return cards;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function buildTechnicalStopTpCredibilityReport(
  records: StrategyExperienceRecord[],
  opts: { evidenceEra?: TechnicalStopTpEvidenceEra } = {},
  now: Date = new Date(),
): TechnicalStopTpCredibilityReport {
  const evidenceEra = opts.evidenceEra ?? "POST_CALIBRATION";
  const generatedAt = now.toISOString();

  const eraRecords = filterByEra(records, evidenceEra);
  const totalResolvedExperienceRecords = eraRecords.length;
  const recordsWithRealizedPath = eraRecords.filter((r) => isPathAvailable(r.outcome)).length;
  const recordsWithoutRealizedPath = totalResolvedExperienceRecords - recordsWithRealizedPath;
  const realizedPathCoveragePct = totalResolvedExperienceRecords === 0
    ? 0
    : r4(recordsWithRealizedPath / totalResolvedExperienceRecords);

  const pathRecords = buildPathRecords(eraRecords);
  const baselinePathMetrics = buildBaselinePathMetrics(eraRecords, pathRecords);
  const stopSurvivalProfile = buildStopSurvivalProfile(pathRecords);
  const favorableExcursionProfile = buildFavorableExcursionProfile(pathRecords);
  const captureEfficiencyProfile = buildCaptureEfficiencyProfile(pathRecords);
  const routeAssessments = buildRouteAssessments(pathRecords);
  const symbolDirectionAssessments = buildSymbolDirectionAssessments(pathRecords);
  const patchHypotheses = buildPatchHypotheses(
    pathRecords,
    stopSurvivalProfile,
    favorableExcursionProfile,
    captureEfficiencyProfile,
    routeAssessments,
  );
  const readiness = buildReadiness(realizedPathCoveragePct, recordsWithRealizedPath, routeAssessments);
  const answerCards = buildAnswerCards(
    stopSurvivalProfile,
    favorableExcursionProfile,
    captureEfficiencyProfile,
    recordsWithRealizedPath,
    totalResolvedExperienceRecords,
    realizedPathCoveragePct,
  );

  return {
    generatedAt,
    evidenceEra,
    totalResolvedExperienceRecords,
    recordsWithRealizedPath,
    recordsWithoutRealizedPath,
    realizedPathCoveragePct,
    baselinePathMetrics,
    stopSurvivalProfile,
    favorableExcursionProfile,
    captureEfficiencyProfile,
    routeAssessments,
    symbolDirectionAssessments,
    patchHypotheses,
    readiness,
    answerCards,
    notes: [
      "Technical Stop/TP Credibility is read-only. It does NOT change stop placement, TP placement, routing, ranking, execution, or live readiness.",
      "MAE (Max Adverse Excursion R): max drawdown in R units from entry, tracked per position during shadow execution.",
      "MFE (Max Favorable Excursion R): max favorable move in R units from entry, tracked per position during shadow execution.",
      "Path availability: outcome.realizedPathAvailable===true OR both maeR and mfeR present and finite.",
      "Win/Loss determined by outcome.winnerLabel. BREAKEVEN records are excluded from excursion profiles.",
      "Stop survival profile: measures how much adverse excursion winning trades survive before they win.",
      "Favorable excursion profile: measures how much favorable move losing trades show before failing.",
      "Capture efficiency profile: measures what share of MFE winning trades actually realize via their TP.",
      "All patch hypotheses have patchStatus WATCH or AUDIT_DEEPER at current path coverage. readyForBehaviorInfluence is always false.",
      "Sample tier thresholds: EMPTY=0, TOO_EARLY=1-2, EARLY=3-9, WATCHABLE=10-29, EVALUABLE=30+.",
      "Phase 2D.2 (not yet built) would add route-specific technical invalidation, TP capture alternatives, and a realized-path counterfactual simulator.",
    ],
  };
}

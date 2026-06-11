import type { ShadowPosition, ShadowVariantPosition } from "@dtc/shared";
import { classifyEvidenceEra } from "@dtc/shared";

/**
 * WINNER VS LOSER SETUP DISCRIMINANT AUDIT
 *
 * Read-only diagnostic that identifies which setup features separate profitable
 * POST_CALIBRATION trades from losing ones. Directly answers the question that
 * cost attribution and entry-precision audits could not:
 *
 *   "Which conditions are present in winners but absent in losers?"
 *
 * Uses only persisted ShadowPosition fields:
 *   - variantSelection (routeMode, routeScore, routeReasonCodes, calibratedExpectedNetR,
 *     costR, stopDistanceBps, chaseRisk, entryDriftPct)
 *   - tradePlan (directionQuality, directionGap, horizonConflict, entryPlaybook)
 *   - position-level (symbol, direction, dangerScore, riskReward, marketRegime, latestStatus)
 *
 * Does NOT change:
 *   - scanner ranking or Top-10 selection
 *   - routeMode or variant selection
 *   - shadow execution logic
 *   - cost model, calibrated expectancy, route maturity
 *   - live readiness gates, symbol quarantine, or trade caps
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type WinnerLoserEraFilter = "POST_CALIBRATION" | "POST_ROUTING" | "ALL";
export type LiftOrDrag = "WINNER_SKEW" | "LOSER_SKEW" | "NEUTRAL";
export type FeatureConfidence = "LOW" | "MEDIUM" | "HIGH";
export type EffectSizeLabel = "STRONG" | "MODERATE" | "WEAK";
export type WinnerLoserMainDiagnosis =
  | "FEATURE_SEPARATION_EMERGING"
  | "NO_CLEAR_SEPARATOR_YET"
  | "LOSSES_BROAD_BASED"
  | "INSUFFICIENT_SAMPLE";
export type WinnerLoserFlagCode =
  | "SYMBOL_DIRECTION_TOXIC_SLICE"
  | "SYMBOL_DIRECTION_PROMISING_SLICE"
  | "KRONOS_ALIGNMENT_HELPFUL"
  | "KRONOS_ALIGNMENT_NOT_HELPFUL"
  | "WHALE_ALIGNMENT_HELPFUL"
  | "WHALE_ALIGNMENT_NOT_HELPFUL"
  | "HIGH_DANGER_LOSER_SKEW"
  | "LOW_CONFIDENCE_LOSER_SKEW"
  | "CALIBRATED_EDGE_STILL_OVERSTATED"
  | "ROUTE_ONLY_WORKS_IN_NARROW_CONTEXT"
  | "NO_CLEAR_WINNER_SEPARATOR_YET";
export type RouteDiagnosis =
  | "WORKS_ONLY_IN_NARROW_CONTEXT"
  | "BROADLY_WEAK"
  | "EARLY_MIXED"
  | "INSUFFICIENT_SAMPLE";
export type SliceVerdict = "PROMISING_SLICE" | "TOXIC_SLICE" | "MIXED" | "TOO_EARLY";
export type PatchSurface =
  | "ranking"
  | "routing"
  | "route_eligibility"
  | "symbol_route_preference"
  | "direction_gating"
  | "no_patch_yet";
export type PatchReadiness = "WATCH" | "AUDIT_DEEPER" | "READY_FOR_PATCH_DISCUSSION";
export type FlagSeverity = "INFO" | "WARN" | "CRITICAL";

export interface FeatureComparison {
  featureName: string;
  description: string;
  winnerValue: string;
  loserValue: string;
  delta: string;
  liftOrDrag: LiftOrDrag;
  confidence: FeatureConfidence;
  effectSizeLabel: EffectSizeLabel;
  supportCount: number;
  note: string;
  booleanCondition?: {
    trueIsWinnerFavorable: boolean;
    winnerTrueRate: number;
    loserTrueRate: number;
  };
}

export interface SeparatingSignal {
  feature: string;
  observedPattern: string;
  effectSizeLabel: EffectSizeLabel;
  supportCount: number;
  evidenceNote: string;
}

export interface WinnerLoserSummary {
  eraFilter: WinnerLoserEraFilter;
  closedCount: number;
  winnerCount: number;
  loserCount: number;
  breakevenCount: number;
  netAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  mainDiagnosis: WinnerLoserMainDiagnosis;
}

export interface LeadingRouteAudit {
  routeLabel: string;
  closedCount: number;
  winnerCount: number;
  loserCount: number;
  netAvgR: number | null;
  profitFactor: number | null;
  topWinnerSignalsWithinRoute: SeparatingSignal[];
  topLoserSignalsWithinRoute: SeparatingSignal[];
  routeDiagnosis: RouteDiagnosis;
  routeDiagnosisNote: string;
}

export interface ContextSlice {
  symbol: string;
  direction: string;
  routeLabel: string;
  closedCount: number;
  netAvgR: number | null;
  profitFactor: number | null;
  winRate: number | null;
  profitableTp1Rate: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  verdict: SliceVerdict;
}

export interface PatchHypothesis {
  title: string;
  observedEvidence: string;
  likelyPatchSurface: PatchSurface;
  confidence: FeatureConfidence;
  recommendation: PatchReadiness;
}

export interface WinnerLoserFlag {
  code: WinnerLoserFlagCode;
  severity: FlagSeverity;
  message: string;
}

export interface WinnerLoserAuditReport {
  generatedAt: string;
  eraFilter: WinnerLoserEraFilter;
  summary: WinnerLoserSummary;
  featureComparisons: FeatureComparison[];
  topWinnerSignals: SeparatingSignal[];
  topLoserSignals: SeparatingSignal[];
  leadingRouteAudit: LeadingRouteAudit;
  contextSlices: ContextSlice[];
  patchHypotheses: PatchHypothesis[];
  flags: WinnerLoserFlag[];
  answerCards: Array<{ question: string; answer: string }>;
  notes: string[];
}

export interface WinnerLoserAuditInput {
  positions: ShadowPosition[];
  eraFilter?: WinnerLoserEraFilter;
  routeFilter?: { entryVariant?: string; exitVariant?: string };
}

// ─── Internal record ──────────────────────────────────────────────────────────

interface ClosedRecord {
  // Outcome
  netR: number;
  grossR: number;
  tp1Hit: boolean;
  closeReason: string;
  isWinner: boolean;
  isLoser: boolean;
  isBreakeven: boolean;

  // Position-level
  symbol: string;
  direction: string;
  signalFamily: string;
  latestStatus: string;
  dangerScore: number;
  riskReward: number | null;
  entryVariant: string;
  exitVariant: string;
  routeLabel: string;
  marketRegime: string;

  // variantSelection
  routeMode: string;
  routeScore: number | null;
  calibratedExpectedNetR: number | null;
  rawExpectedNetR: number | null;
  calibrationVerdict: string;
  costR: number | null;
  stopDistanceBps: number | null;
  chaseRisk: string;
  entryDriftPct: number | null;
  kronosAligned: boolean | null;    // KRONOS_AGREES in routeReasonCodes
  whaleAligned: boolean | null;     // WHALE_AGREES in routeReasonCodes

  // tradePlan
  directionQuality: string;
  directionGap: number;
  horizonConflict: boolean;
  entryPlaybook: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function r4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function meanNum(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return r4(xs.reduce((a, b) => a + b, 0) / xs.length);
}

function closedVariants(p: ShadowPosition): ShadowVariantPosition[] {
  return p.variants.filter((v) => v.state === "CLOSED" && v.closeReason !== "NO_FILL");
}

function eraInFilter(p: ShadowPosition, filter: WinnerLoserEraFilter): boolean {
  if (filter === "ALL") return true;
  const era = classifyEvidenceEra(p);
  if (filter === "POST_CALIBRATION") return era === "POST_CALIBRATION";
  return era === "POST_ROUTING_PRE_CALIBRATION" || era === "POST_CALIBRATION";
}

function inferKronosAligned(routeReasonCodes: string[] | null | undefined): boolean | null {
  if (!routeReasonCodes || routeReasonCodes.length === 0) return null;
  const agrees = routeReasonCodes.includes("KRONOS_AGREES");
  const disagrees = routeReasonCodes.includes("KRONOS_DISAGREES");
  if (agrees) return true;
  if (disagrees) return false;
  return null;
}

function inferWhaleAligned(routeReasonCodes: string[] | null | undefined): boolean | null {
  if (!routeReasonCodes || routeReasonCodes.length === 0) return null;
  const agrees = routeReasonCodes.includes("WHALE_AGREES");
  const disagrees = routeReasonCodes.includes("WHALE_DISAGREES");
  if (agrees) return true;
  if (disagrees) return false;
  return null;
}

function flattenClosed(positions: ShadowPosition[], eraFilter: WinnerLoserEraFilter): ClosedRecord[] {
  const out: ClosedRecord[] = [];
  for (const p of positions) {
    if (!eraInFilter(p, eraFilter)) continue;
    const cvs = closedVariants(p);
    if (cvs.length === 0) continue;

    const sel = p.variantSelection;
    const plan = p.tradePlan;
    const entry = sel?.selectedEntryVariant ?? p.selectedEntryVariant ?? "unknown";
    const exit = sel?.selectedExitVariant ?? p.selectedExitVariant ?? "unknown";
    const routeReasonCodes = sel?.routeReasonCodes as string[] | undefined;

    for (const v of cvs) {
      out.push({
        netR: v.realizedNetR,
        grossR: v.realizedGrossR,
        tp1Hit: v.tp1Hit,
        closeReason: v.closeReason ?? "UNKNOWN",
        isWinner: v.realizedNetR > 0,
        isLoser: v.realizedNetR < 0,
        isBreakeven: v.realizedNetR === 0,
        symbol: p.symbol,
        direction: p.direction,
        signalFamily: p.signalFamily,
        latestStatus: p.latestStatus,
        dangerScore: p.dangerScore,
        riskReward: p.riskReward,
        entryVariant: entry,
        exitVariant: exit,
        routeLabel: `${entry} + ${exit}`,
        marketRegime: p.marketRegime ?? "UNKNOWN",
        routeMode: sel?.routeMode ?? "UNKNOWN",
        routeScore: sel?.routeScore ?? null,
        calibratedExpectedNetR: sel?.calibratedExpectedNetR ?? null,
        rawExpectedNetR: sel?.rawExpectedNetR ?? null,
        calibrationVerdict: sel?.calibrationVerdict ?? "UNKNOWN",
        costR: p.costR ?? sel?.costR ?? null,
        stopDistanceBps: p.stopDistanceBps ?? sel?.stopDistanceBps ?? null,
        chaseRisk: sel?.chaseRisk ?? "UNKNOWN",
        entryDriftPct: sel?.entryDriftPct !== null && sel?.entryDriftPct !== undefined
          ? Math.abs(sel.entryDriftPct)
          : null,
        kronosAligned: inferKronosAligned(routeReasonCodes),
        whaleAligned: inferWhaleAligned(routeReasonCodes),
        directionQuality: plan?.directionQuality ?? "UNKNOWN",
        directionGap: plan?.directionGap ?? 0,
        horizonConflict: plan?.horizonConflict ?? false,
        entryPlaybook: plan?.entryPlaybook ?? "UNKNOWN",
      });
    }
  }
  return out;
}

// ─── Group stats ──────────────────────────────────────────────────────────────

interface BasicStats {
  closedCount: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  totalNetR: number;
  profitFactor: number | null;
  winRate: number | null;
  tp1Rate: number | null;
  profitableTp1Rate: number | null;
  slRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
}

function computeStats(records: ClosedRecord[]): BasicStats {
  if (records.length === 0) {
    return {
      closedCount: 0, netAvgR: null, grossAvgR: null, totalNetR: 0, profitFactor: null,
      winRate: null, tp1Rate: null, profitableTp1Rate: null, slRate: null,
      avgWinR: null, avgLossR: null,
    };
  }
  const n = records.length;
  const winners = records.filter((r) => r.netR > 0);
  const losers = records.filter((r) => r.netR < 0);
  const grossWin = winners.reduce((s, r) => s + r.netR, 0);
  const grossLoss = Math.abs(losers.reduce((s, r) => s + r.netR, 0));
  const totalNetR = records.reduce((s, r) => s + r.netR, 0);
  const totalGrossR = records.reduce((s, r) => s + r.grossR, 0);
  const tp1Hits = records.filter((r) => r.tp1Hit);
  const profitableTp1 = tp1Hits.filter((r) => r.netR > 0);
  const slCount = records.filter((r) => r.closeReason === "SL" || r.closeReason === "BREAKEVEN").length;
  return {
    closedCount: n,
    netAvgR: r4(totalNetR / n),
    grossAvgR: r4(totalGrossR / n),
    totalNetR: r4(totalNetR),
    profitFactor: grossLoss === 0 ? null : r4(grossWin / grossLoss),
    winRate: r4(winners.length / n),
    tp1Rate: r4(tp1Hits.length / n),
    profitableTp1Rate: tp1Hits.length === 0 ? null : r4(profitableTp1.length / tp1Hits.length),
    slRate: r4(slCount / n),
    avgWinR: winners.length === 0 ? null : r4(grossWin / winners.length),
    avgLossR: losers.length === 0 ? null : r4(-grossLoss / losers.length),
  };
}

// ─── Feature comparison builders ──────────────────────────────────────────────

function effectLabel(normalizedEffect: number): EffectSizeLabel {
  if (normalizedEffect > 0.35) return "STRONG";
  if (normalizedEffect > 0.12) return "MODERATE";
  return "WEAK";
}

function confidenceLevel(n: number): FeatureConfidence {
  if (n >= 10) return "HIGH";
  if (n >= 5) return "MEDIUM";
  return "LOW";
}

/** Compare a numeric feature: winner avg vs loser avg. */
function numericComparison(
  featureName: string,
  description: string,
  winners: ClosedRecord[],
  losers: ClosedRecord[],
  extractor: (r: ClosedRecord) => number | null,
  higherIsBetter: boolean,
  formatFn: (v: number) => string = (v) => v.toFixed(3),
): FeatureComparison | null {
  const wVals = winners.map(extractor).filter((v): v is number => v !== null);
  const lVals = losers.map(extractor).filter((v): v is number => v !== null);
  if (wVals.length < 2 || lVals.length < 2) return null;

  const wAvg = meanNum(wVals)!;
  const lAvg = meanNum(lVals)!;
  const delta = r4(wAvg - lAvg);
  const allVals = [...wVals, ...lVals];
  const range = Math.max(...allVals) - Math.min(...allVals);
  const normalizedEffect = range > 0.001 ? Math.abs(delta) / range : 0;
  const minSupport = Math.min(wVals.length, lVals.length);

  // liftOrDrag: WINNER_SKEW means winners have higher value (and higher is better)
  let liftOrDrag: LiftOrDrag = "NEUTRAL";
  if (Math.abs(delta) > range * 0.05 + 0.001) {
    if ((delta > 0 && higherIsBetter) || (delta < 0 && !higherIsBetter)) {
      liftOrDrag = "WINNER_SKEW";
    } else {
      liftOrDrag = "LOSER_SKEW";
    }
  }

  return {
    featureName,
    description,
    winnerValue: formatFn(wAvg),
    loserValue: formatFn(lAvg),
    delta: (delta >= 0 ? "+" : "") + formatFn(delta),
    liftOrDrag,
    confidence: confidenceLevel(minSupport),
    effectSizeLabel: effectLabel(normalizedEffect),
    supportCount: minSupport,
    note: `Winners ${formatFn(wAvg)} vs losers ${formatFn(lAvg)} (n=${wVals.length}W/${lVals.length}L)`,
  };
}

/** Compare a boolean feature: winner rate vs loser rate. */
function boolComparison(
  featureName: string,
  description: string,
  winners: ClosedRecord[],
  losers: ClosedRecord[],
  isTrue: (r: ClosedRecord) => boolean,
  hasData: (r: ClosedRecord) => boolean = () => true,
  trueIsWinnerFavorable: boolean = true,
): FeatureComparison | null {
  const wWith = winners.filter(hasData);
  const lWith = losers.filter(hasData);
  if (wWith.length < 2 || lWith.length < 2) return null;

  const wRate = r4(wWith.filter(isTrue).length / wWith.length);
  const lRate = r4(lWith.filter(isTrue).length / lWith.length);
  const delta = r4(wRate - lRate);
  const normalizedEffect = Math.abs(delta); // rates are 0-1, delta is already normalized
  const minSupport = Math.min(wWith.length, lWith.length);

  let liftOrDrag: LiftOrDrag = "NEUTRAL";
  if (Math.abs(delta) > 0.1) {
    if ((delta > 0 && trueIsWinnerFavorable) || (delta < 0 && !trueIsWinnerFavorable)) {
      liftOrDrag = "WINNER_SKEW";
    } else {
      liftOrDrag = "LOSER_SKEW";
    }
  }

  const fmtPct = (v: number) => `${(v * 100).toFixed(0)}%`;
  return {
    featureName,
    description,
    winnerValue: fmtPct(wRate),
    loserValue: fmtPct(lRate),
    delta: (delta >= 0 ? "+" : "") + fmtPct(delta),
    liftOrDrag,
    confidence: confidenceLevel(minSupport),
    effectSizeLabel: effectLabel(normalizedEffect),
    supportCount: minSupport,
    note: `Winner rate ${fmtPct(wRate)}, loser rate ${fmtPct(lRate)} (n=${wWith.length}W/${lWith.length}L)`,
    booleanCondition: {
      trueIsWinnerFavorable,
      winnerTrueRate: wRate,
      loserTrueRate: lRate,
    },
  };
}

/** Compare a categorical feature: find the most skewed category. */
function categoricalComparison(
  featureName: string,
  description: string,
  winners: ClosedRecord[],
  losers: ClosedRecord[],
  extractor: (r: ClosedRecord) => string,
): FeatureComparison | null {
  if (winners.length < 2 || losers.length < 2) return null;

  // Count each category in winners and losers
  const wCounts = new Map<string, number>();
  const lCounts = new Map<string, number>();
  for (const r of winners) {
    const v = extractor(r);
    wCounts.set(v, (wCounts.get(v) ?? 0) + 1);
  }
  for (const r of losers) {
    const v = extractor(r);
    lCounts.set(v, (lCounts.get(v) ?? 0) + 1);
  }

  // Find the category with highest winner-skew or loser-skew
  const allCats = new Set([...wCounts.keys(), ...lCounts.keys()]);
  let bestCat = "";
  let bestDelta = 0;
  let liftOrDrag: LiftOrDrag = "NEUTRAL";

  for (const cat of allCats) {
    const wRate = (wCounts.get(cat) ?? 0) / winners.length;
    const lRate = (lCounts.get(cat) ?? 0) / losers.length;
    const delta = wRate - lRate;
    if (Math.abs(delta) > Math.abs(bestDelta)) {
      bestDelta = delta;
      bestCat = cat;
      liftOrDrag = delta > 0.1 ? "WINNER_SKEW" : delta < -0.1 ? "LOSER_SKEW" : "NEUTRAL";
    }
  }

  if (!bestCat || Math.abs(bestDelta) < 0.05) return null;

  const wRate = r4((wCounts.get(bestCat) ?? 0) / winners.length);
  const lRate = r4((lCounts.get(bestCat) ?? 0) / losers.length);
  const minSupport = Math.min(winners.length, losers.length);

  return {
    featureName,
    description,
    winnerValue: `"${bestCat}" ${(wRate * 100).toFixed(0)}%`,
    loserValue: `"${bestCat}" ${(lRate * 100).toFixed(0)}%`,
    delta: (bestDelta >= 0 ? "+" : "") + `${(bestDelta * 100).toFixed(0)}pp`,
    liftOrDrag,
    confidence: confidenceLevel(minSupport),
    effectSizeLabel: effectLabel(Math.abs(bestDelta)),
    supportCount: minSupport,
    note: `"${bestCat}": winners ${(wRate * 100).toFixed(0)}%, losers ${(lRate * 100).toFixed(0)}%`,
  };
}

function buildFeatureComparisons(
  winners: ClosedRecord[],
  losers: ClosedRecord[],
): FeatureComparison[] {
  const comparisons: Array<FeatureComparison | null> = [
    // Numeric: lower danger is better for winners
    numericComparison("dangerScore", "Danger score at selection", winners, losers,
      (r) => r.dangerScore, false, (v) => v.toFixed(1)),

    // Numeric: higher R:R is better
    numericComparison("riskReward", "Risk/reward ratio (TP1)", winners, losers,
      (r) => r.riskReward, true, (v) => v.toFixed(2)),

    // Numeric: wider stop gives more room → neutral / context-dependent; compare anyway
    numericComparison("stopDistanceBps", "Stop distance (bps)", winners, losers,
      (r) => r.stopDistanceBps, true, (v) => v.toFixed(0)),

    // Numeric: higher calibrated expectancy → winner skew expected
    numericComparison("calibratedExpectedNetR", "Calibrated expected net R", winners, losers,
      (r) => r.calibratedExpectedNetR, true, (v) => v.toFixed(4)),

    // Numeric: lower entry drift is better
    numericComparison("entryDriftPct", "Entry drift (% of zone)", winners, losers,
      (r) => r.entryDriftPct !== null ? r.entryDriftPct * 100 : null, false,
      (v) => `${v.toFixed(1)}%`),

    // Numeric: higher direction gap means clearer direction signal
    numericComparison("directionGap", "Direction gap (confidence spread)", winners, losers,
      (r) => r.directionGap, true, (v) => v.toFixed(3)),

    // Numeric: route score
    numericComparison("routeScore", "Route planner score", winners, losers,
      (r) => r.routeScore, true, (v) => v.toFixed(3)),

    // Boolean: Kronos alignment
    boolComparison("kronosAligned", "Kronos agrees with direction",
      winners, losers,
      (r) => r.kronosAligned === true,
      (r) => r.kronosAligned !== null,
      true),

    // Boolean: Whale alignment
    boolComparison("whaleAligned", "Whale flow agrees with direction",
      winners, losers,
      (r) => r.whaleAligned === true,
      (r) => r.whaleAligned !== null,
      true),

    // Boolean: Horizon conflict (presence is bad)
    boolComparison("horizonConflict", "Kronos horizon conflict present",
      winners, losers,
      (r) => r.horizonConflict,
      () => true,
      false), // horizon conflict should be lower in winners

    // Boolean: HIGH chase risk (presence is bad)
    boolComparison("highChaseRisk", "HIGH chase risk at entry",
      winners, losers,
      (r) => r.chaseRisk === "HIGH",
      () => true,
      false),

    // Boolean: direction quality CLEAR
    boolComparison("directionClear", "Direction quality: CLEAR",
      winners, losers,
      (r) => r.directionQuality === "CLEAR",
      () => true,
      true),

    // Categorical: symbol dominance
    categoricalComparison("symbol", "Dominant symbol", winners, losers, (r) => r.symbol),

    // Categorical: direction
    categoricalComparison("direction", "Trade direction", winners, losers, (r) => r.direction),

    // Categorical: market regime
    categoricalComparison("marketRegime", "Market regime at entry", winners, losers,
      (r) => r.marketRegime !== "UNKNOWN" ? r.marketRegime : "UNKNOWN"),

    // Categorical: entry playbook
    categoricalComparison("entryPlaybook", "Entry playbook used", winners, losers,
      (r) => r.entryPlaybook),

    // Categorical: latestStatus at selection
    categoricalComparison("latestStatus", "Signal status at entry", winners, losers,
      (r) => r.latestStatus),

    // Categorical: routeMode
    categoricalComparison("routeMode", "Route execution mode", winners, losers,
      (r) => r.routeMode),

    // Boolean: calibration says negative verdict → losers should have more of this
    boolComparison("calibrationNegativeVerdict", "Calibration verdict NEGATIVE/NOT_VALIDATED",
      winners, losers,
      (r) => r.calibrationVerdict === "CALIBRATED_NEGATIVE" || r.calibrationVerdict === "RAW_EDGE_NOT_VALIDATED",
      (r) => r.calibrationVerdict !== "UNKNOWN",
      false), // negative calibration should be loser-skewed
  ];

  return comparisons.filter((c): c is FeatureComparison => c !== null);
}

function extractSeparatingSignals(
  comparisons: FeatureComparison[],
  side: "WINNER_SKEW" | "LOSER_SKEW",
): SeparatingSignal[] {
  return comparisons
    .filter((c) => c.liftOrDrag === side && c.effectSizeLabel !== "WEAK")
    .sort((a, b) => {
      const order = { STRONG: 2, MODERATE: 1, WEAK: 0 };
      const confOrder = { HIGH: 2, MEDIUM: 1, LOW: 0 };
      const ea = order[a.effectSizeLabel], eb = order[b.effectSizeLabel];
      if (ea !== eb) return eb - ea;
      return confOrder[b.confidence] - confOrder[a.confidence];
    })
    .slice(0, 5)
    .map((c) => ({
      feature: c.booleanCondition
        ? `${c.featureName}=${c.booleanCondition.trueIsWinnerFavorable ? "true" : "false"}`
        : c.featureName,
      observedPattern:
        c.booleanCondition
          ? (() => {
              const winnerRate = c.booleanCondition.trueIsWinnerFavorable
                ? c.booleanCondition.winnerTrueRate
                : 1 - c.booleanCondition.winnerTrueRate;
              const loserRate = c.booleanCondition.trueIsWinnerFavorable
                ? c.booleanCondition.loserTrueRate
                : 1 - c.booleanCondition.loserTrueRate;
              const fmtPct = (v: number) => `${(v * 100).toFixed(0)}%`;
              return side === "WINNER_SKEW"
                ? `Winners: ${fmtPct(winnerRate)} vs losers: ${fmtPct(loserRate)}`
                : `Losers: ${fmtPct(loserRate)} vs winners: ${fmtPct(winnerRate)}`;
            })()
          : side === "WINNER_SKEW"
            ? `Winners: ${c.winnerValue} vs losers: ${c.loserValue}`
            : `Losers: ${c.loserValue} vs winners: ${c.winnerValue}`,
      effectSizeLabel: c.effectSizeLabel,
      supportCount: c.supportCount,
      evidenceNote: c.note,
    }));
}

// ─── Leading route audit ──────────────────────────────────────────────────────

const LEADING_ROUTE_ENTRY = "vwap_retest_entry";
const LEADING_ROUTE_EXIT = "tp1_full_exit";

function buildLeadingRouteAudit(all: ClosedRecord[]): LeadingRouteAudit {
  const routeRecords = all.filter(
    (r) => r.entryVariant === LEADING_ROUTE_ENTRY && r.exitVariant === LEADING_ROUTE_EXIT,
  );
  const routeWinners = routeRecords.filter((r) => r.isWinner);
  const routeLosers = routeRecords.filter((r) => r.isLoser);
  const stats = computeStats(routeRecords);

  let routeDiagnosis: RouteDiagnosis;
  let routeDiagnosisNote: string;

  if (routeRecords.length < 5) {
    routeDiagnosis = "INSUFFICIENT_SAMPLE";
    routeDiagnosisNote = `Only ${routeRecords.length} closes for this route — too early to judge conditions.`;
  } else if (routeWinners.length === 0) {
    routeDiagnosis = "BROADLY_WEAK";
    routeDiagnosisNote = `vwap_retest + tp1_full_exit has 0 winners from ${routeRecords.length} closes. No winning condition detected in data.`;
  } else {
    // Check how concentrated winners are by symbol
    const winnerSymbols = new Set(routeWinners.map((r) => r.symbol));
    const loserSymbols = new Set(routeLosers.map((r) => r.symbol));
    const mixedSymbols = [...winnerSymbols].filter((s) => loserSymbols.has(s));

    if (winnerSymbols.size <= 2 && routeWinners.length < routeLosers.length) {
      routeDiagnosis = "WORKS_ONLY_IN_NARROW_CONTEXT";
      routeDiagnosisNote =
        `This route wins only on ${[...winnerSymbols].join(", ")} (${routeWinners.length} winners) ` +
        `while losing on ${routeLosers.length} trades across ${[...loserSymbols].join(", ")}. ` +
        `Evidence suggests edge is symbol-specific or condition-narrow.`;
    } else if (mixedSymbols.length > 0) {
      routeDiagnosis = "EARLY_MIXED";
      routeDiagnosisNote =
        `Route wins and loses on the same symbols (${mixedSymbols.join(", ")}), ` +
        `suggesting setup conditions within a symbol drive outcomes more than the symbol itself.`;
    } else {
      routeDiagnosis = "BROADLY_WEAK";
      routeDiagnosisNote =
        `Route underperforms broadly. Net avg R ${stats.netAvgR?.toFixed(4) ?? "n/a"}, ` +
        `win rate ${((stats.winRate ?? 0) * 100).toFixed(0)}% from ${routeRecords.length} closes.`;
    }
  }

  // Compute feature comparisons within this route
  const innerComparisons = buildFeatureComparisons(routeWinners, routeLosers);
  const topWinner = extractSeparatingSignals(innerComparisons, "WINNER_SKEW");
  const topLoser = extractSeparatingSignals(innerComparisons, "LOSER_SKEW");

  return {
    routeLabel: `${LEADING_ROUTE_ENTRY} + ${LEADING_ROUTE_EXIT}`,
    closedCount: routeRecords.length,
    winnerCount: routeWinners.length,
    loserCount: routeLosers.length,
    netAvgR: stats.netAvgR,
    profitFactor: stats.profitFactor,
    topWinnerSignalsWithinRoute: topWinner,
    topLoserSignalsWithinRoute: topLoser,
    routeDiagnosis,
    routeDiagnosisNote,
  };
}

// ─── Context slices ───────────────────────────────────────────────────────────

function sliceVerdict(stats: BasicStats): SliceVerdict {
  if (stats.closedCount < 3) return "TOO_EARLY";
  if ((stats.netAvgR ?? 0) > 0.1 && (stats.winRate ?? 0) > 0.5) return "PROMISING_SLICE";
  if ((stats.netAvgR ?? 0) < -0.3 && (stats.slRate ?? 0) > 0.5) return "TOXIC_SLICE";
  return "MIXED";
}

function buildContextSlices(records: ClosedRecord[]): ContextSlice[] {
  const grouped = new Map<string, ClosedRecord[]>();
  for (const r of records) {
    const key = `${r.symbol}||${r.direction}||${r.routeLabel}`;
    const arr = grouped.get(key) ?? [];
    arr.push(r);
    grouped.set(key, arr);
  }

  const slices: ContextSlice[] = [];
  for (const [key, recs] of grouped) {
    const [symbol, direction, routeLabel] = key.split("||") as [string, string, string];
    const stats = computeStats(recs);
    slices.push({
      symbol,
      direction,
      routeLabel,
      closedCount: stats.closedCount,
      netAvgR: stats.netAvgR,
      profitFactor: stats.profitFactor,
      winRate: stats.winRate,
      profitableTp1Rate: stats.profitableTp1Rate,
      slRate: stats.slRate,
      avgWinR: stats.avgWinR,
      avgLossR: stats.avgLossR,
      verdict: sliceVerdict(stats),
    });
  }

  // Sort: TOXIC first (worst net R), then PROMISING last (best net R)
  return slices.sort((a, b) => {
    const aNet = a.netAvgR ?? 0;
    const bNet = b.netAvgR ?? 0;
    return aNet - bNet;
  });
}

// ─── Patch hypotheses ─────────────────────────────────────────────────────────

function buildPatchHypotheses(
  records: ClosedRecord[],
  comparisons: FeatureComparison[],
  slices: ContextSlice[],
  leadingRoute: LeadingRouteAudit,
): PatchHypothesis[] {
  const hypotheses: PatchHypothesis[] = [];

  // 1. Symbol-direction toxic slices
  const toxicSlices = slices.filter((s) => s.verdict === "TOXIC_SLICE" && s.closedCount >= 5);
  if (toxicSlices.length > 0) {
    hypotheses.push({
      title: `Exclude or deprioritize toxic symbol-direction combinations`,
      observedEvidence:
        `${toxicSlices.length} symbol-direction-route slice(s) identified as TOXIC (≥5 closes, ` +
        `netAvgR < -0.3R, SL rate > 50%): ` +
        toxicSlices
          .slice(0, 3)
          .map((s) => `${s.symbol}/${s.direction} (${s.netAvgR?.toFixed(4)}R, ${s.closedCount} closes)`)
          .join("; "),
      likelyPatchSurface: "symbol_route_preference",
      confidence: toxicSlices.some((s) => s.closedCount >= 10) ? "MEDIUM" : "LOW",
      recommendation: toxicSlices.some((s) => s.closedCount >= 10) ? "AUDIT_DEEPER" : "WATCH",
    });
  }

  // 2. Kronos alignment is a separator
  const kronosFeat = comparisons.find((c) => c.featureName === "kronosAligned");
  if (kronosFeat && kronosFeat.liftOrDrag === "WINNER_SKEW" && kronosFeat.effectSizeLabel !== "WEAK") {
    hypotheses.push({
      title: "Gate entries on Kronos alignment",
      observedEvidence:
        `Kronos-aligned trades have a higher winner rate vs non-aligned. ` +
        `Winner-side alignment rate: ${kronosFeat.winnerValue}, loser-side: ${kronosFeat.loserValue} (Δ${kronosFeat.delta}).`,
      likelyPatchSurface: "route_eligibility",
      confidence: kronosFeat.confidence,
      recommendation: kronosFeat.confidence === "HIGH" ? "AUDIT_DEEPER" : "WATCH",
    });
  }

  // 3. Horizon conflict is a separator
  const horizonFeat = comparisons.find((c) => c.featureName === "horizonConflict");
  if (horizonFeat && horizonFeat.liftOrDrag === "WINNER_SKEW" && horizonFeat.effectSizeLabel !== "WEAK") {
    // WINNER_SKEW on horizonConflict means winners have LOWER conflict rate (we set trueIsWinnerFavorable=false)
    hypotheses.push({
      title: "Block entries when Kronos horizon conflict is active",
      observedEvidence:
        `Horizon conflict present less often in winners. ` +
        `Winner horizon-conflict rate: ${kronosFeat?.winnerValue ?? "n/a"}, loser rate: ${kronosFeat?.loserValue ?? "n/a"} (Δ${horizonFeat.delta}).`,
      likelyPatchSurface: "route_eligibility",
      confidence: horizonFeat.confidence,
      recommendation: "WATCH",
    });
  }

  // 4. Danger score skew
  const dangerFeat = comparisons.find((c) => c.featureName === "dangerScore");
  if (dangerFeat && dangerFeat.liftOrDrag === "WINNER_SKEW" && dangerFeat.effectSizeLabel !== "WEAK") {
    hypotheses.push({
      title: "Add a danger-score cap for route eligibility",
      observedEvidence:
        `Losers have higher average danger scores than winners. ` +
        `Winner avg: ${dangerFeat.winnerValue}, loser avg: ${dangerFeat.loserValue} (Δ${dangerFeat.delta}).`,
      likelyPatchSurface: "route_eligibility",
      confidence: dangerFeat.confidence,
      recommendation: dangerFeat.confidence === "HIGH" ? "AUDIT_DEEPER" : "WATCH",
    });
  }

  // 5. Route works only in narrow context
  if (
    leadingRoute.routeDiagnosis === "WORKS_ONLY_IN_NARROW_CONTEXT" &&
    leadingRoute.closedCount >= 5
  ) {
    const winnerSymbols = records
      .filter((r) => r.isWinner && r.entryVariant === LEADING_ROUTE_ENTRY)
      .map((r) => r.symbol);
    const uniqueWinnerSymbols = [...new Set(winnerSymbols)];
    hypotheses.push({
      title: `Restrict vwap_retest route to symbols where it has shown positive edge`,
      observedEvidence:
        `The leading route wins only on ${uniqueWinnerSymbols.join(", ")} ` +
        `(${leadingRoute.winnerCount} winners) but loses on ${leadingRoute.loserCount} trades across other symbols. ` +
        `A symbol-specific routing eligibility filter appears warranted once sample is sufficient.`,
      likelyPatchSurface: "symbol_route_preference",
      confidence: leadingRoute.closedCount >= 15 ? "MEDIUM" : "LOW",
      recommendation: leadingRoute.closedCount >= 15 ? "AUDIT_DEEPER" : "WATCH",
    });
  }

  // 6. No clear separator → general observation
  if (hypotheses.length === 0) {
    const n = records.length;
    hypotheses.push({
      title: "No actionable patch candidate yet — continue data collection",
      observedEvidence:
        `With ${n} closed trades in the current era, no feature shows consistently strong separation ` +
        `between winners and losers. The best current approach is to continue collecting data ` +
        `and re-run this audit at ≥30 closes per major symbol-route combination.`,
      likelyPatchSurface: "no_patch_yet",
      confidence: "LOW",
      recommendation: "WATCH",
    });
  }

  return hypotheses;
}

// ─── Flags ────────────────────────────────────────────────────────────────────

function buildFlags(
  summary: WinnerLoserSummary,
  comparisons: FeatureComparison[],
  slices: ContextSlice[],
  leadingRoute: LeadingRouteAudit,
): WinnerLoserFlag[] {
  const flags: WinnerLoserFlag[] = [];

  // Toxic slices
  const toxicSlices = slices.filter((s) => s.verdict === "TOXIC_SLICE" && s.closedCount >= 3);
  if (toxicSlices.length > 0) {
    flags.push({
      code: "SYMBOL_DIRECTION_TOXIC_SLICE",
      severity: toxicSlices.some((s) => s.closedCount >= 5) ? "WARN" : "INFO",
      message:
        `${toxicSlices.length} toxic symbol-direction-route slice(s) with ≥3 closes: ` +
        toxicSlices
          .slice(0, 3)
          .map((s) => `${s.symbol}/${s.direction} ${s.netAvgR?.toFixed(4)}R avg, ${s.closedCount} closes`)
          .join("; "),
    });
  }

  // Promising slices
  const promisingSlices = slices.filter((s) => s.verdict === "PROMISING_SLICE" && s.closedCount >= 3);
  if (promisingSlices.length > 0) {
    flags.push({
      code: "SYMBOL_DIRECTION_PROMISING_SLICE",
      severity: "INFO",
      message:
        `${promisingSlices.length} promising slice(s): ` +
        promisingSlices
          .slice(0, 3)
          .map((s) => `${s.symbol}/${s.direction} ${s.netAvgR?.toFixed(4)}R avg, ${s.closedCount} closes`)
          .join("; "),
    });
  }

  // Kronos alignment
  const kronosFeat = comparisons.find((c) => c.featureName === "kronosAligned");
  if (kronosFeat && kronosFeat.effectSizeLabel !== "WEAK") {
    flags.push({
      code: kronosFeat.liftOrDrag === "WINNER_SKEW" ? "KRONOS_ALIGNMENT_HELPFUL" : "KRONOS_ALIGNMENT_NOT_HELPFUL",
      severity: kronosFeat.liftOrDrag === "WINNER_SKEW" ? "INFO" : "WARN",
      message:
        `Kronos alignment shows ${kronosFeat.effectSizeLabel.toLowerCase()} effect. ` +
        `Winner rate: ${kronosFeat.winnerValue}, loser rate: ${kronosFeat.loserValue} (Δ${kronosFeat.delta}).`,
    });
  }

  // Whale alignment
  const whaleFeat = comparisons.find((c) => c.featureName === "whaleAligned");
  if (whaleFeat && whaleFeat.effectSizeLabel !== "WEAK") {
    flags.push({
      code: whaleFeat.liftOrDrag === "WINNER_SKEW" ? "WHALE_ALIGNMENT_HELPFUL" : "WHALE_ALIGNMENT_NOT_HELPFUL",
      severity: whaleFeat.liftOrDrag === "WINNER_SKEW" ? "INFO" : "WARN",
      message:
        `Whale alignment shows ${whaleFeat.effectSizeLabel.toLowerCase()} effect. ` +
        `Winner rate: ${whaleFeat.winnerValue}, loser rate: ${whaleFeat.loserValue} (Δ${whaleFeat.delta}).`,
    });
  }

  // High danger loser skew
  const dangerFeat = comparisons.find((c) => c.featureName === "dangerScore");
  if (dangerFeat && dangerFeat.liftOrDrag === "WINNER_SKEW" && dangerFeat.effectSizeLabel !== "WEAK") {
    flags.push({
      code: "HIGH_DANGER_LOSER_SKEW",
      severity: "WARN",
      message:
        `Losers have higher average danger scores (${dangerFeat.loserValue}) vs winners (${dangerFeat.winnerValue}). ` +
        `Danger score appears to have predictive value for loss probability.`,
    });
  }

  // Low confidence loser skew
  const calibFeat = comparisons.find((c) => c.featureName === "calibrationNegativeVerdict");
  if (calibFeat && calibFeat.liftOrDrag === "WINNER_SKEW" && calibFeat.effectSizeLabel !== "WEAK") {
    flags.push({
      code: "CALIBRATED_EDGE_STILL_OVERSTATED",
      severity: "WARN",
      message:
        `Negative calibration verdict is ${calibFeat.effectSizeLabel.toLowerCase()} loser-skewed ` +
        `(loser rate: ${calibFeat.loserValue} vs winner rate: ${calibFeat.winnerValue}). ` +
        `Calibration is showing some ability to warn, but may still be allowing marginal setups through.`,
    });
  }

  // Route narrow context
  if (leadingRoute.routeDiagnosis === "WORKS_ONLY_IN_NARROW_CONTEXT") {
    flags.push({
      code: "ROUTE_ONLY_WORKS_IN_NARROW_CONTEXT",
      severity: "WARN",
      message: `Leading route (${leadingRoute.routeLabel}) shows wins concentrated on few symbols. ${leadingRoute.routeDiagnosisNote}`,
    });
  }

  // No clear winner separator
  const hasStrong = comparisons.some(
    (c) => c.effectSizeLabel === "STRONG" && c.confidence !== "LOW",
  );
  if (!hasStrong) {
    flags.push({
      code: "NO_CLEAR_WINNER_SEPARATOR_YET",
      severity: "INFO",
      message:
        `No feature shows strong, high-confidence separation between winners and losers ` +
        `at current sample size (${summary.closedCount} closes). Continue accumulating data.`,
    });
  }

  return flags;
}

// ─── Answer cards ─────────────────────────────────────────────────────────────

function buildAnswerCards(
  summary: WinnerLoserSummary,
  topWinner: SeparatingSignal[],
  topLoser: SeparatingSignal[],
  leadingRoute: LeadingRouteAudit,
  slices: ContextSlice[],
  hypotheses: PatchHypothesis[],
): Array<{ question: string; answer: string }> {
  const cards: Array<{ question: string; answer: string }> = [];
  const n = summary.closedCount;

  // 1. What most clearly separates winners from losers?
  {
    let answer: string;
    if (n < 10) {
      answer = `Too few closed trades (${n}) to reliably separate winners from losers. The patterns visible now are heavily influenced by individual outliers. Accumulate to ≥30 closes before drawing strong conclusions.`;
    } else if (topWinner.length === 0) {
      answer = `No single feature shows strong or moderate winner-skew at current sample size. Losses appear broadly distributed — no obvious filter exists yet. This is common at early sample sizes.`;
    } else {
      const top = topWinner[0];
      answer =
        `The clearest current separator is "${top.feature}": ${top.observedPattern}. ` +
        `Effect size: ${top.effectSizeLabel} (n=${top.supportCount}). ` +
        (topWinner.length > 1
          ? `Other winner-skewed features: ${topWinner
              .slice(1, 3)
              .map((s) => s.feature)
              .join(", ")}.`
          : "Only one strong feature detected so far.") +
        ` These patterns are suggestive at this sample size but require ≥30 closes per feature bucket to confirm.`;
    }
    cards.push({ question: "What most clearly separates winners from losers?", answer });
  }

  // 2. Does VWAP + TP1 full work only in specific conditions?
  {
    let answer: string;
    const lr = leadingRoute;
    if (lr.closedCount < 5) {
      answer = `Too few closes for the VWAP + TP1 full route (${lr.closedCount}) to conclude anything. Data is still early.`;
    } else if (lr.routeDiagnosis === "WORKS_ONLY_IN_NARROW_CONTEXT") {
      answer =
        `Yes — the VWAP + TP1 full route appears to work only in a narrow context. ` +
        lr.routeDiagnosisNote +
        (lr.topWinnerSignalsWithinRoute.length > 0
          ? ` Within this route, the clearest winner condition is: "${lr.topWinnerSignalsWithinRoute[0]?.feature}" (${lr.topWinnerSignalsWithinRoute[0]?.observedPattern}).`
          : "");
    } else if (lr.routeDiagnosis === "BROADLY_WEAK") {
      answer =
        `The VWAP + TP1 full route is broadly weak across all conditions tested so far ` +
        `(${lr.winnerCount} winners from ${lr.closedCount} closes, net avg R ${lr.netAvgR?.toFixed(4) ?? "n/a"}R). ` +
        `No specific condition appears to rescue performance.`;
    } else if (lr.routeDiagnosis === "EARLY_MIXED") {
      answer =
        `Results are mixed and inconclusive (${lr.closedCount} closes). ` +
        lr.routeDiagnosisNote;
    } else {
      answer = `Insufficient sample for the leading route (${lr.closedCount} closes). Accumulate more data.`;
    }
    cards.push({ question: "Does VWAP + TP1 full work only in specific conditions?", answer });
  }

  // 3. Are some symbol-direction pairs toxic?
  {
    const toxic = slices.filter((s) => s.verdict === "TOXIC_SLICE" && s.closedCount >= 3);
    const promising = slices.filter((s) => s.verdict === "PROMISING_SLICE" && s.closedCount >= 3);
    let answer: string;
    if (toxic.length === 0 && promising.length === 0) {
      answer = `No clearly toxic or promising symbol-direction pairs identified yet. Most slices have fewer than 3 closes or fall in MIXED territory. Verdict will sharpen as sample grows.`;
    } else {
      const parts: string[] = [];
      if (toxic.length > 0) {
        parts.push(
          `Toxic: ${toxic
            .slice(0, 3)
            .map((s) => `${s.symbol}/${s.direction} (${s.netAvgR?.toFixed(4)}R avg, ${s.closedCount} closes)`)
            .join("; ")}.`,
        );
      }
      if (promising.length > 0) {
        parts.push(
          `Promising: ${promising
            .slice(0, 3)
            .map((s) => `${s.symbol}/${s.direction} (${s.netAvgR?.toFixed(4)}R avg, ${s.closedCount} closes)`)
            .join("; ")}.`,
        );
      }
      answer =
        parts.join(" ") +
        (toxic.some((s) => s.closedCount < 10)
          ? " Note: some slices are still below 10 closes — verdicts may shift."
          : "");
    }
    cards.push({ question: "Are some symbol-direction pairs toxic?", answer });
  }

  // 4. Should Top 10 eventually weight symbol-route evidence?
  {
    const toxic = slices.filter((s) => s.verdict === "TOXIC_SLICE" && s.closedCount >= 5);
    const promising = slices.filter((s) => s.verdict === "PROMISING_SLICE" && s.closedCount >= 5);
    let answer: string;
    if (toxic.length === 0 && promising.length === 0) {
      answer =
        `Not yet justifiable. No symbol-direction-route slice with ≥5 closes shows clear TOXIC or PROMISING verdict. ` +
        `Build to ≥15 closes per major slice before considering ranking adjustments.`;
    } else {
      answer =
        `Yes, eventually. ${toxic.length > 0 ? `Toxic slices (${toxic.map((s) => `${s.symbol}/${s.direction}`).join(", ")}) ` +
          `should carry a lower scanner weight as data accumulates. ` : ""}` +
        `${promising.length > 0 ? `Promising slices (${promising.map((s) => `${s.symbol}/${s.direction}`).join(", ")}) ` +
          `deserve increased consideration. ` : ""}` +
        `Do NOT change ranking yet — current sample is below the reliable-evidence threshold.`;
    }
    cards.push({ question: "Should Top 10 eventually weight symbol-route evidence?", answer });
  }

  // 5. What is the next patch candidate after this audit?
  {
    let answer: string;
    const bestHyp = hypotheses.find((h) => h.recommendation !== "WATCH");
    if (!bestHyp) {
      answer =
        `No patch candidate is ready at current sample size (${n} closes). ` +
        `The top observation is: ${hypotheses[0]?.observedEvidence ?? "no clear signal yet."}. ` +
        `Focus: accumulate closes, re-run audit at 30+ per symbol-route, then revisit.`;
    } else {
      answer =
        `Next candidate: "${bestHyp.title}". ` +
        `Evidence: ${bestHyp.observedEvidence} ` +
        `Surface: ${bestHyp.likelyPatchSurface}. ` +
        `Confidence: ${bestHyp.confidence}. ` +
        `Status: ${bestHyp.recommendation}. ` +
        `This requires human review before any code changes.`;
    }
    cards.push({ question: "What is the next patch candidate after this audit?", answer });
  }

  return cards;
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function buildWinnerLoserAuditReport(
  input: WinnerLoserAuditInput,
  now: Date = new Date(),
): WinnerLoserAuditReport {
  const generatedAt = now.toISOString();
  const eraFilter: WinnerLoserEraFilter = input.eraFilter ?? "POST_CALIBRATION";

  const all = flattenClosed(input.positions, eraFilter);

  // Apply optional route filter
  const records = input.routeFilter
    ? all.filter((r) => {
        const ef = input.routeFilter!;
        if (ef.entryVariant && r.entryVariant !== ef.entryVariant) return false;
        if (ef.exitVariant && r.exitVariant !== ef.exitVariant) return false;
        return true;
      })
    : all;

  const winners = records.filter((r) => r.isWinner);
  const losers = records.filter((r) => r.isLoser);
  const breakevens = records.filter((r) => r.isBreakeven);
  const stats = computeStats(records);

  // Main diagnosis
  let mainDiagnosis: WinnerLoserMainDiagnosis;
  if (records.length < 10) {
    mainDiagnosis = "INSUFFICIENT_SAMPLE";
  } else if (winners.length === 0) {
    mainDiagnosis = "LOSSES_BROAD_BASED";
  } else {
    const feats = buildFeatureComparisons(winners, losers);
    const hasStrongSeparation = feats.some(
      (f) => f.effectSizeLabel === "STRONG" && f.confidence !== "LOW",
    );
    const hasModerateSeparation = feats.some(
      (f) => f.effectSizeLabel === "MODERATE" && f.confidence !== "LOW",
    );
    if (hasStrongSeparation || hasModerateSeparation) {
      mainDiagnosis = "FEATURE_SEPARATION_EMERGING";
    } else {
      mainDiagnosis = "NO_CLEAR_SEPARATOR_YET";
    }
  }

  const summary: WinnerLoserSummary = {
    eraFilter,
    closedCount: records.length,
    winnerCount: winners.length,
    loserCount: losers.length,
    breakevenCount: breakevens.length,
    netAvgR: stats.netAvgR,
    profitFactor: stats.profitFactor,
    winRate: stats.winRate,
    mainDiagnosis,
  };

  // Build sections
  const featureComparisons = buildFeatureComparisons(winners, losers);
  const topWinnerSignals = extractSeparatingSignals(featureComparisons, "WINNER_SKEW");
  const topLoserSignals = extractSeparatingSignals(featureComparisons, "LOSER_SKEW");
  const leadingRouteAudit = buildLeadingRouteAudit(all); // always on full all, not filtered
  const contextSlices = buildContextSlices(records);
  const patchHypotheses = buildPatchHypotheses(records, featureComparisons, contextSlices, leadingRouteAudit);
  const flags = buildFlags(summary, featureComparisons, contextSlices, leadingRouteAudit);
  const answerCards = buildAnswerCards(
    summary, topWinnerSignals, topLoserSignals, leadingRouteAudit, contextSlices, patchHypotheses,
  );

  return {
    generatedAt,
    eraFilter,
    summary,
    featureComparisons,
    topWinnerSignals,
    topLoserSignals,
    leadingRouteAudit,
    contextSlices,
    patchHypotheses,
    flags,
    answerCards,
    notes: [
      "Winner vs Loser Audit is read-only. It does not change ranking, routing, execution, or live readiness.",
      "Winners = closed variants with realizedNetR > 0. Losers = realizedNetR < 0.",
      "featureComparisons use persisted ShadowPosition fields only (no market data lookup).",
      "Kronos/Whale alignment inferred from variantSelection.routeReasonCodes.",
      "Effect sizes: STRONG >35% of range, MODERATE >12%, WEAK otherwise.",
      "Confidence: HIGH ≥10 in both groups, MEDIUM ≥5, LOW <5.",
      "sliceVerdict TOXIC requires ≥3 closes, netAvgR < -0.3R AND slRate > 50%.",
    ],
  };
}

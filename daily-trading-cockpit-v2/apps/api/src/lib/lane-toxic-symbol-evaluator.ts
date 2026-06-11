import type { StrategyExperienceRecord } from "@dtc/shared";

/**
 * LANE TOXIC SYMBOL EVALUATOR (Phase 2 Cross-Intelligence Influence Patch)
 *
 * Pure advisory function. No I/O. No hardcoded tickers.
 *
 * Classifies symbols within a specific (regime, direction, entryVariant, exitVariant)
 * lane into:
 *   - Tier-1 OPERATIVE_SUPPRESSED (cross-intel path): n >= 3 AND slRate === 1.0 AND >= 1 cross-intelligence support
 *   - Tier-1 OPERATIVE_SUPPRESSED (load-bearing path): slRate === 1.0 AND n >= 2 AND grossAvgR <= -0.95
 *       AND |netSumConservative| >= 1.5 AND laneN >= 30 AND excluding the symbol flips lane
 *       conservative netAvgR from negative to positive (deltaConsNetAvgR >= +0.05)
 *   - Tier-2 WATCHLIST: n === 2 AND slRate === 1.0 (did not qualify for load-bearing Tier-1)
 *   - NORMAL: everything else
 *
 * Cross-intelligence supports:
 *   - "UNIVERSE_ROTATION_PRESSURE": symbol appears in universeRotationPressureSymbols
 *   - "SYMBOL_SENSITIVE_ROUTE": symbolSensitiveLaneSignal is true for this lane
 *
 * Does NOT modify any live trading behavior, resolver semantics, stop/TP, or universe.
 */

export type LaneToxicTier =
  | "TIER_1_OPERATIVE_SUPPRESSED"
  | "TIER_2_WATCHLIST"
  | "NORMAL";

export type CrossIntelligenceSupport =
  | "UNIVERSE_ROTATION_PRESSURE"
  | "SYMBOL_SENSITIVE_ROUTE";

export interface LaneToxicSymbolDiagnostic {
  symbol: string;
  n: number;
  slRate: number;
  netAvgR: number | null;
  grossAvgR: number | null;
  tier: LaneToxicTier;
  crossIntelligenceSupports: CrossIntelligenceSupport[];
  /** Set when this symbol was promoted to Tier-1 via the load-bearing contaminant path. */
  promotionBranch?: "LOAD_BEARING_CONTAMINANT_V1";
  /** Sum of realizedNetR (conservative basis) for this symbol in the lane. */
  netSumConservative: number;
  /** Total observations in the lane (all symbols combined). */
  laneN: number;
  /** Lane conservative netAvgR including this symbol. */
  laneConsNetAvgR: number | null;
  /** Lane conservative netAvgR excluding this symbol. */
  laneConsNetAvgRExcludingSymbol: number | null;
  /** laneConsNetAvgRExcludingSymbol − laneConsNetAvgR. */
  deltaConsNetAvgR: number | null;
}

export interface LaneToxicSymbolEvaluationResult {
  tier1ToxicSymbols: string[];
  tier2ToxicWatchlistSymbols: string[];
  perSymbolDiagnostics: LaneToxicSymbolDiagnostic[];
}

export interface LaneToxicSymbolLane {
  regime: string | null;
  direction: "LONG" | "SHORT";
  entryVariant: string;
  exitVariant: string;
}

export interface LaneToxicSymbolCrossIntelligenceContext {
  universeRotationPressureSymbols: Set<string>;
  symbolSensitiveLaneSignal: boolean;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return round4(values.reduce((sum, v) => sum + v, 0) / values.length);
}

function normalizedRegime(record: StrategyExperienceRecord): string | null {
  const value = record.context.marketRegime;
  if (!value) return null;
  const upper = String(value).toUpperCase();
  if (upper.includes("BULL")) return "BULLISH_EXPANSION";
  if (upper.includes("BEAR")) return "BEARISH_EXPANSION";
  if (upper.includes("SIDE") || upper.includes("RANGE") || upper.includes("CHOP")) return "SIDEWAYS";
  if (upper.includes("MIX")) return "MIXED";
  return upper;
}

function routeOf(record: StrategyExperienceRecord): string {
  return record.context.selectedEntryVariant ?? record.outcome.selectedEntryVariant ?? "UNKNOWN_ENTRY";
}

function exitOf(record: StrategyExperienceRecord): string {
  return record.context.selectedExitVariant ?? record.outcome.selectedExitVariant ?? "UNKNOWN_EXIT";
}

/**
 * Evaluate toxic symbol tiers within a specific lane.
 *
 * @param records All strategy experience records for the lane (pre-filtered to era).
 * @param lane The lane tuple to evaluate.
 * @param crossIntelligenceContext External intelligence signals.
 */
export function evaluateLaneToxicSymbols(
  records: StrategyExperienceRecord[],
  lane: LaneToxicSymbolLane,
  crossIntelligenceContext: LaneToxicSymbolCrossIntelligenceContext,
): LaneToxicSymbolEvaluationResult {
  // Filter records to the specific lane tuple
  const laneRecords = records.filter((record) => {
    if (record.context.direction !== lane.direction) return false;
    const regime = normalizedRegime(record);
    if (regime !== lane.regime) return false;
    if (routeOf(record) !== lane.entryVariant) return false;
    if (exitOf(record) !== lane.exitVariant) return false;
    return true;
  });

  // Group by symbol
  const bySymbol = new Map<string, StrategyExperienceRecord[]>();
  for (const record of laneRecords) {
    const symbol = record.context.symbol;
    const list = bySymbol.get(symbol) ?? [];
    list.push(record);
    bySymbol.set(symbol, list);
  }

  const tier1ToxicSymbols: string[] = [];
  const tier2ToxicWatchlistSymbols: string[] = [];
  const perSymbolDiagnostics: LaneToxicSymbolDiagnostic[] = [];

  // Full lane metrics (used for cross-intel Tier-1 diagnostics)
  const laneN = laneRecords.length;
  const laneNetSumConservative = laneRecords.reduce(
    (sum, r) => sum + (typeof r.outcome.realizedNetR === "number" ? r.outcome.realizedNetR : 0),
    0,
  );
  const laneConsNetAvgR: number | null = laneN > 0 ? round4(laneNetSumConservative / laneN) : null;

  // PASS 1: Identify cross-intel Tier-1 symbols.
  // The load-bearing check must evaluate whether a Tier-2-shaped symbol is load-bearing for the
  // RESIDUAL lane after known-bad Tier-1 symbols are already excluded. If we use the full lane,
  // heavy Tier-1 symbols (e.g. BNBUSDT with n=4, all SL) dominate the lane deficit and prevent
  // smaller Tier-2 contaminants from passing the sign-flip test even when they individually
  // exceed the residual negative expectancy.
  const crossIntelTier1Symbols = new Set<string>();
  for (const [symbol, symbolRecords] of bySymbol) {
    const n = symbolRecords.length;
    const slRate = n > 0 ? symbolRecords.filter((r) => r.outcome.slHit === true).length / n : 0;
    const hasCrossIntel =
      crossIntelligenceContext.universeRotationPressureSymbols.has(symbol) ||
      crossIntelligenceContext.symbolSensitiveLaneSignal;
    if (slRate === 1.0 && n >= 3 && hasCrossIntel) {
      crossIntelTier1Symbols.add(symbol);
    }
  }

  // Cleaned lane: exclude cross-intel Tier-1 symbols.
  // This is the reference lane for load-bearing evaluation.
  const cleanedLaneRecords = laneRecords.filter((r) => !crossIntelTier1Symbols.has(r.context.symbol));
  const cleanedLaneN = cleanedLaneRecords.length;
  const cleanedLaneNetSum = cleanedLaneRecords.reduce(
    (sum, r) => sum + (typeof r.outcome.realizedNetR === "number" ? r.outcome.realizedNetR : 0),
    0,
  );
  const cleanedLaneConsNetAvgR: number | null = cleanedLaneN > 0 ? round4(cleanedLaneNetSum / cleanedLaneN) : null;

  // PASS 2: Full classification using per-symbol metrics and cleaned lane reference.
  for (const [symbol, symbolRecords] of bySymbol) {
    const n = symbolRecords.length;
    const slHitRecords = symbolRecords.filter((r) => r.outcome.slHit === true);
    const slRate = n > 0 ? slHitRecords.length / n : 0;
    const netValues = symbolRecords.map((r) => r.outcome.realizedNetR).filter((v): v is number => typeof v === "number");
    const grossValues = symbolRecords.map((r) => r.outcome.realizedGrossR).filter((v): v is number => typeof v === "number");
    const netAvgR = average(netValues);
    const grossAvgR = average(grossValues);

    // Determine cross-intelligence supports
    const crossIntelligenceSupports: CrossIntelligenceSupport[] = [];
    if (crossIntelligenceContext.universeRotationPressureSymbols.has(symbol)) {
      crossIntelligenceSupports.push("UNIVERSE_ROTATION_PRESSURE");
    }
    if (crossIntelligenceContext.symbolSensitiveLaneSignal) {
      crossIntelligenceSupports.push("SYMBOL_SENSITIVE_ROUTE");
    }

    const netSumConservative = round4(netValues.reduce((s, v) => s + v, 0));

    // Reference lane for load-bearing metrics:
    //   - Cross-intel Tier-1 symbols: full lane (they're not in the cleaned lane, so use raw)
    //   - All others: cleaned lane (residual after Tier-1 exclusion)
    const isCrossIntelTier1 = crossIntelTier1Symbols.has(symbol);
    const refLaneNetSum = isCrossIntelTier1 ? laneNetSumConservative : cleanedLaneNetSum;
    const refLaneN = isCrossIntelTier1 ? laneN : cleanedLaneN;
    const refLaneConsNetAvgR = isCrossIntelTier1 ? laneConsNetAvgR : cleanedLaneConsNetAvgR;

    const excludedRefLaneNetSum = refLaneNetSum - netSumConservative;
    const excludedRefLaneN = refLaneN - n;
    const laneConsNetAvgRExcludingSymbol: number | null =
      excludedRefLaneN > 0 ? round4(excludedRefLaneNetSum / excludedRefLaneN) : null;
    const deltaConsNetAvgR: number | null =
      refLaneConsNetAvgR !== null && laneConsNetAvgRExcludingSymbol !== null
        ? round4(laneConsNetAvgRExcludingSymbol - refLaneConsNetAvgR)
        : null;

    let tier: LaneToxicTier = "NORMAL";
    let promotionBranch: "LOAD_BEARING_CONTAMINANT_V1" | undefined = undefined;

    if (isCrossIntelTier1) {
      // Tier-1 (cross-intel path): pre-classified in Pass 1
      tier = "TIER_1_OPERATIVE_SUPPRESSED";
      tier1ToxicSymbols.push(symbol);
    } else if (
      slRate === 1.0 &&
      n >= 2 &&
      grossAvgR !== null && grossAvgR <= -0.95 &&
      Math.abs(netSumConservative) >= 1.5 &&
      cleanedLaneN >= 30 &&
      cleanedLaneConsNetAvgR !== null && cleanedLaneConsNetAvgR < 0 &&
      laneConsNetAvgRExcludingSymbol !== null && laneConsNetAvgRExcludingSymbol > 0 &&
      deltaConsNetAvgR !== null && deltaConsNetAvgR >= 0.05
    ) {
      // Tier-1 (load-bearing contaminant path): symbol's damage is load-bearing for the
      // cleaned lane's residual negative expectancy — excluding it alone flips the cleaned
      // lane from negative to positive.
      tier = "TIER_1_OPERATIVE_SUPPRESSED";
      promotionBranch = "LOAD_BEARING_CONTAMINANT_V1";
      tier1ToxicSymbols.push(symbol);
    } else if (slRate === 1.0 && n === 2) {
      // Tier-2: n === 2, 100% SL rate, did not qualify for load-bearing Tier-1
      tier = "TIER_2_WATCHLIST";
      tier2ToxicWatchlistSymbols.push(symbol);
    }

    perSymbolDiagnostics.push({
      symbol,
      n,
      slRate,
      netAvgR,
      grossAvgR,
      tier,
      crossIntelligenceSupports,
      ...(promotionBranch !== undefined ? { promotionBranch } : {}),
      netSumConservative,
      laneN: refLaneN,
      laneConsNetAvgR: refLaneConsNetAvgR,
      laneConsNetAvgRExcludingSymbol,
      deltaConsNetAvgR,
    });
  }

  // Sort diagnostics: tier-1 first, then tier-2, then normal; alphabetically within tier
  perSymbolDiagnostics.sort((a, b) => {
    const tierOrder = (tier: LaneToxicTier): number => {
      if (tier === "TIER_1_OPERATIVE_SUPPRESSED") return 0;
      if (tier === "TIER_2_WATCHLIST") return 1;
      return 2;
    };
    const tierDelta = tierOrder(a.tier) - tierOrder(b.tier);
    if (tierDelta !== 0) return tierDelta;
    return a.symbol.localeCompare(b.symbol);
  });

  tier1ToxicSymbols.sort();
  tier2ToxicWatchlistSymbols.sort();

  return {
    tier1ToxicSymbols,
    tier2ToxicWatchlistSymbols,
    perSymbolDiagnostics,
  };
}

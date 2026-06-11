import type {
  Candidate,
  EdgeScoreSnapshot,
  PerformanceStats,
  ShadowVariantKey,
  ShadowVariantStats,
} from "./types.js";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizedNetR(value: number | null | undefined): number {
  if (value === null || value === undefined || Number.isNaN(value)) return 50;
  return clamp(50 + value * 25, 0, 100);
}

function normalizedRate(value: number | null | undefined): number {
  if (value === null || value === undefined || Number.isNaN(value)) return 50;
  return clamp(value * 100, 0, 100);
}

function entryMid(candidate: Candidate): number | null {
  if (!candidate.entryZone) return null;
  return (candidate.entryZone[0] + candidate.entryZone[1]) / 2;
}

function shortHorizonOnly(candidate: Candidate): boolean {
  if (candidate.kronosBias === "UNAVAILABLE") return false;
  if (candidate.finalDirection === "LONG") {
    return (candidate.expectedReturn1h ?? 0) > 0 && (candidate.expectedReturn4h ?? 0) < 0;
  }
  return (candidate.expectedReturn1h ?? 0) < 0 && (candidate.expectedReturn4h ?? 0) > 0;
}

function getBestVariant(
  variants: ShadowVariantStats[] | undefined,
  category: ShadowVariantStats["category"],
  preferred: ShadowVariantKey[],
): ShadowVariantStats | null {
  if (!variants) return null;
  return variants
    .filter((variant) => variant.category === category && preferred.includes(variant.key) && variant.resolved > 0)
    .sort((left, right) => {
      const netDiff = (right.avgNetRResult ?? Number.NEGATIVE_INFINITY) - (left.avgNetRResult ?? Number.NEGATIVE_INFINITY);
      if (netDiff !== 0) return netDiff;
      return right.profitableTp1Rate - left.profitableTp1Rate;
    })[0] ?? null;
}

export function buildEdgeScore(candidate: Candidate, perf: PerformanceStats | null, marketRegime: string): EdgeScoreSnapshot {
  const symbolStats = perf ? [...perf.bySymbol, ...perf.earlySampleSymbols].find((entry) => entry.symbol === candidate.symbol) ?? null : null;
  const directionStats = perf
    ? candidate.finalDirection === "SHORT"
      ? perf.byDirection.SHORT
      : perf.byDirection.LONG
    : null;
  const statusStats = perf ? perf.byStatus[candidate.status] : null;
  const variants = perf?.windows["1h"].shadowVariants;

  const historicalScore = round(
    (
      normalizedNetR(symbolStats?.avgNetRResult) * 0.4 +
      normalizedNetR(directionStats?.avgNetRResult) * 0.35 +
      normalizedNetR(statusStats?.avgNetRResult) * 0.25
    ),
    2,
  );

  const activeKronosBias = candidate.selectedKronosBias ?? candidate.kronosBias;
  const kronosAligned = activeKronosBias !== "UNAVAILABLE" && activeKronosBias === candidate.finalDirection;
  const kronosConflicting = activeKronosBias !== "UNAVAILABLE" && activeKronosBias !== candidate.finalDirection;
  const horizonConflict = candidate.horizonConflict ?? false;
  const shortHorizon = shortHorizonOnly(candidate);
  const kronosContinuation =
    !horizonConflict && candidate.finalDirection === "LONG"
      ? (candidate.expectedReturn1h ?? 0) > 0 && (candidate.expectedReturn4h ?? 0) > 0 && (candidate.probabilityUp ?? 0) >= (candidate.probabilityDown ?? 0)
      : !horizonConflict && (candidate.expectedReturn1h ?? 0) < 0 && (candidate.expectedReturn4h ?? 0) < 0 && (candidate.probabilityDown ?? 0) >= (candidate.probabilityUp ?? 0);
  const kronosScore = round(
    candidate.kronosBias === "UNAVAILABLE" || candidate.kronosConfidenceBucket === "WEAK"
      ? 50
      : horizonConflict
        ? clamp((candidate.kronosConfidence ?? 50) * 0.45, 20, 55)
      : kronosAligned && kronosContinuation
        ? clamp((candidate.kronosConfidence ?? 50) * 0.7 + 25, 0, 100)
        : kronosConflicting
          ? clamp(25 + (100 - (candidate.kronosConfidence ?? 50)) * 0.4, 0, 100)
          : 50,
    2,
  );

  const whaleAgrees =
    (candidate.finalDirection === "LONG" && candidate.whale.signal === "BULLISH") ||
    (candidate.finalDirection === "SHORT" && candidate.whale.signal === "BEARISH");
  const whaleDisagrees =
    (candidate.finalDirection === "LONG" && candidate.whale.signal === "BEARISH") ||
    (candidate.finalDirection === "SHORT" && candidate.whale.signal === "BULLISH");
  const whaleScore = round(
    !candidate.whale.available || candidate.whale.signal === "NEUTRAL"
      ? 50
      : whaleAgrees
        ? clamp(45 + candidate.whale.score * 0.7, 0, 100)
        : whaleDisagrees
          ? clamp(55 - candidate.whale.score * 0.45, 0, 100)
          : 50,
    2,
  );

  const entryMidpoint = entryMid(candidate);
  const price = candidate.indicators.fiveMinute.latestClose;
  const atr = candidate.indicators.fiveMinute.atr14;
  const fibBand = [
    candidate.fibonacci.retracement382,
    candidate.fibonacci.retracement500,
    candidate.fibonacci.retracement618,
  ];
  const fibDistancePct = Math.min(...fibBand.map((level) => Math.abs((price - level) / level) * 100));
  const inEntryZone = candidate.entryZone ? price >= candidate.entryZone[0] && price <= candidate.entryZone[1] : false;
  const noChase = entryMidpoint !== null && atr > 0 && Math.abs(price - entryMidpoint) > atr;
  const entryQuality = round(
    clamp(
      35 +
        (inEntryZone ? 28 : 0) +
        Math.max(0, 18 - fibDistancePct * 18) +
        Math.max(0, 12 - Math.abs(candidate.indicators.fiveMinute.distanceFromEma20) * 8) +
        Math.max(0, 12 - Math.abs(candidate.indicators.fiveMinute.distanceFromVwap) * 6) -
        (noChase ? 22 : 0),
      0,
      100,
    ),
    2,
  );

  const fibAtrRrQuality = round(
    clamp(
      30 +
        Math.max(0, 24 - fibDistancePct * 20) +
        Math.max(0, Math.min((candidate.riskReward ?? 0) * 18, 32)) +
        Math.max(0, 18 - Math.abs(candidate.indicators.fiveMinute.atrPercent - 1.1) * 14),
      0,
      100,
    ),
    2,
  );

  const regimeCompatible =
    (candidate.finalDirection === "LONG" && marketRegime.toLowerCase().includes("bull")) ||
    (candidate.finalDirection === "SHORT" && marketRegime.toLowerCase().includes("bear")) ||
    marketRegime.toLowerCase().includes("mixed");
  const volumeRegimeCompatibility = round(
    clamp(
      35 +
        Math.min((candidate.volume.volumeRatio5m ?? 0) * 22, 40) +
        (regimeCompatible ? 25 : 5),
      0,
      100,
    ),
    2,
  );

  const score = round(
    historicalScore * 0.3 +
      kronosScore * 0.2 +
      whaleScore * 0.15 +
      entryQuality * 0.15 +
      fibAtrRrQuality * 0.15 +
      volumeRegimeCompatibility * 0.05,
    2,
  );

  const bestEntryVariant = getBestVariant(variants, "ENTRY", [
    "base_current",
    "fib_382_entry",
    "fib_500_entry",
    "fib_618_entry",
    "ema20_pullback_entry",
    "vwap_retest_entry",
    "no_chase_atr_entry",
  ]);
  const bestExitVariant = getBestVariant(variants, "EXIT", [
    "tp1_fast_exit",
    "tp1_50_tp2_runner",
    "kronos_runner_exit",
    "kronos_flip_exit",
    "trail_after_tp1",
    "whale_conflict_exit",
    "fib_extension_exit",
  ]);

  const notes: string[] = [];
  const cautions: string[] = [];

  if (symbolStats && symbolStats.resolved >= 10 && (symbolStats.avgNetRResult ?? 0) > 0) {
    notes.push("symbol showing positive net expectancy in shadow data");
  }
  if (symbolStats && symbolStats.resolved >= 10 && (symbolStats.avgNetRResult ?? 0) <= 0) {
    cautions.push("symbol net expectancy is weak after costs");
  }
  if (whaleAgrees) {
    notes.push("whale flow confirms direction");
  } else if (whaleDisagrees) {
    cautions.push("whale flow disagrees with direction");
  }
  if (noChase) {
    cautions.push("price is more than 1 ATR from ideal entry - no chase / wait better entry");
  }
  if ((candidate.volume.volumeRatio5m ?? 0) < 1) {
    cautions.push("volume confirmation is thin");
  }
  if (horizonConflict) {
    cautions.push("Kronos 1h and 4h horizons disagree");
  }
  if (shortHorizon) {
    notes.push("short-horizon bias only");
  }

  const kronosExitGuidance =
    candidate.kronosBias === "UNAVAILABLE" || candidate.kronosConfidenceBucket === "WEAK"
      ? "Kronos is weak or unavailable, so favor faster TP1 management and no runner bias."
      : shortHorizon
        ? "short-horizon bias only; TP1 fast, no runner"
      : horizonConflict
        ? "Kronos horizons conflict, so do not use Kronos for runner guidance."
      : kronosAligned && kronosContinuation
        ? (candidate.finalDirection === "LONG"
            ? "Kronos supports continuation. Favor TP1 partial, then hold a runner toward TP2/TP3 while trailing after TP1."
            : "Kronos supports downside continuation. Favor TP1 partial, then hold a runner toward TP2/TP3 while trailing after TP1.")
        : "Kronos conflicts or weakens. Favor faster exits, smaller runners, or early profit-taking if the forecast flips.";

  const whaleGuidance =
    !candidate.whale.available || candidate.whale.signal === "NEUTRAL"
      ? "Whale flow is neutral or unavailable, so it does not change the edge view."
      : whaleAgrees
        ? "Whale flow agrees with direction and acts as confirmation only."
        : "Whale flow disagrees with direction, so treat continuation as less durable.";

  return {
    score,
    historicalNetExpectancy: historicalScore,
    kronosForecastSupport: kronosScore,
    whaleFlowSupport: whaleScore,
    entryQuality,
    fibAtrRrQuality,
    volumeRegimeCompatibility,
    entryQualityLabel: noChase ? "No chase / wait better entry" : inEntryZone ? "Inside preferred entry zone" : "Review pullback / retest quality",
    bestShadowEntryVariant: bestEntryVariant?.key ?? null,
    bestShadowExitVariant: bestExitVariant?.key ?? null,
    kronosExitGuidance,
    whaleGuidance,
    netEdgeWarning:
      symbolStats && symbolStats.resolved >= 10 && ((symbolStats.avgNetRResult ?? 0) <= 0 || (directionStats?.avgNetRResult ?? 0) <= 0 || (statusStats?.avgNetRResult ?? 0) <= 0)
        ? "Net edge is still thin after fee/slippage once symbol, direction, or status history is applied."
        : null,
    noChase,
    horizonConflict,
    shortHorizonOnly: shortHorizon,
    notes,
    cautions,
  };
}

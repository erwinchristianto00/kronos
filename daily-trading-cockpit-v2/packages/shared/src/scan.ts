import {
  buildAtrPlan,
  calculateFibonacciLevels,
  calculateTimeframeIndicators,
  completedCandles,
  clamp,
  roundPrice,
  round,
} from "./indicators.js";
import {
  DECISION_PIPELINE_POLICY_VERSION,
  MAX_SCANNER_SPREAD_PERCENT,
  MIN_EXECUTION_RR,
  MIN_RAW_QUOTE_VOLUME_24H,
  MIN_STRUCTURAL_RR,
} from "./policy-versions.js";
import type {
  Candidate,
  Candle,
  Direction,
  FibonacciLevels,
  IndicatorSet,
  KronosPrediction,
  SentimentSignal,
  SpreadSnapshot,
  TimeframeIndicatorSnapshot,
  VolumeSnapshot,
  WhaleSignal,
} from "./types.js";

export interface CandidateBuildInput {
  symbol: string;
  candles5m: Candle[];
  candles15m: Candle[];
  candles1h: Candle[];
  spread: SpreadSnapshot;
  volume: VolumeSnapshot;
  kronos: KronosPrediction;
  whale: WhaleSignal;
  sentiment: SentimentSignal;
  now?: number;
}

function capAtWait(status: Candidate["status"]): Candidate["status"] {
  if (status === "TRADE_NOW" || status === "READY") return "WAIT";
  return status;
}

function normalizeSpread(spread: SpreadSnapshot): SpreadSnapshot {
  const bid = spread.bid ?? null;
  const ask = spread.ask ?? null;
  const absolute = spread.absolute ?? (bid !== null && ask !== null ? Math.max(ask - bid, 0) : null);
  const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null;
  const percent =
    absolute !== null && mid !== null && mid > 0
      ? round((absolute / mid) * 100, 4)
      : spread.percent ?? null;

  return {
    bid,
    ask,
    absolute,
    percent,
  };
}

function externalSignalContribution(
  signal: WhaleSignal["signal"] | SentimentSignal["signal"],
  score: number,
  direction: Direction,
): number {
  if (signal === "UNAVAILABLE") {
    return 0;
  }
  if (signal === "NEUTRAL" || direction === "NEUTRAL") {
    return 50;
  }

  const aligns =
    (signal === "BULLISH" && direction === "LONG") ||
    (signal === "BEARISH" && direction === "SHORT");

  return aligns ? score : Math.max(0, 100 - score);
}

function sentimentWeight(sentiment: SentimentSignal): number {
  if (!sentiment.available) {
    return 0;
  }
  return sentiment.scope === "SYMBOL" ? 10 : 5;
}

function scoreTrend(snapshot: TimeframeIndicatorSnapshot, direction: Direction): number {
  const bullishTrend = snapshot.trend === "BULLISH" ? 30 : snapshot.trend === "SIDEWAYS" ? 15 : 0;
  const bearishTrend = snapshot.trend === "BEARISH" ? 30 : snapshot.trend === "SIDEWAYS" ? 15 : 0;
  const priceVsEma = direction === "LONG" ? 15 - Math.abs(snapshot.distanceFromEma20) * 1.4 : 15 - Math.abs(snapshot.distanceFromEma20) * 1.4;
  const priceVsVwap = 15 - Math.abs(snapshot.distanceFromVwap) * 1.2;
  const breakoutScore =
    direction === "LONG"
      ? snapshot.breakoutHigh
        ? 10
        : 0
      : snapshot.breakoutLow
        ? 10
        : 0;
  const macdScore =
    direction === "LONG"
      ? snapshot.macd.histogram > 0
        ? 15
        : 0
      : snapshot.macd.histogram < 0
        ? 15
        : 0;
  const rsiScore =
    direction === "LONG"
      ? clamp(20 - Math.abs(snapshot.rsi14 - 58), 0, 20)
      : clamp(20 - Math.abs(snapshot.rsi14 - 42), 0, 20);

  return clamp(
    (direction === "LONG" ? bullishTrend : bearishTrend) +
      Math.max(priceVsEma, 0) +
      Math.max(priceVsVwap, 0) +
      breakoutScore +
      macdScore +
      rsiScore,
    0,
    100,
  );
}

function scoreFibonacci(price: number, fib: FibonacciLevels, direction: Direction): number {
  if (direction === "NEUTRAL") {
    return 0;
  }
  const preferred =
    direction === "LONG"
      ? [fib.retracement382, fib.retracement500, fib.retracement618]
      : [fib.retracement236, fib.retracement382, fib.retracement500];
  const distance = Math.min(...preferred.map((level) => Math.abs((price - level) / level) * 100));
  return clamp(100 - distance * 35, 0, 100);
}

function scoreVolume(volume: VolumeSnapshot, spread: SpreadSnapshot): { volumeScore: number; liquidityScore: number } {
  // Missing inputs are not neutral values.  They simply do not contribute to
  // the optional quality score; required fields are rejected by eligibility.
  const volumeScore =
    volume.volumeRatio5m === null || volume.quoteVolume24h === null
      ? 0
      : clamp(30 + volume.volumeRatio5m * 35 + Math.log10(Math.max(volume.quoteVolume24h, 1)) * 8, 0, 100);
  const liquidityScore =
    spread.percent === null || volume.quoteVolume24h === null
      ? 0
      : clamp(100 - spread.percent * 1400 + Math.log10(Math.max(volume.quoteVolume24h, 1)) * 10, 0, 100);
  return {
    volumeScore: round(volumeScore),
    liquidityScore: round(liquidityScore),
  };
}

function scoreVolatility(atrPercent: number): number {
  const target = 1.2;
  const distance = Math.abs(atrPercent - target);
  return round(clamp(100 - distance * 35, 0, 100));
}

function scoreKronos(kronos: KronosPrediction, direction: Direction): number {
  if (!kronos.available || direction === "NEUTRAL") {
    return 0;
  }
  const probability =
    direction === "LONG" ? kronos.kronosLongProbability ?? 0 : kronos.kronosShortProbability ?? 0;
  return round(clamp(probability * 0.7 + (kronos.kronosConfidence ?? 0) * 0.3, 0, 100));
}

function computeDataQuality(
  indicators: IndicatorSet,
  spread: SpreadSnapshot,
  volume: VolumeSnapshot,
): number {
  const freshnessScore = [indicators.fiveMinute, indicators.fifteenMinute, indicators.oneHour].every(
    (snapshot) => snapshot.isFresh,
  )
    ? 100
    : 40;
  const spreadPenalty = spread.percent === null ? 30 : clamp(spread.percent * 1200, 0, 30);
  const volumePenalty = volume.quoteVolume24h === null || volume.quoteVolume24h < MIN_RAW_QUOTE_VOLUME_24H ? 20 : 0;
  return round(clamp(freshnessScore - spreadPenalty - volumePenalty, 0, 100));
}

export function chooseDirection(longScore: number, shortScore: number): Direction {
  if (Math.abs(longScore - shortScore) < 8 || Math.max(longScore, shortScore) < 52) {
    return "NEUTRAL";
  }
  return longScore > shortScore ? "LONG" : "SHORT";
}

export function calculateDangerScore(
  args: {
    direction: Direction;
    indicators: IndicatorSet;
    spread: SpreadSnapshot;
    volume: VolumeSnapshot;
    riskReward: number | null;
    whale: WhaleSignal;
    sentiment: SentimentSignal;
    oneHourTrendConflict: boolean;
  },
): number {
  const { indicators, oneHourTrendConflict } = args;
  let danger = 10;

  // Structural danger only.  Data freshness, spread, raw liquidity, RR and
  // external opinions are eligibility/confidence concerns and must not get
  // silently counted again here.
  if (indicators.fiveMinute.atrPercent > 4 || indicators.fiveMinute.atrPercent < 0.2) {
    danger += 14;
  }
  if (Math.abs(indicators.fiveMinute.distanceFromEma20) > 2.4 || Math.abs(indicators.fiveMinute.distanceFromVwap) > 2.4) {
    danger += 10;
  }
  if (oneHourTrendConflict) {
    danger += 12;
  }

  return round(clamp(danger, 0, 100));
}

export function classifyStatus(args: {
  dataFresh: boolean;
  spreadAcceptable: boolean;
  direction: Direction;
  opportunityScore: number;
  confidence: number;
  dangerScore: number;
  riskReward: number | null;
  hasTradePlan: boolean;
  kronosAgrees?: boolean;
  liquidityScore: number;
  eligible?: boolean;
}): Candidate["status"] {
  const {
    dataFresh,
    spreadAcceptable,
    direction,
    opportunityScore,
    confidence,
    dangerScore,
    riskReward,
    hasTradePlan,
    liquidityScore,
    eligible = true,
  } = args;

  if (!eligible || !dataFresh || liquidityScore < 35 || !spreadAcceptable || dangerScore > 75 || direction === "NEUTRAL" || (riskReward ?? 0) < MIN_STRUCTURAL_RR) {
    return "SKIP";
  }
  if (
    opportunityScore >= 75 &&
    confidence >= 70 &&
    dangerScore <= 45 &&
    (riskReward ?? 0) >= MIN_EXECUTION_RR &&
    hasTradePlan
  ) {
    return "TRADE_NOW";
  }
  // Structural geometry may be worth observing, but it is not executable
  // until it clears the stricter execution RR. READY must not become a
  // side-door around the same admission threshold used by the resolver.
  if ((riskReward ?? 0) < MIN_EXECUTION_RR) {
    return "WAIT";
  }
  if (opportunityScore >= 68 && confidence >= 62 && dangerScore <= 55) {
    return "READY";
  }
  if (opportunityScore >= 60 && dangerScore <= 65) {
    return "WAIT";
  }
  if (opportunityScore >= 50 && dangerScore <= 70) {
    return "WATCH";
  }
  return "SKIP";
}

export function buildCandidate(input: CandidateBuildInput): Candidate {
  const spread = normalizeSpread(input.spread);
  const now = input.now ?? Date.now();
  const fiveMinute = calculateTimeframeIndicators(input.candles5m, "5m", now);
  const fifteenMinute = calculateTimeframeIndicators(input.candles15m, "15m", now);
  const oneHour = calculateTimeframeIndicators(input.candles1h, "1h", now);
  const fibonacci = calculateFibonacciLevels(completedCandles(input.candles1h, "1h", now));

  const longTrendComposite = round(scoreTrend(fiveMinute, "LONG") * 0.35 + scoreTrend(fifteenMinute, "LONG") * 0.25 + scoreTrend(oneHour, "LONG") * 0.4);
  const shortTrendComposite = round(scoreTrend(fiveMinute, "SHORT") * 0.35 + scoreTrend(fifteenMinute, "SHORT") * 0.25 + scoreTrend(oneHour, "SHORT") * 0.4);
  const { volumeScore, liquidityScore } = scoreVolume(input.volume, spread);
  const volatilityScore = scoreVolatility(fiveMinute.atrPercent);
  const longFibScore = scoreFibonacci(fiveMinute.latestClose, fibonacci, "LONG");
  const shortFibScore = scoreFibonacci(fiveMinute.latestClose, fibonacci, "SHORT");
  const optionalQuality = input.volume.volumeRatio5m === null || input.volume.quoteVolume24h === null || spread.percent === null
    ? null
    : (volumeScore + liquidityScore) / 2;
  const publicDirectionScore = (trend: number, fib: number): number => {
    const parts: Array<[number, number]> = [[trend, 0.65], [fib, 0.2], [volatilityScore, 0.1]];
    if (optionalQuality !== null) parts.push([optionalQuality, 0.05]);
    const weight = parts.reduce((total, [, partWeight]) => total + partWeight, 0);
    return round(parts.reduce((total, [value, partWeight]) => total + value * partWeight, 0) / weight);
  };
  // These public scores are the canonical directional decision.  Forecast,
  // whale, sentiment and telemetry cannot secretly choose a different side.
  const longScore = publicDirectionScore(longTrendComposite, longFibScore);
  const shortScore = publicDirectionScore(shortTrendComposite, shortFibScore);
  const direction = chooseDirection(longScore, shortScore);
  const atrPlan = buildAtrPlan(fiveMinute.latestClose, fiveMinute.atr14, fiveMinute.atrPercent, direction, fibonacci);
  const indicatorComposite = direction === "LONG" ? longTrendComposite : direction === "SHORT" ? shortTrendComposite : Math.max(longTrendComposite, shortTrendComposite);
  const opportunityScore = direction === "LONG" ? longScore : direction === "SHORT" ? shortScore : Math.max(longScore, shortScore);
  const riskReward = atrPlan.riskReward;
  const kronosScore = scoreKronos(input.kronos, direction);
  const oneHourTrendConflict =
    (direction === "LONG" && oneHour.trend === "BEARISH") || (direction === "SHORT" && oneHour.trend === "BULLISH");
  const indicators: IndicatorSet = {
    fiveMinute,
    fifteenMinute,
    oneHour,
    fibonacci,
    atr: atrPlan,
  };
  const dataQualityScore = computeDataQuality(indicators, spread, input.volume);
  const dangerScore = calculateDangerScore({
    direction,
    indicators,
    spread,
    volume: input.volume,
    riskReward,
    whale: input.whale,
    sentiment: input.sentiment,
    oneHourTrendConflict,
  });
  // Keep room for real external opinions.  A score margin is a confidence
  // contributor, not a substitute for certainty.
  const confidenceParts: Array<[number, number]> = [[clamp(50 + Math.abs(longScore - shortScore) * 1.5, 0, 100), 0.45]];
  if (input.kronos.available && input.kronos.kronosBias && input.kronos.kronosBias !== "NEUTRAL" && direction !== "NEUTRAL") {
    const strength = clamp(input.kronos.kronosConfidence ?? 50, 0, 100);
    confidenceParts.push([input.kronos.kronosBias === direction ? strength : 100 - strength, 0.25]);
  }
  const appendOpinion = (available: boolean, signal: WhaleSignal["signal"] | SentimentSignal["signal"], score: number, weight: number) => {
    if (available && direction !== "NEUTRAL" && signal !== "NEUTRAL" && signal !== "UNAVAILABLE") {
      confidenceParts.push([externalSignalContribution(signal, clamp(score, 0, 100), direction), weight]);
    }
  };
  appendOpinion(input.whale.available, input.whale.signal, input.whale.score, 0.2);
  appendOpinion(input.sentiment.available, input.sentiment.signal, input.sentiment.confidence ?? input.sentiment.score, sentimentWeight(input.sentiment) / 100);
  const confidenceWeight = confidenceParts.reduce((total, [, weight]) => total + weight, 0);
  const adjustedConfidence = round(confidenceParts.reduce((total, [value, weight]) => total + value * weight, 0) / confidenceWeight);
  const sourceConflict =
    (input.kronos.available && input.whale.available && input.kronos.kronosBias !== undefined &&
      ((input.kronos.kronosBias === "LONG" && input.whale.signal === "BEARISH") ||
        (input.kronos.kronosBias === "SHORT" && input.whale.signal === "BULLISH"))) ||
    (input.whale.available && direction !== "NEUTRAL" && externalSignalContribution(input.whale.signal, input.whale.score, direction) < 35) ||
    (input.sentiment.available && direction !== "NEUTRAL" && externalSignalContribution(input.sentiment.signal, input.sentiment.score, direction) < 35);
  const baseStatus = classifyStatus({
    dataFresh: [fiveMinute, fifteenMinute, oneHour].every((snapshot) => snapshot.isFresh),
    spreadAcceptable: spread.bid !== null && spread.ask !== null && spread.bid > 0 && spread.ask >= spread.bid && spread.percent !== null && spread.percent <= MAX_SCANNER_SPREAD_PERCENT,
    direction,
    opportunityScore,
    confidence: adjustedConfidence,
    dangerScore,
    riskReward,
    hasTradePlan: Boolean(atrPlan.stopLoss && atrPlan.takeProfit1 && atrPlan.takeProfit2 && atrPlan.takeProfit3),
    liquidityScore,
    eligible:
      [fiveMinute, fifteenMinute, oneHour].every((snapshot) => snapshot.ema200Available) &&
      input.volume.quoteVolume24h !== null && input.volume.quoteVolume24h >= MIN_RAW_QUOTE_VOLUME_24H,
  });
  const STRONG_AGAINST_THRESHOLD = 65;
  const whaleStronglyAgainst =
    input.whale.available &&
    ((direction === "LONG" && input.whale.signal === "BEARISH") ||
      (direction === "SHORT" && input.whale.signal === "BULLISH")) &&
    input.whale.score >= STRONG_AGAINST_THRESHOLD;
  const sentimentStronglyAgainst =
    input.sentiment.available &&
    ((direction === "LONG" && input.sentiment.signal === "BEARISH") ||
      (direction === "SHORT" && input.sentiment.signal === "BULLISH")) &&
    input.sentiment.score >= STRONG_AGAINST_THRESHOLD;
  const directionConflict = whaleStronglyAgainst || sentimentStronglyAgainst;
  const status = directionConflict ? capAtWait(baseStatus) : baseStatus;

  const reason: string[] = [];
  const blockers: string[] = [];

  if (direction === "LONG") {
    reason.push(`5m/15m/1h trend stack favors long continuation with ${fiveMinute.trend}/${fifteenMinute.trend}/${oneHour.trend}.`);
  } else if (direction === "SHORT") {
    reason.push(`5m/15m/1h trend stack favors short continuation with ${fiveMinute.trend}/${fifteenMinute.trend}/${oneHour.trend}.`);
  } else {
    blockers.push("Directional edge is weak because long and short scores are too close.");
  }
  if (input.volume.volumeRatio5m === null) {
    reason.push("5m volume ratio is unknown because recent volume data is incomplete.");
  } else if (input.volume.volumeRatio5m > 1) {
    reason.push(`5m volume ratio is ${input.volume.volumeRatio5m}, supporting current move quality.`);
  } else {
    blockers.push(`5m volume ratio is ${input.volume.volumeRatio5m}, below the preferred expansion threshold.`);
  }
  if (input.kronos.available) {
    reason.push(`Kronos bias is ${input.kronos.kronosBias} with ${input.kronos.kronosConfidence ?? 0} confidence.`);
  }
  if (input.whale.available && input.whale.reason) {
    reason.push(input.whale.reason);
  }
  if (input.sentiment.available && input.sentiment.reason) {
    reason.push(input.sentiment.reason);
  }
  if ((riskReward ?? 0) < MIN_EXECUTION_RR) {
    blockers.push(`Risk/reward is ${riskReward ?? 0}, below the execution threshold ${MIN_EXECUTION_RR}.`);
  } else if (riskReward) {
    reason.push(`Risk/reward is ${riskReward}, meeting the paper-trade threshold.`);
  }
  if (spread.percent !== null && spread.percent > MAX_SCANNER_SPREAD_PERCENT) {
    blockers.push(`Spread is ${spread.percent}% which is too wide for the main list.`);
  }
  if (spread.percent === null) {
    blockers.push("Spread is unavailable; scanner eligibility fails closed.");
  }
  if (input.volume.quoteVolume24h === null) {
    blockers.push("24h quote volume is unavailable; scanner eligibility fails closed.");
  } else if (input.volume.quoteVolume24h < MIN_RAW_QUOTE_VOLUME_24H) {
    blockers.push(`24h quote volume is below the required ${MIN_RAW_QUOTE_VOLUME_24H}.`);
  }
  if (![fiveMinute, fifteenMinute, oneHour].every((snapshot) => snapshot.ema200Available)) {
    blockers.push("EMA200 is unavailable: each timeframe requires 250 completed candles.");
  }
  if (![fiveMinute, fifteenMinute, oneHour].every((snapshot) => snapshot.isFresh)) {
    blockers.push("One or more Binance candle sets are stale.");
  }
  if (!atrPlan.stopLoss || !atrPlan.takeProfit1 || !atrPlan.takeProfit2 || !atrPlan.takeProfit3) {
    blockers.push("Trade plan is incomplete because entry, stop, or targets are invalid.");
  }
  if (sourceConflict) {
    reason.push(`SOURCE_CONFLICT: Kronos ${input.kronos.kronosBias} conflicts with whale ${input.whale.signal}.`);
  }
  if (directionConflict) {
    const parts = [
      whaleStronglyAgainst ? `whale ${input.whale.signal} (score ${input.whale.score})` : "",
      sentimentStronglyAgainst ? `sentiment ${input.sentiment.signal} (score ${input.sentiment.score})` : "",
    ].filter(Boolean);
    reason.push(`DIRECTION_CONFLICT: ${direction} capped at WAIT — ${parts.join(" and ")} strongly disagrees.`);
  }

  return {
    rank: 0,
    symbol: input.symbol,
    direction,
    status,
    longScore,
    shortScore,
    opportunityScore,
    dangerScore,
    confidence: adjustedConfidence,
    dataQualityScore,
    liquidityScore,
    volatilityScore,
    trendScore: round(indicatorComposite),
    volumeScore,
    kronosScore,
    finalDirection: direction,
    finalStatus: status,
    sourceConflict,
    directionConflict,
    kronosBias: input.kronos.available ? input.kronos.kronosBias ?? "NEUTRAL" : "UNAVAILABLE",
    kronosBias1h: input.kronos.available ? input.kronos.kronosBias1h ?? null : null,
    kronosBias4h: input.kronos.available ? input.kronos.kronosBias4h ?? null : null,
    selectedKronosBias: input.kronos.available ? input.kronos.selectedKronosBias ?? input.kronos.kronosBias ?? null : null,
    kronosConfidence: input.kronos.available ? input.kronos.kronosConfidence ?? null : null,
    kronosReason: input.kronos.available ? null : input.kronos.reason ?? "Kronos forecast unavailable.",
    kronosAvailabilityReasonCode: input.kronos.available ? null : input.kronos.availabilityReasonCode ?? "UNAVAILABLE",
    expectedReturn3: input.kronos.available ? input.kronos.expectedReturn3 ?? null : null,
    expectedReturn6: input.kronos.available ? input.kronos.expectedReturn6 ?? null : null,
    kronosRisk: input.kronos.available ? input.kronos.kronosRisk ?? null : null,
    currentPrice: input.kronos.available ? input.kronos.currentPrice ?? null : null,
    forecastMedianClose: input.kronos.available ? input.kronos.forecastMedianClose ?? null : null,
    forecastP25Close: input.kronos.available ? input.kronos.forecastP25Close ?? null : null,
    forecastP75Close: input.kronos.available ? input.kronos.forecastP75Close ?? null : null,
    forecastMaxHigh: input.kronos.available ? input.kronos.forecastMaxHigh ?? null : null,
    forecastMinLow: input.kronos.available ? input.kronos.forecastMinLow ?? null : null,
    expectedReturn15m: input.kronos.available ? input.kronos.expectedReturn15m ?? null : null,
    expectedReturn1h: input.kronos.available ? input.kronos.expectedReturn1h ?? null : null,
    expectedReturn4h: input.kronos.available ? input.kronos.expectedReturn4h ?? null : null,
    probabilityUp: input.kronos.available ? input.kronos.probabilityUp ?? null : null,
    probabilityDown: input.kronos.available ? input.kronos.probabilityDown ?? null : null,
    kronosConfidenceBucket: input.kronos.available ? input.kronos.kronosConfidenceBucket ?? null : null,
    horizonConflict: input.kronos.available ? input.kronos.horizonConflict ?? null : null,
    indicators,
    fibonacci,
    atr: atrPlan,
    volume: input.volume,
    spread,
    whale: input.whale,
    sentiment: input.sentiment,
    entryZone:
      atrPlan.entryZoneLow !== null && atrPlan.entryZoneHigh !== null
        ? [atrPlan.entryZoneLow, atrPlan.entryZoneHigh]
        : null,
    stopLoss: atrPlan.stopLoss,
    takeProfits: {
      tp1: atrPlan.takeProfit1,
      tp2: atrPlan.takeProfit2,
      tp3: atrPlan.takeProfit3,
    },
    riskReward,
    reason,
    blockers,
    chart: completedCandles(input.candles5m, "5m", now).slice(-60).map((candle) => ({
      time: Math.floor(candle.openTime / 1000),
      value: roundPrice(candle.close),
    })),
    candidateFingerprint: {
      policyVersion: DECISION_PIPELINE_POLICY_VERSION,
      symbol: input.symbol,
      direction,
      fiveMinuteSourceCloseTime: fiveMinute.sourceCandleCloseTime,
      fifteenMinuteSourceCloseTime: fifteenMinute.sourceCandleCloseTime,
      oneHourSourceCloseTime: oneHour.sourceCandleCloseTime,
      value: [
        DECISION_PIPELINE_POLICY_VERSION,
        input.symbol,
        direction,
        fiveMinute.sourceCandleCloseTime,
        fifteenMinute.sourceCandleCloseTime,
        oneHour.sourceCandleCloseTime,
      ].join(":"),
    },
  };
}

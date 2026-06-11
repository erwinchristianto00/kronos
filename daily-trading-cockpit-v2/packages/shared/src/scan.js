import { buildAtrPlan, calculateFibonacciLevels, calculateTimeframeIndicators, clamp, roundPrice, round, } from "./indicators.js";
function hasSourceConflict(kronos, whale) {
    if (!kronos.available || !whale.available || !kronos.kronosBias) {
        return false;
    }
    return ((kronos.kronosBias === "LONG" && whale.signal === "BEARISH") ||
        (kronos.kronosBias === "SHORT" && whale.signal === "BULLISH"));
}
function downgradeStatus(status) {
    switch (status) {
        case "TRADE_NOW":
            return "READY";
        case "READY":
            return "WAIT";
        case "WAIT":
            return "WATCH";
        case "WATCH":
            return "SKIP";
        default:
            return "SKIP";
    }
}
function normalizeSpread(spread) {
    const bid = spread.bid ?? null;
    const ask = spread.ask ?? null;
    const absolute = spread.absolute ?? (bid !== null && ask !== null ? Math.max(ask - bid, 0) : null);
    const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null;
    const percent = absolute !== null && mid !== null && mid > 0
        ? round((absolute / mid) * 100, 4)
        : spread.percent ?? null;
    return {
        bid,
        ask,
        absolute,
        percent,
    };
}
function externalSignalContribution(signal, score, direction) {
    if (signal === "UNAVAILABLE") {
        return 0;
    }
    if (signal === "NEUTRAL" || direction === "NEUTRAL") {
        return 50;
    }
    const aligns = (signal === "BULLISH" && direction === "LONG") ||
        (signal === "BEARISH" && direction === "SHORT");
    return aligns ? score : Math.max(0, 100 - score);
}
function sentimentWeight(sentiment) {
    if (!sentiment.available) {
        return 0;
    }
    return sentiment.scope === "SYMBOL" ? 10 : 5;
}
function scoreTrend(snapshot, direction) {
    const bullishTrend = snapshot.trend === "BULLISH" ? 30 : snapshot.trend === "SIDEWAYS" ? 15 : 0;
    const bearishTrend = snapshot.trend === "BEARISH" ? 30 : snapshot.trend === "SIDEWAYS" ? 15 : 0;
    const priceVsEma = direction === "LONG" ? 15 - Math.abs(snapshot.distanceFromEma20) * 1.4 : 15 - Math.abs(snapshot.distanceFromEma20) * 1.4;
    const priceVsVwap = 15 - Math.abs(snapshot.distanceFromVwap) * 1.2;
    const breakoutScore = direction === "LONG"
        ? snapshot.breakoutHigh
            ? 10
            : 0
        : snapshot.breakoutLow
            ? 10
            : 0;
    const macdScore = direction === "LONG"
        ? snapshot.macd.histogram > 0
            ? 15
            : 0
        : snapshot.macd.histogram < 0
            ? 15
            : 0;
    const rsiScore = direction === "LONG"
        ? clamp(20 - Math.abs(snapshot.rsi14 - 58), 0, 20)
        : clamp(20 - Math.abs(snapshot.rsi14 - 42), 0, 20);
    return clamp((direction === "LONG" ? bullishTrend : bearishTrend) +
        Math.max(priceVsEma, 0) +
        Math.max(priceVsVwap, 0) +
        breakoutScore +
        macdScore +
        rsiScore, 0, 100);
}
function scoreFibonacci(price, fib, direction) {
    if (direction === "NEUTRAL") {
        return 0;
    }
    const preferred = direction === "LONG"
        ? [fib.retracement382, fib.retracement500, fib.retracement618]
        : [fib.retracement236, fib.retracement382, fib.retracement500];
    const distance = Math.min(...preferred.map((level) => Math.abs((price - level) / level) * 100));
    return clamp(100 - distance * 35, 0, 100);
}
function scoreVolume(volume, spread) {
    const volumeRatio = volume.volumeRatio5m ?? 1;
    const quoteVolume = volume.quoteVolume24h ?? 10_000_000;
    const spreadPenalty = spread.percent === null ? 10 : spread.percent * 1400;
    const volumeScore = clamp(30 + volumeRatio * 35 + Math.log10(Math.max(quoteVolume, 1)) * 8, 0, 100);
    const liquidityScore = clamp(100 - spreadPenalty + Math.log10(Math.max(quoteVolume, 1)) * 10, 0, 100);
    return {
        volumeScore: round(volumeScore),
        liquidityScore: round(liquidityScore),
    };
}
function scoreVolatility(atrPercent) {
    const target = 1.2;
    const distance = Math.abs(atrPercent - target);
    return round(clamp(100 - distance * 35, 0, 100));
}
function scoreKronos(kronos, direction) {
    if (!kronos.available || direction === "NEUTRAL") {
        return 0;
    }
    const probability = direction === "LONG" ? kronos.kronosLongProbability ?? 0 : kronos.kronosShortProbability ?? 0;
    return round(clamp(probability * 0.7 + (kronos.kronosConfidence ?? 0) * 0.3, 0, 100));
}
function computeDataQuality(indicators, spread, volume) {
    const freshnessScore = [indicators.fiveMinute, indicators.fifteenMinute, indicators.oneHour].every((snapshot) => snapshot.isFresh)
        ? 100
        : 40;
    const spreadPenalty = spread.percent === null ? 0 : clamp(spread.percent * 1200, 0, 30);
    const volumePenalty = volume.quoteVolume24h !== null && volume.quoteVolume24h < 10_000_000 ? 20 : 0;
    return round(clamp(freshnessScore - spreadPenalty - volumePenalty, 0, 100));
}
export function chooseDirection(longScore, shortScore) {
    if (Math.abs(longScore - shortScore) < 8 || Math.max(longScore, shortScore) < 52) {
        return "NEUTRAL";
    }
    return longScore > shortScore ? "LONG" : "SHORT";
}
export function calculateDangerScore(args) {
    const { indicators, spread, volume, riskReward, whale, sentiment, oneHourTrendConflict } = args;
    let danger = 10;
    if (![indicators.fiveMinute, indicators.fifteenMinute, indicators.oneHour].every((snapshot) => snapshot.isFresh)) {
        danger += 28;
    }
    if (spread.percent !== null && spread.percent > 0.12) {
        danger += 18;
    }
    if (indicators.fiveMinute.atrPercent > 4 || indicators.fiveMinute.atrPercent < 0.2) {
        danger += 14;
    }
    if (Math.abs(indicators.fiveMinute.distanceFromEma20) > 2.4 || Math.abs(indicators.fiveMinute.distanceFromVwap) > 2.4) {
        danger += 10;
    }
    if ((volume.volumeRatio5m !== null && volume.volumeRatio5m < 0.9) || (volume.quoteVolume24h !== null && volume.quoteVolume24h < 10_000_000)) {
        danger += 12;
    }
    if ((riskReward ?? 0) < 1.5) {
        danger += 15;
    }
    if (oneHourTrendConflict) {
        danger += 12;
    }
    if (whale.available &&
        ((args.direction === "LONG" && whale.signal === "BEARISH") ||
            (args.direction === "SHORT" && whale.signal === "BULLISH"))) {
        danger += 6;
    }
    if (sentiment.available &&
        ((args.direction === "LONG" && sentiment.signal === "BEARISH") ||
            (args.direction === "SHORT" && sentiment.signal === "BULLISH"))) {
        danger += 6;
    }
    return round(clamp(danger, 0, 100));
}
export function classifyStatus(args) {
    const { dataFresh, spreadAcceptable, direction, opportunityScore, confidence, dangerScore, riskReward, hasTradePlan, kronosAgrees, liquidityScore, } = args;
    if (!dataFresh || liquidityScore < 35 || !spreadAcceptable || dangerScore > 75 || direction === "NEUTRAL" || (riskReward ?? 0) < 1.2) {
        return "SKIP";
    }
    if (opportunityScore >= 75 &&
        confidence >= 70 &&
        dangerScore <= 45 &&
        (riskReward ?? 0) >= 1.5 &&
        hasTradePlan &&
        kronosAgrees) {
        return "TRADE_NOW";
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
export function buildCandidate(input) {
    const spread = normalizeSpread(input.spread);
    const now = input.now ?? Date.now();
    const fiveMinute = calculateTimeframeIndicators(input.candles5m, "5m", now);
    const fifteenMinute = calculateTimeframeIndicators(input.candles15m, "15m", now);
    const oneHour = calculateTimeframeIndicators(input.candles1h, "1h", now);
    const fibonacci = calculateFibonacciLevels(input.candles1h);
    const longTrendComposite = round(scoreTrend(fiveMinute, "LONG") * 0.35 + scoreTrend(fifteenMinute, "LONG") * 0.25 + scoreTrend(oneHour, "LONG") * 0.4);
    const shortTrendComposite = round(scoreTrend(fiveMinute, "SHORT") * 0.35 + scoreTrend(fifteenMinute, "SHORT") * 0.25 + scoreTrend(oneHour, "SHORT") * 0.4);
    const direction = chooseDirection(longTrendComposite, shortTrendComposite);
    const atrPlan = buildAtrPlan(fiveMinute.latestClose, fiveMinute.atr14, fiveMinute.atrPercent, direction, fibonacci);
    const fibonacciScore = scoreFibonacci(fiveMinute.latestClose, fibonacci, direction);
    const { volumeScore, liquidityScore } = scoreVolume(input.volume, spread);
    const volatilityScore = scoreVolatility(fiveMinute.atrPercent);
    const kronosScore = scoreKronos(input.kronos, direction);
    const whaleComponent = input.whale.available ? externalSignalContribution(input.whale.signal, input.whale.score, direction) : 0;
    const sentimentComponent = input.sentiment.available ? externalSignalContribution(input.sentiment.signal, input.sentiment.score, direction) : 0;
    const socialWeight = sentimentWeight(input.sentiment);
    const activeWeight = (input.kronos.available ? 35 : 0) + 25 + 15 + 10 + 10 + (input.whale.available ? 5 : 0) + socialWeight;
    const indicatorComposite = direction === "LONG" ? longTrendComposite : direction === "SHORT" ? shortTrendComposite : Math.max(longTrendComposite, shortTrendComposite);
    const opportunityScore = round((kronosScore * (input.kronos.available ? 35 : 0) +
        indicatorComposite * 25 +
        ((volumeScore + liquidityScore) / 2) * 15 +
        volatilityScore * 10 +
        fibonacciScore * 10 +
        whaleComponent * (input.whale.available ? 5 : 0) +
        sentimentComponent * socialWeight) / Math.max(activeWeight, 1));
    const riskReward = atrPlan.riskReward;
    const oneHourTrendConflict = (direction === "LONG" && oneHour.trend === "BEARISH") || (direction === "SHORT" && oneHour.trend === "BULLISH");
    const indicators = {
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
    const confidenceWeight = 45 + 20 + 20 + (input.kronos.available ? 15 : 0);
    const confidenceBase = (opportunityScore * 45 +
        dataQualityScore * 20 +
        indicatorComposite * 20 +
        kronosScore * (input.kronos.available ? 15 : 0)) /
        Math.max(confidenceWeight, 1);
    const conflictPenalty = (oneHourTrendConflict ? 6 : 0) +
        (input.whale.available &&
            ((direction === "LONG" && input.whale.signal === "BEARISH") ||
                (direction === "SHORT" && input.whale.signal === "BULLISH"))
            ? 4
            : 0) +
        (input.sentiment.available &&
            ((direction === "LONG" && input.sentiment.signal === "BEARISH") ||
                (direction === "SHORT" && input.sentiment.signal === "BULLISH"))
            ? 4
            : 0);
    const confidence = round(clamp(confidenceBase - dangerScore * 0.15 - conflictPenalty, 0, 100));
    const sentimentAlignment = input.sentiment.available && direction !== "NEUTRAL"
        ? input.sentiment.signal === "NEUTRAL"
            ? 0
            : (input.sentiment.signal === "BULLISH" && direction === "LONG") ||
                (input.sentiment.signal === "BEARISH" && direction === "SHORT")
                ? 1
                : -1
        : 0;
    const adjustedConfidence = round(clamp(confidence +
        sentimentAlignment *
            (((input.sentiment.confidence ?? input.sentiment.score) / 100) * (input.sentiment.scope === "SYMBOL" ? 4 : 2)), 0, 100));
    const kronosAgrees = input.kronos.available && input.kronos.kronosBias
        ? input.kronos.kronosBias === direction
        : false;
    const sourceConflict = hasSourceConflict(input.kronos, input.whale);
    const baseStatus = classifyStatus({
        dataFresh: [fiveMinute, fifteenMinute, oneHour].every((snapshot) => snapshot.isFresh),
        spreadAcceptable: spread.percent === null || spread.percent <= 0.12,
        direction,
        opportunityScore,
        confidence: adjustedConfidence,
        dangerScore,
        riskReward,
        hasTradePlan: Boolean(atrPlan.stopLoss && atrPlan.takeProfit1 && atrPlan.takeProfit2 && atrPlan.takeProfit3),
        kronosAgrees,
        liquidityScore,
    });
    const afterSourceConflict = sourceConflict ? downgradeStatus(baseStatus) : baseStatus;
    const STRONG_AGAINST_THRESHOLD = 65;
    const whaleStronglyAgainst = input.whale.available &&
        ((direction === "LONG" && input.whale.signal === "BEARISH") ||
            (direction === "SHORT" && input.whale.signal === "BULLISH")) &&
        input.whale.score >= STRONG_AGAINST_THRESHOLD;
    const sentimentStronglyAgainst = input.sentiment.available &&
        ((direction === "LONG" && input.sentiment.signal === "BEARISH") ||
            (direction === "SHORT" && input.sentiment.signal === "BULLISH")) &&
        input.sentiment.score >= STRONG_AGAINST_THRESHOLD;
    const directionConflict = whaleStronglyAgainst || sentimentStronglyAgainst;
    const status = directionConflict ? capAtWait(afterSourceConflict) : afterSourceConflict;
    const longScore = round(clamp(longTrendComposite * 0.55 +
        volumeScore * 0.15 +
        volatilityScore * 0.1 +
        (input.kronos.available ? (input.kronos.kronosLongProbability ?? 0) : 0) * 0.2, 0, 100));
    const shortScore = round(clamp(shortTrendComposite * 0.55 +
        volumeScore * 0.15 +
        volatilityScore * 0.1 +
        (input.kronos.available ? (input.kronos.kronosShortProbability ?? 0) : 0) * 0.2, 0, 100));
    const reason = [];
    const blockers = [];
    if (direction === "LONG") {
        reason.push(`5m/15m/1h trend stack favors long continuation with ${fiveMinute.trend}/${fifteenMinute.trend}/${oneHour.trend}.`);
    }
    else if (direction === "SHORT") {
        reason.push(`5m/15m/1h trend stack favors short continuation with ${fiveMinute.trend}/${fifteenMinute.trend}/${oneHour.trend}.`);
    }
    else {
        blockers.push("Directional edge is weak because long and short scores are too close.");
    }
    if (input.volume.volumeRatio5m === null) {
        reason.push("5m volume ratio is unknown because recent volume data is incomplete.");
    }
    else if (input.volume.volumeRatio5m > 1) {
        reason.push(`5m volume ratio is ${input.volume.volumeRatio5m}, supporting current move quality.`);
    }
    else {
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
    if ((riskReward ?? 0) < 1.5) {
        blockers.push(`Risk/reward is ${riskReward ?? 0}, below the preferred 1.5 threshold.`);
    }
    else if (riskReward) {
        reason.push(`Risk/reward is ${riskReward}, meeting the paper-trade threshold.`);
    }
    if (spread.percent !== null && spread.percent > 0.12) {
        blockers.push(`Spread is ${spread.percent}% which is too wide for the main list.`);
    }
    if (spread.percent === null) {
        reason.push("Spread is unknown, so liquidity checks stay neutral instead of punitive.");
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
        reason.push(`DIRECTION_CONFLICT: ${direction} capped at WAIT - ${parts.join(" and ")} strongly disagrees.`);
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
        indicators,
        fibonacci,
        atr: atrPlan,
        volume: input.volume,
        spread,
        whale: input.whale,
        sentiment: input.sentiment,
        entryZone: atrPlan.entryZoneLow !== null && atrPlan.entryZoneHigh !== null
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
        chart: input.candles5m.slice(-60).map((candle) => ({
            time: Math.floor(candle.openTime / 1000),
            value: roundPrice(candle.close),
        })),
    };
}
//# sourceMappingURL=scan.js.map

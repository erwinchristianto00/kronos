import type { Candidate, EntryPlaybook, EntryTimingAction, ExitMode, TradePlanSnapshot } from "./types.js";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function effectiveEntryZone(candidate: Candidate): [number, number] | null {
  if (candidate.entryZone) return candidate.entryZone;
  if (candidate.atr.entryZoneLow !== null && candidate.atr.entryZoneHigh !== null) {
    return [candidate.atr.entryZoneLow, candidate.atr.entryZoneHigh];
  }
  if (candidate.finalDirection === "LONG") {
    return [candidate.fibonacci.retracement500, candidate.fibonacci.retracement382];
  }
  return [candidate.fibonacci.retracement382, candidate.fibonacci.retracement500];
}

function effectiveStopLoss(candidate: Candidate): number | null {
  if (candidate.stopLoss !== null) return candidate.stopLoss;
  if (candidate.atr.stopLoss !== null) return candidate.atr.stopLoss;
  if (candidate.finalDirection === "LONG") {
    return Math.min(candidate.fibonacci.retracement618, candidate.indicators.fiveMinute.support);
  }
  return Math.max(candidate.fibonacci.retracement382, candidate.indicators.fiveMinute.resistance);
}

function effectiveTakeProfits(candidate: Candidate) {
  const shortRange = Math.max(candidate.fibonacci.recentHigh - candidate.fibonacci.recentLow, 0);
  const tp2 =
    candidate.takeProfits.tp2 ??
    candidate.atr.takeProfit2 ??
    (candidate.finalDirection === "LONG"
      ? candidate.fibonacci.extension1272
      : candidate.fibonacci.recentLow - shortRange * 0.272);
  const tp3 =
    candidate.takeProfits.tp3 ??
    candidate.atr.takeProfit3 ??
    (candidate.finalDirection === "LONG"
      ? candidate.fibonacci.extension1618
      : candidate.fibonacci.recentLow - shortRange * 0.618);
  // The fallback tp1 mixes a short-lookback indicator (5m support/resistance) with a
  // long-lookback Fibonacci level via min/max, unlike tp2/tp3 which share one anchor —
  // so it has no natural ordering guarantee against tp2. Clamp it so tp1 always stays the
  // *nearest* target; otherwise a partial-exit ladder can book its "first" target at a
  // worse price than its "second" one.
  const fallbackTp1 =
    candidate.finalDirection === "LONG"
      ? Math.min(Math.max(candidate.indicators.fiveMinute.resistance, candidate.fibonacci.retracement236), tp2)
      : Math.max(Math.min(candidate.indicators.fiveMinute.support, candidate.fibonacci.retracement618), tp2);
  const tp1 = candidate.takeProfits.tp1 ?? candidate.atr.takeProfit1 ?? fallbackTp1;
  return { tp1, tp2, tp3 };
}

function effectiveRiskReward(candidate: Candidate): number | null {
  if (candidate.riskReward !== null) return candidate.riskReward;
  if (candidate.atr.riskReward !== null) return candidate.atr.riskReward;
  const mid = entryMid(candidate);
  const stop = effectiveStopLoss(candidate);
  const targets = effectiveTakeProfits(candidate);
  const target = targets.tp1;
  if (mid === null || stop === null || target === null) return null;
  const risk = Math.abs(mid - stop);
  if (!Number.isFinite(risk) || risk <= 0) return null;
  const reward =
    candidate.finalDirection === "LONG"
      ? target - mid
      : mid - target;
  if (!Number.isFinite(reward)) return null;
  return round(reward / risk, 2);
}

function entryMid(candidate: Candidate): number | null {
  const zone = effectiveEntryZone(candidate);
  if (!zone) return null;
  return (zone[0] + zone[1]) / 2;
}

function driftAtr(candidate: Candidate): number | null {
  const mid = entryMid(candidate);
  const atr = candidate.indicators.fiveMinute.atr14;
  if (mid === null || !Number.isFinite(mid) || !Number.isFinite(atr) || atr <= 0) {
    return null;
  }
  return Math.abs(candidate.indicators.fiveMinute.latestClose - mid) / atr;
}

function directionGap(candidate: Candidate) {
  return round(Math.abs(candidate.longScore - candidate.shortScore), 2);
}

function directionQuality(candidate: Candidate): TradePlanSnapshot["directionQuality"] {
  const gap = directionGap(candidate);
  if (gap >= 15) return "CLEAR";
  if (gap >= 5) return "MIXED";
  return "NO_EDGE";
}

function chooseEntryPlaybook(candidate: Candidate): EntryPlaybook {
  const price = candidate.indicators.fiveMinute.latestClose;
  const fib = candidate.fibonacci;
  const atr = candidate.indicators.fiveMinute.atr14;
  const zone = effectiveEntryZone(candidate);
  const mid = entryMid(candidate);
  const insideOrNearEntryZone =
    zone !== null &&
    (price >= zone[0] && price <= zone[1] ||
      (mid !== null && Number.isFinite(atr) && atr > 0 && Math.abs(price - mid) <= atr * 0.5));
  const nearFibBand =
    price >= Math.min(fib.retracement382, fib.retracement618) &&
    price <= Math.max(fib.retracement382, fib.retracement618);

  if (candidate.finalDirection === "LONG") {
    if (
      insideOrNearEntryZone ||
      nearFibBand ||
      price >= candidate.indicators.fiveMinute.ema20 ||
      price >= candidate.indicators.fiveMinute.vwap
    ) {
      return "PULLBACK_RECLAIM";
    }
    if (candidate.indicators.fiveMinute.breakoutHigh || price >= candidate.indicators.fiveMinute.resistance) {
      return "BREAKOUT_RETEST";
    }
    return "LIQUIDITY_SWEEP_RECLAIM";
  }

  if (
    insideOrNearEntryZone ||
    nearFibBand ||
    price <= candidate.indicators.fiveMinute.ema20 ||
    price <= candidate.indicators.fiveMinute.vwap
  ) {
    return "RETRACE_REJECTION";
  }
  if (candidate.indicators.fiveMinute.breakoutLow || price <= candidate.indicators.fiveMinute.support) {
    return "BREAKDOWN_RETEST";
  }
  return "LIQUIDITY_SWEEP_REJECTION";
}

function invalidated(candidate: Candidate): boolean {
  const price = candidate.indicators.fiveMinute.latestClose;
  const atr = candidate.indicators.fiveMinute.atr14;
  if (!Number.isFinite(price) || !Number.isFinite(atr) || atr <= 0) return false;
  const zone = effectiveEntryZone(candidate);
  if (candidate.finalDirection === "LONG") {
    const floor = Math.min(
      zone?.[0] ?? Number.POSITIVE_INFINITY,
      candidate.indicators.fiveMinute.support,
      candidate.fibonacci.retracement618,
    );
    return price < floor - atr * 0.25;
  }
  const ceiling = Math.max(
    zone?.[1] ?? Number.NEGATIVE_INFINITY,
    candidate.indicators.fiveMinute.resistance,
    candidate.fibonacci.retracement382,
  );
  return price > ceiling + atr * 0.25;
}

function entryAction(candidate: Candidate): EntryTimingAction {
  if (invalidated(candidate)) return "CANCEL_IF_INVALIDATED";
  const drift = driftAtr(candidate);
  if (drift === null) return "WAIT_BETTER_ENTRY";
  if (drift <= 0.5) return "ENTER_ON_TRIGGER";
  if (drift <= 1) return "WAIT_BETTER_ENTRY";
  return "NO_CHASE";
}

function triggerText(candidate: Candidate, playbook: EntryPlaybook): string {
  switch (playbook) {
    case "PULLBACK_RECLAIM":
      return "Enter only if 5m candle reclaims VWAP/EMA20 after pullback.";
    case "BREAKOUT_RETEST":
      return "Wait for breakout retest to hold as support before entering.";
    case "LIQUIDITY_SWEEP_RECLAIM":
      return "Enter after liquidity sweep low is reclaimed and held on 5m.";
    case "RETRACE_REJECTION":
      return "Enter only if retrace rejects VWAP/EMA20 on 5m.";
    case "BREAKDOWN_RETEST":
      return "Wait for breakdown retest to fail before entering.";
    case "LIQUIDITY_SWEEP_REJECTION":
      return "Enter after liquidity sweep high is rejected on 5m.";
  }
}

function kronosContinuation(candidate: Candidate): boolean {
  if (candidate.kronosBias === "UNAVAILABLE" || candidate.kronosConfidenceBucket === "WEAK" || candidate.horizonConflict) return false;
  if (candidate.finalDirection === "LONG") {
    return (candidate.selectedKronosBias ?? candidate.kronosBias) === "LONG" &&
      (candidate.expectedReturn1h ?? 0) > 0 &&
      (candidate.expectedReturn4h ?? 0) > 0 &&
      (candidate.probabilityUp ?? 0) >= (candidate.probabilityDown ?? 0);
  }
  return (candidate.selectedKronosBias ?? candidate.kronosBias) === "SHORT" &&
    (candidate.expectedReturn1h ?? 0) < 0 &&
    (candidate.expectedReturn4h ?? 0) < 0 &&
    (candidate.probabilityDown ?? 0) >= (candidate.probabilityUp ?? 0);
}

function shortHorizonOnly(candidate: Candidate): boolean {
  if (candidate.kronosBias === "UNAVAILABLE") return false;
  if (candidate.finalDirection === "LONG") {
    return (candidate.expectedReturn1h ?? 0) > 0 && (candidate.expectedReturn4h ?? 0) < 0;
  }
  return (candidate.expectedReturn1h ?? 0) < 0 && (candidate.expectedReturn4h ?? 0) > 0;
}

function whaleAgree(candidate: Candidate): boolean {
  return (candidate.finalDirection === "LONG" && candidate.whale.signal === "BULLISH") ||
    (candidate.finalDirection === "SHORT" && candidate.whale.signal === "BEARISH");
}

function whaleConflict(candidate: Candidate): boolean {
  return (candidate.finalDirection === "LONG" && candidate.whale.signal === "BEARISH") ||
    (candidate.finalDirection === "SHORT" && candidate.whale.signal === "BULLISH");
}

function weakVolume(candidate: Candidate): boolean {
  return (candidate.volume.volumeRatio5m ?? 0) < 1;
}

function runnerAllowed(candidate: Candidate): boolean {
  const targets = effectiveTakeProfits(candidate);
  return candidate.finalDirection !== "NEUTRAL" &&
    !shortHorizonOnly(candidate) &&
    !candidate.horizonConflict &&
    kronosContinuation(candidate) &&
    !whaleConflict(candidate) &&
    !weakVolume(candidate) &&
    (effectiveRiskReward(candidate) ?? 0) >= 1.5 &&
    (
      candidate.finalDirection === "LONG"
        ? (candidate.forecastMaxHigh ?? Number.NEGATIVE_INFINITY) >= (targets.tp2 ?? Number.POSITIVE_INFINITY)
        : (candidate.forecastMinLow ?? Number.POSITIVE_INFINITY) <= (targets.tp2 ?? Number.NEGATIVE_INFINITY)
    );
}

function exitMode(candidate: Candidate): ExitMode {
  if (whaleConflict(candidate)) return "EXIT_ON_WHALE_FLIP";
  if (candidate.kronosBias !== "UNAVAILABLE" && candidate.kronosBias !== candidate.finalDirection && candidate.kronosConfidenceBucket !== "WEAK") {
    return "EXIT_ON_KRONOS_FLIP";
  }
  if (shortHorizonOnly(candidate) || candidate.horizonConflict) {
    return "TP1_FAST";
  }
  if (runnerAllowed(candidate) && directionQuality(candidate) === "CLEAR") {
    return candidate.kronosConfidenceBucket === "STRONG" ? "TRAIL_AFTER_TP1" : "TP1_PARTIAL_RUNNER";
  }
  if (candidate.finalDirection === "LONG" && candidate.indicators.fiveMinute.latestClose < candidate.indicators.fiveMinute.vwap) {
    return "EXIT_ON_VWAP_LOSS";
  }
  if (candidate.finalDirection === "SHORT" && candidate.indicators.fiveMinute.latestClose > candidate.indicators.fiveMinute.vwap) {
    return "EXIT_ON_VWAP_LOSS";
  }
  return "TP1_FAST";
}

function stagedEntrySplit(candidate: Candidate): string {
  const action = entryAction(candidate);
  if (directionQuality(candidate) === "NO_EDGE") return "0% / wait only";
  if (action === "ENTER_ON_TRIGGER") return "50% on trigger, 50% on retest confirmation";
  if (action === "WAIT_BETTER_ENTRY") return "0% until better reclaim / retest";
  if (action === "NO_CHASE") return "0% until price returns toward entry zone";
  return "0% cancelled if invalidated";
}

function stagedExitSplit(candidate: Candidate): string {
  if (shortHorizonOnly(candidate) || candidate.horizonConflict) {
    return "TP1 fast, no runner";
  }
  if (!runnerAllowed(candidate) || directionQuality(candidate) === "NO_EDGE") {
    return "TP1 70-100%, no runner";
  }
  return "TP1 40%, TP2 40%, runner 20%";
}

function noChaseWarning(candidate: Candidate): string | null {
  const drift = driftAtr(candidate);
  if (drift === null || drift <= 1) return null;
  return `No chase: price is ${round(drift, 2)} ATR from ideal entry. Wait for pullback / retest.`;
}

function invalidationText(candidate: Candidate): string[] {
  if (candidate.finalDirection === "LONG") {
    return [
      "Close below VWAP / EMA20 after entry.",
      "Reclaim fails after pullback.",
      "Break below support or sweep low.",
      "Whale flips bearish.",
      "Kronos forecast flips negative.",
    ];
  }
  return [
    "Close above VWAP / EMA20 after entry.",
    "Rejection fails after retrace.",
    "Break above resistance or sweep high.",
    "Whale flips bullish.",
    "Kronos forecast flips positive.",
  ];
}

function earlyExitCondition(candidate: Candidate): string {
  if (whaleConflict(candidate)) return "Exit early if whale flow flips against the trade after entry.";
  if (candidate.kronosBias !== "UNAVAILABLE" && candidate.kronosBias !== candidate.finalDirection) {
    return "Exit early if Kronos forecast stays flipped against direction.";
  }
  if (shortHorizonOnly(candidate) || candidate.horizonConflict) {
    return "Short-horizon bias only; take TP1 fast and avoid holding a runner if the 4h path disagrees.";
  }
  if (weakVolume(candidate)) return "Take TP1 faster if breakout volume does not expand.";
  return "Reduce or exit if VWAP/EMA20 loses support for the trade direction.";
}

export function buildTradePlan(candidate: Candidate): TradePlanSnapshot {
  const gap = directionGap(candidate);
  const quality = directionQuality(candidate);
  const playbook = chooseEntryPlaybook(candidate);
  const action = entryAction(candidate);
  const horizonOnly = shortHorizonOnly(candidate);
  const horizonConflict = candidate.horizonConflict ?? false;
  const runner = runnerAllowed(candidate);
  const mode = exitMode(candidate);
  const targets = effectiveTakeProfits(candidate);
  const why = [
    `Direction gap is ${gap}, so bias is ${quality}.`,
    whaleAgree(candidate) ? "Whale flow supports the direction." : whaleConflict(candidate) ? "Whale flow conflicts with the direction." : "Whale flow is neutral / unavailable.",
    horizonOnly ? "Kronos only supports the short horizon, so TP1 should be managed fast with no runner." :
      horizonConflict ? "Kronos horizons conflict, so continuation guidance stays conservative." :
      kronosContinuation(candidate) ? "Kronos forecast path supports continuation." : "Kronos does not support an aggressive runner.",
    weakVolume(candidate) ? "5m volume is not yet strong enough for chasing." : "5m volume is supportive enough for trigger confirmation.",
  ];

  return {
    directionGap: gap,
    directionQuality: quality,
    biasSummary: `${candidate.finalDirection} bias with ${quality.toLowerCase()} directional dominance.`,
    entryPlaybook: playbook,
    entryAction: action,
    exactEntryTrigger: triggerText(candidate, playbook),
    noChaseWarning: noChaseWarning(candidate),
    invalidation: invalidationText(candidate),
    stopLoss: effectiveStopLoss(candidate),
    takeProfit1: targets.tp1,
    takeProfit2: targets.tp2,
    takeProfit3: targets.tp3,
    exitMode: mode,
    earlyExitCondition: earlyExitCondition(candidate),
    runnerAllowed: runner,
    horizonConflict,
    shortHorizonOnly: horizonOnly,
    stagedEntrySplit: stagedEntrySplit(candidate),
    stagedExitSplit: stagedExitSplit(candidate),
    why,
  };
}

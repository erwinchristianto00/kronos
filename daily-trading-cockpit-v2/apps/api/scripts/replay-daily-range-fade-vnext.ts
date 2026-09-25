/**
 * Read-only, Testnet-source-compatible replay for the Daily Range FADE VNext
 * experiment. It is intentionally hard-bound to the public USD-M Testnet
 * endpoint: this script has no private client, credentials, order endpoints,
 * state writes, or Mainnet fallback.
 *
 * Input is a copied Daily Range Testnet state file.  Each historical episode
 * is replayed with its frozen range / sweep facts, but current V5 geometry:
 * sweep-buffered stop, opposite-range native target, and the requested trail
 * variants. One-minute OHLC cannot prove an intrabar order; any bar that can
 * produce materially different terminal outcomes is classified AMBIGUOUS and
 * excluded from policy selection instead of being optimistically resolved.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  dailyRangeFadeVNextParameters,
  evaluateDailyRangeFadeSoftInvalidation,
  evaluateDailyRangeFadeStrictEntry,
  type DailyRangeFadeVNextCandle,
  type DailyRangeFadeVNextParameters,
  type DailyRangeFadeVNextVariant,
} from "../src/lib/daily-range-fade-vnext.js";
import { structuralStopForDailyRangeFadeSweep } from "../src/lib/daily-4h-range-acceptance-lane.js";

const TESTNET_ORIGIN = "https://testnet.binancefuture.com";
const MINUTE_MS = 60_000;
const HORIZON_MINUTES = 1_500;
const EPSILON = 1e-10;
const VARIANTS: readonly DailyRangeFadeVNextVariant[] = [
  "BASELINE",
  "STRICTER_ENTRY",
  "LATER_TRAIL",
  "SOFT_INVALIDATION",
  "HYBRID",
];

type Direction = "LONG" | "SHORT";
type BreakoutDirection = "UP" | "DOWN";
type ExitReason = "SL" | "TP" | "TRAIL" | "SOFT" | "TIMEOUT";
type ResultStatus = "EXECUTED" | "STRICT_REJECTED" | "INVALID_INPUT" | "UNAVAILABLE" | "AMBIGUOUS";

interface StoredTrade {
  tradeId?: string;
  symbol?: string;
  direction?: Direction;
  entryPolicy?: string | null;
  entryFillPrice?: number | null;
  entryFilledAt?: string | null;
  entryQty?: number | null;
  entryNotionalUsd?: number | null;
  signalTimestamp?: string | null;
  signalTimestampMs?: number | null;
  rangeLow?: number;
  rangeHigh?: number;
  breakoutDirection?: BreakoutDirection | null;
  breakoutExtreme?: number | null;
  status?: string;
}

interface StateFile {
  trades?: StoredTrade[];
  frictionModels?: Array<{
    id?: string;
    cutoffAt?: string;
    entryFeeP95Bps?: number;
    exitFeeP95Bps?: number;
    entryAdverseP95Bps?: number;
    takeProfitExitAdverseP50Bps?: number;
  }>;
}

interface Candle extends DailyRangeFadeVNextCandle {}

interface Episode {
  trade: StoredTrade;
  tradeId: string;
  symbol: string;
  direction: Direction;
  breakoutDirection: BreakoutDirection;
  sweepExtreme: number;
  rangeLow: number;
  rangeHigh: number;
  signalAtMs: number;
  baselineEntryAtMs: number;
  baselineEntry: number;
  quantity: number;
  notionalUsd: number;
}

interface ReplayResult {
  tradeId: string;
  symbol: string;
  variant: DailyRangeFadeVNextVariant;
  status: ResultStatus;
  detail: string | null;
  entryAt: string | null;
  entryPrice: number | null;
  stopPrice: number | null;
  takeProfitPrice: number | null;
  exitAt: string | null;
  exitPrice: number | null;
  exitReason: ExitReason | null;
  grossPnlUsd: number | null;
  netPnlUsd: number | null;
  netR: number | null;
  holdMinutes: number | null;
  mfeR: number | null;
  maeR: number | null;
  peakR: number | null;
  trailFloorR: number | null;
  entryPartialMinute: boolean;
  stopFollowThrough: "CONTINUED_BREAKOUT" | "REVERTED_TO_RANGE" | "INSUFFICIENT_PATH" | null;
}

interface Friction {
  feeBps: number;
  exitSlippageBps: number;
  entrySlippageBps: number;
  source: string;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finitePositive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function asIso(ms: number): string {
  return new Date(ms).toISOString();
}

function minuteOpen(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

function minuteAfter(ms: number): number {
  return minuteOpen(ms) + MINUTE_MS;
}

function parseCandle(row: unknown): Candle | null {
  const raw = Array.isArray(row) && row.length >= 7
    ? {
      openTime: row[0],
      open: row[1],
      high: row[2],
      low: row[3],
      close: row[4],
      closeTime: row[6],
    }
    : row !== null && typeof row === "object"
      ? row as Record<string, unknown>
      : null;
  if (!raw) return null;
  const candle: Candle = {
    openTime: Number(raw.openTime),
    closeTime: Number(raw.closeTime),
    open: Number(raw.open),
    high: Number(raw.high),
    low: Number(raw.low),
    close: Number(raw.close),
  };
  return [candle.openTime, candle.closeTime, candle.open, candle.high, candle.low, candle.close]
    .every(Number.isFinite)
    && candle.closeTime === candle.openTime + MINUTE_MS - 1
    && candle.high >= Math.max(candle.open, candle.close)
    && candle.low <= Math.min(candle.open, candle.close)
    ? candle
    : null;
}

function parseStateEpisodes(state: StateFile): Episode[] {
  return (state.trades ?? [])
    .filter((trade) => trade.entryPolicy === "FADE")
    .flatMap((trade): Episode[] => {
      const baselineEntryAtMs = Date.parse(trade.entryFilledAt ?? "");
      const signalAtMs = finite(trade.signalTimestampMs)
        ? trade.signalTimestampMs
        : Date.parse(trade.signalTimestamp ?? "");
      const fields = [
        trade.symbol,
        trade.direction,
        trade.breakoutDirection,
        trade.breakoutExtreme,
        trade.rangeLow,
        trade.rangeHigh,
        trade.entryFillPrice,
      ];
      if (!fields.every((value) => value !== null && value !== undefined)
        || !Number.isFinite(baselineEntryAtMs)
        || !Number.isFinite(signalAtMs)
        || !finitePositive(trade.entryFillPrice)
        || !finitePositive(trade.breakoutExtreme)
        || !finitePositive(trade.rangeLow)
        || !finitePositive(trade.rangeHigh)
        || trade.rangeHigh! <= trade.rangeLow!
        || (trade.direction !== "LONG" && trade.direction !== "SHORT")
        || (trade.breakoutDirection !== "UP" && trade.breakoutDirection !== "DOWN")) return [];
      const quantity = finitePositive(trade.entryQty)
        ? trade.entryQty
        : finitePositive(trade.entryNotionalUsd)
          ? trade.entryNotionalUsd / trade.entryFillPrice
          : 25 / trade.entryFillPrice;
      if (!finitePositive(quantity)) return [];
      return [{
        trade,
        tradeId: trade.tradeId ?? `${trade.symbol}-${baselineEntryAtMs}`,
        symbol: trade.symbol!.trim().toUpperCase(),
        direction: trade.direction,
        breakoutDirection: trade.breakoutDirection,
        sweepExtreme: trade.breakoutExtreme!,
        rangeLow: trade.rangeLow!,
        rangeHigh: trade.rangeHigh!,
        signalAtMs,
        baselineEntryAtMs,
        baselineEntry: trade.entryFillPrice,
        quantity,
        notionalUsd: quantity * trade.entryFillPrice,
      }];
    })
    .sort((left, right) => left.baselineEntryAtMs - right.baselineEntryAtMs || left.tradeId.localeCompare(right.tradeId));
}

function frictionFromState(state: StateFile): Friction {
  const latest = [...(state.frictionModels ?? [])]
    .filter((row) => finitePositive(row.entryFeeP95Bps) && finitePositive(row.exitFeeP95Bps))
    .sort((left, right) => String(left.cutoffAt ?? "").localeCompare(String(right.cutoffAt ?? "")))
    .at(-1);
  if (!latest) return { feeBps: 5, exitSlippageBps: 5, entrySlippageBps: 0, source: "conservative-default-5bps-fee-plus-5bps-exit" };
  return {
    feeBps: Math.max(Number(latest.entryFeeP95Bps), Number(latest.exitFeeP95Bps)),
    // Soft/trail exits are reduce-only markets. The latest empirical TP p50 is
    // a conservative minimum proxy where dedicated market-exit evidence is not
    // yet mature; it is not borrowed from spot or a Mainnet source.
    exitSlippageBps: Math.max(5, Number(latest.takeProfitExitAdverseP50Bps ?? 0)),
    entrySlippageBps: Math.max(0, Number(latest.entryAdverseP95Bps ?? 0)),
    source: latest.id ?? "latest-testnet-friction-model",
  };
}

function signedR(direction: Direction, entry: number, risk: number, price: number): number {
  return direction === "LONG" ? (price - entry) / risk : (entry - price) / risk;
}

function exitWithFriction(input: {
  direction: Direction;
  entry: number;
  rawExit: number;
  quantity: number;
  riskPrice: number;
  friction: Friction;
}): Pick<ReplayResult, "exitPrice" | "grossPnlUsd" | "netPnlUsd" | "netR"> {
  const exitPrice = input.direction === "LONG"
    ? input.rawExit * (1 - input.friction.exitSlippageBps / 10_000)
    : input.rawExit * (1 + input.friction.exitSlippageBps / 10_000);
  const grossPnlUsd = (input.direction === "LONG" ? exitPrice - input.entry : input.entry - exitPrice) * input.quantity;
  const fees = (input.entry * input.quantity + exitPrice * input.quantity) * input.friction.feeBps / 10_000;
  const netPnlUsd = grossPnlUsd - fees;
  const riskUsd = input.riskPrice * input.quantity;
  return {
    exitPrice,
    grossPnlUsd,
    netPnlUsd,
    netR: riskUsd > EPSILON ? netPnlUsd / riskUsd : null,
  };
}

function outsideTowardBreakout(episode: Episode, candle: Candle): boolean {
  return evaluateDailyRangeFadeSoftInvalidation({
    breakoutDirection: episode.breakoutDirection,
    rangeLow: episode.rangeLow,
    rangeHigh: episode.rangeHigh,
    candle,
  }) !== null;
}

function stopFollowThrough(episode: Episode, candles: readonly Candle[], fromOpenTime: number): ReplayResult["stopFollowThrough"] {
  const after = candles.filter((candle) => candle.openTime > fromOpenTime && candle.openTime <= fromOpenTime + 60 * MINUTE_MS);
  if (after.length < 15) return "INSUFFICIENT_PATH";
  return after.some((candle) => candle.close > episode.rangeLow && candle.close < episode.rangeHigh)
    ? "REVERTED_TO_RANGE"
    : "CONTINUED_BREAKOUT";
}

function invalidResult(
  episode: Episode,
  variant: DailyRangeFadeVNextVariant,
  status: Exclude<ResultStatus, "EXECUTED">,
  detail: string,
): ReplayResult {
  return {
    tradeId: episode.tradeId,
    symbol: episode.symbol,
    variant,
    status,
    detail,
    entryAt: null,
    entryPrice: null,
    stopPrice: null,
    takeProfitPrice: null,
    exitAt: null,
    exitPrice: null,
    exitReason: null,
    grossPnlUsd: null,
    netPnlUsd: null,
    netR: null,
    holdMinutes: null,
    mfeR: null,
    maeR: null,
    peakR: null,
    trailFloorR: null,
    entryPartialMinute: false,
    stopFollowThrough: null,
  };
}

function simulateEpisode(input: {
  episode: Episode;
  candles: readonly Candle[];
  variant: DailyRangeFadeVNextVariant;
  friction: Friction;
}): ReplayResult {
  const { episode, candles, variant, friction } = input;
  const config = dailyRangeFadeVNextParameters(variant);
  const ordered = [...candles].sort((left, right) => left.openTime - right.openTime);
  if (!ordered.length) return invalidResult(episode, variant, "UNAVAILABLE", "no Testnet candles returned");
  const byOpen = new Map(ordered.map((candle) => [candle.openTime, candle]));
  let entry = episode.baselineEntry;
  let entryAtMs = episode.baselineEntryAtMs;
  let firstWholeOpen = minuteAfter(entryAtMs);
  let entryPartialMinute = entryAtMs !== minuteOpen(entryAtMs);

  if (config.strictEntryConfirmation) {
    const confirmationOpen = minuteOpen(episode.signalAtMs);
    const confirmation = byOpen.get(confirmationOpen);
    if (!confirmation) return invalidResult(episode, variant, "UNAVAILABLE", "strict confirmation candle unavailable from Testnet");
    const strict = evaluateDailyRangeFadeStrictEntry({
      breakoutDirection: episode.breakoutDirection,
      sweepExtreme: episode.sweepExtreme,
      rangeLow: episode.rangeLow,
      rangeHigh: episode.rangeHigh,
      candle: confirmation,
    });
    if (!strict.accepted) return invalidResult(episode, variant, "STRICT_REJECTED", strict.reason);
    entry = episode.direction === "LONG"
      ? confirmation.close * (1 + friction.entrySlippageBps / 10_000)
      : confirmation.close * (1 - friction.entrySlippageBps / 10_000);
    entryAtMs = confirmation.closeTime;
    firstWholeOpen = confirmation.closeTime + 1;
    entryPartialMinute = false;
  }

  const stop = structuralStopForDailyRangeFadeSweep({
    direction: episode.direction,
    rangeLow: episode.rangeLow,
    rangeHigh: episode.rangeHigh,
    breakoutExtreme: episode.sweepExtreme,
    entry,
  });
  const takeProfit = episode.direction === "LONG" ? episode.rangeHigh : episode.rangeLow;
  const riskPrice = Math.abs(entry - stop);
  const targetDistance = Math.abs(takeProfit - entry);
  if (!finitePositive(stop) || !(riskPrice > EPSILON) || !(targetDistance > EPSILON)
    || (episode.direction === "LONG" && !(takeProfit > entry))
    || (episode.direction === "SHORT" && !(takeProfit < entry))) {
    return invalidResult(episode, variant, "INVALID_INPUT", "current V5 stop/target geometry is invalid for this historical episode");
  }

  // The actual fill can land inside a one-minute candle. Native barrier hits
  // there cannot be sequenced around the fill, so such an episode is never
  // used to select a policy. If neither native bracket could have triggered,
  // the first full subsequent candle is still defensible for the requested
  // close-based soft invalidation.
  if (entryPartialMinute) {
    const partial = byOpen.get(minuteOpen(entryAtMs));
    if (!partial) return invalidResult(episode, variant, "UNAVAILABLE", "actual-fill minute unavailable from Testnet");
    const partialSl = episode.direction === "LONG" ? partial.low <= stop : partial.high >= stop;
    const partialTp = episode.direction === "LONG" ? partial.high >= takeProfit : partial.low <= takeProfit;
    if (partialSl || partialTp) return invalidResult(episode, variant, "AMBIGUOUS", "partial entry minute touched a native bracket");
  }

  let previousOpen: number | null = null;
  let peakR = 0;
  let maeR = 0;
  let floorR: number | null = null;
  let exit: { at: number; rawPrice: number; reason: ExitReason } | null = null;
  const entryCostR = (2 * (friction.feeBps + friction.exitSlippageBps) / 10_000 * entry) / riskPrice;

  for (const candle of ordered) {
    if (candle.openTime < firstWholeOpen) continue;
    if (candle.openTime >= firstWholeOpen + HORIZON_MINUTES * MINUTE_MS) break;
    if (previousOpen !== null && candle.openTime !== previousOpen + MINUTE_MS) {
      return invalidResult(episode, variant, "UNAVAILABLE", "Testnet 1m candle path has a gap");
    }
    previousOpen = candle.openTime;
    const stopHit = episode.direction === "LONG" ? candle.low <= stop : candle.high >= stop;
    const targetHit = episode.direction === "LONG" ? candle.high >= takeProfit : candle.low <= takeProfit;
    if (stopHit && targetHit) return invalidResult(episode, variant, "AMBIGUOUS", "one 1m candle touched native SL and TP");
    if (stopHit || targetHit) {
      exit = { at: candle.closeTime, rawPrice: stopHit ? stop : takeProfit, reason: stopHit ? "SL" : "TP" };
      break;
    }

    const favourablePrice = episode.direction === "LONG" ? candle.high : candle.low;
    const adversePrice = episode.direction === "LONG" ? candle.low : candle.high;
    const favourableR = signedR(episode.direction, entry, riskPrice, favourablePrice);
    const adverseR = signedR(episode.direction, entry, riskPrice, adversePrice);
    const priorFloorR = floorR;
    const priorFloorPrice = priorFloorR === null ? null : episode.direction === "LONG"
      ? entry + priorFloorR * riskPrice
      : entry - priorFloorR * riskPrice;
    const priorFloorHit = priorFloorPrice !== null && (episode.direction === "LONG"
      ? candle.low <= priorFloorPrice
      : candle.high >= priorFloorPrice);
    const peakWouldAdvance = favourableR > peakR + EPSILON;

    // A one-minute OHLC cannot establish whether a new high/low was observed
    // before a prior or newly raised trail floor was crossed. Do not credit the
    // later trail outcome to either side of that unknowable ordering.
    if (priorFloorHit && peakWouldAdvance) {
      return invalidResult(episode, variant, "AMBIGUOUS", "1m trail order is unknowable: prior floor and new peak both touched");
    }
    if (priorFloorHit && priorFloorPrice !== null) {
      exit = { at: candle.closeTime, rawPrice: priorFloorPrice, reason: "TRAIL" };
      break;
    }

    peakR = Math.max(peakR, favourableR, 0);
    maeR = Math.min(maeR, adverseR);
    if (peakR >= config.trailArmR) {
      const allowedGivebackR = Math.max(config.trailGivebackFraction * peakR, config.trailMinimumGivebackR);
      const candidateFloorR = Math.max(entryCostR, peakR - allowedGivebackR);
      const nextFloorR = floorR === null ? candidateFloorR : Math.max(floorR, candidateFloorR);
      const nextFloorPrice = episode.direction === "LONG"
        ? entry + nextFloorR * riskPrice
        : entry - nextFloorR * riskPrice;
      const newFloorHit = (episode.direction === "LONG" ? candle.low <= nextFloorPrice : candle.high >= nextFloorPrice);
      if (nextFloorR > (floorR ?? -Infinity) + EPSILON && newFloorHit) {
        return invalidResult(episode, variant, "AMBIGUOUS", "1m trail order is unknowable: newly raised floor touched in its arming bar");
      }
      floorR = nextFloorR;
    }

    if (config.softInvalidation && outsideTowardBreakout(episode, candle)) {
      exit = { at: candle.closeTime, rawPrice: candle.close, reason: "SOFT" };
      break;
    }
  }

  if (!exit) {
    const last = ordered.filter((candle) => candle.openTime >= firstWholeOpen).at(-1);
    if (!last) return invalidResult(episode, variant, "UNAVAILABLE", "no full candle after entry");
    exit = { at: last.closeTime, rawPrice: last.close, reason: "TIMEOUT" };
  }
  const pnl = exitWithFriction({ direction: episode.direction, entry, rawExit: exit.rawPrice, quantity: episode.quantity, riskPrice, friction });
  return {
    tradeId: episode.tradeId,
    symbol: episode.symbol,
    variant,
    status: "EXECUTED",
    detail: null,
    entryAt: asIso(entryAtMs),
    entryPrice: entry,
    stopPrice: stop,
    takeProfitPrice: takeProfit,
    exitAt: asIso(exit.at),
    exitReason: exit.reason,
    ...pnl,
    holdMinutes: Math.max(0, (exit.at - entryAtMs) / MINUTE_MS),
    mfeR: peakR,
    maeR,
    peakR,
    trailFloorR: floorR,
    entryPartialMinute,
    stopFollowThrough: exit.reason === "SL" ? stopFollowThrough(episode, ordered, minuteOpen(exit.at)) : null,
  };
}

function median(values: readonly number[]): number | null {
  const ordered = [...values].filter(Number.isFinite).sort((left, right) => left - right);
  if (!ordered.length) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function metrics(results: readonly ReplayResult[]): Record<string, unknown> {
  const executed = results.filter((result) => result.status === "EXECUTED" && finite(result.netPnlUsd));
  const wins = executed.filter((result) => result.netPnlUsd! > 0);
  const losses = executed.filter((result) => result.netPnlUsd! < 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const result of executed) {
    equity += result.netPnlUsd!;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const grossProfit = wins.reduce((sum, result) => sum + result.netPnlUsd!, 0);
  const grossLoss = Math.abs(losses.reduce((sum, result) => sum + result.netPnlUsd!, 0));
  const counts = (key: keyof ReplayResult): Record<string, number> => results.reduce<Record<string, number>>((all, result) => {
    const value = result[key];
    if (typeof value === "string") all[value] = (all[value] ?? 0) + 1;
    return all;
  }, {});
  return {
    opportunities: results.length,
    executed: executed.length,
    skippedStrict: results.filter((result) => result.status === "STRICT_REJECTED").length,
    unavailable: results.filter((result) => result.status === "UNAVAILABLE").length,
    ambiguous: results.filter((result) => result.status === "AMBIGUOUS").length,
    invalidInput: results.filter((result) => result.status === "INVALID_INPUT").length,
    grossPnlUsd: executed.reduce((sum, result) => sum + (result.grossPnlUsd ?? 0), 0),
    netPnlUsd: executed.reduce((sum, result) => sum + result.netPnlUsd!, 0),
    grossProfitUsd: grossProfit,
    grossLossUsd: grossLoss,
    expectancyUsd: executed.length ? executed.reduce((sum, result) => sum + result.netPnlUsd!, 0) / executed.length : null,
    expectancyR: executed.length ? executed.reduce((sum, result) => sum + (result.netR ?? 0), 0) / executed.length : null,
    profitFactor: grossLoss > EPSILON ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    winRate: executed.length ? wins.length / executed.length : null,
    averageWinUsd: wins.length ? grossProfit / wins.length : null,
    averageLossUsd: losses.length ? grossLoss / losses.length : null,
    maxDrawdownUsd: maxDrawdown,
    worstTradeUsd: executed.length ? Math.min(...executed.map((result) => result.netPnlUsd!)) : null,
    medianHoldMinutes: median(executed.map((result) => result.holdMinutes ?? NaN)),
    exitCounts: counts("exitReason"),
    statusCounts: counts("status"),
    stopFollowThrough: counts("stopFollowThrough"),
    bestTradeUsd: executed.length ? Math.max(...executed.map((result) => result.netPnlUsd!)) : null,
  };
}

function splitMetrics(results: readonly ReplayResult[]): Record<"EARLY" | "MIDDLE" | "RECENT", Record<string, unknown>> {
  const third = Math.ceil(results.length / 3);
  return {
    EARLY: metrics(results.slice(0, third)),
    MIDDLE: metrics(results.slice(third, third * 2)),
    RECENT: metrics(results.slice(third * 2)),
  };
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function chooseVariant(byVariant: Record<DailyRangeFadeVNextVariant, ReplayResult[]>): Record<string, unknown> {
  const baselineMetrics = metrics(byVariant.BASELINE);
  const baselineNet = asNumber(baselineMetrics.netPnlUsd);
  const baselineMdd = asNumber(baselineMetrics.maxDrawdownUsd);
  const candidates = VARIANTS.filter((variant) => variant !== "BASELINE").map((variant) => {
    const summary = metrics(byVariant[variant]);
    const splits = splitMetrics(byVariant[variant]);
    const executed = asNumber(summary.executed);
    const net = asNumber(summary.netPnlUsd);
    const pf = summary.profitFactor;
    const avgWin = summary.averageWinUsd;
    const avgLoss = summary.averageLossUsd;
    const mdd = asNumber(summary.maxDrawdownUsd);
    const recentNet = asNumber(splits.RECENT.netPnlUsd);
    const best = Math.abs(asNumber(summary.bestTradeUsd));
    const grossProfit = asNumber(summary.grossProfitUsd);
    const noSingleOutlier = grossProfit > EPSILON && best <= grossProfit * 0.75;
    const materiallyImproved = baselineNet < 0
      ? net - baselineNet >= Math.abs(baselineNet) * 0.3
      : net > baselineNet;
    const pass = executed >= 15
      && net > 0
      && typeof pf === "number" && pf > 1.1
      && typeof avgWin === "number" && typeof avgLoss === "number" && avgWin > avgLoss
      && mdd <= baselineMdd + EPSILON
      && recentNet > 0;
    const experimental = !pass
      && executed >= 15
      && materiallyImproved
      && mdd <= baselineMdd + EPSILON
      && recentNet >= asNumber(splitMetrics(byVariant.BASELINE).RECENT.netPnlUsd)
      && noSingleOutlier;
    return { variant, summary, splits, pass, experimental, materiallyImproved, noSingleOutlier };
  });
  const rank = (left: typeof candidates[number], right: typeof candidates[number]) => (
    asNumber(right.summary.netPnlUsd) - asNumber(left.summary.netPnlUsd)
    || asNumber(right.summary.profitFactor) - asNumber(left.summary.profitFactor)
    || asNumber(left.summary.maxDrawdownUsd) - asNumber(right.summary.maxDrawdownUsd)
  );
  const passed = candidates.filter((candidate) => candidate.pass).sort(rank);
  const experimental = candidates.filter((candidate) => candidate.experimental).sort(rank);
  const selected = passed[0] ?? experimental[0] ?? null;
  return {
    status: passed.length ? "PASS_TO_TESTNET" : experimental.length ? "EXPERIMENTAL_TESTNET" : "BLOCKED_NO_IMPROVEMENT",
    selectedVariant: selected?.variant ?? null,
    baseline: baselineMetrics,
    candidates,
    preregisteredMinimumExecutedEpisodes: 15,
    selectionNotes: [
      "A strict-entry rejection is a zero-PnL skipped opportunity, not silently removed from the opportunity count.",
      "PASS requires positive net, PF > 1.1, average win > average loss, no worse MDD, positive RECENT split, and at least 15 executable unambiguous episodes.",
      "EXPERIMENTAL requires a >=30% material improvement versus a negative baseline (or positive absolute improvement), no worse MDD, no weaker RECENT split, and no single-outlier result.",
    ],
  };
}

let lastRequestAt = 0;
let rateLimited = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCache(path: string): Promise<Candle[] | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(value) ? value.map(parseCandle).filter((candle): candle is Candle => candle !== null) : null;
  } catch {
    return null;
  }
}

async function fetchTestnetCandles(input: { symbol: string; startTime: number; cacheDir: string | null; minGapMs: number }): Promise<Candle[]> {
  const cachePath = input.cacheDir === null ? null : join(input.cacheDir, `${input.symbol}-${input.startTime}-${HORIZON_MINUTES}m.json`);
  if (cachePath) {
    const cached = await readCache(cachePath);
    if (cached) return cached;
  }
  if (rateLimited) throw new Error("Testnet public replay halted after rate-limit response");
  const pause = Math.max(0, input.minGapMs - (Date.now() - lastRequestAt));
  if (pause) await sleep(pause);
  const url = new URL("/fapi/v1/klines", TESTNET_ORIGIN);
  url.searchParams.set("symbol", input.symbol);
  url.searchParams.set("interval", "1m");
  url.searchParams.set("startTime", String(input.startTime));
  url.searchParams.set("endTime", String(input.startTime + HORIZON_MINUTES * MINUTE_MS - 1));
  url.searchParams.set("limit", String(HORIZON_MINUTES));
  if (url.origin !== TESTNET_ORIGIN) throw new Error("replay endpoint must remain Binance USD-M Testnet");
  lastRequestAt = Date.now();
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const body = await response.text();
  if (!response.ok) {
    if (response.status === 418 || response.status === 429) rateLimited = true;
    throw new Error(`Testnet kline HTTP ${response.status}: ${body.slice(0, 180)}`);
  }
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed)) throw new Error("Testnet kline payload is not an array");
  const candles = parsed.map(parseCandle).filter((candle): candle is Candle => candle !== null);
  if (cachePath) {
    await mkdir(input.cacheDir!, { recursive: true });
    await writeFile(cachePath, JSON.stringify(candles));
  }
  return candles;
}

async function main(): Promise<void> {
  const statePath = process.env.DAILY_FADE_VNEXT_STATE_FILE;
  if (!statePath) throw new Error("DAILY_FADE_VNEXT_STATE_FILE is required");
  const cacheDir = process.env.DAILY_FADE_VNEXT_CACHE_DIR?.trim() || null;
  const outputPath = process.env.DAILY_FADE_VNEXT_OUTPUT_FILE?.trim() || null;
  const minGapMs = Math.max(1_250, Math.min(5_000, Number(process.env.DAILY_FADE_VNEXT_MIN_GAP_MS ?? "1500")));
  const state = JSON.parse(await readFile(statePath, "utf8")) as StateFile;
  const episodes = parseStateEpisodes(state);
  const friction = frictionFromState(state);
  const byVariant = Object.fromEntries(VARIANTS.map((variant) => [variant, [] as ReplayResult[]])) as Record<DailyRangeFadeVNextVariant, ReplayResult[]>;
  const transportFailures: Array<{ tradeId: string; symbol: string; error: string }> = [];

  for (const episode of episodes) {
    const startTime = minuteOpen(Math.min(episode.signalAtMs, episode.baselineEntryAtMs));
    let candles: Candle[];
    try {
      candles = await fetchTestnetCandles({ symbol: episode.symbol, startTime, cacheDir, minGapMs });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      transportFailures.push({ tradeId: episode.tradeId, symbol: episode.symbol, error: message });
      for (const variant of VARIANTS) byVariant[variant].push(invalidResult(episode, variant, "UNAVAILABLE", message));
      if (rateLimited) break;
      continue;
    }
    for (const variant of VARIANTS) byVariant[variant].push(simulateEpisode({ episode, candles, variant, friction }));
  }

  const baseline = byVariant.BASELINE;
  const softEarlier = baseline.filter((result) => result.status === "EXECUTED" && (result.netPnlUsd ?? 0) < 0).map((result) => {
    const soft = byVariant.SOFT_INVALIDATION.find((candidate) => candidate.tradeId === result.tradeId);
    return { baseline: result, soft };
  }).filter(({ baseline: current, soft }) => soft?.status === "EXECUTED"
    && soft.exitReason === "SOFT"
    && (soft.holdMinutes ?? Infinity) < (current.holdMinutes ?? -Infinity)
    && (soft.netPnlUsd ?? -Infinity) > (current.netPnlUsd ?? Infinity));
  const truncatedWinners = baseline.filter((result) => result.status === "EXECUTED" && result.exitReason === "TRAIL").map((result) => {
    const later = byVariant.LATER_TRAIL.find((candidate) => candidate.tradeId === result.tradeId);
    return { baseline: result, later };
  }).filter(({ baseline: current, later }) => later?.status === "EXECUTED"
    && (later.peakR ?? -Infinity) >= (current.peakR ?? Infinity) + 0.25);

  const report = {
    policy: {
      id: "daily-fade-vnext-testnet-replay-v1",
      endpoint: TESTNET_ORIGIN,
      endpointGuard: "TESTNET_ONLY_NO_MAINNET_FALLBACK",
      stateSource: statePath,
      horizonMinutes: HORIZON_MINUTES,
      minimumRequestGapMs: minGapMs,
      friction,
    },
    source: {
      totalFadeEpisodes: episodes.length,
      replayedEpisodeCount: byVariant.BASELINE.length,
      transportFailures,
      sourceCompatibility: "TESTNET_LEDGER_WITH_TESTNET_USDM_1M_CANDLES_ONLY",
    },
    variants: Object.fromEntries(VARIANTS.map((variant) => [variant, {
      metrics: metrics(byVariant[variant]),
      splits: splitMetrics(byVariant[variant]),
      samples: byVariant[variant].filter((row) => row.status === "EXECUTED").slice(0, 8),
      // Keep the complete, deterministic replay set for follow-on research.
      // This has no execution authority and is only emitted when a caller
      // explicitly writes a local report file.
      fullResults: byVariant[variant],
    }])),
    diagnostics: {
      baselineLosersSoftInvalidatedEarlierAndLessNegative: {
        count: softEarlier.length,
        examples: softEarlier.slice(0, 12).map(({ baseline: current, soft }) => ({
          tradeId: current.tradeId,
          baselineNetPnlUsd: current.netPnlUsd,
          softNetPnlUsd: soft?.netPnlUsd,
          baselineHoldMinutes: current.holdMinutes,
          softHoldMinutes: soft?.holdMinutes,
        })),
      },
      baselineTrailExitsWithLaterTrailHigherMfeByAtLeast025R: {
        count: truncatedWinners.length,
        examples: truncatedWinners.slice(0, 12).map(({ baseline: current, later }) => ({
          tradeId: current.tradeId,
          baselinePeakR: current.peakR,
          laterTrailPeakR: later?.peakR,
          baselineNetPnlUsd: current.netPnlUsd,
          laterTrailNetPnlUsd: later?.netPnlUsd,
        })),
      },
      baselineStopAftermath: metrics(baseline).stopFollowThrough,
      ambiguityRule: "1m OHLC bars that can sequence a native barrier or trail floor in more than one materially different way are excluded from selection",
    },
    selection: chooseVariant(byVariant),
  };
  const text = JSON.stringify(report, null, 2);
  if (outputPath) {
    await writeFile(outputPath, `${text}\n`);
    process.stdout.write(`${JSON.stringify({ outputPath, selection: report.selection, source: report.source }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${text}\n`);
}

await main();

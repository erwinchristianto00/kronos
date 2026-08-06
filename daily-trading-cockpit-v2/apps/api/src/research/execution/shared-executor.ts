import {
  type TournamentCandle,
  type TournamentExecutionMode,
  type TournamentExperimentSpec,
  type TournamentIntent,
  type TournamentMetrics,
  type TournamentRunManifest,
  type TournamentRunResult,
  type TournamentTrade,
} from "../tournament-types.js";
import type { TournamentStrategy } from "../strategies/challengers.js";
import { PointInTimeUniverse } from "../universe/point-in-time-universe.js";

export interface TournamentExecutionInput {
  manifest: TournamentRunManifest;
  strategy: TournamentStrategy;
  candles: readonly TournamentCandle[];
  universe: PointInTimeUniverse;
  /** Return the signed funding rate paid at timestamp, or null when unavailable. */
  fundingRateAt?: (symbol: string, timestampMs: number) => number | null;
  /** Point-in-time liquidity model required for EXPECTED execution. */
  expectedSlippageBpsAt?: (symbol: string, timestampMs: number, side: "LONG" | "SHORT", notional: number) => number | null;
  /** Point-in-time fee tier/order model required for EXPECTED execution. */
  expectedFeeBpsAt?: (symbol: string, timestampMs: number, side: "LONG" | "SHORT", notional: number) => number | null;
  correlationClusterBySymbol?: ReadonlyMap<string, string>;
  btcBetaBySymbol?: ReadonlyMap<string, number>;
}

interface OpenPosition {
  readonly intent: TournamentIntent;
  readonly entryTimeMs: number;
  readonly entryPrice: number;
  readonly quantity: number;
  readonly notional: number;
  readonly entryFee: number;
  readonly entrySlippage: number;
  readonly entryIndex: number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const bps = (value: number): number => value / 10_000;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function modeCost(mode: TournamentExecutionMode, spec: TournamentExperimentSpec): { feeBps: number; slipBps: number; ambiguity: "STOP_FIRST" | "PATH_ASSUMPTION" | "TARGET_FIRST" } {
  if (mode === "CONSERVATIVE") return { feeBps: spec.costs.takerFeeBps, slipBps: spec.costs.baseSlippageBps * spec.costs.pessimisticSlippageMultiplier, ambiguity: "STOP_FIRST" };
  if (mode === "EXPECTED") return { feeBps: spec.costs.takerFeeBps, slipBps: spec.costs.baseSlippageBps, ambiguity: "PATH_ASSUMPTION" };
  return { feeBps: spec.costs.makerFeeBps, slipBps: 0, ambiguity: "TARGET_FIRST" };
}

function adversePrice(price: number, side: "LONG" | "SHORT", entering: boolean, slipBps: number): number {
  const factor = 1 + bps(slipBps);
  if (side === "LONG") return entering ? price * factor : price / factor;
  return entering ? price / factor : price * factor;
}

function sideSign(side: "LONG" | "SHORT"): number { return side === "LONG" ? 1 : -1; }

function episodeId(timestampMs: number): string {
  // A conservative shared-market episode; callers can replace only with a
  // persisted event identity, never symbol-row count.
  return `day:${Math.floor(timestampMs / DAY)}`;
}

function groupedCandles(candles: readonly TournamentCandle[]): Map<number, Map<string, TournamentCandle>> {
  const grouped = new Map<number, Map<string, TournamentCandle>>();
  for (const candle of candles) {
    if (!finite(candle.open) || !finite(candle.high) || !finite(candle.low) || !finite(candle.close) || candle.open <= 0 || candle.high < candle.low) {
      throw new Error(`TOURNAMENT_INVALID_CANDLE_${candle.symbol}_${candle.openTimeMs}`);
    }
    const bucket = grouped.get(candle.openTimeMs) ?? new Map<string, TournamentCandle>();
    if (bucket.has(candle.symbol)) throw new Error(`TOURNAMENT_DUPLICATE_CANDLE_${candle.symbol}_${candle.openTimeMs}`);
    bucket.set(candle.symbol, candle); grouped.set(candle.openTimeMs, bucket);
  }
  return grouped;
}

function calculateMetrics(trades: TournamentTrade[], startingCapital: number): TournamentMetrics {
  const net = trades.map((trade) => trade.netPnl);
  const wins = net.filter((value) => value > 0);
  const losses = net.filter((value) => value < 0);
  const grossWin = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = -losses.reduce((sum, value) => sum + value, 0);
  let equity = startingCapital; let peak = equity; let maxDrawdown = 0;
  for (const value of net) { equity += value; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 1); }
  const returns = net.map((value) => value / startingCapital);
  const average = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0;
  const variance = returns.length ? returns.reduce((sum, value) => sum + (value - average) ** 2, 0) / returns.length : 0;
  const sharpe = variance > 0 ? average / Math.sqrt(variance) * Math.sqrt(252) : null;
  const elapsedMs = (trades.at(-1)?.exitTimeMs ?? 0) - (trades[0]?.entryTimeMs ?? 0);
  const years = Math.max(1 / 365, elapsedMs / (365 * DAY));
  const annualized = startingCapital > 0 && equity > 0 ? (equity / startingCapital) ** (1 / years) - 1 : null;
  const calmar = annualized !== null && maxDrawdown > 0 ? annualized / maxDrawdown : null;
  const bySymbol = new Map<string, number>(); const byRegime = new Map<string, number>(); const byYear = new Map<string, number>();
  for (const trade of trades) {
    bySymbol.set(trade.symbol, (bySymbol.get(trade.symbol) ?? 0) + trade.netPnl);
    byRegime.set(trade.regime ?? "UNSPECIFIED", (byRegime.get(trade.regime ?? "UNSPECIFIED") ?? 0) + trade.netPnl);
    const year = new Date(trade.entryTimeMs).getUTCFullYear().toString(); byYear.set(year, (byYear.get(year) ?? 0) + trade.netPnl);
  }
  const total = net.reduce((sum, value) => sum + value, 0);
  const topShare = (values: Iterable<number>): number | null => total === 0 ? null : Math.max(...[...values].map((value) => Math.abs(value / total)));
  const symbolProfitable = [...bySymbol.values()].filter((value) => value > 0).length;
  return {
    tradeCount: trades.length,
    independentEpisodes: new Set(trades.map((trade) => trade.marketEpisodeId)).size,
    expectancyAfterCost: trades.length ? total / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    winRate: trades.length ? wins.length / trades.length : 0,
    payoffRatio: wins.length && losses.length ? (grossWin / wins.length) / (grossLoss / losses.length) : null,
    sharpe,
    calmar,
    maxDrawdown,
    netPnl: total,
    returnFraction: startingCapital > 0 ? total / startingCapital : 0,
    profitableAssetRatio: bySymbol.size ? symbolProfitable / bySymbol.size : null,
    concentration: { topSymbolNetPnlShare: topShare(bySymbol.values()), topRegimeNetPnlShare: topShare(byRegime.values()), topYearNetPnlShare: topShare(byYear.values()) },
  };
}

/** Shared wallet, fill, funding and stop-first ambiguity engine for every challenger. */
export function runTournament(input: TournamentExecutionInput): TournamentRunResult {
  const { manifest, strategy, universe } = input;
  const spec = manifest.spec;
  if (manifest.strategyId !== strategy.id) throw new Error("TOURNAMENT_STRATEGY_MANIFEST_MISMATCH");
  const warnings: string[] = []; const invalidReasons: string[] = [];
  try { universe.assertCoverage([...input.candles]); } catch (error) { invalidReasons.push(error instanceof Error ? error.message : "TOURNAMENT_UNIVERSE_INVALID"); }
  if (input.candles.length === 0) invalidReasons.push("TOURNAMENT_NO_CANDLES");
  if (manifest.executionMode === "EXPECTED" && (!input.expectedSlippageBpsAt || !input.expectedFeeBpsAt)) {
    invalidReasons.push("TOURNAMENT_EXPECTED_LIQUIDITY_EXECUTION_MISSING");
  }
  if (invalidReasons.length) return { manifest, trades: [], metrics: calculateMetrics([], spec.portfolio.startingCapital), warnings, valid: false, invalidReasons };

  const grouped = groupedCandles(input.candles);
  const times = [...grouped.keys()].sort((a, b) => a - b);
  const symbols = [...new Set(input.candles.map((candle) => candle.symbol))].sort();
  const history = new Map(symbols.map((symbol) => [symbol, [] as TournamentCandle[]]));
  const indexBySymbol = new Map(symbols.map((symbol) => [symbol, 0]));
  const pending = new Map<number, TournamentIntent[]>();
  const open: OpenPosition[] = []; const trades: TournamentTrade[] = [];
  const costs = modeCost(manifest.executionMode, spec);
  let equity = spec.portfolio.startingCapital;

  const fillCosts = (symbol: string, timestampMs: number, side: "LONG" | "SHORT", notional: number): { feeBps: number; slipBps: number } => {
    if (manifest.executionMode !== "EXPECTED") return costs;
    const feeBps = input.expectedFeeBpsAt!(symbol, timestampMs, side, notional);
    const slipBps = input.expectedSlippageBpsAt!(symbol, timestampMs, side, notional);
    if (!finite(feeBps) || feeBps < 0 || !finite(slipBps) || slipBps < 0) {
      invalidReasons.push(`TOURNAMENT_EXPECTED_LIQUIDITY_VALUE_INVALID_${symbol}_${timestampMs}`);
      return { feeBps: 0, slipBps: 0 };
    }
    return { feeBps, slipBps };
  };

  const close = (position: OpenPosition, candle: TournamentCandle, exitRaw: number, reason: TournamentTrade["exitReason"]): boolean => {
    const exitCosts = fillCosts(position.intent.symbol, candle.openTimeMs, position.intent.side, position.notional);
    const exitPrice = adversePrice(exitRaw, position.intent.side, false, exitCosts.slipBps);
    const gross = (exitPrice - position.entryPrice) * position.quantity * sideSign(position.intent.side);
    const exitFee = position.notional * bps(exitCosts.feeBps);
    let funding = 0;
    const holds = Math.max(0, candle.openTimeMs - position.entryTimeMs);
    if (spec.costs.fundingEnabled) {
      const rate = input.fundingRateAt?.(position.intent.symbol, candle.openTimeMs);
      if (rate === null || rate === undefined) { invalidReasons.push(`TOURNAMENT_FUNDING_MISSING_${position.intent.symbol}_${candle.openTimeMs}`); return false; }
      funding = position.notional * rate * Math.ceil(holds / (8 * HOUR)) * sideSign(position.intent.side);
    }
    const fee = position.entryFee + exitFee;
    const net = gross - fee - position.entrySlippage - Math.abs(exitPrice - exitRaw) * position.quantity - funding;
    equity += net;
    trades.push({ tradeId: `${position.intent.strategyId}:${position.intent.symbol}:${position.entryTimeMs}:${trades.length}`, strategyId: position.intent.strategyId, symbol: position.intent.symbol, side: position.intent.side, entryTimeMs: position.entryTimeMs, exitTimeMs: candle.closeTimeMs, entryPrice: position.entryPrice, exitPrice, quantity: position.quantity, notionalAtEntry: position.notional, grossPnl: gross, feeCost: fee, slippageCost: position.entrySlippage + Math.abs(exitPrice - exitRaw) * position.quantity, fundingCost: funding, netPnl: net, exitReason: reason, holdingBars: Math.max(1, indexBySymbol.get(position.intent.symbol)! - position.entryIndex), marketEpisodeId: typeof position.intent.metadata.marketEpisodeId === "string" ? position.intent.metadata.marketEpisodeId : episodeId(position.entryTimeMs), regime: typeof position.intent.metadata.regime === "string" ? position.intent.metadata.regime : null });
    return true;
  };

  for (const time of times) {
    const frame = grouped.get(time)!;
    // Next-open execution: only intents created from the PRIOR completed candle can fill here.
    for (const intent of pending.get(time) ?? []) {
      const candle = frame.get(intent.symbol); if (!candle || open.some((position) => position.intent.symbol === intent.symbol)) continue;
      if (open.length >= spec.portfolio.maxPositions) continue;
      const signedExposure = open.reduce((sum, position) => sum + position.notional * sideSign(position.intent.side), 0);
      const grossExposure = open.reduce((sum, position) => sum + position.notional, 0);
      const benchmark = intent.metadata.benchmark === true;
      const usableCapital = equity * (1 - spec.portfolio.liquidationBufferFraction);
      const rawNotional = benchmark
        ? usableCapital / Math.max(1, intent.metadata.equalWeight === true ? universe.at(intent.decisionTimeMs).size : 1)
        : intent.stopFraction && intent.stopFraction > 0 ? usableCapital * spec.portfolio.riskPerTradeFraction / intent.stopFraction : 0;
      const cap = usableCapital * spec.portfolio.maxGrossExposureFraction - grossExposure;
      const notional = Math.max(0, Math.min(rawNotional, cap));
      if (notional <= 0 || Math.abs(signedExposure + notional * sideSign(intent.side)) > usableCapital * spec.portfolio.maxNetExposureFraction) continue;
      const beta = Math.abs(input.btcBetaBySymbol?.get(intent.symbol) ?? (intent.symbol === "BTCUSDT" ? 1 : 0));
      const usedBeta = open.reduce((sum, position) => sum + position.notional * Math.abs(input.btcBetaBySymbol?.get(position.intent.symbol) ?? (position.intent.symbol === "BTCUSDT" ? 1 : 0)), 0);
      if (usedBeta + notional * beta > usableCapital * spec.portfolio.maxBtcBetaFraction) continue;
      const cluster = input.correlationClusterBySymbol?.get(intent.symbol) ?? intent.symbol;
      const clusterGross = open.filter((position) => (input.correlationClusterBySymbol?.get(position.intent.symbol) ?? position.intent.symbol) === cluster).reduce((sum, position) => sum + position.notional, 0);
      if (clusterGross + notional > usableCapital * spec.portfolio.maxCorrelationClusterFraction) continue;
      const entryCosts = fillCosts(intent.symbol, candle.openTimeMs, intent.side, notional);
      const entryPrice = adversePrice(candle.open, intent.side, true, entryCosts.slipBps);
      const quantity = notional / entryPrice; const entryFee = notional * bps(entryCosts.feeBps);
      open.push({ intent, entryTimeMs: candle.openTimeMs, entryPrice, quantity, notional, entryFee, entrySlippage: Math.abs(entryPrice - candle.open) * quantity, entryIndex: indexBySymbol.get(intent.symbol)! });
    }
    pending.delete(time);

    // Exit resolution is evaluated only from the first FULL candle after entry.
    for (const position of [...open]) {
      const candle = frame.get(position.intent.symbol); if (!candle || candle.openTimeMs === position.entryTimeMs) continue;
      const index = indexBySymbol.get(position.intent.symbol)!;
      const stop = position.intent.stopFraction === null ? null : position.entryPrice * (1 - sideSign(position.intent.side) * position.intent.stopFraction);
      const target = position.intent.targetFraction === null ? null : position.entryPrice * (1 + sideSign(position.intent.side) * position.intent.targetFraction);
      const stopHit = stop !== null && (position.intent.side === "LONG" ? candle.low <= stop : candle.high >= stop);
      const targetHit = target !== null && (position.intent.side === "LONG" ? candle.high >= target : candle.low <= target);
      let exit: { price: number; reason: TournamentTrade["exitReason"] } | null = null;
      if (stopHit && targetHit) exit = costs.ambiguity === "TARGET_FIRST" ? { price: target!, reason: "TARGET" } : { price: stop!, reason: "STOP" };
      else if (stopHit) exit = { price: stop!, reason: "STOP" };
      else if (targetHit) exit = { price: target!, reason: "TARGET" };
      else if (index - position.entryIndex >= position.intent.maxHoldBars) exit = { price: candle.close, reason: "TIME" };
      if (exit && close(position, candle, exit.price, exit.reason)) open.splice(open.indexOf(position), 1);
    }

    // Completed-candle strategy evaluation; current bar can only create next-open intents.
    for (const [symbol, candle] of frame) {
      const series = history.get(symbol)!;
      const index = indexBySymbol.get(symbol)!;
      const next = times[times.indexOf(time) + 1] ?? null;
      const nextCandle = next === null ? null : grouped.get(next)?.get(symbol) ?? null;
      const eligible = universe.at(candle.closeTimeMs);
      const intents = strategy.onCompletedBar({ symbol, index, candle, history: series, eligibleSymbols: eligible, nextOpenTimeMs: nextCandle?.openTimeMs ?? null });
      for (const candidate of intents) {
        if (candidate.decisionTimeMs !== candle.closeTimeMs || candidate.entryAtOpenTimeMs !== nextCandle?.openTimeMs) throw new Error("TOURNAMENT_LOOKAHEAD_OR_NON_NEXT_OPEN_INTENT");
        pending.set(candidate.entryAtOpenTimeMs, [...(pending.get(candidate.entryAtOpenTimeMs) ?? []), candidate]);
      }
      series.push(candle); indexBySymbol.set(symbol, index + 1);
    }
  }
  const finalTime = times.at(-1)!; const finalFrame = grouped.get(finalTime)!;
  for (const position of [...open]) { const candle = finalFrame.get(position.intent.symbol); if (candle) close(position, candle, candle.close, "END_OF_DATA"); }
  if (manifest.executionMode === "OPTIMISTIC") warnings.push("OPTIMISTIC_DIAGNOSTIC_ONLY");
  const metrics = calculateMetrics(trades, spec.portfolio.startingCapital);
  return { manifest, metrics, trades, warnings, valid: invalidReasons.length === 0, invalidReasons };
}

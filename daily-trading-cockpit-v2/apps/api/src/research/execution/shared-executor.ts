import {
  type FundingSettlement,
  type TournamentCandle,
  type TournamentExecutionMode,
  type TournamentExperimentSpec,
  type TournamentIntent,
  type TournamentMetrics,
  type TournamentNavPoint,
  type TournamentPortfolioMetrics,
  type TournamentRunManifest,
  type TournamentRunResult,
  type TournamentTerminalOpenPosition,
  type TournamentTrade,
} from "../tournament-types.js";
import type { TournamentStrategy } from "../strategies/challengers.js";
import { PointInTimePortfolioRisk } from "../risk/point-in-time-portfolio-risk.js";
import { PointInTimeUniverse } from "../universe/point-in-time-universe.js";
import { canonicalMarks, buildCanonicalClock, type ValidatedAbsence } from "../foundry/canonical-clock.js";

export interface TournamentExecutionInput {
  manifest: TournamentRunManifest;
  strategy: TournamentStrategy;
  candles: readonly TournamentCandle[];
  /**
   * Optional completed bars strictly before this run's canonical clock. They
   * warm strategy indicators only: no mark, order, funding, NAV, or position
   * may be created from them. Walk-forward folds derive this internally from
   * the immutable parent candle ledger.
   */
  historyCandles?: readonly TournamentCandle[];
  universe: PointInTimeUniverse;
  validatedAbsences?: readonly ValidatedAbsence[];
  portfolioRisk: PointInTimePortfolioRisk;
  /** Actual exchange settlement times/rates, never an exit-time extrapolation. */
  fundingSettlements?: readonly FundingSettlement[];
  fundingSettlementScheduleBySymbol?: ReadonlyMap<string, readonly number[]>;
  /** Point-in-time liquidity model required for EXPECTED execution. */
  expectedSlippageBpsAt?: (symbol: string, timestampMs: number, side: "LONG" | "SHORT", notional: number) => number | null;
  /** Point-in-time fee tier/order model required for EXPECTED execution. */
  expectedFeeBpsAt?: (symbol: string, timestampMs: number, side: "LONG" | "SHORT", notional: number) => number | null;
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
  fundingCost: number;
  settledFundingTimes: Set<number>;
}

const DAY = 86_400_000;
const bps = (value: number): number => value / 10_000;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const sideSign = (side: "LONG" | "SHORT"): number => side === "LONG" ? 1 : -1;

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

function groupedCandles(candles: readonly TournamentCandle[]): Map<number, Map<string, TournamentCandle>> {
  const grouped = new Map<number, Map<string, TournamentCandle>>();
  for (const candle of candles) {
    if (!finite(candle.open) || !finite(candle.high) || !finite(candle.low) || !finite(candle.close) || candle.open <= 0 || candle.high < candle.low) throw new Error(`TOURNAMENT_INVALID_CANDLE_${candle.symbol}_${candle.openTimeMs}`);
    const bucket = grouped.get(candle.openTimeMs) ?? new Map<string, TournamentCandle>();
    if (bucket.has(candle.symbol)) throw new Error(`TOURNAMENT_DUPLICATE_CANDLE_${candle.symbol}_${candle.openTimeMs}`);
    bucket.set(candle.symbol, candle); grouped.set(candle.openTimeMs, bucket);
  }
  return grouped;
}

function seededCompletedHistory(input: { candles: readonly TournamentCandle[]; symbols: readonly string[]; startMs: number; timeframeMs: number }): Map<string, TournamentCandle[]> {
  const knownSymbols = new Set(input.symbols); const result = new Map(input.symbols.map((symbol) => [symbol, [] as TournamentCandle[]])); const seen = new Set<string>();
  for (const candle of input.candles.slice().sort((left, right) => left.openTimeMs - right.openTimeMs || left.symbol.localeCompare(right.symbol))) {
    const key = `${candle.symbol}:${candle.openTimeMs}`;
    if (!knownSymbols.has(candle.symbol) || seen.has(key) || candle.openTimeMs < 0 || candle.openTimeMs % input.timeframeMs !== 0 || candle.closeTimeMs !== candle.openTimeMs + input.timeframeMs - 1 || candle.closeTimeMs >= input.startMs || !finite(candle.open) || !finite(candle.high) || !finite(candle.low) || !finite(candle.close) || candle.open <= 0 || candle.high < candle.low) throw new Error(`TOURNAMENT_HISTORY_CANDLE_INVALID_${candle.symbol}_${candle.openTimeMs}`);
    seen.add(key); result.get(candle.symbol)!.push({ ...candle });
  }
  for (const [symbol, candles] of result) for (let index = 1; index < candles.length; index += 1) {
    if (candles[index]!.openTimeMs - candles[index - 1]!.openTimeMs !== input.timeframeMs) throw new Error(`TOURNAMENT_HISTORY_CANDLE_GAP_${symbol}_${candles[index]!.openTimeMs}`);
  }
  return result;
}

function calculateMetrics(trades: TournamentTrade[], nav: readonly TournamentNavPoint[], startingCapital: number, canonicalEpisodeProvenanceComplete: boolean, terminalPositionsResolved = true): TournamentMetrics {
  const net = trades.map((trade) => trade.netPnl); const wins = net.filter((value) => value > 0); const losses = net.filter((value) => value < 0);
  const grossWin = wins.reduce((sum, value) => sum + value, 0); const grossLoss = -losses.reduce((sum, value) => sum + value, 0);
  const navReturns = nav.map((point, index) => (index ? nav[index - 1]!.equity : startingCapital) > 0 ? point.equity / (index ? nav[index - 1]!.equity : startingCapital) - 1 : 0);
  const average = navReturns.length ? navReturns.reduce((sum, value) => sum + value, 0) / navReturns.length : 0;
  const variance = navReturns.length ? navReturns.reduce((sum, value) => sum + (value - average) ** 2, 0) / navReturns.length : 0;
  const intervalsPerYear = nav.length > 1 ? (365 * DAY) / ((nav.at(-1)!.timestampMs - nav[0]!.timestampMs) / (nav.length - 1)) : 0;
  const sharpe = variance > 0 && intervalsPerYear > 0 ? average / Math.sqrt(variance) * Math.sqrt(intervalsPerYear) : null;
  // Sortino is intentionally derived from this same fixed-interval NAV series,
  // not from trade-close outcomes. Zero and positive returns do not contribute
  // to downside deviation.
  const downsideVariance = navReturns.length ? navReturns.reduce((sum, value) => sum + Math.min(0, value) ** 2, 0) / navReturns.length : 0;
  const sortino = downsideVariance > 0 && intervalsPerYear > 0 ? average / Math.sqrt(downsideVariance) * Math.sqrt(intervalsPerYear) : null;
  let peak = startingCapital; let maxDrawdown = 0;
  for (const point of nav) { peak = Math.max(peak, point.equity); maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - point.equity) / peak : 1); }
  const elapsedMs = (nav.at(-1)?.timestampMs ?? 0) - (nav[0]?.timestampMs ?? 0); const years = Math.max(1 / 365, elapsedMs / (365 * DAY));
  const finalEquity = nav.at(-1)?.equity ?? startingCapital; const annualized = finalEquity > 0 ? (finalEquity / startingCapital) ** (1 / years) - 1 : null;
  const calmar = annualized !== null && maxDrawdown > 0 ? annualized / maxDrawdown : null;
  const bySymbol = new Map<string, number>(); const byRegime = new Map<string, number>(); const byYear = new Map<string, number>();
  for (const trade of trades) { bySymbol.set(trade.symbol, (bySymbol.get(trade.symbol) ?? 0) + trade.netPnl); byRegime.set(trade.regime ?? "UNSPECIFIED", (byRegime.get(trade.regime ?? "UNSPECIFIED") ?? 0) + trade.netPnl); const year = new Date(trade.entryTimeMs).getUTCFullYear().toString(); byYear.set(year, (byYear.get(year) ?? 0) + trade.netPnl); }
  const total = net.reduce((sum, value) => sum + value, 0); const topShare = (values: Iterable<number>): number | null => total === 0 ? null : Math.max(...[...values].map((value) => Math.abs(value / total)));
  return {
    tradeCount: trades.length, independentEpisodes: canonicalEpisodeProvenanceComplete ? new Set(trades.map((trade) => trade.marketEpisodeId)).size : 0,
    expectancyAfterCost: trades.length ? total / trades.length : 0, profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    winRate: trades.length ? wins.length / trades.length : 0, payoffRatio: wins.length && losses.length ? (grossWin / wins.length) / (grossLoss / losses.length) : null,
    sharpe, sortino, calmar, maxDrawdown, netPnl: total, returnFraction: finalEquity / startingCapital - 1,
    profitableAssetRatio: bySymbol.size ? [...bySymbol.values()].filter((value) => value > 0).length / bySymbol.size : null,
    concentration: { topSymbolNetPnlShare: topShare(bySymbol.values()), topRegimeNetPnlShare: topShare(byRegime.values()), topYearNetPnlShare: topShare(byYear.values()) },
    canonicalEpisodeProvenanceComplete, terminalPositionsResolved,
  };
}

function emptyPortfolioMetrics(spec: TournamentExperimentSpec): TournamentPortfolioMetrics {
  return { peakOpenPositions: 0, peakGrossExposureFraction: 0, peakAbsoluteNetExposureFraction: 0, peakBtcBetaFraction: 0, liquidationBufferFraction: spec.portfolio.liquidationBufferFraction, navPointCount: 0 };
}

/** Shared wallet, NAV ledger, exact funding settlements, and PIT-risk execution engine. */
export function runTournament(input: TournamentExecutionInput): TournamentRunResult {
  const { manifest, strategy, universe } = input; const spec = manifest.spec;
  if (manifest.strategyId !== strategy.id) throw new Error("TOURNAMENT_STRATEGY_MANIFEST_MISMATCH");
  const warnings: string[] = []; const invalidReasons: string[] = [];
  try { universe.assertCoverage([...input.candles]); } catch (error) { invalidReasons.push(error instanceof Error ? error.message : "TOURNAMENT_UNIVERSE_INVALID"); }
  if (input.candles.length === 0) invalidReasons.push("TOURNAMENT_NO_CANDLES");
  if (manifest.executionMode === "EXPECTED" && (!input.expectedSlippageBpsAt || !input.expectedFeeBpsAt)) invalidReasons.push("TOURNAMENT_EXPECTED_LIQUIDITY_EXECUTION_MISSING");
  if (spec.costs.fundingEnabled && (!input.fundingSettlements || !input.fundingSettlementScheduleBySymbol)) invalidReasons.push("TOURNAMENT_FUNDING_SETTLEMENT_DATA_MISSING");
  const clock = buildCanonicalClock({ startMs: spec.dataset.dataRange.startMs, endMs: spec.dataset.dataRange.endMs, timeframeMs: spec.dataset.timeframeMs }); let marks = new Map<string, number>();
  try { marks = canonicalMarks({ clock, candles: input.candles, universe, absences: input.validatedAbsences }); } catch (error) { invalidReasons.push(error instanceof Error ? error.message : "FOUNDRY_CANONICAL_CLOCK_INVALID"); }
  const emptyNav: TournamentNavPoint[] = [];
  if (invalidReasons.length) { const strategyMetrics = calculateMetrics([], emptyNav, spec.portfolio.startingCapital, false); return { manifest, trades: [], terminalOpenPositions: [], navLedger: emptyNav, strategyMetrics, portfolioMetrics: emptyPortfolioMetrics(spec), metrics: strategyMetrics, warnings, valid: false, invalidReasons }; }

  const grouped = groupedCandles(input.candles); const times = clock.timestamps; const symbols = [...new Set(input.candles.map((candle) => candle.symbol))].sort();
  let history: Map<string, TournamentCandle[]>;
  try { history = seededCompletedHistory({ candles: input.historyCandles ?? [], symbols, startMs: spec.dataset.dataRange.startMs, timeframeMs: spec.dataset.timeframeMs }); } catch (error) { invalidReasons.push(error instanceof Error ? error.message : "TOURNAMENT_HISTORY_INVALID"); history = new Map(symbols.map((symbol) => [symbol, []])); }
  const indexBySymbol = new Map(symbols.map((symbol) => [symbol, 0]));
  const pending = new Map<number, TournamentIntent[]>(); const open: OpenPosition[] = []; const trades: TournamentTrade[] = []; const navLedger: TournamentNavPoint[] = [];
  const costs = modeCost(manifest.executionMode, spec); const portfolioMetrics = emptyPortfolioMetrics(spec); let cash = spec.portfolio.startingCapital; let equityForAdmission = spec.portfolio.startingCapital;
  const fundingByKey = new Map<string, FundingSettlement>();
  for (const settlement of input.fundingSettlements ?? []) {
    const key = `${settlement.symbol}:${settlement.canonicalSettlementTimeMs}`; const schedule = input.fundingSettlementScheduleBySymbol?.get(settlement.symbol) ?? [];
    if (!Number.isInteger(settlement.canonicalSettlementTimeMs) || !Number.isInteger(settlement.observedSettlementTimeMs) || settlement.observedSettlementTimeMs - settlement.canonicalSettlementTimeMs !== settlement.alignmentOffsetMs || !settlement.scheduleSourceHash || !settlement.sourceHash || !finite(settlement.rate) || !schedule.includes(settlement.canonicalSettlementTimeMs)) invalidReasons.push(`TOURNAMENT_FUNDING_CANONICAL_IDENTITY_INVALID_${key}`);
    if (fundingByKey.has(key)) invalidReasons.push(`TOURNAMENT_FUNDING_DUPLICATE_CANONICAL_SETTLEMENT_${key}`);
    fundingByKey.set(key, settlement);
  }
  if (invalidReasons.length) { const strategyMetrics = calculateMetrics([], emptyNav, spec.portfolio.startingCapital, false); return { manifest, trades: [], terminalOpenPositions: [], navLedger: emptyNav, strategyMetrics, portfolioMetrics: emptyPortfolioMetrics(spec), metrics: strategyMetrics, warnings, valid: false, invalidReasons }; }

  const fillCosts = (symbol: string, timestampMs: number, side: "LONG" | "SHORT", notional: number): { feeBps: number; slipBps: number } => {
    if (manifest.executionMode !== "EXPECTED") return costs;
    const feeBps = input.expectedFeeBpsAt!(symbol, timestampMs, side, notional); const slipBps = input.expectedSlippageBpsAt!(symbol, timestampMs, side, notional);
    if (!finite(feeBps) || feeBps < 0 || !finite(slipBps) || slipBps < 0) { invalidReasons.push(`TOURNAMENT_EXPECTED_LIQUIDITY_VALUE_INVALID_${symbol}_${timestampMs}`); return { feeBps: 0, slipBps: 0 }; }
    return { feeBps, slipBps };
  };
  const accrueFundingThrough = (position: OpenPosition, throughMs: number): boolean => {
    if (!spec.costs.fundingEnabled) return true;
    const schedule = input.fundingSettlementScheduleBySymbol!.get(position.intent.symbol);
    if (!schedule) { invalidReasons.push(`TOURNAMENT_FUNDING_SCHEDULE_MISSING_${position.intent.symbol}`); return false; }
    for (const settlementTimeMs of schedule) {
      if (settlementTimeMs <= position.entryTimeMs || settlementTimeMs > throughMs || position.settledFundingTimes.has(settlementTimeMs)) continue;
      const settlement = fundingByKey.get(`${position.intent.symbol}:${settlementTimeMs}`);
      if (!settlement || settlement.canonicalSettlementTimeMs !== settlementTimeMs || !finite(settlement.rate) || !settlement.sourceHash || !settlement.scheduleSourceHash) { invalidReasons.push(`TOURNAMENT_FUNDING_SETTLEMENT_MISSING_${position.intent.symbol}_${settlementTimeMs}`); return false; }
      position.fundingCost += position.notional * settlement.rate * sideSign(position.intent.side); position.settledFundingTimes.add(settlementTimeMs);
    }
    return true;
  };
  const close = (position: OpenPosition, candle: TournamentCandle, exitRaw: number, reason: TournamentTrade["exitReason"]): boolean => {
    if (!accrueFundingThrough(position, candle.closeTimeMs)) return false;
    const exitCosts = fillCosts(position.intent.symbol, candle.closeTimeMs, position.intent.side, position.notional); const exitPrice = adversePrice(exitRaw, position.intent.side, false, exitCosts.slipBps);
    const gross = (exitPrice - position.entryPrice) * position.quantity * sideSign(position.intent.side); const exitFee = position.notional * bps(exitCosts.feeBps); const fee = position.entryFee + exitFee;
    const net = gross - fee - position.entrySlippage - Math.abs(exitPrice - exitRaw) * position.quantity - position.fundingCost; cash += net;
    trades.push({ tradeId: `${position.intent.strategyId}:${position.intent.symbol}:${position.entryTimeMs}:${trades.length}`, strategyId: position.intent.strategyId, symbol: position.intent.symbol, side: position.intent.side, decisionTimeMs: position.intent.decisionTimeMs, entryTimeMs: position.entryTimeMs, exitTimeMs: candle.closeTimeMs, entryPrice: position.entryPrice, exitPrice, quantity: position.quantity, notionalAtEntry: position.notional, grossPnl: gross, feeCost: fee, slippageCost: position.entrySlippage + Math.abs(exitPrice - exitRaw) * position.quantity, fundingCost: position.fundingCost, netPnl: net, exitReason: reason, holdingBars: Math.max(1, indexBySymbol.get(position.intent.symbol)! - position.entryIndex), canonicalCycleId: position.intent.canonicalCycleId ?? null, canonicalCycleSourceHash: position.intent.canonicalCycleSourceHash ?? null, persistedMarketCauseId: position.intent.persistedMarketCauseId ?? null, persistedMarketCauseSourceHash: position.intent.persistedMarketCauseSourceHash ?? null, marketEpisodeId: "POST_TRADE_PENDING", regime: typeof position.intent.metadata.regime === "string" ? position.intent.metadata.regime : null });
    return true;
  };
  const recordNav = (time: number, frame: Map<string, TournamentCandle>): void => {
    let unrealizedPnl = 0; let grossExposure = 0; let netExposure = 0; let btcBetaExposure = 0;
    for (const position of open) {
      const candle = frame.get(position.intent.symbol); const rawMark = candle?.close ?? marks.get(`${position.intent.symbol}:${time}`);
      if (!finite(rawMark) || !accrueFundingThrough(position, time + spec.dataset.timeframeMs - 1)) { invalidReasons.push(`FOUNDRY_CANONICAL_CLOCK_POSITION_MARK_MISSING_${position.intent.symbol}_${time}`); continue; }
      const exitCosts = fillCosts(position.intent.symbol, time + spec.dataset.timeframeMs - 1, position.intent.side, position.notional); const mark = adversePrice(rawMark, position.intent.side, false, exitCosts.slipBps);
      unrealizedPnl += (mark - position.entryPrice) * position.quantity * sideSign(position.intent.side) - position.entryFee - position.entrySlippage - position.notional * bps(exitCosts.feeBps) - Math.abs(mark - rawMark) * position.quantity - position.fundingCost;
      grossExposure += position.notional; netExposure += position.notional * sideSign(position.intent.side);
      try { btcBetaExposure += position.notional * Math.abs(input.portfolioRisk.at(position.intent.symbol, time, spec.portfolio.maxPortfolioRiskSnapshotAgeMs).btcBeta); } catch (error) { invalidReasons.push(error instanceof Error ? error.message : "TOURNAMENT_PORTFOLIO_RISK_MISSING"); }
    }
    const equity = cash + unrealizedPnl; equityForAdmission = equity; const usable = Math.max(1, equity * (1 - spec.portfolio.liquidationBufferFraction));
    navLedger.push({ timestampMs: time, cash, realizedPnl: cash - spec.portfolio.startingCapital, unrealizedPnl, equity, grossExposure, netExposure, marginUsage: grossExposure * spec.portfolio.initialMarginFraction, liquidationBuffer: Math.max(0, equity * spec.portfolio.liquidationBufferFraction) });
    portfolioMetrics.peakOpenPositions = Math.max(portfolioMetrics.peakOpenPositions, open.length); portfolioMetrics.peakGrossExposureFraction = Math.max(portfolioMetrics.peakGrossExposureFraction, grossExposure / usable); portfolioMetrics.peakAbsoluteNetExposureFraction = Math.max(portfolioMetrics.peakAbsoluteNetExposureFraction, Math.abs(netExposure) / usable); portfolioMetrics.peakBtcBetaFraction = Math.max(portfolioMetrics.peakBtcBetaFraction, btcBetaExposure / usable); portfolioMetrics.navPointCount = navLedger.length;
  };

  for (let timeIndex = 0; timeIndex < times.length; timeIndex += 1) {
    const time = times[timeIndex]!; const frame = grouped.get(time) ?? new Map<string, TournamentCandle>();
    for (const intent of pending.get(time) ?? []) {
      const candle = frame.get(intent.symbol); if (!candle || open.some((position) => position.intent.symbol === intent.symbol) || open.length >= spec.portfolio.maxPositions) continue;
      const usable = equityForAdmission * (1 - spec.portfolio.liquidationBufferFraction); const gross = open.reduce((sum, position) => sum + position.notional, 0); const net = open.reduce((sum, position) => sum + position.notional * sideSign(position.intent.side), 0);
      const benchmark = intent.metadata.benchmark === true; const rawNotional = benchmark ? usable / Math.max(1, intent.metadata.equalWeight === true ? universe.at(intent.decisionTimeMs).size : 1) : intent.stopFraction && intent.stopFraction > 0 ? usable * spec.portfolio.riskPerTradeFraction / intent.stopFraction : 0;
      const notional = Math.max(0, Math.min(rawNotional, usable * spec.portfolio.maxGrossExposureFraction - gross)); if (notional <= 0 || Math.abs(net + notional * sideSign(intent.side)) > usable * spec.portfolio.maxNetExposureFraction) continue;
      try {
        const incomingRisk = input.portfolioRisk.at(intent.symbol, time, spec.portfolio.maxPortfolioRiskSnapshotAgeMs); const beta = Math.abs(incomingRisk.btcBeta);
        const usedBeta = open.reduce((sum, position) => sum + position.notional * Math.abs(input.portfolioRisk.at(position.intent.symbol, time, spec.portfolio.maxPortfolioRiskSnapshotAgeMs).btcBeta), 0);
        const clusterGross = open.filter((position) => input.portfolioRisk.at(position.intent.symbol, time, spec.portfolio.maxPortfolioRiskSnapshotAgeMs).correlationCluster === incomingRisk.correlationCluster).reduce((sum, position) => sum + position.notional, 0);
        if (usedBeta + notional * beta > usable * spec.portfolio.maxBtcBetaFraction || clusterGross + notional > usable * spec.portfolio.maxCorrelationClusterFraction) continue;
      } catch (error) { invalidReasons.push(error instanceof Error ? error.message : "TOURNAMENT_PORTFOLIO_RISK_MISSING"); continue; }
      const entryCosts = fillCosts(intent.symbol, candle.openTimeMs, intent.side, notional); const entryPrice = adversePrice(candle.open, intent.side, true, entryCosts.slipBps); const quantity = notional / entryPrice;
      open.push({ intent, entryTimeMs: candle.openTimeMs, entryPrice, quantity, notional, entryFee: notional * bps(entryCosts.feeBps), entrySlippage: Math.abs(entryPrice - candle.open) * quantity, entryIndex: indexBySymbol.get(intent.symbol)!, fundingCost: 0, settledFundingTimes: new Set() });
    }
    pending.delete(time);
    for (const position of [...open]) {
      const candle = frame.get(position.intent.symbol); if (!candle || candle.openTimeMs === position.entryTimeMs) continue;
      const index = indexBySymbol.get(position.intent.symbol)!; const stop = position.intent.stopFraction === null ? null : position.entryPrice * (1 - sideSign(position.intent.side) * position.intent.stopFraction); const target = position.intent.targetFraction === null ? null : position.entryPrice * (1 + sideSign(position.intent.side) * position.intent.targetFraction);
      const stopHit = stop !== null && (position.intent.side === "LONG" ? candle.low <= stop : candle.high >= stop); const targetHit = target !== null && (position.intent.side === "LONG" ? candle.high >= target : candle.low <= target);
      const exit = stopHit && targetHit ? (costs.ambiguity === "TARGET_FIRST" ? { price: target!, reason: "TARGET" as const } : { price: stop!, reason: "STOP" as const }) : stopHit ? { price: stop!, reason: "STOP" as const } : targetHit ? { price: target!, reason: "TARGET" as const } : index - position.entryIndex >= position.intent.maxHoldBars ? { price: candle.close, reason: "TIME" as const } : null;
      if (exit && close(position, candle, exit.price, exit.reason)) open.splice(open.indexOf(position), 1);
    }
    for (const [symbol, candle] of frame) {
      const series = history.get(symbol)!; const index = indexBySymbol.get(symbol)!; const next = times[timeIndex + 1] ?? null; const nextCandle = next === null ? null : grouped.get(next)?.get(symbol) ?? null;
      const intents = strategy.onCompletedBar({ symbol, index, candle, history: series, eligibleSymbols: universe.at(candle.closeTimeMs), nextOpenTimeMs: nextCandle?.openTimeMs ?? null });
      for (const candidate of intents) { if (candidate.decisionTimeMs !== candle.closeTimeMs || candidate.entryAtOpenTimeMs !== nextCandle?.openTimeMs) throw new Error("TOURNAMENT_LOOKAHEAD_OR_NON_NEXT_OPEN_INTENT"); pending.set(candidate.entryAtOpenTimeMs, [...(pending.get(candidate.entryAtOpenTimeMs) ?? []), candidate]); }
      series.push(candle); indexBySymbol.set(symbol, index + 1);
    }
    if (timeIndex === times.length - 1) for (const position of [...open]) {
      const candle = frame.get(position.intent.symbol);
      if (candle && close(position, candle, candle.close, "END_OF_DATA")) open.splice(open.indexOf(position), 1);
    }
    recordNav(time, frame);
  }
  const terminalOpenPositions: TournamentTerminalOpenPosition[] = [];
  const terminalTime = times.at(-1)!; const terminalFrame = grouped.get(terminalTime) ?? new Map<string, TournamentCandle>();
  for (const position of open) {
    const rawMark = terminalFrame.get(position.intent.symbol)?.close ?? marks.get(`${position.intent.symbol}:${terminalTime}`);
    if (!finite(rawMark)) { invalidReasons.push(`FOUNDRY_CANONICAL_CLOCK_POSITION_MARK_MISSING_${position.intent.symbol}_${terminalTime}`); continue; }
    const exitCosts = fillCosts(position.intent.symbol, terminalTime + spec.dataset.timeframeMs - 1, position.intent.side, position.notional); const mark = adversePrice(rawMark, position.intent.side, false, exitCosts.slipBps);
    const unrealizedPnl = (mark - position.entryPrice) * position.quantity * sideSign(position.intent.side) - position.entryFee - position.entrySlippage - position.notional * bps(exitCosts.feeBps) - Math.abs(mark - rawMark) * position.quantity - position.fundingCost;
    terminalOpenPositions.push({ symbol: position.intent.symbol, side: position.intent.side, notional: position.notional, unrealizedPnl, blocker: "TERMINAL_POSITION_UNRESOLVED" });
  }
  if (terminalOpenPositions.length) invalidReasons.push("TERMINAL_POSITION_UNRESOLVED");
  const terminalUnrealizedPnl = terminalOpenPositions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
  if (terminalOpenPositions.length && Math.abs((navLedger.at(-1)?.unrealizedPnl ?? 0) - terminalUnrealizedPnl) > 1e-8) invalidReasons.push("TERMINAL_POSITION_LEDGER_RECONCILIATION_FAILED");
  if (manifest.executionMode === "OPTIMISTIC") warnings.push("OPTIMISTIC_DIAGNOSTIC_ONLY");
  // The canonical episode ledger is deliberately attached by tournament-runner
  // after every strategy has emitted and completed its immutable trades.
  const strategyMetrics = calculateMetrics(trades, navLedger, spec.portfolio.startingCapital, false, terminalOpenPositions.length === 0);
  return { manifest, navLedger, strategyMetrics, portfolioMetrics, metrics: strategyMetrics, trades, terminalOpenPositions, warnings, valid: invalidReasons.length === 0, invalidReasons };
}

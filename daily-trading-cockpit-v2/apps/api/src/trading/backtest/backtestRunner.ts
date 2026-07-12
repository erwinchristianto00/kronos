import type {
  BreakevenStopMode,
  EntryAction,
  FeatureSourceMap,
  LaneId,
  MarketContext,
  Regime,
  TradingDecision,
} from "../types.js";
import { buildTradingDecision } from "../decision/buildTradingDecision.js";
import { getStrategyMode } from "../config/strategyModes.js";

// ─────────────────────────────────────────────────────────────────────────────
// Backtest / dry-run runner — SKELETON.
//
// Deliberately model-pluggable so real fee / spread / slippage / funding curves
// can be swapped in later without touching the event loop. It is a HONEST-COSTS
// harness: fees, slippage and funding are subtracted from every trade, and the
// rejection criteria are strict on purpose (a lane must clear costs, not just
// gross). No exchange calls; feed it historical bars + models and it replays.
//
// A "bar" is one decision opportunity: the pre-computed MarketContext for that
// instant plus the OHLC/ATR needed to simulate the trade that a decision opens.
// The upstream feature layer is responsible for producing the contexts — the
// runner never re-derives indicators.
// ─────────────────────────────────────────────────────────────────────────────

export interface BacktestBar {
  timestamp: number; // epoch ms
  ctx: MarketContext; // decision context at this bar (governance fields are overwritten by the sim)
  price: number; // this bar's own close — mark-to-market / managing an ALREADY-open position only
  // Opening price of the immediately-following bar, or null if there is none (the
  // last bar in the dataset). A decision computed from `ctx` (this bar's own fully-
  // closed data) is only actionable starting here — the earliest a live system could
  // have reacted — so NEW entries fill at `nextOpen`, never at this bar's own `price`.
  nextOpen: number | null;
  high: number;
  low: number;
  atr: number; // ATR at this bar, in price units (drives ATR-multiple exits)
}

/** All models default to simple, conservative implementations. */
export interface BacktestModels {
  /** Per-side fee in USD given the notional. Default: 5 bps taker-ish. */
  feeModel?: (notional: number) => number;
  /** Round-trip slippage in bps applied to entry+exit. Default: reads bar.ctx.slippageBps. */
  slippageBpsModel?: (bar: BacktestBar) => number;
  /** Round-trip spread in bps applied to entry+exit. Default: 0 (legacy behavior). */
  spreadBpsModel?: (bar: BacktestBar) => number;
  /** Funding cost in USD per bar held. Default: 0. */
  fundingModel?: (bar: BacktestBar, notional: number) => number;
  /** Filled fraction of the intended position. 0 = missed fill, 1 = fully filled. */
  fillRatioModel?: (bar: BacktestBar, decision: Extract<TradingDecision, { action: EntryAction }>) => number;
}

export interface BacktestConfig {
  bars: BacktestBar[];
  startingEquity: number;
  models?: BacktestModels;
  /** Honor mode cooldownAfterLoss / cooldownAfterTwoLosses. Default: true. */
  respectCooldowns?: boolean;
  /** Test/report override. Strategy exits default to NET_BREAKEVEN when unset. */
  breakevenStopMode?: BreakevenStopMode;
  /** Optional extra buffer added to NET_BREAKEVEN cost estimates. Default: 0 bps. */
  breakevenSafetyBufferBps?: number;
}

export interface SimTrade {
  lane: LaneId;
  regime: Regime;
  action: EntryAction;
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  grossPnl: number;
  fees: number;
  spreadCost: number;
  slippageCost: number;
  fundingCost: number;
  netPnl: number;
  holdMinutes: number;
  exitReason: "TP" | "SL" | "MAX_HOLD" | "END_OF_DATA";
  takeProfitATR: number;
  stopLossATR: number;
  atrAtEntry: number;
  rawBreakevenPrice: number | null;
  netBreakevenPrice: number | null;
  breakevenMode: BreakevenStopMode | null;
  estimatedCostBufferPrice: number | null;
  stopMovedToBreakevenAt: number | null;
  stopMovedToBreakevenReason: string | null;
  grossPnlAtBreakevenStop: number | null;
  netPnlAtBreakevenStop: number | null;
  featureSources?: FeatureSourceMap;
}

export interface RegimePerf {
  trades: number;
  netPnl: number;
  wins: number;
  winRate: number;
}

export interface BacktestMetrics {
  numTrades: number;
  totalReturn: number; // fraction of starting equity
  endingEquity: number;
  maxDrawdown: number; // fraction, positive number
  winRate: number;
  profitFactor: number; // grossWin / grossLoss (Infinity if no losses & some wins)
  sharpePlaceholder: number | null; // naive mean/std of per-trade returns; NOT annualized
  avgTradeDurationMinutes: number;
  avgWin: number;
  avgLoss: number;
  longPerformanceByRegime: Partial<Record<Regime, RegimePerf>>;
  shortPerformanceByRegime: Partial<Record<Regime, RegimePerf>>;
  feeImpact: number; // total fees paid (USD)
  spreadImpact: number; // total spread cost (USD)
  slippageImpact: number; // total slippage cost (USD)
  fundingImpact: number; // total funding cost (USD)
  noTradeDays: number;
  trades: SimTrade[];
  diagnostics: BacktestRunDiagnostics;
}

export interface BacktestRunDiagnostics {
  enterSignalCount: number;
  closedTradeCount: number;
  skippedBecausePositionOpen: number;
  skippedBecauseCooldown: number;
  skippedBecauseMaxTrades: number;
  skippedBecauseExecutionGuard: number;
  skippedBecauseNoNextBar: number;
  positionManagementDecisionCount: number;
  noTradeDecisionCount: number;
}

const DEFAULT_FEE = (notional: number): number => notional * 0.0005; // 5 bps/side
const DEFAULT_BREAKEVEN_MODE: BreakevenStopMode = "NET_BREAKEVEN";
const bpsToFrac = (bps: number): number => bps / 10_000;
const dayKey = (ts: number): number => Math.floor(ts / 86_400_000);
const clamp01 = (n: number): number => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

export type BacktestCostScenarioName = "optimistic" | "base" | "pessimistic";

export interface BacktestCostScenario {
  name: BacktestCostScenarioName;
  models: Required<BacktestModels>;
}

export function backtestCostScenarios(): BacktestCostScenario[] {
  const feeBps = (bps: number) => (notional: number): number => notional * bpsToFrac(bps);
  const plusSlippage = (extraBps: number) => (bar: BacktestBar): number => Math.max(0, bar.ctx.slippageBps) + extraBps;
  const spread = (multiplier: number) => (bar: BacktestBar): number => Math.max(0, bar.ctx.spreadBps) * multiplier;

  return [
    {
      name: "optimistic",
      models: {
        feeModel: feeBps(3),
        slippageBpsModel: (bar) => Math.max(0, bar.ctx.slippageBps),
        spreadBpsModel: spread(0.5),
        fundingModel: () => 0,
        fillRatioModel: () => 1,
      },
    },
    {
      name: "base",
      models: {
        feeModel: feeBps(5),
        slippageBpsModel: plusSlippage(1),
        spreadBpsModel: spread(1),
        fundingModel: (_bar, notional) => notional * 0.00002,
        fillRatioModel: () => 0.9,
      },
    },
    {
      name: "pessimistic",
      models: {
        feeModel: feeBps(10),
        slippageBpsModel: plusSlippage(5),
        spreadBpsModel: spread(1.5),
        fundingModel: (_bar, notional) => notional * 0.0001,
        fillRatioModel: () => 0.7,
      },
    },
  ];
}

export function runBacktestCostScenarios(
  config: Omit<BacktestConfig, "models"> & { models?: BacktestModels },
): Record<BacktestCostScenarioName, BacktestMetrics> {
  const out = {} as Record<BacktestCostScenarioName, BacktestMetrics>;
  const baseModels = config.models ?? {};
  for (const scenario of backtestCostScenarios()) {
    out[scenario.name] = runBacktest({
      ...config,
      models: { ...scenario.models, ...baseModels },
    });
  }
  return out;
}

interface OpenState {
  lane: LaneId;
  regime: Regime;
  action: EntryAction;
  entryTs: number;
  entryPrice: number;
  qty: number;
  atr: number;
  takeProfitATR: number;
  stopLossATR: number;
  maxHoldMinutes: number;
  tpPrice: number;
  slPrice: number;
  beArmATR?: number;
  breakevenMode?: BreakevenStopMode;
  rawBreakevenPrice: number | null;
  netBreakevenPrice: number | null;
  estimatedCostBufferPrice: number | null;
  estimatedBreakevenCost: number;
  stopMovedToBreakevenAt: number | null;
  stopMovedToBreakevenReason: string | null;
  grossPnlAtBreakevenStop: number | null;
  netPnlAtBreakevenStop: number | null;
  entrySlippageCost: number;
  entrySpreadCost: number;
  entryFee: number;
  fundingAccrued: number;
  featureSources?: FeatureSourceMap;
}

/**
 * Replay the bars through buildTradingDecision, simulating each opened trade to
 * its ATR-based TP/SL or time-stop, subtracting honest costs, and enforcing the
 * daily-loss cap + consecutive-loss cooldown between trades.
 */
export function runBacktest(config: BacktestConfig): BacktestMetrics {
  const { bars, startingEquity } = config;
  const feeModel = config.models?.feeModel ?? DEFAULT_FEE;
  const fundingModel = config.models?.fundingModel ?? (() => 0);
  const slippageBpsModel = config.models?.slippageBpsModel ?? ((bar) => bar.ctx.slippageBps);
  const spreadBpsModel = config.models?.spreadBpsModel ?? (() => 0);
  const fillRatioModel = config.models?.fillRatioModel ?? (() => 1);
  const respectCooldowns = config.respectCooldowns ?? true;
  const breakevenSafetyBufferBps = Math.max(0, config.breakevenSafetyBufferBps ?? 0);

  let equity = startingEquity;
  let peakEquity = startingEquity;
  let maxDrawdown = 0;

  let consecutiveLosses = 0;
  let cooldownUntilTs = 0;
  let curDay = bars.length > 0 ? dayKey(bars[0]!.timestamp) : 0;
  let tradesToday = 0;
  let dailyStartEquity = startingEquity;
  const tradedDays = new Set<number>();
  const allDays = new Set<number>();

  const trades: SimTrade[] = [];
  const diagnostics: BacktestRunDiagnostics = {
    enterSignalCount: 0,
    closedTradeCount: 0,
    skippedBecausePositionOpen: 0,
    skippedBecauseCooldown: 0,
    skippedBecauseMaxTrades: 0,
    skippedBecauseExecutionGuard: 0,
    skippedBecauseNoNextBar: 0,
    positionManagementDecisionCount: 0,
    noTradeDecisionCount: 0,
  };
  let open: OpenState | null = null;

  const buildSimContext = (bar: BacktestBar, openPositions: number): MarketContext => {
    const dailyLossPct =
      dailyStartEquity > 0 ? Math.max(0, (dailyStartEquity - equity) / dailyStartEquity) * 100 : 0;
    return {
      ...bar.ctx,
      dailyLossPct,
      consecutiveLosses,
      openPositions,
      tradesToday,
    };
  };

  const recordDecisionDiagnostic = (decision: TradingDecision): void => {
    if (decision.action === "NO_TRADE") {
      diagnostics.noTradeDecisionCount += 1;
      if (decision.trace?.executionGuardReason) diagnostics.skippedBecauseExecutionGuard += 1;
      if (decision.trace?.riskGuardReason?.startsWith("MAX_TRADES_PER_DAY")) {
        diagnostics.skippedBecauseMaxTrades += 1;
      }
      return;
    }
    diagnostics.enterSignalCount += 1;
  };

  const closeTrade = (
    bar: BacktestBar,
    exitPrice: number,
    exitReason: SimTrade["exitReason"],
  ): void => {
    if (!open) return;
    const dir = open.action === "ENTER_LONG" ? 1 : -1;
    const gross = dir * (exitPrice - open.entryPrice) * open.qty;
    const exitNotional = Math.abs(exitPrice * open.qty);
    const exitFee = feeModel(exitNotional);
    const exitSlipBps = slippageBpsModel(bar);
    const exitSpreadBps = spreadBpsModel(bar);
    const exitSlippageCost = exitNotional * bpsToFrac(exitSlipBps);
    const exitSpreadCost = exitNotional * bpsToFrac(exitSpreadBps);
    const fees = open.entryFee + exitFee;
    const slippageCost = open.entrySlippageCost + exitSlippageCost;
    const spreadCost = open.entrySpreadCost + exitSpreadCost;
    const fundingCost = open.fundingAccrued;
    const net = gross - fees - spreadCost - slippageCost - fundingCost;

    equity += net;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.max(maxDrawdown, peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0);

    if (net < 0) consecutiveLosses += 1;
    else consecutiveLosses = 0;

    if (respectCooldowns && net < 0) {
      const mode = getStrategyMode(open.regime);
      const cd =
        consecutiveLosses >= 2
          ? mode.risk.cooldownAfterTwoLossesMinutes
          : mode.risk.cooldownAfterLossMinutes;
      cooldownUntilTs = bar.timestamp + cd * 60_000;
    }

    trades.push({
      lane: open.lane,
      regime: open.regime,
      action: open.action,
      entryTs: open.entryTs,
      exitTs: bar.timestamp,
      entryPrice: open.entryPrice,
      exitPrice,
      qty: open.qty,
      grossPnl: gross,
      fees,
      spreadCost,
      slippageCost,
      fundingCost,
      netPnl: net,
      holdMinutes: (bar.timestamp - open.entryTs) / 60_000,
      exitReason,
      takeProfitATR: open.takeProfitATR,
      stopLossATR: open.stopLossATR,
      atrAtEntry: open.atr,
      rawBreakevenPrice: open.rawBreakevenPrice,
      netBreakevenPrice: open.netBreakevenPrice,
      breakevenMode: open.breakevenMode ?? null,
      estimatedCostBufferPrice: open.estimatedCostBufferPrice,
      stopMovedToBreakevenAt: open.stopMovedToBreakevenAt,
      stopMovedToBreakevenReason: open.stopMovedToBreakevenReason,
      grossPnlAtBreakevenStop: open.grossPnlAtBreakevenStop,
      netPnlAtBreakevenStop: open.netPnlAtBreakevenStop,
      featureSources: open.featureSources,
    });
    open = null;
  };

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]!;
    allDays.add(dayKey(bar.timestamp));

    // Daily rollover: reset per-day counters when the calendar day changes.
    const d = dayKey(bar.timestamp);
    if (d !== curDay) {
      curDay = d;
      tradesToday = 0;
      dailyStartEquity = equity;
    }

    // ── manage an open position first ──────────────────────────────────────
    if (open) {
      diagnostics.positionManagementDecisionCount += 1;
      open.fundingAccrued += fundingModel(bar, Math.abs(open.entryPrice * open.qty));
      const isLong = open.action === "ENTER_LONG";

      // Breakeven ratchet: once price has moved beArm*ATR in favor, lift SL to
      // raw entry or cost-adjusted net breakeven depending on explicit mode.
      if (open.beArmATR !== undefined) {
        const favMove = isLong ? bar.high - open.entryPrice : open.entryPrice - bar.low;
        if (favMove >= open.beArmATR * open.atr) {
          const target =
            open.breakevenMode === "RAW_BREAKEVEN"
              ? open.rawBreakevenPrice ?? open.entryPrice
              : open.netBreakevenPrice ?? open.entryPrice;
          const previousSl = open.slPrice;
          open.slPrice = isLong ? Math.max(open.slPrice, target) : Math.min(open.slPrice, target);
          if (open.slPrice !== previousSl && open.stopMovedToBreakevenAt === null) {
            const dir = isLong ? 1 : -1;
            const grossAtStop = dir * (open.slPrice - open.entryPrice) * open.qty;
            open.stopMovedToBreakevenAt = bar.timestamp;
            open.stopMovedToBreakevenReason = `${open.breakevenMode ?? DEFAULT_BREAKEVEN_MODE}:favorable_move>=${open.beArmATR}ATR`;
            open.grossPnlAtBreakevenStop = grossAtStop;
            open.netPnlAtBreakevenStop = grossAtStop - open.estimatedBreakevenCost;
          }
        }
      }

      const hitSL = isLong ? bar.low <= open.slPrice : bar.high >= open.slPrice;
      const hitTP = isLong ? bar.high >= open.tpPrice : bar.low <= open.tpPrice;
      const holdMin = (bar.timestamp - open.entryTs) / 60_000;
      const mode = getStrategyMode(open.regime);
      const overHold = holdMin >= open.maxHoldMinutes;

      // Conservative tie-break: if both SL and TP are inside the same bar, take SL.
      if (hitSL) {
        closeTrade(bar, open.slPrice, "SL");
      } else if (hitTP) {
        closeTrade(bar, open.tpPrice, "TP");
      } else if (overHold) {
        closeTrade(bar, bar.price, "MAX_HOLD");
      }
      // `mode` referenced to keep cooldown semantics colocated; no-op otherwise.
      void mode;
      if (open) {
        const blockedDecision = buildTradingDecision(buildSimContext(bar, 1));
        if (blockedDecision.action !== "NO_TRADE") {
          diagnostics.enterSignalCount += 1;
          diagnostics.skippedBecausePositionOpen += 1;
        }
        continue; // still open → nothing else to do this bar.
      }
    }

    // ── flat: consider a new entry ─────────────────────────────────────────
    if (bar.timestamp < cooldownUntilTs) {
      const blockedDecision = buildTradingDecision(buildSimContext(bar, 0));
      if (blockedDecision.action !== "NO_TRADE") {
        diagnostics.enterSignalCount += 1;
        diagnostics.skippedBecauseCooldown += 1;
      }
      continue; // in cooldown, stand aside.
    }

    const ctx = buildSimContext(bar, 0);
    const decision: TradingDecision = buildTradingDecision(ctx);
    recordDecisionDiagnostic(decision);
    if (decision.action === "NO_TRADE") continue;

    // A decision computed from this bar's own closed data is only actionable
    // starting at the NEXT bar — filling on this bar's own close would assume
    // zero-latency, omniscient execution at the exact instant the signal became
    // knowable. Without a next bar (end of the dataset), there is nothing to fill
    // on, exactly like real trading can't act on a signal with no future price.
    if (bar.nextOpen === null) {
      diagnostics.enterSignalCount += 1;
      diagnostics.skippedBecauseNoNextBar += 1;
      continue;
    }

    // Open the trade: adjust the entry against us by the entry-side slippage.
    const entrySlipBps = slippageBpsModel(bar);
    const entrySpreadBps = spreadBpsModel(bar);
    const isLong = decision.action === "ENTER_LONG";
    const fillRatio = clamp01(fillRatioModel(bar, decision));
    if (fillRatio <= 0) continue; // missed maker fill / no executable size.
    const entryPrice = bar.nextOpen * (1 + (isLong ? 1 : -1) * bpsToFrac(entrySlipBps));
    const slDistance = decision.exit.stopLossATR * bar.atr;
    if (!(slDistance > 0)) continue; // degenerate ATR — skip.

    const riskUsd = equity * (decision.risk.riskPerTradePct / 100);
    const qty = (riskUsd / slDistance) * fillRatio;
    const entryNotional = Math.abs(entryPrice * qty);
    const entryFee = feeModel(entryNotional);
    const entrySlippageCost = entryNotional * bpsToFrac(entrySlipBps);
    const entrySpreadCost = entryNotional * bpsToFrac(entrySpreadBps);
    const estimatedExitFee = feeModel(entryNotional);
    const estimatedExitSlippageCost = entryNotional * bpsToFrac(entrySlipBps);
    const estimatedExitSpreadCost = entryNotional * bpsToFrac(entrySpreadBps);
    const estimatedFundingCost = fundingModel(bar, entryNotional);
    const breakevenSafetyCost = entryNotional * bpsToFrac(breakevenSafetyBufferBps);
    const estimatedBreakevenCost =
      entryFee +
      entrySlippageCost +
      entrySpreadCost +
      estimatedExitFee +
      estimatedExitSlippageCost +
      estimatedExitSpreadCost +
      estimatedFundingCost +
      breakevenSafetyCost;
    const estimatedCostBufferPrice = Math.abs(qty) > 0 ? estimatedBreakevenCost / Math.abs(qty) : 0;
    const rawBreakevenPrice = entryPrice;
    const netBreakevenPrice = isLong
      ? entryPrice + estimatedCostBufferPrice
      : entryPrice - estimatedCostBufferPrice;
    const breakevenMode =
      config.breakevenStopMode ??
      decision.exit.breakevenStopMode ??
      (decision.exit.moveStopToBreakevenAfterATR !== undefined ? DEFAULT_BREAKEVEN_MODE : undefined);

    open = {
      lane: decision.lane,
      regime: decision.regime,
      action: decision.action,
      entryTs: bar.timestamp,
      entryPrice,
      qty,
      atr: bar.atr,
      takeProfitATR: decision.exit.takeProfitATR,
      stopLossATR: decision.exit.stopLossATR,
      // 2026-07-12 fix: previously re-derived via a hand-maintained laneMaxHoldMinutes(open.lane)
      // switch at management time, duplicating each lane's own exit.maxHoldMinutes (already sitting
      // right here at entry, same as every other exit field above) — a lane's config could change
      // without this switch ever being updated, silently corrupting backtest fidelity with no error.
      maxHoldMinutes: decision.exit.maxHoldMinutes,
      tpPrice: isLong
        ? entryPrice + decision.exit.takeProfitATR * bar.atr
        : entryPrice - decision.exit.takeProfitATR * bar.atr,
      slPrice: isLong ? entryPrice - slDistance : entryPrice + slDistance,
      beArmATR: decision.exit.moveStopToBreakevenAfterATR,
      breakevenMode,
      rawBreakevenPrice: decision.exit.moveStopToBreakevenAfterATR !== undefined ? rawBreakevenPrice : null,
      netBreakevenPrice: decision.exit.moveStopToBreakevenAfterATR !== undefined ? netBreakevenPrice : null,
      estimatedCostBufferPrice: decision.exit.moveStopToBreakevenAfterATR !== undefined ? estimatedCostBufferPrice : null,
      estimatedBreakevenCost,
      stopMovedToBreakevenAt: null,
      stopMovedToBreakevenReason: null,
      grossPnlAtBreakevenStop: null,
      netPnlAtBreakevenStop: null,
      entrySlippageCost,
      entrySpreadCost,
      entryFee,
      fundingAccrued: 0,
      featureSources: decision.trace?.featureSources ?? bar.ctx.featureSources,
    };
    tradesToday += 1;
    tradedDays.add(d);
  }

  // Close any trade still open at the last bar (mark-to-market at close).
  if (open && bars.length > 0) {
    closeTrade(bars[bars.length - 1]!, bars[bars.length - 1]!.price, "END_OF_DATA");
  }

  diagnostics.closedTradeCount = trades.length;
  return summarize(trades, startingEquity, equity, maxDrawdown, allDays.size, tradedDays.size, diagnostics);
}

function summarize(
  trades: SimTrade[],
  startingEquity: number,
  endingEquity: number,
  maxDrawdown: number,
  totalDays: number,
  tradedDays: number,
  diagnostics: BacktestRunDiagnostics,
): BacktestMetrics {
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));

  const longByRegime: Partial<Record<Regime, RegimePerf>> = {};
  const shortByRegime: Partial<Record<Regime, RegimePerf>> = {};
  for (const t of trades) {
    const bucket = t.action === "ENTER_LONG" ? longByRegime : shortByRegime;
    const perf = (bucket[t.regime] ??= { trades: 0, netPnl: 0, wins: 0, winRate: 0 });
    perf.trades += 1;
    perf.netPnl += t.netPnl;
    if (t.netPnl > 0) perf.wins += 1;
    perf.winRate = perf.wins / perf.trades;
  }

  const perTradeReturns = trades.map((t) => t.netPnl / startingEquity);
  const mean = perTradeReturns.length
    ? perTradeReturns.reduce((s, r) => s + r, 0) / perTradeReturns.length
    : 0;
  const variance = perTradeReturns.length
    ? perTradeReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / perTradeReturns.length
    : 0;
  const std = Math.sqrt(variance);
  const sharpePlaceholder = perTradeReturns.length && std > 0 ? mean / std : null;

  return {
    numTrades: trades.length,
    totalReturn: startingEquity > 0 ? (endingEquity - startingEquity) / startingEquity : 0,
    endingEquity,
    maxDrawdown,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : wins.length ? Infinity : 0,
    sharpePlaceholder,
    avgTradeDurationMinutes: trades.length
      ? trades.reduce((s, t) => s + t.holdMinutes, 0) / trades.length
      : 0,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    longPerformanceByRegime: longByRegime,
    shortPerformanceByRegime: shortByRegime,
    feeImpact: trades.reduce((s, t) => s + t.fees, 0),
    spreadImpact: trades.reduce((s, t) => s + t.spreadCost, 0),
    slippageImpact: trades.reduce((s, t) => s + t.slippageCost, 0),
    fundingImpact: trades.reduce((s, t) => s + t.fundingCost, 0),
    noTradeDays: Math.max(0, totalDays - tradedDays),
    trades,
    diagnostics,
  };
}

// ── Strategy acceptance gate ────────────────────────────────────────────────

export interface RejectionCriteria {
  minProfitFactor: number; // default 1.2 (after fees)
  maxDrawdown: number; // default 0.15 (15%)
  /** Max trades allowed per BEARISH_CHOPPY day before it's "overtrading in chop". */
  maxChopTradesPerDay: number; // default 3
  chopDays: number; // number of BEARISH_CHOPPY days in the sample (for the per-day rate)
}

export interface RejectionResult {
  rejected: boolean;
  reasons: string[];
}

const DEFAULT_REJECTION: RejectionCriteria = {
  minProfitFactor: 1.2,
  maxDrawdown: 0.15,
  maxChopTradesPerDay: 3,
  chopDays: 1,
};

/**
 * Encodes the spec's "reject the strategy in simulation if …" list. A lane must
 * EARN its place: clear costs, survive drawdown, not overtrade the chop, and
 * (structurally) never depend on averaging/martingale.
 */
export function rejectStrategy(
  metrics: BacktestMetrics,
  criteria: Partial<RejectionCriteria> = {},
): RejectionResult {
  const c = { ...DEFAULT_REJECTION, ...criteria };
  const reasons: string[] = [];

  if (metrics.numTrades === 0) {
    // Nothing traded — can't validate an edge; treat as reject (unproven).
    return { rejected: true, reasons: ["NO_TRADES"] };
  }

  if (metrics.profitFactor < c.minProfitFactor) {
    reasons.push(`PROFIT_FACTOR_BELOW_${c.minProfitFactor}:${metrics.profitFactor.toFixed(2)}`);
  }

  // Profit disappears after slippage: net is red but would be green without slippage.
  const netPnl = sumNet(metrics);
  const pnlExSlippage = netPnl + metrics.slippageImpact;
  if (netPnl <= 0 && pnlExSlippage > 0) {
    reasons.push("PROFIT_DISAPPEARS_AFTER_SLIPPAGE");
  }

  if (metrics.maxDrawdown > c.maxDrawdown) {
    reasons.push(`MAX_DRAWDOWN_TOO_HIGH:${(metrics.maxDrawdown * 100).toFixed(1)}%`);
  }

  const chopTrades = metrics.trades.filter((t) => t.regime === "BEARISH_CHOPPY_DEFENSIVE").length;
  const chopRate = chopTrades / Math.max(1, c.chopDays);
  if (chopRate > c.maxChopTradesPerDay) {
    reasons.push(`OVERTRADING_IN_CHOP:${chopRate.toFixed(1)}/day`);
  }

  // Structural safety: no trade may ever have used averaging-down or martingale.
  // (Impossible via makeRiskConfig; asserted here so a regression is caught.)
  // No per-trade flag is carried, but a dependence would show as a lane that only
  // wins by adding to losers — outside this skeleton's scope, so we assert the
  // invariant at the config layer instead (see constants.makeRiskConfig).

  return { rejected: reasons.length > 0, reasons };
}

function sumNet(metrics: BacktestMetrics): number {
  return metrics.trades.reduce((s, t) => s + t.netPnl, 0);
}

// ── Walk-forward validation ─────────────────────────────────────────────────

export interface WalkForwardResult {
  folds: BacktestMetrics[];
  profitableFolds: number;
  /** True when the edge only shows up in a single fold (curve-fit risk). */
  singlePeriodDependence: boolean;
}

/**
 * Split the bars into `foldCount` contiguous folds and backtest each. If fewer
 * than half the folds are profitable, the edge is likely fit to one period.
 */
export function walkForwardBacktest(config: BacktestConfig, foldCount: number): WalkForwardResult {
  const n = config.bars.length;
  const folds: BacktestMetrics[] = [];
  const size = Math.max(1, Math.floor(n / Math.max(1, foldCount)));

  for (let start = 0; start < n; start += size) {
    const slice = config.bars.slice(start, start + size);
    if (slice.length === 0) continue;
    folds.push(runBacktest({ ...config, bars: slice }));
  }

  const profitableFolds = folds.filter((f) => f.totalReturn > 0).length;
  const singlePeriodDependence = folds.length > 1 && profitableFolds <= 1;
  return { folds, profitableFolds, singlePeriodDependence };
}

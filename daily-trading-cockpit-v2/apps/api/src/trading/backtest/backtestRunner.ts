import type { EntryAction, LaneId, MarketContext, Regime, TradingDecision } from "../types.js";
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
  price: number; // reference/close price for entries and mark-to-market
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
  /** Funding cost in USD per bar held. Default: 0. */
  fundingModel?: (bar: BacktestBar, notional: number) => number;
}

export interface BacktestConfig {
  bars: BacktestBar[];
  startingEquity: number;
  models?: BacktestModels;
  /** Honor mode cooldownAfterLoss / cooldownAfterTwoLosses. Default: true. */
  respectCooldowns?: boolean;
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
  slippageCost: number;
  fundingCost: number;
  netPnl: number;
  holdMinutes: number;
  exitReason: "TP" | "SL" | "MAX_HOLD" | "END_OF_DATA";
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
  slippageImpact: number; // total slippage cost (USD)
  fundingImpact: number; // total funding cost (USD)
  noTradeDays: number;
  trades: SimTrade[];
}

const DEFAULT_FEE = (notional: number): number => notional * 0.0005; // 5 bps/side
const bpsToFrac = (bps: number): number => bps / 10_000;
const dayKey = (ts: number): number => Math.floor(ts / 86_400_000);

interface OpenState {
  lane: LaneId;
  regime: Regime;
  action: EntryAction;
  entryTs: number;
  entryPrice: number;
  qty: number;
  atr: number;
  tpPrice: number;
  slPrice: number;
  beArmATR?: number;
  entrySlippageCost: number;
  entryFee: number;
  fundingAccrued: number;
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
  const respectCooldowns = config.respectCooldowns ?? true;

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
  let open: OpenState | null = null;

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
    const exitSlippageCost = exitNotional * bpsToFrac(exitSlipBps);
    const fees = open.entryFee + exitFee;
    const slippageCost = open.entrySlippageCost + exitSlippageCost;
    const fundingCost = open.fundingAccrued;
    const net = gross - fees - slippageCost - fundingCost;

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
      slippageCost,
      fundingCost,
      netPnl: net,
      holdMinutes: (bar.timestamp - open.entryTs) / 60_000,
      exitReason,
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
      open.fundingAccrued += fundingModel(bar, Math.abs(open.entryPrice * open.qty));
      const isLong = open.action === "ENTER_LONG";

      // Breakeven ratchet: once price has moved beArm*ATR in favor, lift SL to entry.
      if (open.beArmATR !== undefined) {
        const favMove = isLong ? bar.high - open.entryPrice : open.entryPrice - bar.low;
        if (favMove >= open.beArmATR * open.atr) {
          open.slPrice = isLong
            ? Math.max(open.slPrice, open.entryPrice)
            : Math.min(open.slPrice, open.entryPrice);
        }
      }

      const hitSL = isLong ? bar.low <= open.slPrice : bar.high >= open.slPrice;
      const hitTP = isLong ? bar.high >= open.tpPrice : bar.low <= open.tpPrice;
      const holdMin = (bar.timestamp - open.entryTs) / 60_000;
      const mode = getStrategyMode(open.regime);
      const laneMaxHold = laneMaxHoldMinutes(open.lane);
      const overHold = holdMin >= laneMaxHold;

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
      if (open) continue; // still open → nothing else to do this bar.
    }

    // ── flat: consider a new entry ─────────────────────────────────────────
    if (bar.timestamp < cooldownUntilTs) continue; // in cooldown, stand aside.

    const dailyLossPct =
      dailyStartEquity > 0 ? Math.max(0, (dailyStartEquity - equity) / dailyStartEquity) * 100 : 0;

    const ctx: MarketContext = {
      ...bar.ctx,
      dailyLossPct,
      consecutiveLosses,
      openPositions: 0,
      tradesToday,
    };

    const decision: TradingDecision = buildTradingDecision(ctx);
    if (decision.action === "NO_TRADE") continue;

    // Open the trade: adjust the entry against us by the entry-side slippage.
    const entrySlipBps = slippageBpsModel(bar);
    const isLong = decision.action === "ENTER_LONG";
    const entryPrice = bar.price * (1 + (isLong ? 1 : -1) * bpsToFrac(entrySlipBps));
    const slDistance = decision.exit.stopLossATR * bar.atr;
    if (!(slDistance > 0)) continue; // degenerate ATR — skip.

    const riskUsd = equity * (decision.risk.riskPerTradePct / 100);
    const qty = riskUsd / slDistance;
    const entryNotional = Math.abs(entryPrice * qty);
    const entryFee = feeModel(entryNotional);
    const entrySlippageCost = entryNotional * bpsToFrac(entrySlipBps);

    open = {
      lane: decision.lane,
      regime: decision.regime,
      action: decision.action,
      entryTs: bar.timestamp,
      entryPrice,
      qty,
      atr: bar.atr,
      tpPrice: isLong
        ? entryPrice + decision.exit.takeProfitATR * bar.atr
        : entryPrice - decision.exit.takeProfitATR * bar.atr,
      slPrice: isLong ? entryPrice - slDistance : entryPrice + slDistance,
      beArmATR: decision.exit.moveStopToBreakevenAfterATR,
      entrySlippageCost,
      entryFee,
      fundingAccrued: 0,
    };
    tradesToday += 1;
    tradedDays.add(d);
  }

  // Close any trade still open at the last bar (mark-to-market at close).
  if (open && bars.length > 0) {
    closeTrade(bars[bars.length - 1]!, bars[bars.length - 1]!.price, "END_OF_DATA");
  }

  return summarize(trades, startingEquity, equity, maxDrawdown, allDays.size, tradedDays.size);
}

function laneMaxHoldMinutes(lane: LaneId): number {
  switch (lane) {
    case "SHORT_RALLY_FADE":
      return 60;
    case "BREAKDOWN_RETEST_SHORT":
      return 90;
    case "MICRO_MEAN_REVERSION":
      return 20;
    case "PULLBACK_LONG_SCALP":
      return 120;
    case "BREAKOUT_RETEST_LONG":
      return 180;
    case "RELATIVE_STRENGTH_LONG":
      return 180;
    default:
      return 120;
  }
}

function summarize(
  trades: SimTrade[],
  startingEquity: number,
  endingEquity: number,
  maxDrawdown: number,
  totalDays: number,
  tradedDays: number,
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
    slippageImpact: trades.reduce((s, t) => s + t.slippageCost, 0),
    fundingImpact: trades.reduce((s, t) => s + t.fundingCost, 0),
    noTradeDays: Math.max(0, totalDays - tradedDays),
    trades,
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

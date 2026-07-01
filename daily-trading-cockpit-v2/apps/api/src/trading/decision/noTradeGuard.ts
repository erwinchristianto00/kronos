import type { MarketContext, Regime, TradingDecision } from "../types.js";
import { GUARD_THRESHOLDS } from "../constants.js";

// ─────────────────────────────────────────────────────────────────────────────
// No-trade guard — the "survive first" veto. No-trade is a valid, first-class
// lane: when the environment is hostile to ANY edge (losing day, loss streak,
// wide book, low regime confidence, decision zone, abnormal vol/funding, thin
// liquidity, conflicting signals) we stand aside regardless of regime.
// ─────────────────────────────────────────────────────────────────────────────

export interface NoTradeEvaluation {
  triggered: boolean;
  /** Names of every condition that fired (empty when not triggered). */
  reasons: string[];
}

export function evaluateNoTrade(ctx: MarketContext): NoTradeEvaluation {
  const reasons: string[] = [];

  if (ctx.dailyLossPct >= GUARD_THRESHOLDS.maxDailyLossPct) reasons.push("DAILY_LOSS_CAP");
  if (ctx.consecutiveLosses >= GUARD_THRESHOLDS.maxConsecutiveLosses) reasons.push("CONSECUTIVE_LOSSES");
  if (ctx.spreadBps > GUARD_THRESHOLDS.maxSpreadBps) reasons.push("SPREAD_TOO_WIDE");
  if (ctx.slippageBps > GUARD_THRESHOLDS.maxSlippageBps) reasons.push("SLIPPAGE_TOO_HIGH");
  if (ctx.regimeConfidence < GUARD_THRESHOLDS.minRegimeConfidence) reasons.push("LOW_REGIME_CONFIDENCE");
  if (ctx.isDecisionZone === true) reasons.push("BTC_DECISION_ZONE");
  if (ctx.volatilityTooHigh === true) reasons.push("VOLATILITY_ABNORMAL");
  if (ctx.signalConflict === true) reasons.push("SIGNAL_CONFLICT");
  if (ctx.liquidityTooThin === true) reasons.push("LIQUIDITY_TOO_THIN");
  if (ctx.fundingRiskAbnormal === true) reasons.push("FUNDING_RISK_ABNORMAL");

  return { triggered: reasons.length > 0, reasons };
}

/** Build the spec-shaped NO_TRADE decision, echoing the diagnostic reason bag. */
export function noTradeDecision(
  ctx: MarketContext,
  regime: Regime,
  triggered: string[],
): TradingDecision {
  return {
    action: "NO_TRADE",
    regime,
    reason: {
      dailyLossPct: ctx.dailyLossPct,
      consecutiveLosses: ctx.consecutiveLosses,
      spreadBps: ctx.spreadBps,
      slippageBps: ctx.slippageBps,
      regimeConfidence: ctx.regimeConfidence,
      isDecisionZone: ctx.isDecisionZone ?? false,
      volatilityTooHigh: ctx.volatilityTooHigh ?? false,
      signalConflict: ctx.signalConflict ?? false,
      liquidityTooThin: ctx.liquidityTooThin ?? false,
      fundingRiskAbnormal: ctx.fundingRiskAbnormal ?? false,
      triggered,
    },
  };
}

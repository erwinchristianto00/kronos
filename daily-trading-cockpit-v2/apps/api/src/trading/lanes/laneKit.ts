import type { MarketContext, StrategyLane, TradingDecision } from "../types.js";
import { GUARD_THRESHOLDS } from "../constants.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shared lane helpers. Keeps per-lane files down to just their entry predicate.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Microstructure/governance floor that EVERY lane requires before it may enter.
 * (The full no-trade guard is richer; this is the per-lane subset the spec lists
 * verbatim under each lane's "Entry" block so a lane can never self-enter into a
 * wide spread / high slippage / already-losing-day state.)
 */
export function passesLaneFloor(ctx: MarketContext): boolean {
  return (
    ctx.spreadBps <= GUARD_THRESHOLDS.maxSpreadBps &&
    ctx.slippageBps <= GUARD_THRESHOLDS.maxSlippageBps &&
    ctx.dailyLossPct < GUARD_THRESHOLDS.maxDailyLossPct &&
    ctx.consecutiveLosses < GUARD_THRESHOLDS.maxConsecutiveLosses
  );
}

/** True when `value` is a finite number within [low, high] (inclusive). */
export function inRange(value: number | undefined, low: number, high: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
}

/**
 * Build the ENTER decision for a lane whose predicate has already passed. The
 * lane's action, exit and risk are copied onto the decision; averaging/martingale
 * remain false because the lane's RiskConfig can only have been made via
 * makeRiskConfig.
 */
export function buildLaneDecision(lane: StrategyLane, ctx: MarketContext): TradingDecision {
  const regime = ctx.regime ?? "NO_TRADE";
  return {
    action: lane.action,
    lane: lane.id,
    regime,
    exit: lane.exit,
    risk: lane.risk,
  };
}

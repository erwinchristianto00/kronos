import type { RiskConfig } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Framework-wide constants and invariants.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strategy shapes that are NEVER allowed anywhere in this framework, in any
 * regime. Enforced structurally: `makeRiskConfig` cannot produce a config that
 * enables averaging-down or martingale, and `strategyModes` lists these in every
 * mode's `disabledLanes`. Kept as data so tests can assert none of our active
 * lanes ever collide with them.
 */
export const FORBIDDEN_LANES: readonly string[] = [
  "MARTINGALE",
  "AVERAGING_DOWN",
  "DCA_LONG",
  "GRID_LONG",
  "HOLD_UNTIL_RECOVERY",
  "AGGRESSIVE_ALT_LONG",
  "LONG_BREAKOUT", // long breakout during bearish-choppy is explicitly banned
  "TREND_FOLLOW_LONG",
] as const;

/**
 * Global no-trade / guard thresholds. These are the "survive first" floors; a
 * mode's execution config may be stricter (never looser) via ctx overrides.
 */
export const GUARD_THRESHOLDS = {
  maxDailyLossPct: 1.0,
  maxConsecutiveLosses: 2,
  maxSpreadBps: 8,
  maxSlippageBps: 10,
  minRegimeConfidence: 0.6,
  /** RSI band for a "weak bounce" short-fade entry. */
  shortFadeRsiLow: 55,
  shortFadeRsiHigh: 70,
  /** RSI ceiling for a micro-mean-reversion flush entry. */
  microReversionRsiMax: 25,
} as const;

/**
 * The ONLY way to construct a RiskConfig. Averaging-down and martingale are
 * hardcoded off so no lane can accidentally (or deliberately) opt into them.
 */
export function makeRiskConfig(riskPerTradePct: number, maxOpenPositions: number): RiskConfig {
  return {
    riskPerTradePct,
    maxOpenPositions,
    allowAveragingDown: false,
    allowMartingale: false,
  };
}

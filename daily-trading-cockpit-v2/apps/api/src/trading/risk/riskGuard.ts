import type { GuardResult, MarketContext, ModeRiskConfig } from "../types.js";
import { GUARD_THRESHOLDS } from "../constants.js";

// ─────────────────────────────────────────────────────────────────────────────
// Risk guard — mode-level governance BEFORE any lane may open a position. Uses
// the active regime's ModeRiskConfig for caps, allowing per-context overrides to
// TIGHTEN (never loosen). Returns the first failing reason.
// ─────────────────────────────────────────────────────────────────────────────

/** Effective cap: the stricter (smaller) of the mode config and any ctx override. */
function tighter(modeValue: number, override: number | undefined): number {
  return typeof override === "number" && Number.isFinite(override)
    ? Math.min(modeValue, override)
    : modeValue;
}

/** 2026-07-12 fix: `value ?? 0` only replaces null/undefined — a NaN value makes the guard
 *  comparison (`NaN >= cap`) always false, silently DISABLING the cap instead of failing closed.
 *  contextIntegrity.ts already screens dailyLossPct/consecutiveLosses for exactly this failure
 *  mode upstream of this function, but never screened openPositions/tradesToday. Falls back to
 *  Infinity (not 0) on a non-finite value — an unknown count must BLOCK new entries, the same
 *  fail-closed convention as every other guard here, never silently permit them. */
function safeCountOrBlock(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Infinity;
}

export function riskGuard(ctx: MarketContext, mode: ModeRiskConfig): GuardResult {
  const maxDailyLossPct = tighter(mode.maxDailyLossPct, ctx.maxDailyLossPct);
  const maxOpenPositions = tighter(mode.maxOpenPositions, ctx.maxOpenPositions);
  const maxTradesPerDay = tighter(mode.maxTradesPerDay, ctx.maxTradesPerDay);
  const maxSpreadBps = tighter(GUARD_THRESHOLDS.maxSpreadBps, ctx.maxSpreadBps);
  const maxSlippageBps = tighter(GUARD_THRESHOLDS.maxSlippageBps, ctx.maxSlippageBps);

  if (ctx.dailyLossPct >= maxDailyLossPct) {
    return { allowed: false, reason: `DAILY_LOSS_CAP_REACHED:${ctx.dailyLossPct}>=${maxDailyLossPct}` };
  }
  if (ctx.consecutiveLosses >= GUARD_THRESHOLDS.maxConsecutiveLosses) {
    return { allowed: false, reason: `CONSECUTIVE_LOSS_LIMIT:${ctx.consecutiveLosses}` };
  }
  const openPositions = safeCountOrBlock(ctx.openPositions);
  if (openPositions >= maxOpenPositions) {
    return { allowed: false, reason: `MAX_OPEN_POSITIONS:${ctx.openPositions ?? 0}>=${maxOpenPositions}` };
  }
  const tradesToday = safeCountOrBlock(ctx.tradesToday);
  if (tradesToday >= maxTradesPerDay) {
    return { allowed: false, reason: `MAX_TRADES_PER_DAY:${ctx.tradesToday ?? 0}>=${maxTradesPerDay}` };
  }
  if (ctx.spreadBps > maxSpreadBps) {
    return { allowed: false, reason: `SPREAD_TOO_WIDE:${ctx.spreadBps}>${maxSpreadBps}` };
  }
  if (ctx.slippageBps > maxSlippageBps) {
    return { allowed: false, reason: `SLIPPAGE_TOO_HIGH:${ctx.slippageBps}>${maxSlippageBps}` };
  }

  return { allowed: true, reason: "OK" };
}

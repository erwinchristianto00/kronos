/**
 * Regime-flip rescue (testnet-only) — the ENTRY/flip side that complements the engine's existing
 * regime harvest (`maybeCloseTestnetRegimeHarvest`).
 *
 * Problem it solves: a position that OPPOSES the current regime (e.g. a stuck XRPUSDT LONG while the
 * controller is SHORT_ONLY) keeps getting redder as price moves with the regime, so the breakeven
 * harvest — which only flattens an opposing position once it is green-after-cost — never fires. It
 * just bleeds until the 30-min hard-cut dumps it at a loss.
 *
 * The rescue tactic (operator's idea): on a stuck, sufficiently-red, sufficiently-old opposing
 * position, ADD a regime-aligned order. Because the account is one-way / netted, selling more than
 * the long flips the symbol to a net SHORT (regime-aligned). As price keeps moving with the regime,
 * that net short recovers the booked loss; once the COMBINED venture (loss realized at flip + the
 * net short's current unrealized) reaches the target, flatten the entire symbol.
 *
 * This module is a PURE decision function — no exchange calls, no I/O — so the risky sizing/trigger
 * logic is fully unit-testable. The engine provides exchange truth (positions, balance, rescue
 * bookkeeping) and executes the returned plan. It is hard-gated to testnet by the caller.
 *
 * NOTE on netting accounting: a flip SELL of `origLong + netShort` units closes the long (booking its
 * loss as `priorRealizedUsd`) and opens `netShort`. The flatten trigger therefore compares
 * `priorRealizedUsd + currentNetAfterCostUsd` against the target — the whole symbol's P&L, not just
 * the live leg.
 */

export type RescueDirection = "LONG" | "SHORT";

export interface RegimeFlipRescueConfig {
  /** Master gate. The caller additionally hard-gates this to env === "testnet". */
  enabled: boolean;
  /** Opposing position must have been open at least this long before it is eligible (anti-whipsaw). */
  minAgeMs: number;
  /** Opposing position must be at least this red (net-after-cost ≤ -minLossUsd) to rescue. Positive USDT. */
  minLossUsd: number;
  /** Flip target: net regime-aligned size = |original| × netFraction (1.0 ⇒ net short equal to the long). */
  netFraction: number;
  /** Hard cap on the flip order's notional (USDT). Keeps a rescue from over-leveraging a thin account. */
  maxNotionalUsd: number;
  /** Flatten the whole symbol once combined venture P&L (priorRealized + current net-after-cost) ≥ this. */
  targetUsd: number;
  /** Max number of symbols in rescue at once. */
  maxSymbols: number;
  /** Require at least this much available margin before STARTING a new rescue (flattens are exempt). */
  minAvailableBalanceUsd: number;
  /** Safety cut: flatten a rescue that has been open this long even if it has NOT reached target (0 = never). */
  maxHoldMs: number;
}

/** One opposing/under-water position the engine offers to the planner, with rescue bookkeeping. */
export interface RescuePositionView {
  symbol: string;
  /** Direction of the stuck intent (the side that opposes the regime). */
  intentDirection: RescueDirection;
  /** Signed exchange position amount (>0 long, <0 short). */
  positionAmt: number;
  markPrice: number;
  unrealizedUsd: number;
  /** unrealizedUsd minus the conservative estimated close cost. */
  netAfterCostUsd: number;
  openedAtMs: number;
  /** True once this symbol has already been flipped (engine is tracking a rescue for it). */
  inRescue: boolean;
  /** Loss booked when the long was closed at flip (≤ 0 typically). 0 when not yet in rescue. */
  priorRealizedUsd: number;
}

export interface RescueFlipAction {
  kind: "FLIP";
  symbol: string;
  /** Regime-aligned side (opposite of the stuck intentDirection). */
  side: "BUY" | "SELL";
  /** Total order qty to place (UNrounded — the caller rounds to the symbol stepSize and checks minQty). */
  flipQty: number;
  /** The net regime-aligned size we intend to be left holding after the flip. */
  targetNetQty: number;
  reason: string;
}

export interface RescueFlattenAction {
  kind: "FLATTEN";
  symbol: string;
  /** reduce-only side that takes the net position to zero. */
  side: "BUY" | "SELL";
  qty: number;
  combinedUsd: number;
  reason: string;
}

export interface RescueSkip {
  symbol: string;
  reason: string;
}

export interface RegimeFlipRescuePlan {
  flips: RescueFlipAction[];
  flattens: RescueFlattenAction[];
  skips: RescueSkip[];
}

const POSITIVE = (raw: string | undefined, fallback: number): number => {
  const n = raw === undefined ? NaN : Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Parse the rescue config from env. Testnet-only: the caller passes `liveEnv` and we force `enabled`
 * false on anything other than "testnet" so this can never act on mainnet, regardless of env flags.
 */
export function parseRegimeFlipRescueConfig(
  env: NodeJS.ProcessEnv,
  liveEnv: "testnet" | "mainnet" | null,
): RegimeFlipRescueConfig {
  return {
    enabled: env.LIVE_TESTNET_RESCUE_ENABLED === "1" && liveEnv === "testnet",
    minAgeMs: Math.floor(POSITIVE(env.LIVE_TESTNET_RESCUE_MIN_AGE_MS, 60 * 60 * 1000)),
    minLossUsd: POSITIVE(env.LIVE_TESTNET_RESCUE_MIN_LOSS_USD, 1),
    netFraction: POSITIVE(env.LIVE_TESTNET_RESCUE_NET_FRACTION, 1),
    maxNotionalUsd: POSITIVE(env.LIVE_TESTNET_RESCUE_MAX_NOTIONAL_USD, 250),
    targetUsd: POSITIVE(env.LIVE_TESTNET_RESCUE_TARGET_USD, 0),
    maxSymbols: Math.floor(POSITIVE(env.LIVE_TESTNET_RESCUE_MAX_SYMBOLS, 2)),
    minAvailableBalanceUsd: POSITIVE(env.LIVE_TESTNET_RESCUE_MIN_AVAIL_USD, 10),
    maxHoldMs: Math.floor(POSITIVE(env.LIVE_TESTNET_RESCUE_MAX_HOLD_MS, 24 * 60 * 60 * 1000)),
  };
}

/**
 * Pure planner. Returns the flips to open (flip a stuck opposing position to net regime-aligned),
 * the flattens to take (a symbol already in rescue whose combined venture has reached the target),
 * and skips (with reasons) for observability.
 *
 * @param opposingDirection the direction that OPPOSES the regime (LONG when mode SHORT_ONLY, SHORT when
 *        LONG_ONLY, null when the regime is not directional — no new flips, but flattens still run).
 */
export function planRegimeFlipRescue(input: {
  config: RegimeFlipRescueConfig;
  opposingDirection: RescueDirection | null;
  nowMs: number;
  availableBalanceUsd: number | null;
  positions: RescuePositionView[];
  /** Number of symbols already in rescue (engine-tracked), used for the maxSymbols budget. */
  activeRescueCount: number;
}): RegimeFlipRescuePlan {
  const { config, opposingDirection, nowMs, availableBalanceUsd, positions, activeRescueCount } = input;
  const plan: RegimeFlipRescuePlan = { flips: [], flattens: [], skips: [] };
  if (!config.enabled) return plan;

  let flipBudget = Math.max(0, config.maxSymbols - activeRescueCount);

  for (const pos of positions) {
    // ── already in rescue → only decide whether to flatten now ──────────────────────────────────
    if (pos.inRescue) {
      const combinedUsd = pos.priorRealizedUsd + pos.netAfterCostUsd;
      const targetHit = combinedUsd >= config.targetUsd;
      const maxHoldHit = config.maxHoldMs > 0 && nowMs - pos.openedAtMs >= config.maxHoldMs;
      if (targetHit || maxHoldHit) {
        plan.flattens.push({
          kind: "FLATTEN",
          symbol: pos.symbol,
          side: pos.positionAmt > 0 ? "SELL" : "BUY",
          qty: Math.abs(pos.positionAmt),
          combinedUsd,
          reason: targetHit
            ? `combined ${combinedUsd.toFixed(2)} USDT ≥ target ${config.targetUsd.toFixed(2)}`
            : `max-hold cut: rescue open ≥ ${(config.maxHoldMs / 3_600_000).toFixed(1)}h, combined ${combinedUsd.toFixed(2)} USDT`,
        });
      } else {
        plan.skips.push({
          symbol: pos.symbol,
          reason: `in rescue: combined ${combinedUsd.toFixed(2)} < target ${config.targetUsd.toFixed(2)}`,
        });
      }
      continue;
    }

    // ── flip-eligibility for a stuck opposing position ──────────────────────────────────────────
    if (opposingDirection === null) {
      plan.skips.push({ symbol: pos.symbol, reason: "regime not directional — no flip" });
      continue;
    }
    if (pos.intentDirection !== opposingDirection) continue; // aligned with regime already; nothing to rescue
    if (!(Math.abs(pos.positionAmt) > 0) || !(pos.markPrice > 0)) {
      plan.skips.push({ symbol: pos.symbol, reason: "no live position / invalid mark" });
      continue;
    }
    if (!(pos.netAfterCostUsd <= -config.minLossUsd)) {
      plan.skips.push({
        symbol: pos.symbol,
        reason: `not red enough (${pos.netAfterCostUsd.toFixed(2)} > -${config.minLossUsd.toFixed(2)})`,
      });
      continue;
    }
    if (nowMs - pos.openedAtMs < config.minAgeMs) {
      plan.skips.push({ symbol: pos.symbol, reason: "too fresh (min age not met)" });
      continue;
    }
    if (availableBalanceUsd !== null && availableBalanceUsd < config.minAvailableBalanceUsd) {
      plan.skips.push({
        symbol: pos.symbol,
        reason: `available ${availableBalanceUsd.toFixed(2)} < min ${config.minAvailableBalanceUsd.toFixed(2)}`,
      });
      continue;
    }
    if (flipBudget <= 0) {
      plan.skips.push({ symbol: pos.symbol, reason: "rescue slot cap reached" });
      continue;
    }

    const origAbs = Math.abs(pos.positionAmt);
    const uncappedTargetNetQty = origAbs * config.netFraction;
    const uncappedFlipQty = origAbs + uncappedTargetNetQty; // close the opposing leg AND open the net regime-aligned leg
    const flipNotional = uncappedFlipQty * pos.markPrice;
    let flipQty = uncappedFlipQty;
    let targetNetQty = uncappedTargetNetQty;
    let cappedNote = "";
    if (flipNotional > config.maxNotionalUsd) {
      flipQty = config.maxNotionalUsd / pos.markPrice;
      // maxNotionalUsd caps the ORDER size, not just the resulting net — if the cap doesn't even
      // cover closing the original position, the order would only REDUCE it (never cross zero),
      // leaving it still opposing the regime while getting labeled "in rescue" and losing the
      // engine's normal harvest/hard-cut protection (both explicitly skip rescue=true intents).
      // Skip rather than execute a flip that silently isn't one.
      if (!(flipQty > origAbs)) {
        plan.skips.push({
          symbol: pos.symbol,
          reason:
            `capped flip (${config.maxNotionalUsd.toFixed(0)} USDT / ${pos.markPrice} = ${flipQty.toFixed(6)}) ` +
            `would not cross zero (orig ${origAbs.toFixed(6)}) — raise maxNotionalUsd or reduce position size`,
        });
        continue;
      }
      // Still crosses zero, but to a smaller net than intended — recompute targetNetQty to match
      // what will ACTUALLY be left after this capped order, so the execution side's post-flip
      // direction/qty bookkeeping reflects reality instead of the pre-cap intent.
      targetNetQty = flipQty - origAbs;
      cappedNote = ` [capped to ${config.maxNotionalUsd.toFixed(0)} USDT notional]`;
    }
    // Regime-aligned side is the opposite of the stuck (opposing) side.
    const side: "BUY" | "SELL" = opposingDirection === "LONG" ? "SELL" : "BUY";
    plan.flips.push({
      kind: "FLIP",
      symbol: pos.symbol,
      side,
      flipQty,
      targetNetQty,
      reason:
        `flip stuck ${pos.intentDirection} (net ${pos.netAfterCostUsd.toFixed(2)} USDT) → net ` +
        `${side === "SELL" ? "SHORT" : "LONG"} ${targetNetQty.toFixed(6)}${cappedNote}`,
    });
    flipBudget -= 1;
  }

  return plan;
}

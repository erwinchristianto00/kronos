import type {
  ExecutionDirective,
  ExitConfig,
  MarketContext,
  ModeExecutionConfig,
} from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Execution guard — the last gate between a lane signal and an order. It never
// invents a trade; it only refuses or shapes one. Rules:
//   • Prefer maker orders.
//   • During a volatility spike, refuse a market order (avoid chasing fast
//     candles); fall back to maker only.
//   • Reject on wide spread / high slippage / thin liquidity.
//   • Carry the ATR time-stop and breakeven-ratchet through to the caller.
// PURE: returns a directive; the (separate, non-pure) execution layer acts on it.
// ─────────────────────────────────────────────────────────────────────────────

export function executionGuard(
  ctx: MarketContext,
  exec: ModeExecutionConfig,
  exit: ExitConfig,
): ExecutionDirective {
  const reject = (reason: string): ExecutionDirective => ({
    allowed: false,
    reason,
    orderType: "maker",
    maxHoldMinutes: exit.maxHoldMinutes,
    moveStopToBreakevenAfterATR: exit.moveStopToBreakevenAfterATR,
    breakevenStopMode: exit.breakevenStopMode,
  });

  if (ctx.spreadBps > exec.maxSpreadBps) return reject(`SPREAD_TOO_WIDE:${ctx.spreadBps}>${exec.maxSpreadBps}`);
  if (ctx.slippageBps > exec.maxSlippageBps) return reject(`SLIPPAGE_TOO_HIGH:${ctx.slippageBps}>${exec.maxSlippageBps}`);
  if (ctx.liquidityTooThin === true) return reject("LIQUIDITY_TOO_THIN");

  // During a spike, a market order would chase a fast candle. If we can't post as
  // maker (preference off) we stand down rather than take the bad fill.
  const spiking = ctx.volatilityTooHigh === true;
  if (spiking && exec.avoidMarketOrderDuringSpike && !exec.preferMakerOrders) {
    return reject("VOLATILITY_SPIKE_NO_MAKER");
  }

  // Maker whenever preferred, and always forced to maker during a spike.
  const orderType = exec.preferMakerOrders || spiking ? "maker" : "market";

  return {
    allowed: true,
    reason: "OK",
    orderType,
    maxHoldMinutes: exit.maxHoldMinutes,
    moveStopToBreakevenAfterATR: exit.moveStopToBreakevenAfterATR,
    breakevenStopMode: exit.breakevenStopMode,
  };
}

/**
 * Hidden market truth (Market Digital Twin, Phase-1 foundation). The SEPARATION of hidden truth from the observed
 * system view is MANDATORY: during a data-feed outage hidden prices keep moving while the bot's observed prices go
 * STALE; execution can occur at hidden current prices even when the bot sees stale data; a mark-price feed failure
 * must NOT silently overwrite the true price path. Decision functions receive ONLY the observed view (see
 * observed-market-view.ts); outcome evaluation + execution emulation may consult the hidden state. Pure types.
 */

export interface HiddenMarketState {
  asOfMs: number;
  /** The true reference price per symbol (what a fill actually transacts against). */
  truePrices: Record<string, number>;
  /** True available liquidity per symbol, or null when genuinely unknown (never fabricated). */
  trueLiquidity: Record<string, number | null>;
  /** Whether the exchange can actually execute for a symbol right now (an outage affects execution, not the ref market). */
  trueExecutionAvailability: Record<string, boolean>;
  /** The latent regime label (offline metadata; may drive sampling but must NEVER enter decision features). */
  latentRegime: string | null;
}

/** Build a hidden state from observed history; for pure OBSERVED_HISTORICAL replay, hidden truth == observed close. */
export function hiddenFromTruePrices(asOfMs: number, truePrices: Record<string, number>, opts?: { liquidity?: Record<string, number | null>; executionAvailable?: Record<string, boolean>; latentRegime?: string | null }): HiddenMarketState {
  const symbols = Object.keys(truePrices);
  const trueLiquidity: Record<string, number | null> = {};
  const trueExecutionAvailability: Record<string, boolean> = {};
  for (const s of symbols) {
    trueLiquidity[s] = opts?.liquidity?.[s] ?? null;
    trueExecutionAvailability[s] = opts?.executionAvailable?.[s] ?? true;
  }
  return { asOfMs, truePrices, trueLiquidity, trueExecutionAvailability, latentRegime: opts?.latentRegime ?? null };
}

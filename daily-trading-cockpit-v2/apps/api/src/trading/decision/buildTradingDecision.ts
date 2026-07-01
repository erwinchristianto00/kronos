import type { MarketContext, Regime, StrategyLane, TradingDecision } from "../types.js";
import { detectRegime } from "../regime/detectRegime.js";
import { getStrategyMode } from "../config/strategyModes.js";
import { evaluateNoTrade, noTradeDecision } from "./noTradeGuard.js";
import { riskGuard } from "../risk/riskGuard.js";
import { executionGuard } from "../execution/executionGuard.js";
import { buildLaneDecision } from "../lanes/laneKit.js";
import { shortRallyFade } from "../lanes/shortRallyFade.js";
import { breakdownRetestShort } from "../lanes/breakdownRetestShort.js";
import { microMeanReversion } from "../lanes/microMeanReversion.js";
import { pullbackLongScalp } from "../lanes/pullbackLongScalp.js";
import { breakoutRetestLong } from "../lanes/breakoutRetestLong.js";
import { relativeStrengthLong } from "../lanes/relativeStrengthLong.js";

// ─────────────────────────────────────────────────────────────────────────────
// Master decision builder. Deterministic pipeline:
//   1. detect regime
//   2. enrich context with the regime
//   3. no-trade guard  (stand aside if the environment is hostile)
//   4. risk guard      (mode-level caps / cooldown gates)
//   5. route lanes by regime, in priority order
//   6. first lane whose predicate AND execution guard pass wins
//   7. otherwise NO_TRADE "No valid lane setup"
//
// Lane priority per regime (spec):
//   BEARISH_CHOPPY_DEFENSIVE → ShortRallyFade, BreakdownRetestShort, MicroMeanReversion
//   BEAR_TREND               → BreakdownRetestShort
//   NEUTRAL_RECOVERY         → PullbackLongScalp, BreakoutRetestLong, RelativeStrengthLong
//   TREND_RECOVERY           → [TODO LongPullbackTrend], BreakoutRetestLong, [TODO MomentumContinuation]
//   NO_TRADE                 → (none)
// ─────────────────────────────────────────────────────────────────────────────

export const LANE_ROUTING: Record<Regime, StrategyLane[]> = {
  BEARISH_CHOPPY_DEFENSIVE: [shortRallyFade, breakdownRetestShort, microMeanReversion],
  BEAR_TREND: [breakdownRetestShort],
  NEUTRAL_RECOVERY: [pullbackLongScalp, breakoutRetestLong, relativeStrengthLong],
  // TODO(priority 1): LongPullbackTrend — module not built yet.
  // TODO(priority 3): MomentumContinuation — module not built yet.
  TREND_RECOVERY: [breakoutRetestLong],
  NO_TRADE: [],
};

export function buildTradingDecision(rawCtx: MarketContext): TradingDecision {
  // 1–2. detect + enrich.
  const regime = detectRegime(rawCtx);
  const ctx: MarketContext = { ...rawCtx, regime };

  // No routable regime — stand aside immediately.
  if (regime === "NO_TRADE") {
    return noTradeDecision(ctx, regime, ["REGIME_NO_TRADE"]);
  }

  // 3. no-trade guard.
  const noTrade = evaluateNoTrade(ctx);
  if (noTrade.triggered) {
    return noTradeDecision(ctx, regime, noTrade.reasons);
  }

  // 4. risk guard (mode caps + cooldown gates).
  const mode = getStrategyMode(regime);
  const rg = riskGuard(ctx, mode.risk);
  if (!rg.allowed) {
    return noTradeDecision(ctx, regime, [`RISK_GUARD:${rg.reason}`]);
  }

  // 5–6. route lanes by regime in priority order; first fully-valid lane wins.
  for (const lane of LANE_ROUTING[regime]) {
    if (!lane.shouldEnter(ctx)) continue;
    const exec = executionGuard(ctx, mode.execution, lane.exit);
    if (!exec.allowed) continue; // signal was valid but the fill would be bad; try the next lane.
    return buildLaneDecision(lane, ctx);
  }

  // 7. nothing lined up.
  return noTradeDecision(ctx, regime, ["NO_VALID_LANE_SETUP"]);
}

import type {
  DecisionTrace,
  MarketContext,
  Regime,
  StrategyLane,
  TradingDecision,
} from "../types.js";
import { detectRegime } from "../regime/detectRegime.js";
import { getStrategyMode } from "../config/strategyModes.js";
import { evaluateNoTrade, noTradeDecision } from "./noTradeGuard.js";
import { riskGuard } from "../risk/riskGuard.js";
import { executionGuard } from "../execution/executionGuard.js";
import { buildLaneDecision } from "../lanes/laneKit.js";
import { detectContradictions, stalenessReasons } from "../contextIntegrity.js";
import { decisionSafetyRejection } from "../safety.js";
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
//   3. context integrity     (contradictions → stand aside)
//   4. freshness             (stale multi-TF data → stand aside)
//   5. no-trade guard        (hostile environment → stand aside)
//   6. risk guard            (mode-level caps / cooldown gates)
//   7. route lanes by regime priority; first lane whose predicate AND execution
//      guard pass wins
//   8. FINAL HARD GATE        (forbidden lane / forbidden risk can NEVER enter,
//                              even if a lane or the config is wrong)
//   9. otherwise NO_TRADE "No valid lane setup"
//
// Every return carries a DecisionTrace so any outcome is fully explainable.
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

export interface BuildDecisionOptions {
  /** Override the lane routing (test-only: inject a malicious lane to prove the hard gate). */
  routing?: Record<Regime, StrategyLane[]>;
}

function emptyTrace(regime: Regime): DecisionTrace {
  return {
    detectedRegime: regime,
    selectedLane: null,
    rejectedBy: null,
    noTradeReason: null,
    riskGuardReason: null,
    executionGuardReason: null,
    contradictions: [],
  };
}

/** Attach a trace to a decision (mutating a fresh copy keeps callers simple). */
function withTrace(decision: TradingDecision, trace: DecisionTrace): TradingDecision {
  return { ...decision, trace } as TradingDecision;
}

export function buildTradingDecision(
  rawCtx: MarketContext,
  opts: BuildDecisionOptions = {},
): TradingDecision {
  const routing = opts.routing ?? LANE_ROUTING;

  // 1–2. detect + enrich.
  const regime = detectRegime(rawCtx);
  const ctx: MarketContext = { ...rawCtx, regime };
  const trace = emptyTrace(regime);

  // 3. context integrity — contradictory inputs mean the feature layer disagrees
  //    with itself; never trust priority resolution over a contradiction.
  const contradictions = detectContradictions(ctx);
  trace.contradictions = contradictions;
  if (contradictions.length > 0) {
    trace.rejectedBy = "CONTRADICTORY_CONTEXT";
    trace.noTradeReason = contradictions;
    return withTrace(noTradeDecision(ctx, regime, [`CONTRADICTORY_CONTEXT:${contradictions.join(",")}`]), trace);
  }

  // 4. freshness — stale multi-timeframe data cannot be traded on.
  const stale = stalenessReasons(ctx);
  if (stale.length > 0) {
    trace.rejectedBy = "DATA_STALE";
    trace.noTradeReason = stale;
    return withTrace(noTradeDecision(ctx, regime, [`DATA_STALE:${stale.join(",")}`]), trace);
  }

  // No routable regime — stand aside.
  if (regime === "NO_TRADE") {
    trace.rejectedBy = "REGIME_NO_TRADE";
    trace.noTradeReason = ["REGIME_NO_TRADE"];
    return withTrace(noTradeDecision(ctx, regime, ["REGIME_NO_TRADE"]), trace);
  }

  // 5. no-trade guard.
  const noTrade = evaluateNoTrade(ctx);
  if (noTrade.triggered) {
    trace.rejectedBy = "NO_TRADE_GUARD";
    trace.noTradeReason = noTrade.reasons;
    return withTrace(noTradeDecision(ctx, regime, noTrade.reasons), trace);
  }

  // 6. risk guard (mode caps + cooldown gates).
  const mode = getStrategyMode(regime);
  const rg = riskGuard(ctx, mode.risk);
  if (!rg.allowed) {
    trace.rejectedBy = "RISK_GUARD";
    trace.riskGuardReason = rg.reason;
    return withTrace(noTradeDecision(ctx, regime, [`RISK_GUARD:${rg.reason}`]), trace);
  }

  // 7. route lanes by regime in priority order; first fully-valid lane wins.
  for (const lane of routing[regime]) {
    if (!lane.shouldEnter(ctx)) continue;
    const exec = executionGuard(ctx, mode.execution, lane.exit);
    if (!exec.allowed) {
      trace.executionGuardReason = exec.reason; // remember the last exec block for logging
      continue; // signal valid but the fill would be bad; try the next lane.
    }

    const candidate = buildLaneDecision(lane, ctx);

    // 8. FINAL HARD GATE — a forbidden lane or a risk config that enables
    //    martingale/averaging can NEVER produce an entry, no matter what the
    //    lane or config said. Fail SAFE to NO_TRADE.
    const rejection = decisionSafetyRejection(candidate);
    if (rejection) {
      trace.rejectedBy = "FORBIDDEN_LANE_HARD_GATE";
      trace.selectedLane = null;
      trace.noTradeReason = [`FORBIDDEN_LANE_HARD_GATE:${rejection.code}:${rejection.detail}`];
      return withTrace(
        noTradeDecision(ctx, regime, [`FORBIDDEN_LANE_HARD_GATE:${rejection.code}`]),
        trace,
      );
    }

    trace.selectedLane = lane.id;
    return withTrace(candidate, trace);
  }

  // 9. nothing lined up.
  trace.rejectedBy = "NO_VALID_LANE_SETUP";
  trace.noTradeReason = ["NO_VALID_LANE_SETUP"];
  return withTrace(noTradeDecision(ctx, regime, ["NO_VALID_LANE_SETUP"]), trace);
}

// Regime-based strategy framework — public surface.
// HYPOTHESIS-ONLY: nothing here is wired into live execution. Validate via the
// backtest runner + walk-forward + paper trading before trusting any lane.

export * from "./types.js";
export * from "./constants.js";
export { detectRegime } from "./regime/detectRegime.js";
export { STRATEGY_MODES, getStrategyMode } from "./config/strategyModes.js";
export { evaluateNoTrade, noTradeDecision } from "./decision/noTradeGuard.js";
export type { NoTradeEvaluation } from "./decision/noTradeGuard.js";
export { riskGuard } from "./risk/riskGuard.js";
export { executionGuard } from "./execution/executionGuard.js";
export { buildTradingDecision, LANE_ROUTING } from "./decision/buildTradingDecision.js";
export type { BuildDecisionOptions } from "./decision/buildTradingDecision.js";
export {
  isForbiddenLaneId,
  riskConfigViolation,
  assertNoForbiddenRisk,
  assertNoForbiddenLane,
  assertStrategyModeSafe,
  assertLaneSafe,
  decisionSafetyRejection,
  validateFrameworkInvariants,
} from "./safety.js";
export type { SafetyRejection } from "./safety.js";
export {
  detectContradictions,
  stalenessReasons,
  isContextStale,
} from "./contextIntegrity.js";
export { passesLaneFloor, inRange, buildLaneDecision } from "./lanes/laneKit.js";
export { shortRallyFade } from "./lanes/shortRallyFade.js";
export { breakdownRetestShort } from "./lanes/breakdownRetestShort.js";
export { microMeanReversion } from "./lanes/microMeanReversion.js";
export { pullbackLongScalp } from "./lanes/pullbackLongScalp.js";
export { breakoutRetestLong } from "./lanes/breakoutRetestLong.js";
export { relativeStrengthLong } from "./lanes/relativeStrengthLong.js";
export * from "./backtest/backtestRunner.js";
export { contextFromCandles, DEFAULT_FEATURE_CONFIG } from "./features/contextFromCandles.js";
export type { FeatureAdapterInput, FeatureAdapterConfig } from "./features/contextFromCandles.js";

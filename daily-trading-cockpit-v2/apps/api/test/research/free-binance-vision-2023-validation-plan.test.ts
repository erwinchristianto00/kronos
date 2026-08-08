import { describe, expect, it } from "vitest";

import { tournamentHash } from "../../src/research/contract/tournament-contract.js";
import {
  assertFreeBinanceVision2023ValidationPlan,
  FREE_BINANCE_VISION_2023_05_TO_2024_03_BASELINE_ALLOWLIST,
  FREE_BINANCE_VISION_2023_05_TO_2024_03_MAX_TACTICAL_HOLD_BARS,
  FREE_BINANCE_VISION_2023_05_TO_2024_03_VALIDATION_PLAN,
} from "../../src/research/validation/free-binance-vision-2023-05-to-2024-03-plan.js";
import { buildWalkForwardPlan } from "../../src/research/validation/walk-forward.js";

const HOUR_MS = 3_600_000;

describe("free Binance Vision BTCUSDT/ETHUSDT 2023 validation plan", () => {
  it("persists the exact frozen scope, Conservative baseline matrix, and evidence gates", () => {
    const plan = FREE_BINANCE_VISION_2023_05_TO_2024_03_VALIDATION_PLAN;
    expect(plan.scope).toEqual({
      symbols: ["BTCUSDT", "ETHUSDT"],
      timeframe: "1h",
      timeframeMs: HOUR_MS,
      startMs: Date.UTC(2023, 4, 16, 12),
      endMs: Date.UTC(2024, 3, 1),
      totalBars: 7_692,
    });
    expect(FREE_BINANCE_VISION_2023_05_TO_2024_03_BASELINE_ALLOWLIST).toEqual([
      "CASH", "BTC_BUY_AND_HOLD", "EQUAL_WEIGHT_HOLD", "DONCHIAN", "MACD", "EMA_CROSS", "RSI_MEAN_REVERSION", "RANDOM_CONTROL",
    ]);
    expect(plan.executionPolicy.executionModes).toEqual(["CONSERVATIVE"]);
    expect(plan.executionPolicy.baselineAllowlist).toEqual(FREE_BINANCE_VISION_2023_05_TO_2024_03_BASELINE_ALLOWLIST);
    expect(plan.executionPolicy.kronosCurrentForbidden).toBe(true);
    expect(plan.tier1EligibilityPolicy).toEqual({
      minimumHistory: { version: "free-binance-vision-prior-completed-bars-v1", minimumCompletedBars: 168, strictlyPrior: true },
      liquiditySpread: { version: "free-binance-vision-bbo-liquidity-spread-v1", minVolume: 0, minLiquidityNotional: 50_000, maxSpreadBps: 5, maxAgeMs: HOUR_MS },
    });
    expect(plan.tier1ConservativeExecution).toMatchObject({ takerFeeBps: 4, baseSlippageBps: 2, pessimisticSlippageMultiplier: 2, fundingEnabled: true, fillMode: "NEXT_OPEN", intrabarAmbiguity: "STOP_FIRST" });
    expect(plan.tier1Portfolio).toMatchObject({ startingCapital: 10_000, maxPositions: 2, maxPortfolioRiskSnapshotAgeMs: HOUR_MS });
    expect(plan.sourceScopeSelection).toMatchObject({
      requestedStartMs: Date.UTC(2023, 4, 1, 1),
      selectedStartMs: Date.UTC(2023, 4, 16, 12),
      rawBookTickerBundleHash: "3338e528944869fec5b2ce112cdeedac7aa1fe031563a141a57babf4ad39584a",
    });
    expect(plan.evidenceGates).toEqual({
      minimumOosWindows: 3,
      minimumCompletedTradesPerInterpretedStrategy: 20,
      minimumCanonicalIndependentEpisodes: 10,
      maximumInvalidFolds: 0,
      maximumTerminalUnresolvedPositions: 0,
      insufficientEvidenceVerdict: "INCONCLUSIVE",
    });
    expect(plan.robustness.costFundingStress).toEqual({
      scenarioId: "CONSERVATIVE_FEE_SLIPPAGE_AND_FUNDING_STRESS",
      executionMode: "CONSERVATIVE",
      takerFeeBps: 6,
      baseSlippageBps: 3,
      pessimisticSlippageMultiplier: 2,
      fundingRateMultiplier: 2,
      policy: "REPLAY_SAME_IMMUTABLE_PIT_INPUTS_WITH_ADVERSE_COST_TRANSFORM_ONLY",
    });
    expect(plan.robustness.candidateVerdictPolicy).toEqual({
      requiresBaseOosAndHoldoutEvidence: true,
      requiresCostFundingStress: true,
      requiresParameterNeighborhoodAssessment: true,
      verdictWhenAnyRequirementMissing: "INCONCLUSIVE",
    });
  });

  it("uses fixed 120d/30d/30d windows and purges plus embargoes every tactical challenger horizon", () => {
    const plan = FREE_BINANCE_VISION_2023_05_TO_2024_03_VALIDATION_PLAN;
    expect(FREE_BINANCE_VISION_2023_05_TO_2024_03_MAX_TACTICAL_HOLD_BARS).toBe(48);
    expect(plan.challengerHoldingHorizon.directionalStrategyVersions).toEqual([
      { id: "DONCHIAN", version: "donchian-v1", maxHoldBars: 48 },
      { id: "MACD", version: "macd-v1", maxHoldBars: 48 },
      { id: "EMA_CROSS", version: "ema-cross-v1", maxHoldBars: 48 },
      { id: "RSI_MEAN_REVERSION", version: "rsi-mean-reversion-v1", maxHoldBars: 48 },
    ]);
    expect(plan.validation).toMatchObject({ trainBars: 120 * 24, testBars: 30 * 24, stepBars: 30 * 24, purgeBars: 48, embargoBars: 48, minIndependentEpisodes: 10 });
    expect(plan.validation.purgeBars).toBeGreaterThanOrEqual(plan.challengerHoldingHorizon.maxTacticalHoldBars);
    expect(plan.validation.embargoBars).toBeGreaterThanOrEqual(plan.challengerHoldingHorizon.maxTacticalHoldBars);
  });

  it("seals the latest twenty percent of the canonical clock, never less than sixty days", () => {
    const plan = FREE_BINANCE_VISION_2023_05_TO_2024_03_VALIDATION_PLAN;
    expect(plan.sealedHoldout).toEqual({
      allocation: "LATEST_20_PERCENT_OF_CANONICAL_1H_CLOCK",
      minimumBars: 60 * 24,
      actualBars: 1_539,
      actualFraction: 1_539 / 7_692,
    });
    expect(plan.validation.sealedHoldoutStartMs).toBe(Date.UTC(2024, 0, 27, 21));
  });

  it("is deep-frozen and has a deterministic self-excluding artifact hash", () => {
    const plan = FREE_BINANCE_VISION_2023_05_TO_2024_03_VALIDATION_PLAN;
    const { artifactHash, ...payload } = plan;
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.scope)).toBe(true);
    expect(Object.isFrozen(plan.scope.symbols)).toBe(true);
    expect(Object.isFrozen(plan.executionPolicy.baselineAllowlist)).toBe(true);
    expect(Object.isFrozen(plan.robustness.parameterNeighborhoods.DONCHIAN)).toBe(true);
    expect(artifactHash).toBe(tournamentHash(payload));
    expect(() => assertFreeBinanceVision2023ValidationPlan()).not.toThrow();
  });

  it("predeclares adverse cost/funding and one-axis tactical neighborhoods before data results exist", () => {
    const plan = FREE_BINANCE_VISION_2023_05_TO_2024_03_VALIDATION_PLAN;
    expect(plan.robustness.costFundingStress.takerFeeBps).toBeGreaterThanOrEqual(plan.tier1ConservativeExecution.takerFeeBps);
    expect(plan.robustness.costFundingStress.baseSlippageBps).toBeGreaterThanOrEqual(plan.tier1ConservativeExecution.baseSlippageBps);
    expect(plan.robustness.costFundingStress.fundingRateMultiplier).toBeGreaterThanOrEqual(1);
    for (const parameterSets of Object.values(plan.robustness.parameterNeighborhoods).filter(Array.isArray)) {
      expect(parameterSets).toHaveLength(7);
      expect(parameterSets.every((parameters) => parameters.maxHoldBars === FREE_BINANCE_VISION_2023_05_TO_2024_03_MAX_TACTICAL_HOLD_BARS)).toBe(true);
    }
  });

  it("produces at least three sealed-safe OOS folds before its held-out interval", () => {
    const plan = FREE_BINANCE_VISION_2023_05_TO_2024_03_VALIDATION_PLAN;
    const timestamps = Array.from({ length: plan.scope.totalBars }, (_unused, index) => plan.scope.startMs + index * HOUR_MS);
    const walkForward = buildWalkForwardPlan(timestamps, plan.validation);
    expect(walkForward.folds).toHaveLength(4);
    expect(walkForward.folds.length).toBeGreaterThanOrEqual(plan.evidenceGates.minimumOosWindows);
    expect(walkForward.folds.every((fold) => fold.test.endExclusive <= walkForward.sealedHoldout.startIndex)).toBe(true);
  });
});

/**
 * Immutable, pre-result validation contract for the free Binance Vision
 * BTCUSDT/ETHUSDT 1h REAL_TIER1 study.  This module deliberately contains no
 * runner or data access: execution must bind this exact artifact before it can
 * interpret any result.
 */
import { tournamentHash } from "../contract/tournament-contract.js";
import {
  donchianStrategy,
  emaCrossStrategy,
  macdStrategy,
  rsiMeanReversionStrategy,
  type TournamentStrategy,
} from "../strategies/challengers.js";
import type { TournamentStrategyId, TournamentValidationSpec } from "../tournament-types.js";

const HOUR_MS = 3_600_000;
const DAY_BARS = 24;
// The raw verified Binance Vision BBO bundle has no BTCUSDT/ETHUSDT common
// observation before this tick (both May archives first observe 11:49:47Z on
// May 16). This v2 plan is frozen before result generation and replaces the
// unavailable May 1 candidate rather than silently treating missing BBO as
// eligibility.
const FREE_SCOPE_START_MS = Date.UTC(2023, 4, 16, 12);
const FREE_SCOPE_END_MS = Date.UTC(2024, 3, 1);
const FREE_SCOPE_TOTAL_BARS = (FREE_SCOPE_END_MS - FREE_SCOPE_START_MS) / HOUR_MS;
const SEALED_HOLDOUT_MINIMUM_BARS = 60 * DAY_BARS;
const SEALED_HOLDOUT_BARS = Math.max(SEALED_HOLDOUT_MINIMUM_BARS, Math.ceil(FREE_SCOPE_TOTAL_BARS * 0.2));

export const FREE_BINANCE_VISION_2023_05_TO_2024_03_VALIDATION_PLAN_VERSION = "free-binance-vision-btceth-1h-real-tier1-validation-plan-v2" as const;

export const FREE_BINANCE_VISION_2023_05_TO_2024_03_BASELINE_ALLOWLIST = [
  "CASH",
  "BTC_BUY_AND_HOLD",
  "EQUAL_WEIGHT_HOLD",
  "DONCHIAN",
  "MACD",
  "EMA_CROSS",
  "RSI_MEAN_REVERSION",
  "RANDOM_CONTROL",
] as const satisfies readonly TournamentStrategyId[];

const TACTICAL_CHALLENGERS = [donchianStrategy(), macdStrategy(), emaCrossStrategy(), rsiMeanReversionStrategy()] as const satisfies readonly TournamentStrategy[];

function maxHoldBars(strategy: TournamentStrategy): number {
  const value = strategy.parameters.maxHoldBars;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`FREE_TIER1_DIRECTIONAL_HOLDING_HORIZON_INVALID_${strategy.id}`);
  return value;
}

/**
 * Benchmarks intentionally hold to end-of-data and are not tactical
 * challenger horizons. RANDOM_CONTROL inherits its complete trade template,
 * including this horizon, from Donchian in the bound Tier-1 assembly.
 */
export const FREE_BINANCE_VISION_2023_05_TO_2024_03_MAX_TACTICAL_HOLD_BARS = Math.max(...TACTICAL_CHALLENGERS.map(maxHoldBars));

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

const validation: TournamentValidationSpec = {
  trainBars: 120 * DAY_BARS,
  testBars: 30 * DAY_BARS,
  stepBars: 30 * DAY_BARS,
  purgeBars: FREE_BINANCE_VISION_2023_05_TO_2024_03_MAX_TACTICAL_HOLD_BARS,
  embargoBars: FREE_BINANCE_VISION_2023_05_TO_2024_03_MAX_TACTICAL_HOLD_BARS,
  sealedHoldoutStartMs: FREE_SCOPE_END_MS - SEALED_HOLDOUT_BARS * HOUR_MS,
  minIndependentEpisodes: 10,
  // Interpretability is gated separately below; this is not a performance pass threshold.
  minOosProfitabilityFraction: 0,
};

const artifactPayload = {
  artifactKind: "TOURNAMENT_VALIDATION_PLAN",
  schemaVersion: "v1",
  planVersion: FREE_BINANCE_VISION_2023_05_TO_2024_03_VALIDATION_PLAN_VERSION,
  studyId: "free-binance-vision-usdm-btceth-1h-2023-05-16_to_2024-03",
  scope: {
    symbols: ["BTCUSDT", "ETHUSDT"],
    timeframe: "1h",
    timeframeMs: HOUR_MS,
    startMs: FREE_SCOPE_START_MS,
    endMs: FREE_SCOPE_END_MS,
    totalBars: FREE_SCOPE_TOTAL_BARS,
  },
  sourceScopeSelection: {
    policyVersion: "binance-vision-usdm-bookticker-common-start-v1",
    requestedStartMs: Date.UTC(2023, 4, 1, 1),
    selectedStartMs: FREE_SCOPE_START_MS,
    rawBookTickerBundleHash: "3338e528944869fec5b2ce112cdeedac7aa1fe031563a141a57babf4ad39584a",
    firstObservedEventTimeBySymbol: {
      BTCUSDT: { eventTimeMs: 1684237787214, rawObjectSha256: "93a787d1c1f69118f04b40fcc99607ab1f6504cb790672725359a2b94509251e" },
      ETHUSDT: { eventTimeMs: 1684237787207, rawObjectSha256: "7c39ed37defad7b62df39f7a8c901dd5858a2db91f6dd28454e238977c5d0d61" },
    },
  },
  executionPolicy: {
    researchMode: "REAL_TIER1",
    capabilityTier: "TIER_1_BASELINE",
    executionModes: ["CONSERVATIVE"],
    baselineAllowlist: FREE_BINANCE_VISION_2023_05_TO_2024_03_BASELINE_ALLOWLIST,
    kronosCurrentForbidden: true,
    rankingForbidden: true,
    promotionForbidden: true,
  },
  challengerHoldingHorizon: {
    tacticalStrategyIds: [...TACTICAL_CHALLENGERS.map((strategy) => strategy.id), "RANDOM_CONTROL"],
    directionalStrategyVersions: TACTICAL_CHALLENGERS.map((strategy) => ({ id: strategy.id, version: strategy.version, maxHoldBars: maxHoldBars(strategy) })),
    randomControlReferenceStrategyId: "DONCHIAN",
    maxTacticalHoldBars: FREE_BINANCE_VISION_2023_05_TO_2024_03_MAX_TACTICAL_HOLD_BARS,
    maxTacticalHoldMs: FREE_BINANCE_VISION_2023_05_TO_2024_03_MAX_TACTICAL_HOLD_BARS * HOUR_MS,
  },
  validation,
  sealedHoldout: {
    allocation: "LATEST_20_PERCENT_OF_CANONICAL_1H_CLOCK",
    minimumBars: SEALED_HOLDOUT_MINIMUM_BARS,
    actualBars: SEALED_HOLDOUT_BARS,
    actualFraction: SEALED_HOLDOUT_BARS / FREE_SCOPE_TOTAL_BARS,
  },
  evidenceGates: {
    minimumOosWindows: 3,
    minimumCompletedTradesPerInterpretedStrategy: 20,
    minimumCanonicalIndependentEpisodes: 10,
    maximumInvalidFolds: 0,
    maximumTerminalUnresolvedPositions: 0,
    insufficientEvidenceVerdict: "INCONCLUSIVE",
  },
} as const;

export type FreeBinanceVision2023ValidationPlan = Readonly<typeof artifactPayload & { artifactHash: string }>;

/** Hash excludes itself and binds every static scope, policy, and evidence gate. */
export const FREE_BINANCE_VISION_2023_05_TO_2024_03_VALIDATION_PLAN: FreeBinanceVision2023ValidationPlan = deepFreeze({
  ...artifactPayload,
  artifactHash: tournamentHash(artifactPayload),
});

/** Fail closed if a strategy default changes without an explicit plan revision. */
export function assertFreeBinanceVision2023ValidationPlan(): void {
  const plan = FREE_BINANCE_VISION_2023_05_TO_2024_03_VALIDATION_PLAN;
  if (plan.scope.totalBars !== FREE_SCOPE_TOTAL_BARS || !Number.isInteger(plan.scope.totalBars)) throw new Error("FREE_TIER1_VALIDATION_SCOPE_CLOCK_INVALID");
  if (plan.validation.trainBars !== 120 * DAY_BARS || plan.validation.testBars !== 30 * DAY_BARS || plan.validation.stepBars !== 30 * DAY_BARS) throw new Error("FREE_TIER1_VALIDATION_WINDOW_CONTRACT_INVALID");
  if (plan.validation.purgeBars < plan.challengerHoldingHorizon.maxTacticalHoldBars || plan.validation.embargoBars < plan.challengerHoldingHorizon.maxTacticalHoldBars) throw new Error("FREE_TIER1_VALIDATION_HOLDING_HORIZON_LEAKAGE_GUARD_INVALID");
  if (plan.sealedHoldout.actualBars < plan.sealedHoldout.minimumBars || plan.sealedHoldout.actualFraction < 0.2) throw new Error("FREE_TIER1_VALIDATION_SEALED_HOLDOUT_TOO_SHORT");
  if (plan.executionPolicy.executionModes.length !== 1 || plan.executionPolicy.executionModes[0] !== "CONSERVATIVE" || (plan.executionPolicy.baselineAllowlist as readonly TournamentStrategyId[]).includes("KRONOS_CURRENT")) throw new Error("FREE_TIER1_VALIDATION_EXECUTION_POLICY_INVALID");
  if (plan.evidenceGates.minimumOosWindows < 3 || plan.evidenceGates.minimumCompletedTradesPerInterpretedStrategy < 20 || plan.evidenceGates.minimumCanonicalIndependentEpisodes < 10 || plan.evidenceGates.maximumInvalidFolds !== 0 || plan.evidenceGates.maximumTerminalUnresolvedPositions !== 0) throw new Error("FREE_TIER1_VALIDATION_EVIDENCE_GATE_WEAKENED");
  if (plan.artifactHash !== tournamentHash(artifactPayload)) throw new Error("FREE_TIER1_VALIDATION_PLAN_HASH_MISMATCH");
}

assertFreeBinanceVision2023ValidationPlan();

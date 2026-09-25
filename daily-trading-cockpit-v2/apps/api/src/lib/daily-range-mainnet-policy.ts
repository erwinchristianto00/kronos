import {
  parseDailyRangeAllocatorMode,
  type DailyRangeAllocatorMode,
} from "./daily-range-selector.js";

/**
 * Explicit, fail-closed mainnet policy for the isolated Daily Range lane.
 *
 * This is intentionally separate from LIVE_MAINNET_CONFIRM.  That account-level
 * acknowledgement permits the incumbent engine to exist; it must never silently
 * grant a newly promoted lane permission to send real orders.
 */

export const DAILY_RANGE_MAINNET_CONFIRM_PHRASE = "I_UNDERSTAND_DAILY_RANGE_REAL_MONEY";
/** Testnet must exercise the same scarce-slot allocation shape as the Live 3 × 25 USDT policy. */
export const DAILY_RANGE_TESTNET_MAX_OPEN_TRADES_DEFAULT = 3;
/** Default is deliberately the established V3 policy. An unknown value must not change Testnet execution. */
export const DAILY_RANGE_TESTNET_EXPERIMENT_BASELINE = "BASELINE_V3" as const;
/**
 * Isolated Testnet-only cohort: the existing first-reentry failed-breakout FADE
 * router keeps its frozen breakout-extreme stop and R30 trail, but uses a
 * fixed native 2R target instead of the opposite 4H range boundary.
 */
export const DAILY_RANGE_TESTNET_EXPERIMENT_FADE_FIXED_2R_R30_V1 = "FADE_FAILED_BREAKOUT_FIXED_2R_R30_V1" as const;
/**
 * Testnet-only V5 FADE cohort. It keeps the V5 structural stop, opposite-range
 * target, and R30 trail, while rejecting unusually extended sweeps and adding
 * a completed-1m soft invalidation. It can never be selected by Mainnet.
 */
export const DAILY_RANGE_TESTNET_EXPERIMENT_FADE_GENUINE_BREAKOUT_FILTER_SOFT_V1 = "FADE_GENUINE_BREAKOUT_FILTER_SOFT_V1" as const;
export type DailyRangeTestnetExperiment =
  | typeof DAILY_RANGE_TESTNET_EXPERIMENT_BASELINE
  | typeof DAILY_RANGE_TESTNET_EXPERIMENT_FADE_FIXED_2R_R30_V1
  | typeof DAILY_RANGE_TESTNET_EXPERIMENT_FADE_GENUINE_BREAKOUT_FILTER_SOFT_V1;

export type DailyRangeNewEntryMode = "ENABLED" | "PAUSED_SELECTION_FIX";

export interface DailyRangeMainnetControls {
  executionEnabled: boolean;
  /** Explicit future promotion gate; defaults false even when Fade is armed. */
  continuationExecutionEnabled: boolean;
  confirmed: boolean;
  canaryEnabled: boolean;
  armEnabled: boolean;
  maxOpenTrades: number;
  maxGrossNotionalUsd: number;
  /** Independent from arm/disarm so protection and shadow collection can stay live. */
  newEntryMode: DailyRangeNewEntryMode;
  /** LOOP_ORDER_LEGACY is never accepted as an operational Mainnet mode. */
  allocatorMode: DailyRangeAllocatorMode;
}

function nonNegativeInteger(raw: string | undefined): number {
  const value = Number.parseFloat(raw ?? "");
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function nonNegativeNumber(raw: string | undefined): number {
  const value = Number.parseFloat(raw ?? "");
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function newEntryMode(raw: string | undefined): DailyRangeNewEntryMode {
  // After the selection incident, absence is deliberately a pause rather than a
  // silent re-enable during a release/config migration.
  return raw === "ENABLED" ? "ENABLED" : "PAUSED_SELECTION_FIX";
}

/**
 * Testnet's neutral allocator is only a useful comparator when it receives the
 * same finite portfolio decision as Live. An absent, zero, or malformed value
 * therefore fails to the established three-trade strategy cap, never infinity.
 */
export function resolveDailyRangeTestnetMaxOpenTrades(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = nonNegativeInteger(env.DAILY_RANGE_TESTNET_MAX_OPEN_TRADES);
  return configured >= 1 ? configured : DAILY_RANGE_TESTNET_MAX_OPEN_TRADES_DEFAULT;
}

/**
 * Preserve the established Testnet execution behavior when an older release
 * does not carry this key. Once configured, however, only an explicit "1"
 * grants Continuation entry authority. That makes a malformed new config
 * shadow-only rather than silently executable.
 */
export function resolveDailyRangeTestnetContinuationExecutionEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const requested = env.DAILY_RANGE_TESTNET_CONTINUATION_EXECUTION_ENABLED;
  return requested === undefined ? true : requested === "1";
}

/**
 * A Testnet experiment is opt-in by its exact immutable label. Missing,
 * malformed, or future labels preserve V3; this resolver is never used to
 * grant a Mainnet route a different target.
 */
export function resolveDailyRangeTestnetExperiment(
  env: NodeJS.ProcessEnv = process.env,
): DailyRangeTestnetExperiment {
  switch (env.DAILY_RANGE_TESTNET_EXPERIMENT) {
    case DAILY_RANGE_TESTNET_EXPERIMENT_FADE_FIXED_2R_R30_V1:
      return DAILY_RANGE_TESTNET_EXPERIMENT_FADE_FIXED_2R_R30_V1;
    case DAILY_RANGE_TESTNET_EXPERIMENT_FADE_GENUINE_BREAKOUT_FILTER_SOFT_V1:
      return DAILY_RANGE_TESTNET_EXPERIMENT_FADE_GENUINE_BREAKOUT_FILTER_SOFT_V1;
    default:
      return DAILY_RANGE_TESTNET_EXPERIMENT_BASELINE;
  }
}

/**
 * Testnet may still run the explicitly labelled seeded comparator for research,
 * but Mainnet never may. Mainnet's safe operational fallback is the frozen
 * economic-quality baseline; no environment typo can grant random, loop-order,
 * or unvalidated-alpha authority to a real-money entry.
 */
export function resolveDailyRangeRuntimeAllocatorMode(input: {
  environment: "testnet" | "mainnet";
  env?: NodeJS.ProcessEnv;
  mainnetControls?: DailyRangeMainnetControls | null;
}): DailyRangeAllocatorMode {
  if (input.environment === "mainnet") return input.mainnetControls?.allocatorMode ?? "PAUSED";
  const requested = parseDailyRangeAllocatorMode(input.env?.DAILY_RANGE_ALLOCATOR, "ECONOMIC_QUALITY_BASELINE");
  // The legacy mode is retained only in pure replay/tests, never in a running lane.
  return requested === "LOOP_ORDER_LEGACY" ? "PAUSED" : requested;
}

/**
 * All absent/malformed values resolve to a denial.  The caller still constructs
 * the lane in observation mode, but no entry, canary, or arm can occur.
 */
export function parseDailyRangeMainnetControls(
  env: NodeJS.ProcessEnv = process.env,
): DailyRangeMainnetControls {
  const parsedEntryMode = newEntryMode(env.DAILY_RANGE_NEW_ENTRY_MODE);
  const requestedAllocator = parseDailyRangeAllocatorMode(env.DAILY_RANGE_ALLOCATOR, "PAUSED");
  const safeAllocator: DailyRangeAllocatorMode = requestedAllocator === "LOOP_ORDER_LEGACY"
    ? "PAUSED"
    : requestedAllocator === "SEEDED_RANDOM_BASELINE"
      ? "ECONOMIC_QUALITY_BASELINE"
      : requestedAllocator === "SHADOW_SELECTOR"
        ? "SHADOW_ALPHA_SELECTOR"
        : requestedAllocator === "VALIDATED_SELECTOR"
          ? "VALIDATED_ALPHA_SELECTOR"
          : requestedAllocator;
  return {
    executionEnabled: env.DAILY_RANGE_MAINNET_EXECUTION_ENABLED === "1",
    continuationExecutionEnabled: env.DAILY_RANGE_LIVE_CONTINUATION_EXECUTION_ENABLED === "1",
    confirmed: env.DAILY_RANGE_MAINNET_CONFIRM === DAILY_RANGE_MAINNET_CONFIRM_PHRASE,
    canaryEnabled: env.DAILY_RANGE_MAINNET_CANARY_ENABLED === "1",
    armEnabled: env.DAILY_RANGE_MAINNET_ARM_ENABLED === "1",
    maxOpenTrades: nonNegativeInteger(env.DAILY_RANGE_MAINNET_MAX_OPEN_TRADES),
    maxGrossNotionalUsd: nonNegativeNumber(env.DAILY_RANGE_MAINNET_MAX_GROSS_NOTIONAL_USD),
    newEntryMode: parsedEntryMode,
    allocatorMode: parsedEntryMode === "PAUSED_SELECTION_FIX"
      ? "PAUSED"
      : safeAllocator,
  };
}

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

export type DailyRangeNewEntryMode = "ENABLED" | "PAUSED_SELECTION_FIX";

export interface DailyRangeMainnetControls {
  executionEnabled: boolean;
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

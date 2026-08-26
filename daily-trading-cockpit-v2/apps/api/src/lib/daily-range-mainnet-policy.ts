/**
 * Explicit, fail-closed mainnet policy for the isolated Daily Range lane.
 *
 * This is intentionally separate from LIVE_MAINNET_CONFIRM.  That account-level
 * acknowledgement permits the incumbent engine to exist; it must never silently
 * grant a newly promoted lane permission to send real orders.
 */

export const DAILY_RANGE_MAINNET_CONFIRM_PHRASE = "I_UNDERSTAND_DAILY_RANGE_REAL_MONEY";

export interface DailyRangeMainnetControls {
  executionEnabled: boolean;
  confirmed: boolean;
  canaryEnabled: boolean;
  armEnabled: boolean;
  maxOpenTrades: number;
  maxGrossNotionalUsd: number;
}

function nonNegativeInteger(raw: string | undefined): number {
  const value = Number.parseFloat(raw ?? "");
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function nonNegativeNumber(raw: string | undefined): number {
  const value = Number.parseFloat(raw ?? "");
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * All absent/malformed values resolve to a denial.  The caller still constructs
 * the lane in observation mode, but no entry, canary, or arm can occur.
 */
export function parseDailyRangeMainnetControls(
  env: NodeJS.ProcessEnv = process.env,
): DailyRangeMainnetControls {
  return {
    executionEnabled: env.DAILY_RANGE_MAINNET_EXECUTION_ENABLED === "1",
    confirmed: env.DAILY_RANGE_MAINNET_CONFIRM === DAILY_RANGE_MAINNET_CONFIRM_PHRASE,
    canaryEnabled: env.DAILY_RANGE_MAINNET_CANARY_ENABLED === "1",
    armEnabled: env.DAILY_RANGE_MAINNET_ARM_ENABLED === "1",
    maxOpenTrades: nonNegativeInteger(env.DAILY_RANGE_MAINNET_MAX_OPEN_TRADES),
    maxGrossNotionalUsd: nonNegativeNumber(env.DAILY_RANGE_MAINNET_MAX_GROSS_NOTIONAL_USD),
  };
}

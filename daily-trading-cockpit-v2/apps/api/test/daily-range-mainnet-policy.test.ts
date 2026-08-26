import { describe, expect, it } from "vitest";

import {
  DAILY_RANGE_MAINNET_CONFIRM_PHRASE,
  parseDailyRangeMainnetControls,
  resolveDailyRangeTestnetMaxOpenTrades,
} from "../src/lib/daily-range-mainnet-policy.js";

describe("Daily Range mainnet controls", () => {
  it("fails closed for absent, malformed, and partial environment values", () => {
    expect(parseDailyRangeMainnetControls({})).toEqual({
      executionEnabled: false,
      confirmed: false,
      canaryEnabled: false,
      armEnabled: false,
      maxOpenTrades: 0,
      maxGrossNotionalUsd: 0,
      newEntryMode: "PAUSED_SELECTION_FIX",
      allocatorMode: "PAUSED",
    });
    expect(parseDailyRangeMainnetControls({
      DAILY_RANGE_MAINNET_EXECUTION_ENABLED: "true",
      DAILY_RANGE_MAINNET_CONFIRM: "yes",
      DAILY_RANGE_MAINNET_CANARY_ENABLED: "2",
      DAILY_RANGE_MAINNET_ARM_ENABLED: "true",
      DAILY_RANGE_MAINNET_MAX_OPEN_TRADES: "-3",
      DAILY_RANGE_MAINNET_MAX_GROSS_NOTIONAL_USD: "not-a-number",
    })).toEqual({
      executionEnabled: false,
      confirmed: false,
      canaryEnabled: false,
      armEnabled: false,
      maxOpenTrades: 0,
      maxGrossNotionalUsd: 0,
      newEntryMode: "PAUSED_SELECTION_FIX",
      allocatorMode: "PAUSED",
    });
  });

  it("requires every separate real-money acknowledgement and preserves explicit caps", () => {
    expect(parseDailyRangeMainnetControls({
      DAILY_RANGE_MAINNET_EXECUTION_ENABLED: "1",
      DAILY_RANGE_MAINNET_CONFIRM: DAILY_RANGE_MAINNET_CONFIRM_PHRASE,
      DAILY_RANGE_MAINNET_CANARY_ENABLED: "1",
      DAILY_RANGE_MAINNET_ARM_ENABLED: "1",
      DAILY_RANGE_MAINNET_MAX_OPEN_TRADES: "2.9",
      DAILY_RANGE_MAINNET_MAX_GROSS_NOTIONAL_USD: "50.50",
      DAILY_RANGE_NEW_ENTRY_MODE: "ENABLED",
      DAILY_RANGE_ALLOCATOR: "SEEDED_RANDOM_BASELINE",
    })).toEqual({
      executionEnabled: true,
      confirmed: true,
      canaryEnabled: true,
      armEnabled: true,
      maxOpenTrades: 2,
      maxGrossNotionalUsd: 50.5,
      newEntryMode: "ENABLED",
      allocatorMode: "SEEDED_RANDOM_BASELINE",
    });
  });

  it("keeps Mainnet paused unless an explicit entry mode and safe allocator are supplied", () => {
    expect(parseDailyRangeMainnetControls({
      DAILY_RANGE_NEW_ENTRY_MODE: "ENABLED",
      DAILY_RANGE_ALLOCATOR: "LOOP_ORDER_LEGACY",
    })).toMatchObject({ newEntryMode: "ENABLED", allocatorMode: "PAUSED" });
    expect(parseDailyRangeMainnetControls({
      DAILY_RANGE_NEW_ENTRY_MODE: "PAUSED_SELECTION_FIX",
      DAILY_RANGE_ALLOCATOR: "SEEDED_RANDOM_BASELINE",
    })).toMatchObject({ newEntryMode: "PAUSED_SELECTION_FIX", allocatorMode: "PAUSED" });
  });

  it("keeps Testnet baseline allocation under the fixed three-trade cap", () => {
    expect(resolveDailyRangeTestnetMaxOpenTrades({})).toBe(3);
    expect(resolveDailyRangeTestnetMaxOpenTrades({ DAILY_RANGE_TESTNET_MAX_OPEN_TRADES: "3" })).toBe(3);
    expect(resolveDailyRangeTestnetMaxOpenTrades({ DAILY_RANGE_TESTNET_MAX_OPEN_TRADES: "0" })).toBe(3);
    expect(resolveDailyRangeTestnetMaxOpenTrades({ DAILY_RANGE_TESTNET_MAX_OPEN_TRADES: "invalid" })).toBe(3);
  });
});

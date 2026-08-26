import { describe, expect, it } from "vitest";

import {
  DAILY_RANGE_MAINNET_CONFIRM_PHRASE,
  parseDailyRangeMainnetControls,
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
    })).toEqual({
      executionEnabled: true,
      confirmed: true,
      canaryEnabled: true,
      armEnabled: true,
      maxOpenTrades: 2,
      maxGrossNotionalUsd: 50.5,
    });
  });
});

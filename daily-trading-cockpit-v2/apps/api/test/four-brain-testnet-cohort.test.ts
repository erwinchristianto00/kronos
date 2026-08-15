import { describe, expect, it } from "vitest";

import { laneHorizon } from "../src/lib/four-brain-live-gather-bindings.js";
import {
  canonicalFourBrainTestnetCohortLaneId,
  fourBrainTestnetCohortHorizon,
  resolveFourBrainTestnetCohort,
  scopeExitTradeToFourBrainTestnetCohort,
} from "../src/lib/four-brain-testnet-cohort.js";

const ENV = {
  FOUR_BRAIN_TESTNET_FOCUS: "1",
  LIVE_BINANCE_ENV: "testnet",
  FOUR_BRAIN_TESTNET_FOCUS_SINCE: "2026-08-13T07:42:59Z",
} as NodeJS.ProcessEnv;

describe("active Four-Brain testnet cohort", () => {
  it("uses an explicit 4h horizon for directional sectional and MFE Giveback", () => {
    expect(fourBrainTestnetCohortHorizon("CROSS_SECTIONAL_DIRECTIONAL_LONG")).toBe("INTRADAY");
    expect(fourBrainTestnetCohortHorizon("CROSS_SECTIONAL_DIRECTIONAL_SHORT")).toBe("INTRADAY");
    expect(fourBrainTestnetCohortHorizon("CG_MFE_GIVEBACK_LONG")).toBe("INTRADAY");
    expect(fourBrainTestnetCohortHorizon("CG_VARIANT_MATRIX:CG_MFE_GIVEBACK")).toBe("INTRADAY");
    expect(laneHorizon("CROSS_SECTIONAL_DIRECTIONAL_SHORT")).toBe("INTRADAY");
    expect(laneHorizon("CG_MFE_GIVEBACK_LONG")).toBe("INTRADAY");
  });

  it("keeps the market-neutral basket explicitly SWING instead of falling through by accident", () => {
    expect(fourBrainTestnetCohortHorizon("CROSS_SECTIONAL_MARKET_NEUTRAL")).toBe("SWING");
    expect(laneHorizon("CROSS_SECTIONAL_MARKET_NEUTRAL")).toBe("SWING");
  });

  it("requires a stable testnet cutoff before it creates a focused cohort", () => {
    expect(resolveFourBrainTestnetCohort(ENV)?.sinceIso).toBe("2026-08-13T07:42:59.000Z");
    expect(resolveFourBrainTestnetCohort({ ...ENV, LIVE_BINANCE_ENV: "mainnet" })).toBeNull();
    expect(resolveFourBrainTestnetCohort({ ...ENV, FOUR_BRAIN_TESTNET_FOCUS_SINCE: "not-a-date" })).toBeNull();
  });

  it("splits the raw MFE lane by side and filters Exit history to the declared cohort", () => {
    const cohort = resolveFourBrainTestnetCohort(ENV)!;
    expect(canonicalFourBrainTestnetCohortLaneId("CG_VARIANT_MATRIX:CG_MFE_GIVEBACK", "SHORT")).toBe("CG_MFE_GIVEBACK_SHORT");

    const eligible = scopeExitTradeToFourBrainTestnetCohort({
      laneId: "CG_VARIANT_MATRIX:CG_MFE_GIVEBACK",
      direction: "SHORT" as const,
      closedAtIso: "2026-08-13T08:00:00Z",
      marker: "eligible",
    }, cohort);
    expect(eligible?.laneId).toBe("CG_MFE_GIVEBACK_SHORT");

    expect(scopeExitTradeToFourBrainTestnetCohort({
      laneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
      direction: "LONG" as const,
      closedAtIso: "2026-08-13T08:00:00Z",
    }, cohort)).toBeNull();
    expect(scopeExitTradeToFourBrainTestnetCohort({
      laneId: "CROSS_SECTIONAL_DIRECTIONAL_SHORT",
      direction: "SHORT" as const,
      closedAtIso: "2026-08-13T07:42:58Z",
    }, cohort)).toBeNull();
  });
});

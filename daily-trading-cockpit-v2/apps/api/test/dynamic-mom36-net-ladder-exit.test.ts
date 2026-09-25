import { describe, expect, it } from "vitest";

import {
  advanceDynamicMom36NetLadderExitState,
  bindDynamicMom36NetLadderEntryCapital,
  createDynamicMom36NetLadderExitState,
} from "../src/lib/dynamic-mom36-net-ladder-exit.js";

const T0 = Date.UTC(2026, 8, 1, 0, 0, 0);

function state(capital = 150) {
  const value = createDynamicMom36NetLadderExitState("source-1");
  bindDynamicMom36NetLadderEntryCapital(value, capital, new Date(T0).toISOString());
  return value;
}

function step(
  exit: ReturnType<typeof state>,
  netPnlUsd: number,
  netReturn: number,
  minute: number,
) {
  return advanceDynamicMom36NetLadderExitState(exit, {
    netPnlUsd,
    netReturn,
    observedAt: new Date(T0 + minute * 60_000).toISOString(),
  });
}

describe("Dynamic MOM36 net ladder / 5m volatility exit", () => {
  it("does not arm before +$1.50 and retains the existing -2% hard-cut priority", () => {
    const exit = state();
    expect(step(exit, 1.49, 0.01, 0)).toBeNull();
    expect(exit.trailArmed).toBe(false);
    expect(step(exit, -3.5, -0.023, 5)).toBe("HARD_CUT_LOSS_2");
    expect(exit.exitTrigger).toMatchObject({ reason: "HARD_CUT_LOSS_2", observedNetPnlUsd: -3.5 });
  });

  it("records the $1.50/$2.00 ladder and gives the minimum 30% trail before volatility is mature", () => {
    const exit = state();
    expect(step(exit, 1.5, 0.01, 0)).toBeNull();
    expect(exit.trailArmed).toBe(true);
    expect(exit.highestArmLevel).toBe(1);
    expect(exit.trailingFloorNetUsd).toBeCloseTo(1.05); // $1.50 - 30%

    expect(step(exit, 2, 0.013, 5)).toBeNull();
    expect(exit.highestArmLevel).toBe(2);
    expect(exit.trailingFloorNetUsd).toBeCloseTo(1.4);
    expect(step(exit, 1.4, 0.009, 10)).toBe("NET_LADDER_GIVEBACK_30");
  });

  it("uses a real five-minute P&L standard deviation as a larger minimum giveback and never lowers the ratchet", () => {
    const exit = state();
    // Four genuine 5m changes build the minimum volatility evidence. Values
    // swing by $1, so one sigma is intentionally larger than 30% of a $2 peak.
    expect(step(exit, 0, 0, 0)).toBeNull();
    expect(step(exit, 1, 0.006, 5)).toBeNull();
    expect(step(exit, 0, 0, 10)).toBeNull();
    expect(step(exit, 1, 0.006, 15)).toBeNull();
    expect(step(exit, 2, 0.013, 20)).toBeNull();
    expect(exit.fiveMinuteVolatilityUsd).not.toBeNull();
    expect(exit.minimumAllowedGivebackUsd!).toBeGreaterThan(0.6);
    expect(exit.trailingFloorNetUsd!).toBeLessThan(1.4); // sigma gives more room than a static 30% floor

    expect(step(exit, 3, 0.02, 25)).toBeNull();
    const floorAtPeak = exit.trailingFloorNetUsd!;
    expect(step(exit, 2.8, 0.018, 30)).toBeNull();
    expect(exit.trailingFloorNetUsd).toBeGreaterThanOrEqual(floorAtPeak);
  });

  it("takes full TP at 5% of actual entry capital before a giveback decision", () => {
    const exit = state(100);
    expect(step(exit, 5, 0.05, 0)).toBe("NET_LADDER_FULL_TP_5");
    expect(exit.exitTrigger).toMatchObject({ reason: "NET_LADDER_FULL_TP_5" });
  });

  it("does not manufacture extra volatility changes from multiple marks in one five-minute bucket", () => {
    const exit = state();
    step(exit, 0, 0, 0);
    step(exit, 0.5, 0.003, 1);
    step(exit, 0.8, 0.005, 4);
    expect(exit.fiveMinuteNetPnlSamples).toHaveLength(1);
    step(exit, 1.1, 0.007, 5);
    expect(exit.fiveMinuteNetPnlSamples).toHaveLength(2);
  });
});

import { describe, it, expect } from "vitest";
import {
  CRISIS_MODE_LIVE_INSTANCE_PORT,
  CRISIS_MODE_LIVE_EXECUTION_ALLOWED_FLAG,
  resolveCrisisModeInstanceId,
  isCrisisModeLiveInstance,
  isCrisisModeLiveExecutionAllowed,
  canApplyCrisisModeActions,
} from "../src/lib/crisis-mode-instance-guard.js";
import { CRISIS_MODE_ACTION_ENABLED_FLAG } from "../src/lib/crisis-mode-controller.js";

describe("resolveCrisisModeInstanceId", () => {
  it("prefers CRISIS_MODE_INSTANCE_ID over PORT", () => {
    expect(resolveCrisisModeInstanceId({ CRISIS_MODE_INSTANCE_ID: "3102", PORT: "3101" })).toBe("3102");
  });
  it("falls back to PORT when CRISIS_MODE_INSTANCE_ID is unset", () => {
    expect(resolveCrisisModeInstanceId({ PORT: "3103" })).toBe("3103");
  });
  it("falls back to 3101 (never 'unknown') when nothing is set", () => {
    expect(resolveCrisisModeInstanceId({})).toBe("3101");
  });
});

describe("isCrisisModeLiveInstance", () => {
  it("is false for the research/testnet ports", () => {
    expect(isCrisisModeLiveInstance({ PORT: "3101" })).toBe(false);
    expect(isCrisisModeLiveInstance({ PORT: "3102" })).toBe(false);
  });

  it("is true when PORT is 3103", () => {
    expect(isCrisisModeLiveInstance({ PORT: "3103" })).toBe(true);
  });

  it("is true when the resolved CRISIS_MODE_INSTANCE_ID is 3103, even if PORT differs", () => {
    expect(isCrisisModeLiveInstance({ CRISIS_MODE_INSTANCE_ID: "3103", PORT: "3101" })).toBe(true);
  });

  it("BELT-AND-SUSPENDERS: is true when raw PORT is 3103 even if CRISIS_MODE_INSTANCE_ID relabels it to something else", () => {
    // This is the exact scenario the module header calls out: a stray relabeling env var must never
    // unblock the live box.
    expect(isCrisisModeLiveInstance({ CRISIS_MODE_INSTANCE_ID: "research-mirror", PORT: "3103" })).toBe(true);
  });
});

describe("isCrisisModeLiveExecutionAllowed", () => {
  it("defaults to false when unset", () => {
    expect(isCrisisModeLiveExecutionAllowed({})).toBe(false);
  });
  it("is false for any value other than exactly '1'", () => {
    expect(isCrisisModeLiveExecutionAllowed({ [CRISIS_MODE_LIVE_EXECUTION_ALLOWED_FLAG]: "true" })).toBe(false);
    expect(isCrisisModeLiveExecutionAllowed({ [CRISIS_MODE_LIVE_EXECUTION_ALLOWED_FLAG]: "yes" })).toBe(false);
  });
  it("is true only when set to exactly '1'", () => {
    expect(isCrisisModeLiveExecutionAllowed({ [CRISIS_MODE_LIVE_EXECUTION_ALLOWED_FLAG]: "1" })).toBe(true);
  });
});

describe("canApplyCrisisModeActions — the structural gate", () => {
  const fullyEnabledNonLiveEnv = {
    PORT: "3102",
    [CRISIS_MODE_ACTION_ENABLED_FLAG]: "1",
    [CRISIS_MODE_LIVE_EXECUTION_ALLOWED_FLAG]: "1",
  };

  it("is false by default (all gates default-closed) even off the live instance", () => {
    expect(canApplyCrisisModeActions({ PORT: "3102" })).toBe(false);
    expect(canApplyCrisisModeActions({ PORT: "3101" })).toBe(false);
  });

  it("is true only when NOT the live instance AND both action gates are explicitly '1'", () => {
    expect(canApplyCrisisModeActions(fullyEnabledNonLiveEnv)).toBe(true);
  });

  it("is false when only CRISIS_MODE_ACTION_ENABLED is set (missing the live-execution flag)", () => {
    expect(canApplyCrisisModeActions({ PORT: "3102", [CRISIS_MODE_ACTION_ENABLED_FLAG]: "1" })).toBe(false);
  });

  it("is false when only CRISIS_MODE_LIVE_EXECUTION_ALLOWED is set (missing the action-enabled flag)", () => {
    expect(canApplyCrisisModeActions({ PORT: "3102", [CRISIS_MODE_LIVE_EXECUTION_ALLOWED_FLAG]: "1" })).toBe(false);
  });

  it("HARD RULE: is false on the live instance (PORT=3103) NO MATTER WHAT other flags are set", () => {
    expect(
      canApplyCrisisModeActions({
        ...fullyEnabledNonLiveEnv,
        PORT: CRISIS_MODE_LIVE_INSTANCE_PORT,
      }),
    ).toBe(false);
  });

  it("HARD RULE: stays false on live even if CRISIS_MODE_INSTANCE_ID tries to relabel it", () => {
    expect(
      canApplyCrisisModeActions({
        ...fullyEnabledNonLiveEnv,
        PORT: CRISIS_MODE_LIVE_INSTANCE_PORT,
        CRISIS_MODE_INSTANCE_ID: "definitely-not-live",
      }),
    ).toBe(false);
  });
});

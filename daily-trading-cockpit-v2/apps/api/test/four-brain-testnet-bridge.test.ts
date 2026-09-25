import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FourBrainExecutionReinforcementStore } from "../src/lib/four-brain-execution-reinforcement.js";
import {
  FourBrainTestnetBridge,
  normalizeFourBrainTestnetLane,
} from "../src/lib/four-brain-testnet-bridge.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "dtc-four-brain-bridge-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const env = {
  PORT: "3102",
  LIVE_BINANCE_ENV: "testnet",
  FOUR_BRAIN_MODE: "shadow",
  FOUR_BRAIN_TESTNET_FOCUS: "1",
  FOUR_BRAIN_TESTNET_BRIDGE_MODE: "pilot",
} as NodeJS.ProcessEnv;

function reinforcement(verdict: "POSITIVE" | "NEGATIVE" | "INSUFFICIENT") {
  return {
    lookup: () => ({
      source: "TIER1_REALIZED",
      verdict,
      scope: "EXACT_LANE_REGIME_SYMBOL",
      canonicalRegimeFamily: "BULLISH",
      laneId: "CG_MFE_GIVEBACK_LONG",
      symbolOrBasketId: "XRPUSDT",
      side: "LONG",
      n: 8,
      effectiveN: 8,
      winRate: verdict === "NEGATIVE" ? 0.25 : 0.75,
      avgNetR: verdict === "NEGATIVE" ? -0.2 : 0.2,
      adjustment: verdict === "NEGATIVE" ? -0.04 : verdict === "POSITIVE" ? 0.04 : 0,
    }),
  } as unknown as FourBrainExecutionReinforcementStore;
}

describe("Four-Brain testnet bridge", () => {
  it("normalizes only the documented CG split identity", () => {
    expect(normalizeFourBrainTestnetLane("CG_VARIANT_MATRIX:CG_MFE_GIVEBACK", "LONG")).toBe("CG_MFE_GIVEBACK_LONG");
    expect(normalizeFourBrainTestnetLane("CROSS_SECTIONAL_DIRECTIONAL_LONG", "LONG")).toBe("CROSS_SECTIONAL_DIRECTIONAL_LONG");
  });

  it("leaves earned positive evidence as a ranking-only signal", () => {
    const bridge = new FourBrainTestnetBridge({
      dataDir: tmp(),
      getCanonicalRegimeFamily: () => "BULLISH",
      reinforcement: reinforcement("POSITIVE"),
      env,
    });
    const decision = bridge.evaluate({
      laneId: "CG_VARIANT_MATRIX:CG_MFE_GIVEBACK",
      symbol: "XRPUSDT",
      side: "LONG",
      signalId: "cg-1",
      nowMs: 1,
    });

    expect(decision).toMatchObject({ allowed: true, mode: "PILOT_NEGATIVE_VETO", action: "NO_OP" });
    expect(bridge.getStatus()).toMatchObject({ active: true, mode: "PILOT_NEGATIVE_VETO", evaluations: 1, blocked: 0 });
  });

  it("can veto only a mature exact negative cohort on the focused testnet", () => {
    const bridge = new FourBrainTestnetBridge({
      dataDir: tmp(),
      getCanonicalRegimeFamily: () => "BULLISH",
      reinforcement: reinforcement("NEGATIVE"),
      env,
    });
    const decision = bridge.evaluate({
      laneId: "CROSS_SECTIONAL_DIRECTIONAL_LONG",
      symbol: "ETHUSDT",
      side: "LONG",
      signalId: "directional-1",
      nowMs: 1,
    });

    expect(decision).toMatchObject({ allowed: false, mode: "PILOT_NEGATIVE_VETO", action: "BLOCK_NEGATIVE" });
    expect(bridge.getStatus()).toMatchObject({ active: true, evaluations: 1, blocked: 1 });
  });
});

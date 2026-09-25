import { describe, expect, it } from "vitest";

import {
  evaluateCrossSectionalEntryAdmission,
  isCrossSectionalEvidenceIncomplete,
} from "../src/lib/cross-sectional-entry-traffic-light.js";

const testnetEnv = {
  LIVE_BINANCE_ENV: "testnet",
  CROSS_SECTIONAL_TESTNET_LEARNING_COHORT: "1",
  CROSS_SECTIONAL_TESTNET_LEARNING_LEG_MULTIPLIER: "0.35",
  CROSS_SECTIONAL_TESTNET_LEARNING_MAX_OPEN: "2",
} as NodeJS.ProcessEnv;

describe("cross-sectional entry traffic light", () => {
  it("keeps a measured-positive lane GREEN at normal size", () => {
    const decision = evaluateCrossSectionalEntryAdmission({
      rawHealth: { allowed: true, reason: null },
      smartBasketV1: false,
      learningOpenCount: 99,
      env: testnetEnv,
    });
    expect(decision).toMatchObject({ tier: "GREEN", allowed: true, learning: false, sizeMultiplier: 1 });
  });

  it("allows only an incomplete-evidence Smart Basket V1 into bounded YELLOW learning", () => {
    const decision = evaluateCrossSectionalEntryAdmission({
      rawHealth: { allowed: false, reason: "rolling evidence incomplete: 0/8 recent closes" },
      smartBasketV1: true,
      learningOpenCount: 0,
      env: testnetEnv,
    });
    expect(isCrossSectionalEvidenceIncomplete(decision.rawHealth.reason)).toBe(true);
    expect(decision).toMatchObject({
      tier: "YELLOW",
      allowed: true,
      learning: true,
      sizeMultiplier: 0.35,
      maxLearningOpen: 2,
    });
  });

  it("never turns a negative edge, non-Smart signal, mainnet, or full learning quota into a bypass", () => {
    const negative = evaluateCrossSectionalEntryAdmission({
      rawHealth: { allowed: false, reason: "rolling edge negative: last8=-0.200%, last8=-0.200%" },
      smartBasketV1: true,
      learningOpenCount: 0,
      env: testnetEnv,
    });
    const nonSmart = evaluateCrossSectionalEntryAdmission({
      rawHealth: { allowed: false, reason: "rolling evidence incomplete: 0/8 recent closes" },
      smartBasketV1: false,
      learningOpenCount: 0,
      env: testnetEnv,
    });
    const capacity = evaluateCrossSectionalEntryAdmission({
      rawHealth: { allowed: false, reason: "rolling evidence incomplete: 0/8 recent closes" },
      smartBasketV1: true,
      learningOpenCount: 2,
      env: testnetEnv,
    });
    const mainnet = evaluateCrossSectionalEntryAdmission({
      rawHealth: { allowed: false, reason: "rolling evidence incomplete: 0/8 recent closes" },
      smartBasketV1: true,
      learningOpenCount: 0,
      env: { ...testnetEnv, LIVE_BINANCE_ENV: "mainnet" },
    });
    for (const decision of [negative, nonSmart, capacity, mainnet]) {
      expect(decision.tier).toBe("RED");
      expect(decision.allowed).toBe(false);
      expect(decision.sizeMultiplier).toBe(0);
    }
  });
});

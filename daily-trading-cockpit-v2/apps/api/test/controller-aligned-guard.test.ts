/**
 * Tests for computeControllerAlignedGuardThreshold (Phase 2Z.1).
 *
 * ATR unit note:
 *   atrPercent is in percent-form (e.g. 0.69 = 0.69% of price).
 *   Source: packages/shared/src/indicators.ts
 *     atrPercent = round((atrValue / price) * 100, 4)
 *   Formula used here: atrBps = atrPercent * 100
 *   Example: atrPercent=0.69 → atrBps=69bps → threshold=max(80,69)=80bps
 */

import { describe, it, expect } from "vitest";
import {
  computeControllerAlignedGuardThreshold,
} from "../src/lib/regime-controller-aligned-shadow.js";

describe("computeControllerAlignedGuardThreshold", () => {
  // Test 1: ATR below floor — threshold clamps to 80
  it("atrPercent=0.69 → atrBps=69, threshold=80 (floor), rule=ATR_FLOOR_MAX_80_OR_1X_ATR", () => {
    const result = computeControllerAlignedGuardThreshold(0.69);
    expect(result.atrBps).toBeCloseTo(69, 5);
    expect(result.variantAdjustedGuardThresholdBps).toBe(80);
    expect(result.rule).toBe("ATR_FLOOR_MAX_80_OR_1X_ATR");
  });

  // Test 2: ATR above floor — threshold equals 1×ATR
  it("atrPercent=1.8 → atrBps=180, threshold=180, rule=ATR_FLOOR_MAX_80_OR_1X_ATR", () => {
    const result = computeControllerAlignedGuardThreshold(1.8);
    expect(result.atrBps).toBeCloseTo(180, 5);
    expect(result.variantAdjustedGuardThresholdBps).toBe(180);
    expect(result.rule).toBe("ATR_FLOOR_MAX_80_OR_1X_ATR");
  });

  // Test 3: ATR exactly at floor
  it("atrPercent=0.8 → atrBps=80, threshold=80 (equal to floor), rule=ATR_FLOOR_MAX_80_OR_1X_ATR", () => {
    const result = computeControllerAlignedGuardThreshold(0.8);
    expect(result.atrBps).toBeCloseTo(80, 5);
    expect(result.variantAdjustedGuardThresholdBps).toBe(80);
    expect(result.rule).toBe("ATR_FLOOR_MAX_80_OR_1X_ATR");
  });

  // Test 4: null → fallback
  it("null atrPercent → threshold=175, rule=FALLBACK_FIXED_175, atrBps=null", () => {
    const result = computeControllerAlignedGuardThreshold(null);
    expect(result.atrBps).toBeNull();
    expect(result.variantAdjustedGuardThresholdBps).toBe(175);
    expect(result.rule).toBe("FALLBACK_FIXED_175");
  });

  // Test 5: undefined → fallback
  it("undefined atrPercent → threshold=175, rule=FALLBACK_FIXED_175", () => {
    const result = computeControllerAlignedGuardThreshold(undefined);
    expect(result.atrBps).toBeNull();
    expect(result.variantAdjustedGuardThresholdBps).toBe(175);
    expect(result.rule).toBe("FALLBACK_FIXED_175");
  });

  // Test 6: zero → fallback (not positive)
  it("atrPercent=0 → fallback threshold=175, rule=FALLBACK_FIXED_175", () => {
    const result = computeControllerAlignedGuardThreshold(0);
    expect(result.atrBps).toBeNull();
    expect(result.variantAdjustedGuardThresholdBps).toBe(175);
    expect(result.rule).toBe("FALLBACK_FIXED_175");
  });

  // Test 7: negative → fallback
  it("atrPercent=-1 → fallback threshold=175, rule=FALLBACK_FIXED_175", () => {
    const result = computeControllerAlignedGuardThreshold(-1);
    expect(result.atrBps).toBeNull();
    expect(result.variantAdjustedGuardThresholdBps).toBe(175);
    expect(result.rule).toBe("FALLBACK_FIXED_175");
  });

  // Test 8: NaN → fallback
  it("atrPercent=NaN → fallback threshold=175, rule=FALLBACK_FIXED_175", () => {
    const result = computeControllerAlignedGuardThreshold(NaN);
    expect(result.atrBps).toBeNull();
    expect(result.variantAdjustedGuardThresholdBps).toBe(175);
    expect(result.rule).toBe("FALLBACK_FIXED_175");
  });

  // Test 9: Infinity → fallback
  it("atrPercent=Infinity → fallback threshold=175, rule=FALLBACK_FIXED_175", () => {
    const result = computeControllerAlignedGuardThreshold(Infinity);
    expect(result.atrBps).toBeNull();
    expect(result.variantAdjustedGuardThresholdBps).toBe(175);
    expect(result.rule).toBe("FALLBACK_FIXED_175");
  });

  // Test 10: high-ATR asset (BTC-like: ~0.09% ATR → 9bps → floor 80)
  it("atrPercent=0.09 (BTC-like) → atrBps=9, threshold=80 (floor)", () => {
    const result = computeControllerAlignedGuardThreshold(0.09);
    expect(result.atrBps).toBeCloseTo(9, 5);
    expect(result.variantAdjustedGuardThresholdBps).toBe(80);
    expect(result.rule).toBe("ATR_FLOOR_MAX_80_OR_1X_ATR");
  });
});

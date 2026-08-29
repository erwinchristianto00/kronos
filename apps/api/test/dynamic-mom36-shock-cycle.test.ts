import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Candle } from "@dtc/shared";
import {
  DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1,
  DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_SL2_MFE30_36H_V6,
  DYNAMIC_MOM36_CONTINUATION_SLOWFAST_PREFERRED_SL2_MFE30_36H_V5,
  DYNAMIC_MOM36_SHOCK_36H_V1,
} from "../src/lib/dynamic-mom36-shock-strategy.js";

const HOUR = 3_600_000;
const cutoff = Date.parse("2026-08-25T12:00:00.000Z");
const universe = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "LINKUSDT", "FETUSDT", "AAVEUSDT", "WLDUSDT"];
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

function candlesFor(mom36: number): Candle[] {
  const start = 100;
  const end = start * (1 + mom36);
  return Array.from({ length: 37 }, (_, index) => {
    const close = start + (end - start) * (index / 36);
    return { openTime: cutoff - (37 - index) * HOUR, open: close, high: close, low: close, close, volume: 100_000 };
  });
}

function candlesForSlowAndFast(mom36: number, fast4h: number): Candle[] {
  const start = 100;
  const end = start * (1 + mom36);
  const fastStart = end / (1 + fast4h);
  return Array.from({ length: 37 }, (_, index) => {
    const close = index <= 32
      ? start + (fastStart - start) * (index / 32)
      : fastStart + (end - fastStart) * ((index - 32) / 4);
    return { openTime: cutoff - (37 - index) * HOUR, open: close, high: close, low: close, close, volume: 100_000 };
  });
}

describe("Dynamic MOM36 production-cycle integration", () => {
  it("does not let the legacy manual-directional selector suppress a Dynamic breadth basket", () => {
    const source = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    const start = source.indexOf("isAllowed: () => {");
    const end = source.indexOf("laneWeightPct:", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const admission = source.slice(start, end);
    expect(admission).toContain("if (dynamicMom36ShockStrategyActive)");
    expect(admission).toContain("engineForGate?.canOpenNewEntriesIgnoringManualDirectional() ?? false");
    expect(admission).toContain("armed, kill, drain, transport, and canonical strategy");
  });

  it("executes V5 preferred SLOW_AND_FAST in the actual cycle and persists the selector source", async () => {
    const overrides: Record<string, string> = {
      CROSS_SECTIONAL_STRATEGY_VERSION: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_PREFERRED_SL2_MFE30_36H_V5,
      CROSS_SECTIONAL_INTERVAL: "1h",
      CROSS_SECTIONAL_MOMENTUM_BARS: "36",
      CROSS_SECTIONAL_HORIZON_BARS: "48",
      CROSS_SECTIONAL_K: "3",
      CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP: "0.058",
      CROSS_SECTIONAL_FILTERED_MAX_PER_CLUSTER: "2",
      CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST: universe.join(","),
      CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST: universe.join(","),
      // V5 must be active through its strategy version, not the retired wrapper switch.
      CROSS_SECTIONAL_FILTERED_SIDE_TREND_ALIGNMENT: "0",
      CROSS_SECTIONAL_SYMBOL_RELIABILITY_ENABLED: "0",
      CROSS_SECTIONAL_REGIME_SKEW_ENABLED: "0",
      CROSS_SECTIONAL_SMART_FORMATION_RERANK: "0",
      CROSS_SECTIONAL_STAND_DOWN_14D_PCT: "0",
      CROSS_SECTIONAL_LIQUIDITY_FLOOR_USD_PER_HOUR: "0",
      CROSS_SECTIONAL_EDGE_DISABLED: "0",
    };
    const before = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    try {
      for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
      vi.resetModules();
      const edge = await import("../src/lib/cross-sectional-edge.js");
      const dir = mkdtempSync(join(tmpdir(), "dynamic-mom36-v5-cycle-"));
      dirs.push(dir);
      const returns: Record<string, number> = {
        BTCUSDT: 0.10,
        ETHUSDT: 0.09,
        SOLUSDT: 0.08,
        DOGEUSDT: 0.07,
        LINKUSDT: 0.06,
        FETUSDT: 0.05,
        AAVEUSDT: 0.04,
        WLDUSDT: -0.03,
      };
      const now = cutoff + 5 * 60_000;
      const store = new edge.CrossSectionalStore(dir);
      const result = await edge.runCrossSectionalCycle({
        store,
        universe,
        now,
        fetchCandles: async (symbol) => candlesFor(returns[symbol]!),
      });

      expect(result.openedDynamicMom36Shock).toBe(1);
      const observation = store.all.find((candidate) => candidate.variant === "DYNAMIC_MOM36_SHOCK")!;
      expect(observation.dynamicMom36).toMatchObject({
        strategyVersion: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_PREFERRED_SL2_MFE30_36H_V5,
        slowFast: {
          active: true,
          mode: "PREFER",
          policyId: "slow-fast-mom36-fast4h-strict-sign-v1",
          implementationVersion: "legacy-d5243fd-strict-sign-verified-v1",
          interval: "1h",
          slowBars: 36,
          fastBars: 4,
        },
        rawV3SelectionInsufficientReason: null,
        selectionInsufficientReason: null,
        selectionSource: "STRICT_SLOW_FAST",
      });
      expect(observation.dynamicMom36?.rawV3SelectedLongs).toHaveLength(5);
      expect(observation.dynamicMom36?.selectedLongs).toHaveLength(5);
      expect(observation.dynamicMom36?.selectionCandidateAudit?.long.every((candidate) =>
        candidate.slowSourceTimestampMs !== null &&
        candidate.fastSourceTimestampMs !== null &&
        candidate.slowSourceTimestampMs <= cutoff &&
        candidate.fastSourceTimestampMs <= cutoff,
      )).toBe(true);
      expect(store.latestDynamicMom36Formation).toEqual(observation.dynamicMom36);
    } finally {
      for (const [key, value] of before) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("executes V6's fully strict directional-feasibility allocation in the actual cycle", async () => {
    const overrides: Record<string, string> = {
      CROSS_SECTIONAL_STRATEGY_VERSION: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_SL2_MFE30_36H_V6,
      CROSS_SECTIONAL_INTERVAL: "1h",
      CROSS_SECTIONAL_MOMENTUM_BARS: "36",
      CROSS_SECTIONAL_HORIZON_BARS: "48",
      CROSS_SECTIONAL_K: "3",
      CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP: "0.058",
      CROSS_SECTIONAL_FILTERED_MAX_PER_CLUSTER: "0",
      CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST: universe.join(","),
      CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST: universe.join(","),
      CROSS_SECTIONAL_FILTERED_SIDE_TREND_ALIGNMENT: "0",
      CROSS_SECTIONAL_SYMBOL_RELIABILITY_ENABLED: "0",
      CROSS_SECTIONAL_REGIME_SKEW_ENABLED: "0",
      CROSS_SECTIONAL_SMART_FORMATION_RERANK: "0",
      CROSS_SECTIONAL_STAND_DOWN_14D_PCT: "0",
      CROSS_SECTIONAL_LIQUIDITY_FLOOR_USD_PER_HOUR: "0",
      CROSS_SECTIONAL_EDGE_DISABLED: "0",
    };
    const before = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    try {
      for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
      vi.resetModules();
      const edge = await import("../src/lib/cross-sectional-edge.js");
      const dir = mkdtempSync(join(tmpdir(), "dynamic-mom36-v6-cycle-"));
      dirs.push(dir);
      const paths: Record<string, { mom36: number; fast4h: number }> = {
        BTCUSDT: { mom36: 0.10, fast4h: 0.020 }, ETHUSDT: { mom36: 0.09, fast4h: 0.019 },
        SOLUSDT: { mom36: 0.08, fast4h: 0.018 }, DOGEUSDT: { mom36: 0.07, fast4h: 0.017 },
        LINKUSDT: { mom36: 0.06, fast4h: 0.016 }, FETUSDT: { mom36: 0.05, fast4h: 0.015 },
        AAVEUSDT: { mom36: -0.04, fast4h: 0.010 }, WLDUSDT: { mom36: -0.03, fast4h: 0.009 },
      };
      const store = new edge.CrossSectionalStore(dir);
      const result = await edge.runCrossSectionalCycle({
        store,
        universe,
        now: cutoff + 5 * 60_000,
        fetchCandles: async (symbol) => candlesForSlowAndFast(paths[symbol]!.mom36, paths[symbol]!.fast4h),
      });

      expect(result.openedDynamicMom36Shock).toBe(1);
      const observation = store.all.find((candidate) => candidate.variant === "DYNAMIC_MOM36_SHOCK")!;
      expect(observation).toMatchObject({ longK: 6, shortK: 0, longCapitalWeight: 1, shortCapitalWeight: 0 });
      expect(observation.dynamicMom36).toMatchObject({
        strategyVersion: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_SL2_MFE30_36H_V6,
        slowFast: { active: true, mode: "STRICT_DIRECTIONAL_FEASIBILITY" },
        requestedAllocation: { label: "4L2S" },
        finalAllocation: { label: "6L0S" },
        selectionSource: "STRICT_SLOW_FAST_DIRECTIONAL_FEASIBILITY",
        directionalFeasibility: {
          directionalPrior: "LONG",
          outcome: "FALLBACK_APPLIED",
          attempts: [
            { allocation: { label: "5L1S" }, complete: false },
            { allocation: { label: "6L0S" }, complete: true },
          ],
        },
      });
      expect(observation.longLeg).toHaveLength(6);
      expect(observation.shortLeg).toHaveLength(0);
      expect(store.latestDynamicMom36Formation).toEqual(observation.dynamicMom36);
    } finally {
      for (const [key, value] of before) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("admits the exact V6.1 0L6S final plan instead of probing a synthetic 3L3S basket", async () => {
    const bearishUniverse = [
      "N01USDT", "N02USDT", "N03USDT", "N04USDT", "N05USDT", "N06USDT", "N07USDT", "N08USDT",
    ];
    const overrides: Record<string, string> = {
      CROSS_SECTIONAL_STRATEGY_VERSION: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1,
      CROSS_SECTIONAL_INTERVAL: "1h",
      CROSS_SECTIONAL_MOMENTUM_BARS: "36",
      CROSS_SECTIONAL_HORIZON_BARS: "48",
      CROSS_SECTIONAL_K: "3",
      CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP: "0.058",
      CROSS_SECTIONAL_FILTERED_MAX_PER_CLUSTER: "0",
      CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST: bearishUniverse.join(","),
      CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST: bearishUniverse.join(","),
      CROSS_SECTIONAL_FILTERED_SIDE_TREND_ALIGNMENT: "1",
      CROSS_SECTIONAL_SYMBOL_RELIABILITY_ENABLED: "0",
      CROSS_SECTIONAL_REGIME_SKEW_ENABLED: "0",
      CROSS_SECTIONAL_SMART_FORMATION_RERANK: "0",
      CROSS_SECTIONAL_STAND_DOWN_14D_PCT: "0",
      CROSS_SECTIONAL_LIQUIDITY_FLOOR_USD_PER_HOUR: "0",
      CROSS_SECTIONAL_EDGE_DISABLED: "0",
    };
    const before = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    try {
      for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
      vi.resetModules();
      const edge = await import("../src/lib/cross-sectional-edge.js");
      const dir = mkdtempSync(join(tmpdir(), "dynamic-mom36-v6-one-sided-bug-"));
      dirs.push(dir);
      const store = new edge.CrossSectionalStore(dir);
      const result = await edge.runCrossSectionalCycle({
        store,
        universe: bearishUniverse,
        now: cutoff + 5 * 60_000,
        fetchCandles: async () => candlesForSlowAndFast(-0.05, -0.01),
      });

      expect(result.openedDynamicMom36Shock).toBe(1);
      const observation = store.all.find((candidate) => candidate.variant === "DYNAMIC_MOM36_SHOCK")!;
      expect(observation).toMatchObject({ longK: 0, shortK: 6, longCapitalWeight: 0, shortCapitalWeight: 1 });
      expect(store.latestDynamicMom36Formation).toMatchObject({
        strategyVersion: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_FEASIBILITY_FINAL_ADMISSION_SL2_MFE30_36H_V6_1,
        finalAllocation: { label: "0L6S", longCount: 0, shortCount: 6 },
        selectedLongs: [],
        selectedShorts: bearishUniverse.slice(0, 6),
        selectionInsufficientReason: null,
        admission: {
          scoreGap: null,
          scoreGapApplicable: false,
          scoreGapReason: "ONE_SIDED_FINAL_ALLOCATION",
          passed: true,
          reason: "ADMISSION_PASSED",
          finalLongCount: 0,
          finalShortCount: 6,
        },
        noEntryReason: null,
      });
      expect(observation.dynamicMom36?.formationId).toBeTruthy();
      expect(observation.dynamicMom36?.admission.formationId).toBe(observation.dynamicMom36?.formationId);
      expect(observation.dynamicMom36?.admission.selectedCandidateHash).toBe(observation.dynamicMom36?.selectedCandidateHash);
    } finally {
      for (const [key, value] of before) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("skips an isolated daily-range lease before V5 basket formation instead of reaching executor netting", async () => {
    const overrides: Record<string, string> = {
      CROSS_SECTIONAL_STRATEGY_VERSION: DYNAMIC_MOM36_CONTINUATION_SLOWFAST_PREFERRED_SL2_MFE30_36H_V5,
      CROSS_SECTIONAL_INTERVAL: "1h",
      CROSS_SECTIONAL_MOMENTUM_BARS: "36",
      CROSS_SECTIONAL_HORIZON_BARS: "48",
      CROSS_SECTIONAL_K: "3",
      CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP: "0.058",
      CROSS_SECTIONAL_FILTERED_MAX_PER_CLUSTER: "2",
      CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST: universe.join(","),
      CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST: universe.join(","),
      CROSS_SECTIONAL_FILTERED_SIDE_TREND_ALIGNMENT: "0",
      CROSS_SECTIONAL_SYMBOL_RELIABILITY_ENABLED: "0",
      CROSS_SECTIONAL_REGIME_SKEW_ENABLED: "0",
      CROSS_SECTIONAL_SMART_FORMATION_RERANK: "0",
      CROSS_SECTIONAL_STAND_DOWN_14D_PCT: "0",
      CROSS_SECTIONAL_LIQUIDITY_FLOOR_USD_PER_HOUR: "0",
      CROSS_SECTIONAL_EDGE_DISABLED: "0",
    };
    const before = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    try {
      for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
      vi.resetModules();
      const edge = await import("../src/lib/cross-sectional-edge.js");
      const dir = mkdtempSync(join(tmpdir(), "dynamic-mom36-v5-daily-lease-"));
      dirs.push(dir);
      const returns: Record<string, number> = {
        BTCUSDT: 0.10,
        ETHUSDT: 0.09,
        SOLUSDT: 0.08,
        DOGEUSDT: 0.07,
        LINKUSDT: 0.06,
        FETUSDT: 0.05,
        AAVEUSDT: 0.04,
        WLDUSDT: -0.03,
      };
      const store = new edge.CrossSectionalStore(dir);
      const result = await edge.runCrossSectionalCycle({
        store,
        universe,
        now: cutoff + 5 * 60_000,
        fetchCandles: async (symbol) => candlesFor(returns[symbol]!),
        filteredEntryBlocks: async () => ({
          longBlocklist: ["LINKUSDT"],
          shortBlocklist: ["LINKUSDT"],
          longBlockReasons: { LINKUSDT: "SYMBOL_OWNED_BY_DAILY_RANGE" },
          shortBlockReasons: { LINKUSDT: "SYMBOL_OWNED_BY_DAILY_RANGE" },
        }),
      });

      expect(result.openedDynamicMom36Shock).toBe(1);
      const observation = store.all.find((candidate) => candidate.variant === "DYNAMIC_MOM36_SHOCK")!;
      expect(observation.longLeg.map((leg) => leg.symbol)).not.toContain("LINKUSDT");
      expect(observation.longLeg.map((leg) => leg.symbol)).toContain("FETUSDT");
      expect(observation.dynamicMom36?.activeUniverse.find((row) => row.symbol === "LINKUSDT")).toMatchObject({
        longEligible: false,
        longExecutionBlockReason: "SYMBOL_OWNED_BY_DAILY_RANGE",
      });
      expect(observation.dynamicMom36?.selectionCandidateAudit?.long.find((candidate) => candidate.symbol === "LINKUSDT")).toMatchObject({
        executionEligible: false,
        skipReason: "SYMBOL_OWNED_BY_DAILY_RANGE",
      });
    } finally {
      for (const [key, value] of before) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("keeps blocked WLD in breadth/admission information, then skips it only at final short selection", async () => {
    const overrides: Record<string, string> = {
      CROSS_SECTIONAL_STRATEGY_VERSION: DYNAMIC_MOM36_SHOCK_36H_V1,
      CROSS_SECTIONAL_INTERVAL: "1h",
      CROSS_SECTIONAL_MOMENTUM_BARS: "36",
      CROSS_SECTIONAL_HORIZON_BARS: "48",
      CROSS_SECTIONAL_K: "3",
      CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP: "0.058",
      CROSS_SECTIONAL_FILTERED_MAX_PER_CLUSTER: "2",
      CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST: universe.join(","),
      CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST: universe.join(","),
      CROSS_SECTIONAL_FILTERED_SHORT_BLOCKLIST: "WLDUSDT",
      CROSS_SECTIONAL_SYMBOL_RELIABILITY_ENABLED: "0",
      CROSS_SECTIONAL_REGIME_SKEW_ENABLED: "0",
      CROSS_SECTIONAL_SMART_FORMATION_RERANK: "0",
      CROSS_SECTIONAL_STAND_DOWN_14D_PCT: "0",
      CROSS_SECTIONAL_LIQUIDITY_FLOOR_USD_PER_HOUR: "0",
      CROSS_SECTIONAL_EDGE_DISABLED: "0",
    };
    const before = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    try {
      for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
      vi.resetModules();
      const edge = await import("../src/lib/cross-sectional-edge.js");
      const dir = mkdtempSync(join(tmpdir(), "dynamic-mom36-cycle-"));
      dirs.push(dir);
      const store = new edge.CrossSectionalStore(dir);
      const returns: Record<string, number> = {
        BTCUSDT: 0.10,
        ETHUSDT: 0.09,
        SOLUSDT: 0.08,
        DOGEUSDT: 0.07,
        LINKUSDT: 0.06,
        FETUSDT: 0.05,
        AAVEUSDT: 0.04,
        WLDUSDT: -0.03,
      };
      const now = cutoff + 5 * 60_000;
      const result = await edge.runCrossSectionalCycle({
        store,
        universe,
        now,
        fetchCandles: async (symbol) => candlesFor(returns[symbol]!),
      });

      expect(result.openedDynamicMom36Shock).toBe(1);
      const observation = store.all.find((row) => row.variant === "DYNAMIC_MOM36_SHOCK")!;
      expect(observation).toMatchObject({ longK: 5, shortK: 1, horizonMs: 36 * HOUR });
      expect(observation.dynamicMom36).toMatchObject({
        positiveCount: 7,
        negativeCount: 1,
        baseAllocation: { label: "5L1S" },
        finalAllocation: { label: "5L1S" },
      });
      const wld = observation.dynamicMom36?.activeUniverse.find((row) => row.symbol === "WLDUSDT");
      expect(wld?.mom36).toBeCloseTo(-0.03, 8);
      expect(wld?.shortBlocked).toBe(true);
      expect(observation.dynamicMom36?.blockedShortsSkipped).toContain("WLDUSDT");
      expect(observation.shortLeg.map((leg) => leg.symbol)).not.toContain("WLDUSDT");
      expect([...observation.longLeg, ...observation.shortLeg]).toHaveLength(6);
      expect(store.lastCycleAt).toBe(new Date(now).toISOString());

      // A Dynamic formation must survive a process restart; the pre-fix early return skipped save().
      const restored = new edge.CrossSectionalStore(dir);
      expect(restored.lastCycleAt).toBe(new Date(now).toISOString());
      expect(restored.all.some((row) => row.observationId === observation.observationId)).toBe(true);
    } finally {
      for (const [key, value] of before) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("ignores a stale legacy symbol outside the active execution pool", async () => {
    const rawUniverse = [...universe, "RNDRUSDT"];
    const overrides: Record<string, string> = {
      CROSS_SECTIONAL_STRATEGY_VERSION: DYNAMIC_MOM36_SHOCK_36H_V1,
      CROSS_SECTIONAL_INTERVAL: "1h",
      CROSS_SECTIONAL_MOMENTUM_BARS: "36",
      CROSS_SECTIONAL_HORIZON_BARS: "48",
      CROSS_SECTIONAL_K: "3",
      CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP: "0.058",
      CROSS_SECTIONAL_FILTERED_MAX_PER_CLUSTER: "2",
      CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST: universe.join(","),
      CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST: universe.join(","),
      CROSS_SECTIONAL_SYMBOL_RELIABILITY_ENABLED: "0",
      CROSS_SECTIONAL_REGIME_SKEW_ENABLED: "0",
      CROSS_SECTIONAL_SMART_FORMATION_RERANK: "0",
      CROSS_SECTIONAL_STAND_DOWN_14D_PCT: "0",
      CROSS_SECTIONAL_LIQUIDITY_FLOOR_USD_PER_HOUR: "0",
      CROSS_SECTIONAL_EDGE_DISABLED: "0",
    };
    const before = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    try {
      for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
      vi.resetModules();
      const edge = await import("../src/lib/cross-sectional-edge.js");
      const dir = mkdtempSync(join(tmpdir(), "dynamic-mom36-excluded-stale-"));
      dirs.push(dir);
      const returns: Record<string, number> = {
        BTCUSDT: 0.10,
        ETHUSDT: 0.09,
        SOLUSDT: 0.08,
        DOGEUSDT: 0.07,
        LINKUSDT: 0.06,
        FETUSDT: 0.05,
        AAVEUSDT: 0.04,
        WLDUSDT: -0.03,
      };
      const store = new edge.CrossSectionalStore(dir);
      const result = await edge.runCrossSectionalCycle({
        store,
        universe: rawUniverse,
        now: cutoff + 5 * 60_000,
        fetchCandles: async (symbol) => symbol === "RNDRUSDT" ? [] : candlesFor(returns[symbol]!),
      });

      expect(result.openedDynamicMom36Shock).toBe(1);
      const observation = store.all.find((row) => row.variant === "DYNAMIC_MOM36_SHOCK")!;
      expect(observation.dynamicMom36?.activeUniverse.map((row) => row.symbol)).not.toContain("RNDRUSDT");
    } finally {
      for (const [key, value] of before) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("fails closed when a supplied auto-pool cannot provide six synchronous Dynamic symbols", async () => {
    const overrides: Record<string, string> = {
      CROSS_SECTIONAL_STRATEGY_VERSION: DYNAMIC_MOM36_SHOCK_36H_V1,
      CROSS_SECTIONAL_INTERVAL: "1h",
      CROSS_SECTIONAL_MOMENTUM_BARS: "36",
      CROSS_SECTIONAL_HORIZON_BARS: "48",
      CROSS_SECTIONAL_K: "3",
      CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP: "0.058",
      CROSS_SECTIONAL_FILTERED_MAX_PER_CLUSTER: "2",
      CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST: universe.join(","),
      CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST: universe.join(","),
      CROSS_SECTIONAL_SYMBOL_RELIABILITY_ENABLED: "0",
      CROSS_SECTIONAL_REGIME_SKEW_ENABLED: "0",
      CROSS_SECTIONAL_SMART_FORMATION_RERANK: "0",
      CROSS_SECTIONAL_STAND_DOWN_14D_PCT: "0",
      CROSS_SECTIONAL_LIQUIDITY_FLOOR_USD_PER_HOUR: "0",
      CROSS_SECTIONAL_EDGE_DISABLED: "0",
    };
    const before = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    try {
      for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
      vi.resetModules();
      const edge = await import("../src/lib/cross-sectional-edge.js");
      const dir = mkdtempSync(join(tmpdir(), "dynamic-mom36-auto-pool-"));
      dirs.push(dir);
      const store = new edge.CrossSectionalStore(dir);
      // A durable real pool enforces an eight-name floor. This deliberately malformed snapshot
      // proves that a bad persisted/input pool cannot silently reopen selection to the static list.
      const activeSymbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "LINKUSDT"];
      const returns: Record<string, number> = {
        BTCUSDT: 0.20,
        ETHUSDT: 0.18,
        SOLUSDT: 0.16,
        DOGEUSDT: 0.04,
        LINKUSDT: 0.02,
        FETUSDT: -0.03,
        AAVEUSDT: 0.04,
        WLDUSDT: -0.03,
      };
      const result = await edge.runCrossSectionalCycle({
        store,
        universe,
        now: cutoff + 5 * 60_000,
        fetchCandles: async (symbol) => candlesFor(returns[symbol]!),
        filteredExecutionPool: async () => ({
          version: 1,
          enabled: true,
          state: "ACTIVE" as const,
          source: "BINANCE_USDM_MAINNET_PUBLIC" as const,
          candidateUniverse: universe,
          activeSymbols,
          updatedAt: "2026-08-25T12:00:00.000Z",
          lastAttemptAt: "2026-08-25T12:00:00.000Z",
          lastSuccessAt: "2026-08-25T12:00:00.000Z",
          lastError: null,
          refreshEveryMs: 900_000,
          thresholds: {
            minLiquidityUsdPerHour: 200_000,
            maxLotFractionOfLeg: 0.5,
            hysteresisFraction: 0.1,
            minPoolSize: 8,
            effectiveLegUsd: 25,
            oneLotCeilingUsd: 12.5,
          },
          reconciliation: null,
        }),
      });

      expect(result.autoPoolState).toBe("ACTIVE");
      expect(result.openedDynamicMom36Shock).toBeUndefined();
      expect(store.all.some((row) => row.variant === "DYNAMIC_MOM36_SHOCK")).toBe(false);
    } finally {
      for (const [key, value] of before) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("fails closed rather than silently redefining MOM36 when the runtime candle interval drifts", async () => {
    const overrides: Record<string, string> = {
      CROSS_SECTIONAL_STRATEGY_VERSION: DYNAMIC_MOM36_SHOCK_36H_V1,
      CROSS_SECTIONAL_INTERVAL: "15m",
      CROSS_SECTIONAL_MOMENTUM_BARS: "36",
      CROSS_SECTIONAL_K: "3",
      CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST: universe.join(","),
      CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST: universe.join(","),
      CROSS_SECTIONAL_SYMBOL_RELIABILITY_ENABLED: "0",
      CROSS_SECTIONAL_REGIME_SKEW_ENABLED: "0",
      CROSS_SECTIONAL_SMART_FORMATION_RERANK: "0",
      CROSS_SECTIONAL_STAND_DOWN_14D_PCT: "0",
      CROSS_SECTIONAL_LIQUIDITY_FLOOR_USD_PER_HOUR: "0",
      CROSS_SECTIONAL_EDGE_DISABLED: "0",
    };
    const before = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    try {
      for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
      vi.resetModules();
      const edge = await import("../src/lib/cross-sectional-edge.js");
      const dir = mkdtempSync(join(tmpdir(), "dynamic-mom36-invalid-interval-"));
      dirs.push(dir);
      const result = await edge.runCrossSectionalCycle({
        store: new edge.CrossSectionalStore(dir),
        universe,
        now: cutoff + 5 * 60_000,
        fetchCandles: async () => candlesFor(0.03),
      });
      expect(result.opened).toBe(0);
      expect(result.openedDynamicMom36Shock).toBeUndefined();
    } finally {
      for (const [key, value] of before) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

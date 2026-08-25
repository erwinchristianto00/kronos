import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Candle } from "@dtc/shared";
import { DYNAMIC_MOM36_SHOCK_36H_V1 } from "../src/lib/dynamic-mom36-shock-strategy.js";

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

describe("Dynamic MOM36 production-cycle integration", () => {
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
      const result = await edge.runCrossSectionalCycle({
        store,
        universe,
        now: cutoff + 5 * 60_000,
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

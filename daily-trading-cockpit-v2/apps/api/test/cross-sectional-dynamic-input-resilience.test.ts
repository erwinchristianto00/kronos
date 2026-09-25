import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Candle } from "@dtc/shared";

const HOUR_MS = 60 * 60_000;
const decisionAtMs = Date.UTC(2099, 0, 2, 12);

function hourlyMomentumCandles(slope: number): Candle[] {
  return Array.from({ length: 40 }, (_, index) => {
    const close = 100 + slope * index;
    const openTime = decisionAtMs - (40 - index) * HOUR_MS;
    return { openTime, open: close, high: close, low: close, close, volume: 1 };
  });
}

it("[DYNAMIC] excludes one stale executable input and fully reselects from the remaining synchronous rows", async () => {
  const env = {
    CROSS_SECTIONAL_MOMENTUM_BARS: "36",
    CROSS_SECTIONAL_INTERVAL: "1h",
    CROSS_SECTIONAL_STRATEGY_VERSION: "dynamic-mom36-shock-36h-v1",
    CROSS_SECTIONAL_FILTERED_DISABLED: "0",
    CROSS_SECTIONAL_ADAPTIVE_DISABLED: "1",
    CROSS_SECTIONAL_SYMBOL_RELIABILITY_ENABLED: "0",
  } as const;
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  const stateDir = mkdtempSync(join(tmpdir(), "xsec-dynamic-input-"));
  try {
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    await vi.resetModules();
    const { CrossSectionalStore, runCrossSectionalCycle } = await import("../src/lib/cross-sectional-edge.js");
    const universe = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "SUIUSDT", "OPUSDT", "DOGEUSDT", "WLDUSDT"];
    const slopeBySymbol: Record<string, number> = {
      BTCUSDT: 0.18,
      SOLUSDT: 0.16,
      DOGEUSDT: 0.14,
      ETHUSDT: -0.14,
      SUIUSDT: -0.16,
      OPUSDT: -0.18,
      WLDUSDT: 0.12,
    };
    const valid = Object.fromEntries(universe.map((symbol) => [symbol, hourlyMomentumCandles(slopeBySymbol[symbol]!)]));
    // WLD's last fully closed candle is one hour behind the common information cut.
    const stale = valid.WLDUSDT!.slice(0, -1);
    const store = new CrossSectionalStore(stateDir);

    const result = await runCrossSectionalCycle({
      store,
      universe,
      now: decisionAtMs,
      fetchCandles: async (symbol: string) => symbol === "WLDUSDT" ? stale : valid[symbol]!,
      filteredExecutionPool: async () => ({ state: "ACTIVE", activeSymbols: universe }) as never,
    });

    expect(result.opened).toBe(1);
    expect(result.openedDynamicMom36Shock).toBe(1);
    const basket = store.all.find((row) => row.signal === "DYNAMIC_MOM36_SHOCK_36H");
    expect(basket).toBeDefined();
    expect([...basket!.longLeg, ...basket!.shortLeg].map((leg) => leg.symbol)).not.toContain("WLDUSDT");
    expect(basket!.longLeg).toHaveLength(3);
    expect(basket!.shortLeg).toHaveLength(3);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await vi.resetModules();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

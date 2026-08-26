import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CrossSectionalAutoPool } from "../src/lib/cross-sectional-auto-pool.js";
import { CROSS_SECTIONAL_UNIVERSE } from "../src/lib/cross-sectional-edge.js";
import {
  DAILY_RANGE_AUTO_POOL_MIN_CANDIDATES,
  DAILY_RANGE_DEFAULT_CANDIDATE_UNIVERSE,
  resolveDailyRangeAutoPoolInput,
} from "../src/lib/daily-range-auto-pool.js";

describe("daily range isolated auto-pool", () => {
  it("uses a default catalog that is fully disjoint from all cross-sectional candidates", () => {
    const input = resolveDailyRangeAutoPoolInput(CROSS_SECTIONAL_UNIVERSE, {});
    const crossSet = new Set(CROSS_SECTIONAL_UNIVERSE);

    expect(input.candidateUniverse).toHaveLength(DAILY_RANGE_DEFAULT_CANDIDATE_UNIVERSE.length);
    expect(input.candidateUniverse.length).toBeGreaterThanOrEqual(DAILY_RANGE_AUTO_POOL_MIN_CANDIDATES);
    expect(input.candidateUniverse.some((symbol) => crossSet.has(symbol))).toBe(false);
    expect(input.fallbackSymbols).toEqual(input.candidateUniverse);
  });

  it("fails closed if an operator override tries to share a one-way-netted basket symbol", () => {
    expect(() => resolveDailyRangeAutoPoolInput(CROSS_SECTIONAL_UNIVERSE, {
      DAILY_RANGE_AUTO_POOL_CANDIDATES: "TRXUSDT,OPUSDT,DOTUSDT,XLMUSDT,ATOMUSDT,FILUSDT,ONDOUSDT,ENAUSDT,RUNEUSDT",
    })).toThrow("overlaps cross-sectional universe: OPUSDT");
  });

  it("owns its automation switch and durable state file independently from the basket pool", async () => {
    const candidates = DAILY_RANGE_DEFAULT_CANDIDATE_UNIVERSE.slice(0, DAILY_RANGE_AUTO_POOL_MIN_CANDIDATES);
    const dataDir = mkdtempSync(join(tmpdir(), "daily-range-auto-pool-"));
    const pool = new CrossSectionalAutoPool({
      dataDir,
      fileName: "daily-range-auto-pool.json",
      enabledEnvKey: "DAILY_RANGE_AUTO_POOL_ENABLED",
      refreshEveryMsEnvKey: "DAILY_RANGE_AUTO_POOL_REFRESH_MS",
      env: {
        DAILY_RANGE_AUTO_POOL_ENABLED: "1",
        DAILY_RANGE_AUTO_POOL_REFRESH_MS: "60000",
        // Prove the daily lane does not accidentally read the basket switch.
        CROSS_SECTIONAL_AUTO_POOL_ENABLED: "0",
      },
      nowMs: () => 1_000_000,
      fetchImpl: async (url) => ({
        ok: true,
        json: async () => url.includes("exchangeInfo")
          ? {
              symbols: candidates.map((symbol) => ({
                symbol,
                filters: [
                  { filterType: "LOT_SIZE", stepSize: "1", minQty: "1" },
                  { filterType: "MIN_NOTIONAL", notional: "5" },
                ],
              })),
            }
          : candidates.map((symbol) => ({ symbol, lastPrice: "5", quoteVolume: "12000000" })),
      }),
    });

    const snapshot = await pool.refreshIfDue({
      candidateUniverse: candidates,
      fallbackSymbols: candidates,
      baseLegUsd: 25,
      sizeMultiplier: 1,
    });

    expect(snapshot.enabled).toBe(true);
    expect(snapshot.state).toBe("ACTIVE");
    expect(snapshot.activeSymbols).toEqual([...candidates].sort());
  });
});

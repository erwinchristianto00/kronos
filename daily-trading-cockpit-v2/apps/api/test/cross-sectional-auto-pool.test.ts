import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CrossSectionalAutoPool } from "../src/lib/cross-sectional-auto-pool.js";

const universe = [
  "AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT", "FFFUSDT", "GGGUSDT", "HHHUSDT", "ARKMUSDT",
];
const fallback = universe.filter((symbol) => symbol !== "ARKMUSDT");

function response(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

function marketData(volumes: Record<string, number>) {
  return {
    symbols: universe.map((symbol) => ({
      symbol,
      filters: [
        { filterType: "LOT_SIZE", stepSize: "1", minQty: "1" },
        { filterType: "MIN_NOTIONAL", notional: "5" },
      ],
    })),
    tickers: universe.map((symbol) => ({ symbol, lastPrice: "5", quoteVolume: String(volumes[symbol] ?? 0) })),
  };
}

function input() {
  return { candidateUniverse: universe, fallbackSymbols: fallback, baseLegUsd: 25, sizeMultiplier: 1 };
}

describe("CrossSectionalAutoPool", () => {
  it("[AUTO-POOL-ADD] admits ARKM only after it clears the 10% C1 entry band, then persists the active pool", async () => {
    const data = marketData(Object.fromEntries(universe.map((symbol) => [symbol, symbol === "ARKMUSDT" ? 5_400_000 : 12_000_000])));
    let calls = 0;
    const dataDir = mkdtempSync(join(tmpdir(), "xsec-auto-pool-"));
    const pool = new CrossSectionalAutoPool({
      dataDir,
      env: { CROSS_SECTIONAL_AUTO_POOL_ENABLED: "1", CROSS_SECTIONAL_AUTO_POOL_REFRESH_MS: "60000" },
      fetchImpl: async (url) => {
        calls += 1;
        return response(url.includes("exchangeInfo") ? { symbols: data.symbols } : data.tickers);
      },
      nowMs: () => 1_000_000,
    });

    const refreshed = await pool.refreshIfDue(input());
    expect(refreshed.state).toBe("ACTIVE");
    expect(refreshed.activeSymbols).toContain("ARKMUSDT");
    expect(refreshed.reconciliation?.adds).toEqual(["ARKMUSDT"]);
    expect(calls).toBe(2);

    const reloaded = new CrossSectionalAutoPool({
      dataDir,
      env: { CROSS_SECTIONAL_AUTO_POOL_ENABLED: "1" },
    });
    expect(reloaded.getSnapshot(input()).activeSymbols).toContain("ARKMUSDT");
  });

  it("[AUTO-POOL-HYST] holds an existing member inside the C1 band and never writes an outage as a removal", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "xsec-auto-pool-"));
    let now = 1_000_000;
    const healthy = marketData(Object.fromEntries(universe.map((symbol) => [symbol, symbol === "ARKMUSDT" ? 4_800_000 : 12_000_000])));
    const pool = new CrossSectionalAutoPool({
      dataDir,
      env: { CROSS_SECTIONAL_AUTO_POOL_ENABLED: "1", CROSS_SECTIONAL_AUTO_POOL_REFRESH_MS: "60000" },
      fetchImpl: async (url) => response(url.includes("exchangeInfo") ? { symbols: healthy.symbols } : healthy.tickers),
      nowMs: () => now,
    });
    const first = await pool.refreshIfDue({ ...input(), fallbackSymbols: universe });
    expect(first.activeSymbols).toContain("ARKMUSDT");
    expect(first.reconciliation?.changed).toBe(false);

    now += 60_000;
    const outage = new CrossSectionalAutoPool({
      dataDir,
      env: { CROSS_SECTIONAL_AUTO_POOL_ENABLED: "1", CROSS_SECTIONAL_AUTO_POOL_REFRESH_MS: "60000" },
      fetchImpl: async () => response({}, false),
      nowMs: () => now,
    });
    const failed = await outage.refreshIfDue(input());
    expect(failed.activeSymbols).toContain("ARKMUSDT");
    expect(failed.lastError).toContain("public USD-M metadata failed");
  });

  it("[AUTO-POOL-STARTUP-RACE] joins an in-flight refresh instead of serving a stale fallback to a second reader", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "xsec-auto-pool-"));
    const data = marketData(Object.fromEntries(universe.map((symbol) => [symbol, 12_000_000])));
    let releaseTicker!: (value: ReturnType<typeof response>) => void;
    const tickerGate = new Promise<ReturnType<typeof response>>((resolve) => { releaseTicker = resolve; });
    let calls = 0;
    const pool = new CrossSectionalAutoPool({
      dataDir,
      env: { CROSS_SECTIONAL_AUTO_POOL_ENABLED: "1", CROSS_SECTIONAL_AUTO_POOL_REFRESH_MS: "60000" },
      fetchImpl: async (url) => {
        calls += 1;
        return url.includes("exchangeInfo") ? response({ symbols: data.symbols }) : tickerGate;
      },
      nowMs: () => 1_000_000,
    });

    const first = pool.refreshIfDue(input());
    const second = pool.refreshIfDue(input());
    releaseTicker(response(data.tickers));
    const [a, b] = await Promise.all([first, second]);

    expect(calls).toBe(2);
    expect(a.state).toBe("ACTIVE");
    expect(b.state).toBe("ACTIVE");
    expect(a.activeSymbols).toContain("ARKMUSDT");
    expect(b.activeSymbols).toContain("ARKMUSDT");
    expect(b.updatedAt).toBe(a.updatedAt);
  });

  it("[AUTO-POOL-DISABLED] keeps the configured fallback untouched when the feature is off", async () => {
    const pool = new CrossSectionalAutoPool({
      dataDir: mkdtempSync(join(tmpdir(), "xsec-auto-pool-")),
      env: {},
      fetchImpl: async () => { throw new Error("must not fetch"); },
    });
    const snapshot = await pool.refreshIfDue(input());
    expect(snapshot.state).toBe("DISABLED");
    expect(snapshot.activeSymbols).toEqual(fallback.slice().sort());
  });
});

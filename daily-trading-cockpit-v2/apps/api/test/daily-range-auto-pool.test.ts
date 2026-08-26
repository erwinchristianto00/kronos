import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DailyRangeAutoPool,
  resolveDailyRangeAutoPoolInput,
} from "../src/lib/daily-range-auto-pool.js";

const NOW = 1_760_000_000_000;

type MarketOptions = {
  volumes?: Record<string, number>;
  spreads?: Record<string, number>;
  listingDays?: Record<string, number>;
  minQty?: Record<string, number>;
  fiveMinuteGap?: ReadonlySet<string>;
  fail?: () => boolean;
};

function response(payload: unknown, ok = true) {
  return { ok, json: async () => payload };
}

function candleRows(intervalMs: number, limit: number, now: number, gapped: boolean): unknown[][] {
  const currentOpen = Math.floor(now / intervalMs) * intervalMs;
  return Array.from({ length: limit }, (_, index) => {
    const extraGap = gapped && index >= Math.floor(limit / 2) ? intervalMs : 0;
    const openTime = currentOpen - (limit - 1 - index) * intervalMs + extraGap;
    return [openTime, "100", "101", "99", "100.5", "1000", openTime + intervalMs - 1];
  });
}

function makeMarketFetch(symbols: readonly string[], options: MarketOptions = {}) {
  return async (url: string) => {
    if (options.fail?.()) return response({}, false);
    if (url.includes("exchangeInfo")) {
      return response({
        symbols: symbols.map((symbol) => ({
          symbol,
          status: "TRADING",
          contractType: "PERPETUAL",
          quoteAsset: "USDT",
          onboardDate: NOW - (options.listingDays?.[symbol] ?? 90) * 86_400_000,
          filters: [
            { filterType: "LOT_SIZE", stepSize: "0.01", minQty: String(options.minQty?.[symbol] ?? 0.01) },
            { filterType: "MIN_NOTIONAL", notional: "5" },
          ],
        })),
      });
    }
    if (url.includes("ticker/24hr")) {
      return response(symbols.map((symbol) => ({
        symbol,
        lastPrice: "100",
        quoteVolume: String(options.volumes?.[symbol] ?? 24_000_000),
      })));
    }
    if (url.includes("ticker/bookTicker")) {
      return response(symbols.map((symbol) => {
        const spread = options.spreads?.[symbol] ?? 2;
        const half = 100 * spread / 20_000;
        return { symbol, bidPrice: String(100 - half), askPrice: String(100 + half) };
      }));
    }
    if (url.includes("/klines?")) {
      const parsed = new URL(url);
      const symbol = parsed.searchParams.get("symbol") ?? "";
      const interval = parsed.searchParams.get("interval");
      const limit = Number(parsed.searchParams.get("limit") ?? "0");
      const intervalMs = interval === "5m" ? 5 * 60_000 : 4 * 60 * 60_000;
      return response(candleRows(intervalMs, limit, NOW, interval === "5m" && options.fiveMinuteGap?.has(symbol) === true));
    }
    throw new Error("unexpected public URL " + url);
  };
}

function pool(dataDir: string, fetchImpl: ReturnType<typeof makeMarketFetch>, nowMs: () => number) {
  return new DailyRangeAutoPool({
    dataDir,
    env: {
      DAILY_RANGE_AUTO_POOL_ENABLED: "1",
      DAILY_RANGE_AUTO_POOL_REFRESH_MS: "60000",
    },
    nowMs,
    fetchImpl,
    spreadSampleDelayMs: 0,
  });
}

describe("DailyRangeAutoPool C1-C6", () => {
  it("auto-discovers USD-M perpetuals, applies C6 before a Daily universe, and persists the evidence", async () => {
    const symbols = Array.from({ length: 10 }, (_, index) => "AUTO" + index + "USDT");
    const dataDir = mkdtempSync(join(tmpdir(), "daily-range-auto-pool-"));
    let now = NOW;
    const fetchImpl = makeMarketFetch(symbols);
    const subject = pool(dataDir, fetchImpl, () => now);

    const snapshot = await subject.refreshIfDue(resolveDailyRangeAutoPoolInput(
      [symbols[0] as string],
      [symbols[1] as string],
    ));

    expect(snapshot.state).toBe("ACTIVE");
    expect(snapshot.activeSymbols).toEqual(symbols.slice(2).sort());
    expect(snapshot.reconciliation?.crossSectionalExcluded).toEqual([symbols[0]]);
    expect(snapshot.reconciliation?.strategyOwnedExcluded).toEqual([symbols[1]]);

    const durable = JSON.parse(readFileSync(join(dataDir, "daily-range-auto-pool.json"), "utf8")) as {
      version: number;
      audit: Record<string, { failures: string[] }>;
    };
    expect(durable.version).toBe(2);
    expect(durable.audit[symbols[0] as string]?.failures).toContain("C6_CROSS_SECTIONAL_OVERLAP");
    expect(durable.audit[symbols[1] as string]?.failures).toContain("C6_STRATEGY_POSITION");

    now += 1_000;
    const reloaded = pool(dataDir, fetchImpl, () => now);
    expect(reloaded.getSnapshot(resolveDailyRangeAutoPoolInput([symbols[0] as string], [symbols[1] as string])).activeSymbols)
      .toEqual(symbols.slice(2).sort());
  });

  it("rejects exact C1/C3/C4/C5 failures without weakening the remaining pool", async () => {
    const symbols = Array.from({ length: 14 }, (_, index) => "RULE" + index + "USDT");
    const hardSpread = symbols[0] as string;
    const medianSpread = symbols[1] as string;
    const gap = symbols[2] as string;
    const tooNew = symbols[3] as string;
    const tooLargeLot = symbols[4] as string;
    const dataDir = mkdtempSync(join(tmpdir(), "daily-range-auto-pool-rules-"));
    const subject = pool(dataDir, makeMarketFetch(symbols, {
      spreads: { [hardSpread]: 12, [medianSpread]: 6 },
      fiveMinuteGap: new Set([gap]),
      listingDays: { [tooNew]: 59 },
      minQty: { [tooLargeLot]: 0.3 },
    }), () => NOW);

    const snapshot = await subject.refreshIfDue(resolveDailyRangeAutoPoolInput([]));

    expect(snapshot.state).toBe("ACTIVE");
    expect(snapshot.activeSymbols).toHaveLength(9);
    const durable = JSON.parse(readFileSync(join(dataDir, "daily-range-auto-pool.json"), "utf8")) as {
      audit: Record<string, { failures: string[] }>;
    };
    expect(durable.audit[hardSpread]?.failures).toContain("C3_HARD_SPREAD");
    expect(durable.audit[medianSpread]?.failures).toContain("C3_MEDIAN_SPREAD");
    expect(durable.audit[gap]?.failures).toContain("C4_5M_DATA");
    expect(durable.audit[tooNew]?.failures).toContain("C5_LISTING_AGE");
    expect(durable.audit[tooLargeLot]?.failures).toContain("C1_MIN_QTY_NOTIONAL");
  });

  it("uses C2 hysteresis only for current members: 22m to enter, 18m to remain", async () => {
    const symbols = Array.from({ length: 9 }, (_, index) => "LIQ" + index + "USDT");
    const changing = symbols[0] as string;
    const volumes: Record<string, number> = Object.fromEntries(symbols.map((symbol) => [symbol, 24_000_000]));
    const dataDir = mkdtempSync(join(tmpdir(), "daily-range-auto-pool-liquidity-"));
    let now = NOW;
    const subject = pool(dataDir, makeMarketFetch(symbols, { volumes }), () => now);

    expect((await subject.refreshIfDue(resolveDailyRangeAutoPoolInput([]))).activeSymbols).toHaveLength(9);

    volumes[changing] = 19_000_000;
    now += 60_000;
    expect((await subject.refreshIfDue(resolveDailyRangeAutoPoolInput([]))).activeSymbols).toContain(changing);

    volumes[changing] = 17_900_000;
    now += 60_000;
    expect((await subject.refreshIfDue(resolveDailyRangeAutoPoolInput([]))).activeSymbols).not.toContain(changing);
  });

  it("does not fall back to the retired static catalog after a stale public-data failure", async () => {
    const symbols = Array.from({ length: 8 }, (_, index) => "STALE" + index + "USDT");
    const dataDir = mkdtempSync(join(tmpdir(), "daily-range-auto-pool-stale-"));
    let now = NOW;
    let fail = false;
    const subject = pool(dataDir, makeMarketFetch(symbols, { fail: () => fail }), () => now);
    expect((await subject.refreshIfDue(resolveDailyRangeAutoPoolInput([]))).state).toBe("ACTIVE");

    fail = true;
    now += 11 * 60_000;
    const snapshot = await subject.refreshIfDue(resolveDailyRangeAutoPoolInput([]));
    expect(snapshot.state).toBe("STALE_DATA");
    expect(snapshot.activeSymbols).toEqual([]);
    expect(snapshot.lastError).toContain("public USD-M request failed");
  });

  it("returns a detached compact proof for the exact effective Daily pool", async () => {
    const symbols = Array.from({ length: 10 }, (_, index) => "EVID" + index + "USDT");
    const dataDir = mkdtempSync(join(tmpdir(), "daily-range-auto-pool-evidence-"));
    const subject = pool(dataDir, makeMarketFetch(symbols), () => NOW);
    const input = resolveDailyRangeAutoPoolInput([symbols[0] as string], [symbols[1] as string]);
    const snapshot = await subject.refreshIfDue(input);
    const evidence = subject.getEvidence(input, snapshot);

    expect(evidence.activeSymbols).toEqual(symbols.slice(2).sort());
    expect(Object.keys(evidence.auditBySymbol)).toEqual(symbols.slice(2).sort());
    expect(evidence.missingAuditSymbols).toEqual([]);
    expect(evidence.auditBySymbol[symbols[2] as string]?.quoteVolume24hUsd).toBe(24_000_000);

    evidence.activeSymbols.pop();
    evidence.auditBySymbol[symbols[2] as string]!.failures.push("C2_LIQUIDITY");
    const freshEvidence = subject.getEvidence(input, snapshot);
    expect(freshEvidence.activeSymbols).toEqual(symbols.slice(2).sort());
    expect(freshEvidence.auditBySymbol[symbols[2] as string]?.failures).toEqual([]);
  });
});

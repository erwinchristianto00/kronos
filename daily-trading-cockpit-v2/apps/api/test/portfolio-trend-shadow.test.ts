import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  admitToPortfolioTrendShadow,
  buildPortfolioTrendShadowReport,
  PortfolioTrendShadowStore,
  PORTFOLIO_TREND_MAX_CONCURRENT,
  PORTFOLIO_TREND_TOXIC_SYMBOLS,
  resolvePortfolioTrendPositions,
  type PortfolioTrendCandidate,
} from "../src/lib/portfolio-trend-shadow.js";

const tempDirs: string[] = [];

function mkStore(): PortfolioTrendShadowStore {
  const d = mkdtempSync(join(tmpdir(), "pt-shadow-"));
  tempDirs.push(d);
  return new PortfolioTrendShadowStore(d);
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function bullishLongCandidate(
  overrides: Partial<PortfolioTrendCandidate> = {},
): PortfolioTrendCandidate {
  return {
    symbol: "SOLUSDT",
    direction: "LONG",
    marketRegime: "Bullish expansion",
    trendStrength: 0.8,
    atrPercent: 1.0,
    entryPrice: 150,
    liquidityTier: "TIER_1",
    ...overrides,
  };
}

describe("portfolio-trend-shadow admission", () => {
  it("admits a valid bullish-trend LONG candidate", () => {
    const store = mkStore();
    const result = admitToPortfolioTrendShadow(bullishLongCandidate(), store);
    expect(result.admitted).toBe(true);
    expect(result.position?.direction).toBe("LONG");
    expect(result.position?.stopLoss).toBeLessThan(150);
    expect(result.position?.initialStopMultiplier).toBe(3.0);
  });

  it("rejects toxic symbol (BTCUSDT) unless isControl is true", () => {
    const store = mkStore();
    const r = admitToPortfolioTrendShadow(
      bullishLongCandidate({ symbol: "BTCUSDT" }),
      store,
    );
    expect(r.admitted).toBe(false);
    expect(r.rejectionReasons).toContain("TOXIC_SYMBOL_EXCLUDED");
    expect(PORTFOLIO_TREND_TOXIC_SYMBOLS.includes("BTCUSDT")).toBe(true);

    const r2 = admitToPortfolioTrendShadow(
      bullishLongCandidate({ symbol: "BTCUSDT", isControl: true }),
      store,
    );
    expect(r2.admitted).toBe(true);
  });

  it("rejects non-trending regime (Mixed/Choppy)", () => {
    const store = mkStore();
    const r = admitToPortfolioTrendShadow(
      bullishLongCandidate({ marketRegime: "Mixed rotation" }),
      store,
    );
    expect(r.admitted).toBe(false);
    expect(r.rejectionReasons).toContain("REGIME_NOT_TRENDING");
  });

  it("rejects when at max concurrent", () => {
    const store = mkStore();
    for (let i = 0; i < PORTFOLIO_TREND_MAX_CONCURRENT; i++) {
      const r = admitToPortfolioTrendShadow(
        bullishLongCandidate({
          symbol: `SYM${i}USDT`,
          entryPrice: 100 + i,
        }),
        store,
        { nowMs: Date.now() + i * 1000 },
      );
      expect(r.admitted).toBe(true);
      store.add(r.position!);
    }
    const r = admitToPortfolioTrendShadow(
      bullishLongCandidate({ symbol: "OVERFLOWUSDT" }),
      store,
    );
    expect(r.admitted).toBe(false);
    expect(r.rejectionReasons).toContain("MAX_CONCURRENT_REACHED");
  });

  it("stop computation: 3.0×ATR risk", () => {
    const store = mkStore();
    const candidate = bullishLongCandidate({
      entryPrice: 100,
      atrPercent: 2,
    });
    const r = admitToPortfolioTrendShadow(candidate, store);
    expect(r.admitted).toBe(true);
    // risk = 100 * 2/100 * 3 = 6 → stopLoss = 100 - 6 = 94
    expect(r.position?.stopLoss).toBeCloseTo(94, 5);
  });

  it("store path does NOT contain shadow-positions.json", () => {
    const store = mkStore();
    expect(store.path).not.toContain("shadow-positions.json");
    expect(store.path).toContain("portfolio-trend-shadow.json");
  });

  it("time-stop resolver marks CLOSED_TIME_STOP after threshold", async () => {
    const store = mkStore();
    const r = admitToPortfolioTrendShadow(bullishLongCandidate(), store);
    expect(r.admitted).toBe(true);
    store.add(r.position!);
    // Fast-forward 49 hours (default timeStop = 48h)
    const futureMs =
      Date.parse(r.position!.openedAt) + 49 * 60 * 60 * 1000;
    const out = await resolvePortfolioTrendPositions(store, undefined, {
      nowMs: futureMs,
    });
    expect(out.resolved).toBe(1);
    expect(store.all[0]!.status).toBe("CLOSED_TIME_STOP");
    expect(store.all[0]!.closeReason).toBe("TIME_STOP_EXPIRED");
  });

  it("buildPortfolioTrendShadowReport returns expected initial shape", () => {
    const store = mkStore();
    const r = buildPortfolioTrendShadowReport(store);
    expect(r.reportOnly).toBe(true);
    expect(r.totalObs).toBe(0);
    expect(r.status).toBe("COLLECTING");
  });

  it("admitted position file is NOT shadow-positions.json (isolation guard)", () => {
    const d = mkdtempSync(join(tmpdir(), "pt-isolation-"));
    tempDirs.push(d);
    const store = new PortfolioTrendShadowStore(d);
    const r = admitToPortfolioTrendShadow(bullishLongCandidate(), store);
    if (r.admitted && r.position) store.add(r.position);
    expect(existsSync(join(d, "shadow-positions.json"))).toBe(false);
    expect(existsSync(join(d, "portfolio-trend-shadow.json"))).toBe(true);
  });
});

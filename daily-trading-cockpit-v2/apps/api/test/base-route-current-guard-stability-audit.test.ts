import { describe, expect, it } from "vitest";

import {
  buildBaseRouteCurrentGuardStabilityReport,
  type CurrentGuardClosedPosition,
} from "../src/lib/base-route-current-guard-stability-audit.js";

let seq = 0;
function pos(
  override: Partial<CurrentGuardClosedPosition> = {},
): CurrentGuardClosedPosition {
  seq += 1;
  const base = new Date("2026-05-01T00:00:00.000Z").getTime();
  const ms = base + seq * 60 * 60 * 1000; // 1h apart so order is deterministic
  return {
    symbol: "ETHUSDT",
    direction: "LONG",
    grossR: 0.4,
    netR: 0.2,
    costR: 0.2,
    regime: "BULLISH_EXPANSION",
    entryVariant: "base_current_entry",
    exitVariant: "tp1_full_exit",
    policyVersion: "base-route-anchor-consistent-v2",
    openedAt: new Date(ms).toISOString(),
    closedAt: new Date(ms + 30 * 60 * 1000).toISOString(),
    ...override,
  };
}

/** Build n positions with controllable per-position net/gross. */
function seriesFrom(values: Array<{ gross: number; net: number; symbol?: string }>): CurrentGuardClosedPosition[] {
  return values.map((v) => pos({ grossR: v.gross, netR: v.net, costR: v.gross - v.net, symbol: v.symbol }));
}

describe("base route current-guard stability audit (F**)", () => {
  it("test 1: early≤0 & late>0 → RECENCY_ONLY", () => {
    // 20 closes: first 10 net negative, last 10 net positive. Overall net positive.
    // Spread across symbols so SYMBOL_CONCENTRATED (checked earlier) does not fire.
    const symbols = ["ETHUSDT", "SOLUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT"];
    const early = Array.from({ length: 10 }, (_, i) => ({ gross: -0.1, net: -0.15, symbol: symbols[i % symbols.length]! }));
    const late = Array.from({ length: 10 }, (_, i) => ({ gross: 0.8, net: 0.6, symbol: symbols[i % symbols.length]! }));
    const report = buildBaseRouteCurrentGuardStabilityReport(seriesFrom([...early, ...late]), 0);
    expect(report.netAvgR).not.toBeNull();
    expect(report.netAvgR!).toBeGreaterThan(0);
    expect(report.earlyHalf!.netAvgR!).toBeLessThanOrEqual(0);
    expect(report.lateHalf!.netAvgR!).toBeGreaterThan(0);
    expect(report.verdict).toBe("RECENCY_ONLY");
  });

  it("test 2: 3 positive OOS + closed≥100 + PF>1.20 + net>0.05 + low concentration + survives +5bps → STABLE_CANDIDATE", () => {
    // 120 closes, evenly distributed across symbols, consistent positive net with
    // a controlled loss minority so PF>1.20 and survives +5bps stress.
    const vals: Array<{ gross: number; net: number; symbol: string }> = [];
    const symbols = ["ETHUSDT", "SOLUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT"];
    for (let i = 0; i < 120; i++) {
      const sym = symbols[i % symbols.length]!;
      // 75% winners gross +0.6, 25% losers gross -0.2 → PF = (90*0.6)/(30*0.2)=9
      const win = i % 4 !== 0;
      vals.push({ gross: win ? 0.6 : -0.2, net: win ? 0.45 : -0.3, symbol: sym });
    }
    const report = buildBaseRouteCurrentGuardStabilityReport(seriesFrom(vals), 0);
    expect(report.closed).toBe(120);
    expect(report.netAvgR!).toBeGreaterThan(0.05);
    expect(report.pf!).toBeGreaterThan(1.2);
    expect(report.allThreeSegmentsPositive).toBe(true);
    expect(report.topSymbolPnlShare).toBeLessThanOrEqual(0.4);
    const plus5 = report.costSensitivity.find((r) => r.scenario === "plus_5bps_slippage")!;
    expect(plus5.netAvgR!).toBeGreaterThan(0);
    expect(report.verdict).toBe("STABLE_CANDIDATE");
  });

  it("test 3: 3 positive segments but closed<100 → PROMISING_BUT_UNSTABLE (not STABLE)", () => {
    const vals: Array<{ gross: number; net: number; symbol: string }> = [];
    const symbols = ["ETHUSDT", "SOLUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT"];
    for (let i = 0; i < 60; i++) {
      const win = i % 4 !== 0;
      vals.push({ gross: win ? 0.6 : -0.2, net: win ? 0.45 : -0.3, symbol: symbols[i % symbols.length]! });
    }
    const report = buildBaseRouteCurrentGuardStabilityReport(seriesFrom(vals), 0);
    expect(report.closed).toBe(60);
    expect(report.allThreeSegmentsPositive).toBe(true);
    expect(report.verdict).toBe("PROMISING_BUT_UNSTABLE");
  });

  it("test 4: top symbol PnL share > 40% → SYMBOL_CONCENTRATED", () => {
    // One symbol dominates the absolute gross PnL.
    const vals: Array<{ gross: number; net: number; symbol: string }> = [];
    for (let i = 0; i < 10; i++) vals.push({ gross: 2.0, net: 1.5, symbol: "BTCUSDT" });
    for (let i = 0; i < 10; i++) vals.push({ gross: 0.1, net: 0.05, symbol: "ETHUSDT" });
    const report = buildBaseRouteCurrentGuardStabilityReport(seriesFrom(vals), 0);
    expect(report.topSymbol).toBe("BTCUSDT");
    expect(report.topSymbolPnlShare).toBeGreaterThan(0.4);
    expect(report.verdict).toBe("SYMBOL_CONCENTRATED");
  });

  it("test 5: +5bps slippage flips net negative → COST_SENSITIVE", () => {
    // net positive but thin: gross 0.05, net 0.02. AVERAGE_STOP_BPS=200 so +5bps
    // adds 0.025R → net becomes negative. Spread across symbols to avoid concentration.
    const symbols = ["ETHUSDT", "SOLUSDT", "ADAUSDT", "AVAXUSDT"];
    const vals = Array.from({ length: 40 }, (_, i) => ({
      gross: 0.05,
      net: 0.02,
      symbol: symbols[i % symbols.length]!,
    }));
    const report = buildBaseRouteCurrentGuardStabilityReport(seriesFrom(vals), 0);
    expect(report.netAvgR!).toBeGreaterThan(0);
    const plus5 = report.costSensitivity.find((r) => r.scenario === "plus_5bps_slippage")!;
    expect(plus5.netAvgR!).toBeLessThanOrEqual(0);
    expect(plus5.stillPositive).toBe(false);
    expect(report.verdict).toBe("COST_SENSITIVE");
  });

  it("test 6: +10bps slippage downgrades — cost sensitivity row stillPositive=false", () => {
    const symbols = ["ETHUSDT", "SOLUSDT", "ADAUSDT", "AVAXUSDT"];
    const vals = Array.from({ length: 40 }, (_, i) => ({
      gross: 0.05,
      net: 0.04,
      symbol: symbols[i % symbols.length]!,
    }));
    const report = buildBaseRouteCurrentGuardStabilityReport(seriesFrom(vals), 0);
    const plus10 = report.costSensitivity.find((r) => r.scenario === "plus_10bps_slippage")!;
    // 0.05 gross - 0.01 baseCost - 0.05 extra (10/200) = -0.01 → negative
    expect(plus10.netAvgR!).toBeLessThanOrEqual(0);
    expect(plus10.stillPositive).toBe(false);
  });

  it("test 7: netAvgR ≤ 0 → REJECTED_BY_STABILITY", () => {
    const vals = Array.from({ length: 20 }, () => ({ gross: -0.2, net: -0.3 }));
    const report = buildBaseRouteCurrentGuardStabilityReport(seriesFrom(vals), 0);
    expect(report.netAvgR!).toBeLessThanOrEqual(0);
    expect(report.verdict).toBe("REJECTED_BY_STABILITY");
  });

  it("test 8: OOS segments split closed into 3 time-ordered thirds correctly", () => {
    const vals = Array.from({ length: 9 }, (_, i) => ({ gross: 0.1 * (i + 1), net: 0.05 * (i + 1) }));
    const report = buildBaseRouteCurrentGuardStabilityReport(seriesFrom(vals), 0);
    expect(report.oosSegments).not.toBeNull();
    const [s1, s2, s3] = report.oosSegments!;
    expect(s1.n).toBe(3);
    expect(s2.n).toBe(3);
    expect(s3.n).toBe(3);
    // segment 1 has the smallest grosses, segment 3 the largest (time-ordered)
    expect(s1.grossAvgR!).toBeLessThan(s3.grossAvgR!);
  });

  it("test 9: maxAdverseStreak counts consecutive losses", () => {
    // pattern: W L L L W L L
    const vals = [
      { gross: 0.5, net: 0.4 },
      { gross: -0.2, net: -0.3 },
      { gross: -0.2, net: -0.3 },
      { gross: -0.2, net: -0.3 },
      { gross: 0.5, net: 0.4 },
      { gross: -0.2, net: -0.3 },
      { gross: -0.2, net: -0.3 },
    ];
    const report = buildBaseRouteCurrentGuardStabilityReport(seriesFrom(vals), 0);
    expect(report.maxAdverseStreak).toBe(3);
  });

  it("test 10: cautions include 'PF=X on n=Y may be noise' for small-sample high-PF", () => {
    // high PF (>2.0) on small sample (<100), spread across symbols to avoid concentration
    const symbols = ["ETHUSDT", "SOLUSDT", "ADAUSDT", "AVAXUSDT"];
    const vals: Array<{ gross: number; net: number; symbol: string }> = [];
    for (let i = 0; i < 40; i++) {
      const win = i % 5 !== 0; // 80% wins
      vals.push({ gross: win ? 0.6 : -0.1, net: win ? 0.45 : -0.2, symbol: symbols[i % symbols.length]! });
    }
    const report = buildBaseRouteCurrentGuardStabilityReport(seriesFrom(vals), 0);
    expect(report.pf!).toBeGreaterThan(2.0);
    expect(report.closed).toBeLessThan(100);
    expect(report.cautions.some((c) => c.includes("may be noise"))).toBe(true);
  });

  it("realistic fixture (closed=67, net≈+0.12, PF≈3.26, WR≈80%, early/late divergent) → PROMISING_BUT_UNSTABLE or RECENCY_ONLY", () => {
    // 67 closes, ~80% WR, mild early/late divergence (early slightly weaker).
    const symbols = ["ETHUSDT", "SOLUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT", "ATOMUSDT"];
    const vals: Array<{ gross: number; net: number; symbol: string }> = [];
    for (let i = 0; i < 67; i++) {
      const win = i % 5 !== 0; // ~80%
      // make early half slightly weaker so divergence caution fires
      const recent = i >= 34;
      const winGross = recent ? 0.45 : 0.35;
      vals.push({
        gross: win ? winGross : -0.35,
        net: win ? winGross - 0.18 : -0.5,
        symbol: symbols[i % symbols.length]!,
      });
    }
    const report = buildBaseRouteCurrentGuardStabilityReport(seriesFrom(vals), 3);
    expect(report.closed).toBe(67);
    expect(["PROMISING_BUT_UNSTABLE", "RECENCY_ONLY"]).toContain(report.verdict);
    expect(report.reportOnly).toBe(true);
  });
});

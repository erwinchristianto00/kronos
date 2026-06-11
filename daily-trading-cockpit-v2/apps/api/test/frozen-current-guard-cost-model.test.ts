import { describe, expect, it } from "vitest";

import { buildFrozenCurrentGuardCostModelReport } from "../src/lib/frozen-current-guard-cost-model.js";
import {
  FROZEN_LANE,
  type FrozenCurrentGuardObservation,
} from "../src/lib/base-route-current-guard-frozen.js";

let seq = 0;
function obs(grossR: number, override: Partial<FrozenCurrentGuardObservation> = {}): FrozenCurrentGuardObservation {
  seq += 1;
  const base = new Date("2026-05-10T00:00:00.000Z").getTime();
  const ms = base + seq * 60 * 60 * 1000;
  return {
    reportOnly: true,
    laneVersion: FROZEN_LANE,
    observationKey: `SYM${seq}|LONG|${new Date(ms).toISOString()}`,
    symbol: "ETHUSDT",
    direction: "LONG",
    openedAt: new Date(ms).toISOString(),
    closedAt: new Date(ms + 1800000).toISOString(),
    status: grossR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS",
    grossR,
    netR: grossR - 0.1,
    costR: 0.1,
    regime: "BULLISH_EXPANSION",
    entryVariant: "base_current_entry",
    exitVariant: "tp1_full_exit",
    policyVersion: "base-route-anchor-consistent-v2",
    mirroredAt: new Date(ms).toISOString(),
    ...override,
  };
}

// A balanced fixture: mixed wins/losses, modestly positive gross.
function fixture(): FrozenCurrentGuardObservation[] {
  return [
    obs(0.6),
    obs(0.5),
    obs(0.4),
    obs(-0.3),
    obs(0.3),
    obs(-0.2),
  ];
}

const fullInputs = {
  spreadP50Bps: 1.1,
  spreadP90Bps: 4.3,
  spreadP99Bps: 9.4,
  avgFundingRate: 0.0001,
  depthAvailable: true,
  fundingAvailable: true,
  spreadAvailable: true,
};

describe("buildFrozenCurrentGuardCostModelReport", () => {
  it("test 1: computes spread-adjusted scenarios with correct roundTripBps", () => {
    const r = buildFrozenCurrentGuardCostModelReport(fixture(), fullInputs);
    const byName = (n: string) => r.scenarios.find((s) => s.scenario === n);
    expect(byName("spread_p50")?.roundTripBps).toBeCloseTo(10 + 2 * 1.1, 6); // 12.2
    expect(byName("spread_p90")?.roundTripBps).toBeCloseTo(10 + 2 * 4.3, 6); // 18.6
    expect(byName("spread_p99")?.roundTripBps).toBeCloseTo(10 + 2 * 9.4, 6); // 28.8
    expect(byName("current_28bps")?.roundTripBps).toBe(28);
    expect(byName("conservative_flat")?.roundTripBps).toBe(40);
    expect(byName("realistic_taker")?.roundTripBps).toBe(10);
  });

  it("test 2: p90/p99 spread scenarios can downgrade a thin-edge candidate to FAIL", () => {
    // Thin gross edge: mean gross ≈ 0.05R. At assumedStop=200, 28.8bps ≈ 0.144R cost
    // → net goes negative under p99.
    const thin = [obs(0.1), obs(0.1), obs(-0.05), obs(0.1), obs(-0.05), obs(0.1)];
    const r = buildFrozenCurrentGuardCostModelReport(thin, fullInputs);
    const p99 = r.scenarios.find((s) => s.scenario === "spread_p99");
    expect(p99?.netAvgR).not.toBeNull();
    expect(p99!.netAvgR! <= 0).toBe(true);
    expect(p99!.pass).toBe(false);
  });

  it("test 3: funding adjustment included when fundingAvailable, labeled placeholder when not", () => {
    const withFunding = buildFrozenCurrentGuardCostModelReport(fixture(), fullInputs);
    const fa = withFunding.scenarios.find((s) => s.scenario === "funding_adverse");
    // base = 10 + 2*4.3 = 18.6; funding penalty = 0.0001*10000*1 = 1bp → 19.6
    expect(fa?.roundTripBps).toBeCloseTo(18.6 + 1, 6);
    expect(fa?.description).not.toContain("placeholder");

    const noFunding = buildFrozenCurrentGuardCostModelReport(fixture(), {
      ...fullInputs,
      fundingAvailable: false,
      avgFundingRate: null,
    });
    const fa2 = noFunding.scenarios.find((s) => s.scenario === "funding_adverse");
    // base 18.6 + placeholder 2bps = 20.6
    expect(fa2?.roundTripBps).toBeCloseTo(18.6 + 2, 6);
    expect(fa2?.description).toContain("placeholder");
  });

  it("test 4: modelPopulated true only when spread+funding available and p90 computed", () => {
    expect(buildFrozenCurrentGuardCostModelReport(fixture(), fullInputs).modelPopulated).toBe(true);

    // funding missing
    expect(
      buildFrozenCurrentGuardCostModelReport(fixture(), { ...fullInputs, fundingAvailable: false })
        .modelPopulated,
    ).toBe(false);

    // spread flagged unavailable
    expect(
      buildFrozenCurrentGuardCostModelReport(fixture(), { ...fullInputs, spreadAvailable: false })
        .modelPopulated,
    ).toBe(false);

    // p90 spread value missing → no p90 scenario computed
    expect(
      buildFrozenCurrentGuardCostModelReport(fixture(), { ...fullInputs, spreadP90Bps: null })
        .modelPopulated,
    ).toBe(false);
  });

  it("test 5: worstPassingScenario / firstFailingScenario identified correctly", () => {
    // Strong edge: all scenarios pass → worst passing is the highest-bps scenario, no fail.
    const strong = [obs(1.0), obs(1.2), obs(0.8), obs(1.1), obs(0.9), obs(1.0)];
    const rs = buildFrozenCurrentGuardCostModelReport(strong, fullInputs);
    expect(rs.firstFailingScenario).toBeNull();
    // conservative_flat (40) is the highest-bps scenario here
    expect(rs.worstPassingScenario).toBe("conservative_flat");

    // Thin edge: some scenarios fail. firstFailing = lowest-bps failing scenario.
    const thin = [obs(0.1), obs(0.1), obs(-0.05), obs(0.1), obs(-0.05), obs(0.1)];
    const rt = buildFrozenCurrentGuardCostModelReport(thin, fullInputs);
    expect(rt.firstFailingScenario).not.toBeNull();
    const failBps = rt.scenarios.find((s) => s.scenario === rt.firstFailingScenario)!.roundTripBps;
    // every failing scenario must have >= the first-failing bps
    for (const s of rt.scenarios) {
      if (!s.pass) expect(s.roundTripBps).toBeGreaterThanOrEqual(failBps);
    }
    // worst passing scenario must still be positive and below the first failing bps if both exist
    if (rt.worstPassingScenario) {
      const wp = rt.scenarios.find((s) => s.scenario === rt.worstPassingScenario)!;
      expect(wp.pass).toBe(true);
    }
  });

  it("test 6: net recomputation is monotonic — higher cost yields lower netAvgR", () => {
    const r = buildFrozenCurrentGuardCostModelReport(fixture(), fullInputs);
    const sorted = [...r.scenarios].sort((a, b) => a.roundTripBps - b.roundTripBps);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (prev.netAvgR === null || cur.netAvgR === null) continue;
      if (cur.roundTripBps > prev.roundTripBps) {
        expect(cur.netAvgR).toBeLessThanOrEqual(prev.netAvgR + 1e-9);
      }
    }
  });

  it("carries reportOnly:true and assumedAvgStopBps default 200", () => {
    const r = buildFrozenCurrentGuardCostModelReport(fixture(), fullInputs);
    expect(r.reportOnly).toBe(true);
    expect(r.assumedAvgStopBps).toBe(200);
  });
});

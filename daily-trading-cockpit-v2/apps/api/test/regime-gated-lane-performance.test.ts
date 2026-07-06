import { describe, it, expect } from "vitest";
import {
  regimeAllowsObservation,
  regimeGateDecision,
  buildRegimeGatedLaneReport,
  type RgObservation,
} from "../src/lib/regime-gated-lane-performance.js";

describe("regime-gated-lane-performance", () => {
  it("[GATE_V2] drops only captured EXTENDED counter-regime rows", () => {
    expect(regimeAllowsObservation({ regime: "Bearish pressure", direction: "SHORT", posture: "EXTENDED", regimeDirection: "SHORT" })).toBe(true);
    expect(regimeAllowsObservation({ regime: "Bullish expansion", direction: "SHORT", posture: "EXTENDED", regimeDirection: "LONG" })).toBe(false);
    expect(regimeAllowsObservation({ regime: "Bullish expansion", direction: "LONG", posture: "EXTENDED", regimeDirection: "LONG" })).toBe(true);
    expect(regimeAllowsObservation({ regime: "Bearish pressure", direction: "LONG", posture: "EXTENDED", regimeDirection: "SHORT" })).toBe(false);
    expect(regimeAllowsObservation({ regime: "Mixed rotation", direction: "SHORT", posture: "TACTICAL", regimeDirection: "MIXED" })).toBe(true);
    expect(regimeAllowsObservation({ regime: null, direction: "SHORT" })).toBe(true);
  });

  it("[GATE_V2] keeps legacy label-only rows instead of regex-gating them", () => {
    const decision = regimeGateDecision({ regime: "Bullish expansion", direction: "SHORT" });
    expect(decision.allowed).toBe(true);
    expect(decision.gateEligible).toBe(false);
    expect(decision.reason).toBe("LEGACY_OR_UNKNOWN_CONTEXT_KEPT");
  });

  it("[REPORT] gating out counter-regime losers improves a lane's net avg R", () => {
    const obs: RgObservation[] = [
      ...Array.from({ length: 20 }, () => ({
        variantId: "CG_X",
        direction: "SHORT" as const,
        regime: "Bearish pressure",
        posture: "EXTENDED" as const,
        regimeDirection: "SHORT" as const,
        netR: 0.2,
      })),
      ...Array.from({ length: 10 }, () => ({
        variantId: "CG_X",
        direction: "SHORT" as const,
        regime: "Bullish expansion",
        posture: "EXTENDED" as const,
        regimeDirection: "LONG" as const,
        netR: -1.0,
      })),
    ];
    const rep = buildRegimeGatedLaneReport(obs);
    const lane = rep.lanes.find((l) => l.variantId === "CG_X")!;
    expect(lane.raw.n).toBe(30);
    expect(lane.raw.netAvgR).toBeCloseTo(-0.2, 6); // (4 − 10) / 30
    expect(lane.gated.n).toBe(20); // 10 counter-regime shorts dropped
    expect(lane.dropped.n).toBe(10);
    expect(lane.gateEligible).toBe(30);
    expect(lane.filteredOut).toBe(10);
    expect(lane.gated.netAvgR).toBeCloseTo(0.2, 6);
    expect(lane.dropped.netAvgR).toBeCloseTo(-1.0, 6);
    expect(lane.deltaNetAvgR).toBeGreaterThan(0);
    expect(lane.verdict).toBe("IMPROVED");
    expect(rep.totalGateEligible).toBe(30);
    expect(rep.totalGatedOut).toBe(10);
  });

  it("[INSUFFICIENT] a tiny gated sample yields no verdict", () => {
    const obs: RgObservation[] = [
      { variantId: "CG_Y", direction: "SHORT", regime: "Bearish pressure", posture: "EXTENDED", regimeDirection: "SHORT", netR: 0.5 },
      { variantId: "CG_Y", direction: "SHORT", regime: "Bullish expansion", posture: "EXTENDED", regimeDirection: "LONG", netR: -0.3 },
    ];
    expect(buildRegimeGatedLaneReport(obs).lanes[0]!.verdict).toBe("INSUFFICIENT");
  });

  it("[FILTER] only resolved (netR set) directional obs are counted", () => {
    const obs: RgObservation[] = [
      { variantId: "CG_Z", direction: "SHORT", regime: "Bearish pressure", netR: 0.3 },
      { variantId: "CG_Z", direction: "SHORT", regime: "Bearish pressure", netR: null }, // open → excluded
    ];
    expect(buildRegimeGatedLaneReport(obs).lanes[0]!.raw.n).toBe(1);
  });
});

describe("regime-gated verdict is BOOK-R based (not the per-trade-average survivorship trap)", () => {
  it("WORSENED when the gate would drop net-WINNING counter-regime trades (the CG_WIDE_LONG_RUNNER case)", () => {
    const obs: RgObservation[] = [
      // kept (regime-aligned) longs — modest winners
      ...Array.from({ length: 30 }, () => ({
        variantId: "RUNNER", direction: "LONG" as const, regime: "Bullish expansion",
        posture: "EXTENDED" as const, regimeDirection: "LONG" as const, netR: 0.2,
      })),
      // counter-regime longs the gate DROPS — but they are BIG WINNERS (+1.0R)
      ...Array.from({ length: 20 }, () => ({
        variantId: "RUNNER", direction: "LONG" as const, regime: "Bearish pressure",
        posture: "EXTENDED" as const, regimeDirection: "SHORT" as const, netR: 1.0,
      })),
    ];
    const row = buildRegimeGatedLaneReport(obs).lanes.find((l) => l.variantId === "RUNNER")!;
    // per-trade average RISES (0.52 → 0.20?) ... actually gated avg (0.2) < raw avg (0.52), but the
    // point is the BOOK: dropping 20 trades @ +1.0R = -20R of realized edge.
    expect(row.deltaBookR).toBeCloseTo(-20, 5);
    expect(row.verdict).toBe("WORSENED");
    expect(row.gatedTradeable).toBe(true); // lane is still a net winner, so the loss is real
  });

  it("report aggregates the book-R impact over tradeable lanes (the decision number)", () => {
    const obs: RgObservation[] = [
      ...Array.from({ length: 30 }, () => ({
        variantId: "RUNNER", direction: "LONG" as const, regime: "Bullish expansion",
        posture: "EXTENDED" as const, regimeDirection: "LONG" as const, netR: 0.2,
      })),
      ...Array.from({ length: 20 }, () => ({
        variantId: "RUNNER", direction: "LONG" as const, regime: "Bearish pressure",
        posture: "EXTENDED" as const, regimeDirection: "SHORT" as const, netR: 1.0,
      })),
    ];
    const report = buildRegimeGatedLaneReport(obs);
    expect(report.deltaBookRTradeableLanes).toBeCloseTo(-20, 5);
  });
});

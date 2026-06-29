import { describe, it, expect } from "vitest";
import {
  regimeAllowsObservation,
  buildRegimeGatedLaneReport,
  type RgObservation,
} from "../src/lib/regime-gated-lane-performance.js";

describe("regime-gated-lane-performance", () => {
  it("[GATE] keeps same-direction, drops counter-regime, keeps mixed/unknown", () => {
    expect(regimeAllowsObservation({ regime: "Bearish pressure", direction: "SHORT" })).toBe(true);
    expect(regimeAllowsObservation({ regime: "Bullish expansion", direction: "SHORT" })).toBe(false); // counter
    expect(regimeAllowsObservation({ regime: "Bullish expansion", direction: "LONG" })).toBe(true);
    expect(regimeAllowsObservation({ regime: "Bearish pressure", direction: "LONG" })).toBe(false); // counter
    expect(regimeAllowsObservation({ regime: "Mixed rotation", direction: "SHORT" })).toBe(true); // mixed → keep both
    expect(regimeAllowsObservation({ regime: null, direction: "SHORT" })).toBe(true); // unknown → keep
  });

  it("[REPORT] gating out counter-regime losers improves a lane's net avg R", () => {
    const obs: RgObservation[] = [
      ...Array.from({ length: 20 }, () => ({ variantId: "CG_X", direction: "SHORT" as const, regime: "Bearish pressure", netR: 0.2 })),
      ...Array.from({ length: 10 }, () => ({ variantId: "CG_X", direction: "SHORT" as const, regime: "Bullish expansion", netR: -1.0 })),
    ];
    const rep = buildRegimeGatedLaneReport(obs);
    const lane = rep.lanes.find((l) => l.variantId === "CG_X")!;
    expect(lane.raw.n).toBe(30);
    expect(lane.raw.netAvgR).toBeCloseTo(-0.2, 6); // (4 − 10) / 30
    expect(lane.gated.n).toBe(20); // 10 counter-regime shorts dropped
    expect(lane.filteredOut).toBe(10);
    expect(lane.gated.netAvgR).toBeCloseTo(0.2, 6);
    expect(lane.deltaNetAvgR).toBeGreaterThan(0);
    expect(lane.verdict).toBe("IMPROVED");
    expect(rep.totalGatedOut).toBe(10);
  });

  it("[INSUFFICIENT] a tiny gated sample yields no verdict", () => {
    const obs: RgObservation[] = [
      { variantId: "CG_Y", direction: "SHORT", regime: "Bearish pressure", netR: 0.5 },
      { variantId: "CG_Y", direction: "SHORT", regime: "Bullish expansion", netR: -0.3 },
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

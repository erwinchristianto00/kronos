import { describe, it, expect } from "vitest";
import {
  RegimeAutopilot,
  REGIME_AUTOPILOT_PRESETS,
  type LaneAllocationEntry,
} from "../src/lib/regime-autopilot.js";

function makePilot(opts: { stableCycles?: number; minHoldMs?: number } = {}) {
  const applied: Array<LaneAllocationEntry[]> = [];
  let regime: string | null = null;
  let now = 1_000_000_000_000;
  const pilot = new RegimeAutopilot({
    setAllocations: (a) => applied.push(a),
    getLatestRegime: () => regime,
    nowMs: () => now,
    stableCycles: opts.stableCycles ?? 3,
    minHoldMs: opts.minHoldMs ?? 30 * 60_000,
  });
  return {
    pilot,
    applied,
    setRegime: (r: string | null) => { regime = r; },
    advance: (ms: number) => { now += ms; },
  };
}

describe("regime auto-pilot (Tier 1)", () => {
  it("does NOT switch until the regime has been stable for stableCycles (anti-whipsaw)", () => {
    const { pilot, applied, setRegime } = makePilot({ stableCycles: 3 });
    setRegime("TREND_RECOVERY");
    pilot.tick(); // count 1
    pilot.tick(); // count 2
    expect(applied.length).toBe(0);
    pilot.tick(); // count 3 → applies
    expect(applied.length).toBe(1);
    expect(applied[0]).toEqual(REGIME_AUTOPILOT_PRESETS.TREND_RECOVERY);
  });

  it("resets the stability counter when the regime flips mid-count (whipsaw is ignored)", () => {
    const { pilot, applied, setRegime } = makePilot({ stableCycles: 3 });
    setRegime("BEAR_TREND"); pilot.tick(); pilot.tick(); // count 2 for BEAR_TREND
    setRegime("TREND_RECOVERY"); pilot.tick(); // flip → count resets to 1
    expect(applied.length).toBe(0);
    pilot.tick(); pilot.tick(); // count 3 for TREND_RECOVERY → applies TREND, never BEAR
    expect(applied.length).toBe(1);
    expect(applied[0]).toEqual(REGIME_AUTOPILOT_PRESETS.TREND_RECOVERY);
  });

  it("Neutral (NO_TRADE) applies the pure market-neutral preset", () => {
    const { pilot, applied, setRegime } = makePilot({ stableCycles: 1 });
    setRegime("NO_TRADE");
    pilot.tick();
    expect(applied[0]).toEqual([{ laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", weightPct: 100 }]);
  });

  it("does not re-apply the same regime, and honors the min-hold before switching to a new one", () => {
    const { pilot, applied, setRegime, advance } = makePilot({ stableCycles: 1, minHoldMs: 30 * 60_000 });
    setRegime("TREND_RECOVERY"); pilot.tick();
    expect(applied.length).toBe(1);
    pilot.tick(); pilot.tick(); // same regime, stable → no re-apply
    expect(applied.length).toBe(1);
    // New regime, but within the min-hold window → blocked.
    setRegime("BEAR_TREND"); pilot.tick();
    expect(applied.length).toBe(1);
    expect(pilot.getStatus().lastSkipReason).toMatch(/min-hold/);
    // Past the min-hold → the switch goes through.
    advance(31 * 60_000);
    pilot.tick();
    expect(applied.length).toBe(2);
    expect(applied[1]).toEqual(REGIME_AUTOPILOT_PRESETS.BEAR_TREND);
  });

  it("skips unknown / no-preset regimes without throwing", () => {
    const { pilot, applied, setRegime } = makePilot({ stableCycles: 1 });
    setRegime("SOMETHING_ELSE"); pilot.tick();
    setRegime(null); pilot.tick();
    expect(applied.length).toBe(0);
    expect(pilot.getStatus().lastSkipReason).toMatch(/no-preset/);
  });

  it("every preset uses valid weights (0,100] summing sensibly and includes the cross-sectional backbone where non-directional", () => {
    for (const [regime, preset] of Object.entries(REGIME_AUTOPILOT_PRESETS)) {
      const total = preset.reduce((s, e) => s + e.weightPct, 0);
      expect(total).toBeGreaterThan(0);
      expect(total).toBeLessThanOrEqual(100);
      for (const e of preset) {
        expect(e.weightPct).toBeGreaterThan(0);
        expect(e.weightPct).toBeLessThanOrEqual(100);
      }
      // Neutral must be pure market-neutral.
      if (regime === "NO_TRADE") {
        expect(preset).toEqual([{ laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", weightPct: 100 }]);
      }
    }
  });
});

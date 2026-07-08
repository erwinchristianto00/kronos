import { describe, it, expect } from "vitest";
import {
  RegimeAutopilot,
  REGIME_AUTOPILOT_PRESETS,
  type LaneAllocationEntry,
} from "../src/lib/regime-autopilot.js";

function makePilot(opts: { stableCycles?: number; minHoldMs?: number; setAllocationsResult?: { ok: boolean; reason?: string } } = {}) {
  const applied: Array<LaneAllocationEntry[]> = [];
  let regime: string | null = null;
  let now = 1_000_000_000_000;
  let manualMode = false;
  const pilot = new RegimeAutopilot({
    setAllocations: (a) => {
      applied.push(a);
      return opts.setAllocationsResult ?? { ok: true };
    },
    getLatestRegime: () => regime,
    isManualMode: () => manualMode,
    nowMs: () => now,
    stableCycles: opts.stableCycles ?? 3,
    minHoldMs: opts.minHoldMs ?? 30 * 60_000,
  });
  return {
    pilot,
    applied,
    setRegime: (r: string | null) => { regime = r; },
    setManualMode: (m: boolean) => { manualMode = m; },
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

  // 2026-07-08 operator: "autopilot tetep memerintah, tapi kalau execution mode nya manual, gw
  // mau ambil alih lane allocation" — while MANUAL is on the autopilot only observes, and the
  // instant it flips back to auto the preset re-applies (no stale already-applied short-circuit).
  it("[MANUAL-OVERRIDE] never applies while manual mode is ON, re-applies immediately after it turns OFF", () => {
    const { pilot, applied, setRegime, setManualMode } = makePilot({ stableCycles: 1 });
    setRegime("BEAR_TREND");
    pilot.tick();
    expect(applied.length).toBe(1); // auto mode: applies normally

    setManualMode(true); // operator takes over
    setRegime("TREND_RECOVERY");
    pilot.tick(); pilot.tick(); pilot.tick();
    expect(applied.length).toBe(1); // regime changed + stable, but MANUAL holds — nothing applied
    expect(pilot.getStatus().lastSkipReason).toMatch(/manual-selector-mode/);

    setManualMode(false); // back to auto — the bot reclaims on the very next tick
    pilot.tick();
    expect(applied.length).toBe(2);
    expect(applied[1]).toEqual(REGIME_AUTOPILOT_PRESETS.TREND_RECOVERY);
  });

  it("[MANUAL-OVERRIDE] re-applies even the SAME regime after manual mode ends (operator may have changed the allocation)", () => {
    const { pilot, applied, setRegime, setManualMode } = makePilot({ stableCycles: 1 });
    setRegime("NO_TRADE");
    pilot.tick();
    expect(applied.length).toBe(1);
    setManualMode(true);
    pilot.tick(); // operator holds; appliedRegime resets internally
    setManualMode(false);
    pilot.tick(); // same regime as before manual — must STILL re-apply over the manual allocation
    expect(applied.length).toBe(2);
    expect(applied[1]).toEqual(REGIME_AUTOPILOT_PRESETS.NO_TRADE);
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

  // 2026-07-08 audit fix: setAllocations used to be void-returning — a rejected apply (e.g. a
  // future preset edit violating setLaneAllocations' own >4-lane/duplicate/weight constraints)
  // was silently treated as a success, leaving RegimeAutopilot's own state believing it switched
  // while the live engine's real allocation stayed on the OLD preset.
  it("does NOT mark the regime as applied when setAllocations reports a rejection", () => {
    const { pilot, applied, setRegime } = makePilot({ stableCycles: 1, setAllocationsResult: { ok: false, reason: "test rejection" } });
    setRegime("TREND_RECOVERY");
    pilot.tick();
    expect(applied.length).toBe(1); // the attempt was made...
    expect(pilot.getStatus().appliedRegime).toBeNull(); // ...but never accepted
    expect(pilot.getStatus().lastSkipReason).toMatch(/apply-rejected:test rejection/);
    // A later tick must RETRY (not permanently give up) since appliedRegime never advanced.
    pilot.tick();
    expect(applied.length).toBe(2);
  });

  it("every preset uses valid weights (0,100] summing sensibly and includes the cross-sectional backbone where non-directional", () => {
    for (const [regime, preset] of Object.entries(REGIME_AUTOPILOT_PRESETS)) {
      const total = preset.reduce((s, e) => s + e.weightPct, 0);
      // 2026-07-08 audit fix: was `<= 100` only, which would silently pass an accidentally
      // under-allocated preset (e.g. summing to 70) identically to a correctly-balanced one.
      // setLaneAllocations rounds each weightPct with Math.round, so require the sum to land
      // EXACTLY on 100 post-rounding — a preset design intentionally holding cash in reserve
      // would need its own explicit test, not a silent pass-through here.
      expect(total, `${regime} preset weights sum to ${total}, expected exactly 100`).toBe(100);
      for (const e of preset) {
        expect(e.weightPct).toBeGreaterThan(0);
        expect(e.weightPct).toBeLessThanOrEqual(100);
      }
      // Neutral must be pure market-neutral.
      if (regime === "NO_TRADE") {
        expect(preset).toEqual([{ laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", weightPct: 100 }]);
      }
      // setLaneAllocations (live-execution-engine.ts) rejects >4 lanes in one allocation.
      expect(preset.length).toBeLessThanOrEqual(4);
    }
  });

  // 2026-07-08 (operator: "wire lane baru ke allocation selection, atur ulang preset"): the
  // let-it-run lanes (CG_WIDE_LONG_RUNNER, CG_MFE_GIVEBACK) only earn their keep in a CONFIRMED
  // trend — a 3R target rarely gets reached in chop. Assert the placement matches that reasoning,
  // not just "the preset is structurally valid" (the test above).
  it("adds CG_MFE_GIVEBACK to the confirmed-trend regimes (BEAR_TREND, TREND_RECOVERY) only", () => {
    const laneIds = (regime: string) => REGIME_AUTOPILOT_PRESETS[regime]!.map((e) => e.laneId);
    expect(laneIds("BEAR_TREND")).toContain("CG_MFE_GIVEBACK");
    expect(laneIds("TREND_RECOVERY")).toContain("CG_MFE_GIVEBACK");
    expect(laneIds("BEARISH_CHOPPY_DEFENSIVE")).not.toContain("CG_MFE_GIVEBACK");
    expect(laneIds("NEUTRAL_RECOVERY")).not.toContain("CG_MFE_GIVEBACK");
  });

  it("adds CG_WIDE_LONG_RUNNER only to TREND_RECOVERY (confirmed bull trend), not the tactical NEUTRAL_RECOVERY", () => {
    const laneIds = (regime: string) => REGIME_AUTOPILOT_PRESETS[regime]!.map((e) => e.laneId);
    expect(laneIds("TREND_RECOVERY")).toContain("CG_WIDE_LONG_RUNNER");
    expect(laneIds("NEUTRAL_RECOVERY")).not.toContain("CG_WIDE_LONG_RUNNER");
  });

  it("TREND_RECOVERY concentrates fully on the confirmed direction (no market-neutral dilution)", () => {
    const laneIds = REGIME_AUTOPILOT_PRESETS.TREND_RECOVERY!.map((e) => e.laneId);
    expect(laneIds).not.toContain("CROSS_SECTIONAL_MARKET_NEUTRAL");
  });

  // 2026-07-08: CROSS_SECTIONAL_TREND (mirrors TREND_BETA_VOL) only fits a CONFIRMED trend — same
  // reasoning as the CG_WIDE_LONG_RUNNER/CG_MFE_GIVEBACK placement above.
  it("adds CROSS_SECTIONAL_TREND to the confirmed-trend regimes (BEAR_TREND, TREND_RECOVERY) only", () => {
    const laneIds = (regime: string) => REGIME_AUTOPILOT_PRESETS[regime]!.map((e) => e.laneId);
    expect(laneIds("BEAR_TREND")).toContain("CROSS_SECTIONAL_TREND");
    expect(laneIds("TREND_RECOVERY")).toContain("CROSS_SECTIONAL_TREND");
    expect(laneIds("BEARISH_CHOPPY_DEFENSIVE")).not.toContain("CROSS_SECTIONAL_TREND");
    expect(laneIds("NEUTRAL_RECOVERY")).not.toContain("CROSS_SECTIONAL_TREND");
    expect(laneIds("NO_TRADE")).not.toContain("CROSS_SECTIONAL_TREND");
  });

  // CROSS_SECTIONAL_MIXED (mirrors MIXED_MEAN_REVERSION) is the inverse: fits tactical/choppy
  // regimes, not a confirmed trend.
  it("adds CROSS_SECTIONAL_MIXED to the tactical/choppy regimes (BEARISH_CHOPPY_DEFENSIVE, NEUTRAL_RECOVERY) only", () => {
    const laneIds = (regime: string) => REGIME_AUTOPILOT_PRESETS[regime]!.map((e) => e.laneId);
    expect(laneIds("BEARISH_CHOPPY_DEFENSIVE")).toContain("CROSS_SECTIONAL_MIXED");
    expect(laneIds("NEUTRAL_RECOVERY")).toContain("CROSS_SECTIONAL_MIXED");
    expect(laneIds("BEAR_TREND")).not.toContain("CROSS_SECTIONAL_MIXED");
    expect(laneIds("TREND_RECOVERY")).not.toContain("CROSS_SECTIONAL_MIXED");
    expect(laneIds("NO_TRADE")).not.toContain("CROSS_SECTIONAL_MIXED");
  });

  // 2026-07-08: the 2 brand-new SingleSymbolLaneExecutor lanes get a modest slot ONLY where the
  // preset already has room under the 4-lane cap (BEAR_TREND/TREND_RECOVERY are already full) —
  // a more conservative regime to prove out never-before-executed code than the fully-concentrated
  // confirmed-trend presets.
  it("adds SHORT_FADE_EXHAUSTION_CROWDED to BEARISH_CHOPPY_DEFENSIVE only (BEAR_TREND has no room)", () => {
    const laneIds = (regime: string) => REGIME_AUTOPILOT_PRESETS[regime]!.map((e) => e.laneId);
    expect(laneIds("BEARISH_CHOPPY_DEFENSIVE")).toContain("SHORT_FADE_EXHAUSTION_CROWDED");
    expect(laneIds("BEAR_TREND")).not.toContain("SHORT_FADE_EXHAUSTION_CROWDED");
    expect(laneIds("NEUTRAL_RECOVERY")).not.toContain("SHORT_FADE_EXHAUSTION_CROWDED");
    expect(laneIds("TREND_RECOVERY")).not.toContain("SHORT_FADE_EXHAUSTION_CROWDED");
    expect(laneIds("NO_TRADE")).not.toContain("SHORT_FADE_EXHAUSTION_CROWDED");
  });

  it("adds INTRADAY_MOMENTUM_BREAKOUT_LONG to NEUTRAL_RECOVERY only (TREND_RECOVERY has no room)", () => {
    const laneIds = (regime: string) => REGIME_AUTOPILOT_PRESETS[regime]!.map((e) => e.laneId);
    expect(laneIds("NEUTRAL_RECOVERY")).toContain("INTRADAY_MOMENTUM_BREAKOUT_LONG");
    expect(laneIds("TREND_RECOVERY")).not.toContain("INTRADAY_MOMENTUM_BREAKOUT_LONG");
    expect(laneIds("BEAR_TREND")).not.toContain("INTRADAY_MOMENTUM_BREAKOUT_LONG");
    expect(laneIds("BEARISH_CHOPPY_DEFENSIVE")).not.toContain("INTRADAY_MOMENTUM_BREAKOUT_LONG");
    expect(laneIds("NO_TRADE")).not.toContain("INTRADAY_MOMENTUM_BREAKOUT_LONG");
  });
});

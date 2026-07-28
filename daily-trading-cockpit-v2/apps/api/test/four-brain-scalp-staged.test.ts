import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { laneHorizon } from "../src/lib/four-brain-live-gather-bindings.js";

/**
 * SCALP was unreachable in a way that looked exactly like a failing measurement: laneHorizon() could
 * only return INTRADAY or SWING, so no candidate ever carried horizon SCALP, so the SCALP direction
 * decision the gather computes could never attach to an executive decision
 * (four-brain-shadow-tick.ts joins `directionByHorizon.get(candidate.identity.horizon)`), so
 * SCALP/LONG and SCALP/SHORT sat at 0 samples while the readiness panel listed them as gaps.
 *
 * Reassigning the FAST lanes outright would have fixed it by gutting INTRADAY — those lanes ARE
 * INTRADAY's population. So the promotion is STAGED: nothing changes until INTRADAY has enough
 * independent samples to be judged, and only then do the fast lanes move to the shorter horizon.
 */
const APP_SRC = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/app.ts"), "utf-8");

const FAST = "CG_VARIANT_MATRIX:CG_WIDE_FAST_LONG";
const INTRA = "INTRADAY_MOMENTUM_BREAKOUT_LONG";
const FADE = "SHORT_FADE_EXHAUSTION_CROWDED";
const PANIC = "PANIC_WASHOUT_RECLAIM_LONG";
const SWINGY = "CROSS_SECTIONAL_MARKET_NEUTRAL";

describe("before INTRADAY earns a verdict, nothing changes", () => {
  /** The pre-2026-07-28 behaviour, preserved exactly — INTRADAY must not be gutted while it is still
   *  the horizon closest to being measurable. */
  it.each([[FAST], [INTRA], [FADE], [PANIC]])("%s stays INTRADAY", (lane) => {
    expect(laneHorizon(lane)).toBe("INTRADAY");
    expect(laneHorizon(lane, { scalpEnabled: false })).toBe("INTRADAY");
  });

  it("composite/basket lanes are SWING either way", () => {
    expect(laneHorizon(SWINGY)).toBe("SWING");
    expect(laneHorizon(SWINGY, { scalpEnabled: true })).toBe("SWING");
  });
});

describe("once INTRADAY has a verdict, only the FAST lanes promote", () => {
  it("FAST moves to SCALP", () => {
    expect(laneHorizon(FAST, { scalpEnabled: true })).toBe("SCALP");
  });

  /** INTRADAY must survive the promotion with a real population, or the switch would trade a
   *  nearly-measurable horizon for an unmeasurable one. */
  it.each([[INTRA], [FADE], [PANIC]])("%s stays INTRADAY even when enabled", (lane) => {
    expect(laneHorizon(lane, { scalpEnabled: true })).toBe("INTRADAY");
  });

  it("is case-insensitive on the lane id", () => {
    expect(laneHorizon(FAST.toLowerCase(), { scalpEnabled: true })).toBe("SCALP");
  });
});

describe("the trigger is wired to INTRADAY's own sample count", () => {
  /** FAILS WITHOUT THE FIX — app.ts passed no flag at all, so the default could never engage. */
  it("app.ts derives scalpHorizonEnabled from INTRADAY effectiveN against the shared bar", () => {
    const at = APP_SRC.indexOf("scalpHorizonEnabled:");
    expect(at).toBeGreaterThanOrEqual(0);
    const block = APP_SRC.slice(at, at + 400);
    expect(block).toContain("perHorizon.INTRADAY");
    expect(block).toContain("effectiveN");
    expect(block).toContain("DIRECTION_ENTRY_MIN_EXAMPLES_ACTIVE");
  });

  /** effectiveN, not row count — 305 rows over 38 windows is 38 observations, and reading the larger
   *  number is the mistake this repo keeps making. */
  it("does not trigger on a raw row count", () => {
    const at = APP_SRC.indexOf("scalpHorizonEnabled:");
    const block = APP_SRC.slice(at, at + 400);
    expect(block).not.toMatch(/perHorizon\.INTRADAY\?\.n\b/);
  });

  /** Read per tick, so the flip needs no restart and can reverse if retention drops INTRADAY back
   *  below the bar. */
  it("is evaluated inside the per-tick deps builder, not captured once at boot", () => {
    const depsAt = APP_SRC.indexOf("const buildFourBrainDeps");
    expect(depsAt).toBeGreaterThanOrEqual(0);
    expect(APP_SRC.indexOf("scalpHorizonEnabled:")).toBeGreaterThan(depsAt);
  });
});

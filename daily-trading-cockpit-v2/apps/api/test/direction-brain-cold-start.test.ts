import { describe, it, expect } from "vitest";
import { decideDirection, DIRECTION_EDGE_MIN_SAMPLES } from "../src/lib/direction-brain.js";
import { checkDirectionInvariants } from "../src/lib/four-brain-invariants.js";
import { directionInput, src } from "./four-brain-fixtures.js";

/**
 * Enabling SCALP produced 376 decisions, 376 of them FLAT, with no path out: a horizon that has
 * resolved nothing can make neither side PROVEN_ anything, an unmeasured side scores 0, and the FLAT
 * baseline floors at 0.6 when both edges are missing. Never non-FLAT ⇒ never any evidence ⇒ never
 * proven ⇒ never non-FLAT. The same deadlock the PROVEN_BELOW exploration pass was written to break,
 * recreated on a newborn horizon.
 *
 * The allowance is deliberately keyed on an EXPLICIT zero, because "both edges missing" also
 * describes a MATURE horizon that momentarily has no regime slice — and there, standing aside is the
 * right answer.
 */
const N = DIRECTION_EDGE_MIN_SAMPLES;
const cold = (o: Record<string, unknown> = {}) =>
  directionInput({
    longEdge: src(null), shortEdge: src(null), longLaneEdge: src(null), shortLaneEdge: src(null),
    horizonResolvedN: 0, ...o,
  });

describe("a newborn horizon can escape all-FLAT", () => {
  /** FAILS WITHOUT THE FIX — this is SCALP's exact situation. */
  it("takes a direction instead of FLAT when the horizon has resolved nothing", () => {
    const d = decideDirection(cold({ shortLaneEdge: src(0.2), controllerBias: "SHORT" }));
    expect(d.action).not.toBe("FLAT");
    expect(d.supportingSignals.some((s) => s.includes("cold-start"))).toBe(true);
    expect(checkDirectionInvariants(d).ok).toBe(true);
  });

  it("uses the non-edge evidence it does have to pick a side", () => {
    const short = decideDirection(cold({ shortLaneEdge: src(0.3), controllerBias: "SHORT" }));
    const long = decideDirection(cold({ longLaneEdge: src(0.3), controllerBias: "LONG" }));
    expect(short.action).toBe("SHORT");
    expect(long.action).toBe("LONG");
  });

  /** It wins the GATE, not the score — the label must never read as conviction. */
  it("is labelled as exploration, not conviction", () => {
    const d = decideDirection(cold({ shortLaneEdge: src(0.2), controllerBias: "SHORT" }));
    expect(d.supportingSignals.some((s) => s.includes("not conviction"))).toBe(true);
  });

  it("closes by itself once the horizon has any evidence at all", () => {
    expect(decideDirection(cold({ horizonResolvedN: 1, shortLaneEdge: src(0.2), controllerBias: "SHORT" })).action).toBe("FLAT");
  });
});

describe("the invariants it must not break", () => {
  /** A MATURE horizon with both edges momentarily missing still stands aside. */
  it("undefined resolved-count keeps FLAT as a real baseline", () => {
    const d = decideDirection(directionInput({ longEdge: src(null), shortEdge: src(null), longLaneEdge: src(null), shortLaneEdge: src(null), transitionRisk: 0.3 }));
    expect(d.action).toBe("FLAT");
  });

  /** THE 2026-07-25 REGRESSION: a no-evidence side must never outrank a measured-good one. A
   *  measured edge on either side makes this not a cold start at all. */
  it("does not fire when the opposite side has a measured edge", () => {
    const d = decideDirection(directionInput({ marketBias: "BULLISH", longEdge: src(null), shortEdge: src(0.12), shortLaneEdge: src(0.1), controllerBias: "SHORT", longLaneEdge: src(null), horizonResolvedN: 0 }));
    expect(d.action).toBe("SHORT");
  });

  it("a veto still bars the side outright", () => {
    expect(decideDirection(cold({ shortLaneEdge: src(0.2), controllerBias: "SHORT", shortVeto: true, longVeto: true })).action).toBe("FLAT");
  });

  it("BOTH still requires both sides PROVEN_ABOVE", () => {
    expect(decideDirection(cold({ longLaneEdge: src(0.3), shortLaneEdge: src(0.3) })).action).not.toBe("BOTH");
  });

  it("PROVEN_BELOW is still barred even on a cold horizon", () => {
    const d = decideDirection(cold({ shortEdge: src(-0.5), shortEdgeN: N, shortLaneEdge: src(0.3), controllerBias: "SHORT" }));
    expect(d.action).not.toBe("SHORT");
  });
});

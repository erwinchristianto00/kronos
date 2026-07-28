import { describe, it, expect } from "vitest";
import { decideDirection, DIRECTION_EDGE_MIN_SAMPLES } from "../src/lib/direction-brain.js";
import { checkDirectionInvariants } from "../src/lib/four-brain-invariants.js";
import { directionInput, src } from "./four-brain-fixtures.js";

/**
 * SHORT had produced ZERO decisions in the live store's entire life while LONG sat at n=305 /
 * -0.475R. Not a verdict — a closed loop: `edgeSub(null) === 0` means a side with no measured edge
 * scores 0, 0 never beats the FLAT baseline (0.35, or 0.6 when both edges are missing), so SHORT was
 * never chosen, so no SHORT outcome was ever recorded, so SHORT never acquired an edge.
 *
 * The LONG block's own note claimed this was "fixed at the ACTION GATE via edgeStanding()". It was
 * not: edgeStanding only stopped absence from DISQUALIFYING a side; the gate still compared
 * score > flatScore. These tests pin the repair AND the two things it must never break.
 */
const N = DIRECTION_EDGE_MIN_SAMPLES; // enough samples to make an edge PROVEN either way

/** LONG measured and proven bad, SHORT never measured — the live situation exactly. */
const deadlock = (o: Record<string, unknown> = {}) =>
  directionInput({
    longEdge: src(-0.475),
    longEdgeN: N,
    shortEdge: src(null),
    shortEdgeN: 0,
    longLaneEdge: src(null),
    shortLaneEdge: src(null),
    ...o,
  });

describe("SHORT deadlock — an unmeasured side must be reachable", () => {
  /** FAILS WITHOUT THE FIX (was FLAT). */
  it("SHORT is chosen when it is UNPROVEN and LONG is PROVEN_BELOW", () => {
    const d = decideDirection(deadlock());
    expect(d.action).toBe("SHORT");
    expect(d.supportingSignals.some((s) => s.includes("exploration pass"))).toBe(true);
    expect(checkDirectionInvariants(d).ok).toBe(true);
  });

  /** The exploration pass must not read as conviction: the side wins the GATE, not the score. */
  it("the exploring side still scores below FLAT — it is labelled, not inflated", () => {
    const d = decideDirection(deadlock());
    expect(d.shortScore).toBeLessThan(d.flatScore);
    expect(d.supportingSignals.some((s) => s.includes("not conviction"))).toBe(true);
  });

  it("works symmetrically for LONG when SHORT is the proven-bad side", () => {
    const d = decideDirection(
      directionInput({ shortEdge: src(-0.5), shortEdgeN: N, longEdge: src(null), longEdgeN: 0, longLaneEdge: src(null), shortLaneEdge: src(null) }),
    );
    expect(d.action).toBe("LONG");
  });
});

describe("the guards that keep it narrow", () => {
  /** THE 2026-07-25 REGRESSION. A no-evidence side must never outrank a measured-good one. */
  it("does NOT explore while the opposite side is PROVEN_ABOVE", () => {
    const d = decideDirection(
      directionInput({ longEdge: src(0.12), longEdgeN: N, shortEdge: src(null), shortEdgeN: 0, shortLaneEdge: src(null) }),
    );
    expect(d.action).toBe("LONG");
  });

  /** No information either side ⇒ standing aside is still the right answer. */
  it("does NOT explore when BOTH sides are unmeasured", () => {
    const d = decideDirection(
      directionInput({ longEdge: src(null), shortEdge: src(null), longLaneEdge: src(null), shortLaneEdge: src(null), transitionRisk: 0.3 }),
    );
    expect(d.action).toBe("FLAT");
  });

  it.each([["shortVeto"], ["fourBrainShortVeto"]])("does NOT explore against %s", (veto) => {
    expect(decideDirection(deadlock({ [veto]: true })).action).toBe("FLAT");
  });

  it("PROVEN_BELOW still bars a side outright — exploration never rescues it", () => {
    const d = decideDirection(
      directionInput({ longEdge: src(-0.4), longEdgeN: N, shortEdge: src(-0.4), shortEdgeN: N, longLaneEdge: src(null), shortLaneEdge: src(null) }),
    );
    expect(d.action).toBe("FLAT");
  });

  /** Exploration must never open two simultaneous positions. */
  it("BOTH still requires both sides PROVEN_ABOVE", () => {
    expect(decideDirection(deadlock()).action).not.toBe("BOTH");
  });
});

describe("a side that cleared can no longer be vetoed by one that did not", () => {
  /** The gate used to read `shortClears && shortScore > longScore`, so a barred LONG could out-score
   *  a cleared SHORT and the action fell through to FLAT — wrong on its own terms, and it silently
   *  cancelled the exploration pass, whose side scores 0 by construction. */
  it("a cleared side wins even when a barred side scores higher", () => {
    const d = decideDirection(deadlock({ controllerBias: "LONG", conviction: 0.9 }));
    expect(d.longScore).toBeGreaterThan(d.shortScore); // barred LONG still scores higher
    expect(d.action).toBe("SHORT"); // ...and loses anyway, because it did not clear
  });
});

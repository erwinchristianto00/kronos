import { describe, it, expect } from "vitest";
import { decideDirection, DIRECTION_EDGE_MIN_SAMPLES } from "../src/lib/direction-brain.js";
import { EDGE_MIN_SAMPLES } from "../src/lib/regime-edge-memory.js";
import { checkDirectionInvariants } from "../src/lib/four-brain-invariants.js";
import { directionInput, src } from "./four-brain-fixtures.js";

describe("Direction Brain", () => {
  it("FLAT defeats weak long AND weak short scores (FLAT is a real baseline)", () => {
    const d = decideDirection(directionInput({ longEdge: src(null), shortEdge: src(null), longLaneEdge: src(null), shortLaneEdge: src(null), transitionRisk: 0.3 }));
    expect(d.action).toBe("FLAT");
    expect(d.flatScore).toBeGreaterThan(d.longScore);
    expect(d.flatScore).toBeGreaterThan(d.shortScore);
    expect(checkDirectionInvariants(d).ok).toBe(true);
  });

  it("a BULLISH market state does NOT block SHORT when short edge is strong", () => {
    const d = decideDirection(
      directionInput({ marketBias: "BULLISH", longEdge: src(null), shortEdge: src(0.12), shortLaneEdge: src(0.1), controllerBias: "SHORT", longLaneEdge: src(null) }),
    );
    expect(d.action).toBe("SHORT");
    expect(d.shortScore).toBeGreaterThan(d.longScore);
    expect(d.supportingSignals.some((s) => s.includes("BULLISH"))).toBe(true);
  });

  it("a BEARISH market state does NOT block LONG when long edge is strong", () => {
    const d = decideDirection(directionInput({ marketBias: "BEARISH", longEdge: src(0.12), shortEdge: src(null), shortLaneEdge: src(null) }));
    expect(d.action).toBe("LONG");
    expect(d.longScore).toBeGreaterThan(d.shortScore);
  });

  it("edge-memory VETO is a strong penalty (not a hard zero) and lifts FLAT", () => {
    const clean = decideDirection(directionInput({ longEdge: src(0.12) }));
    const vetoed = decideDirection(directionInput({ longEdge: src(0.12), longVeto: true }));
    expect(vetoed.longScore).toBeLessThan(clean.longScore);
    expect(vetoed.conflictingSignals.some((s) => s.includes("VETO"))).toBe(true);
    expect(vetoed.flatScore).toBeGreaterThan(clean.flatScore - 0.001);
  });

  it("conflicting signals reduce confidence", () => {
    const clean = decideDirection(directionInput({ longEdge: src(0.12) }));
    const conflicted = decideDirection(directionInput({ longEdge: src(0.12), longVeto: true }));
    expect(conflicted.confidence).toBeLessThan(clean.confidence);
  });

  it("four-brain's OWN self-outcome VETO (fourBrainLongVeto) is a SECOND, independent soft penalty — never a hard zero — stacked next to the incumbent edge-memory longVeto", () => {
    const clean = decideDirection(directionInput({ longEdge: src(0.12) }));
    const fourBrainOnly = decideDirection(directionInput({ longEdge: src(0.12), fourBrainLongVeto: true }));
    const incumbentOnly = decideDirection(directionInput({ longEdge: src(0.12), longVeto: true }));
    const both = decideDirection(directionInput({ longEdge: src(0.12), longVeto: true, fourBrainLongVeto: true }));

    // Soft, not a gate: penalized but never driven to exactly 0.
    expect(fourBrainOnly.longScore).toBeLessThan(clean.longScore);
    expect(fourBrainOnly.longScore).toBeGreaterThan(0);
    expect(fourBrainOnly.conflictingSignals.some((s) => s.includes("Four-Brain self-outcome VETO"))).toBe(true);

    // The two penalties are independent and compose: stacking both reduces the score further than either alone.
    expect(both.longScore).toBeLessThan(fourBrainOnly.longScore);
    expect(both.longScore).toBeLessThan(incumbentOnly.longScore);
    expect(both.longScore).toBeGreaterThan(0);
  });

  it("four-brain's OWN self-outcome VETO (fourBrainShortVeto) mirrors the LONG side for SHORT", () => {
    const clean = decideDirection(
      directionInput({ marketBias: "BULLISH", longEdge: src(null), shortEdge: src(0.12), shortLaneEdge: src(0.1), controllerBias: "SHORT", longLaneEdge: src(null) }),
    );
    const vetoed = decideDirection(
      directionInput({ marketBias: "BULLISH", longEdge: src(null), shortEdge: src(0.12), shortLaneEdge: src(0.1), controllerBias: "SHORT", longLaneEdge: src(null), fourBrainShortVeto: true }),
    );
    expect(vetoed.shortScore).toBeLessThan(clean.shortScore);
    expect(vetoed.shortScore).toBeGreaterThan(0);
    expect(vetoed.conflictingSignals.some((s) => s.includes("SHORT proven-negative (Four-Brain self-outcome VETO)"))).toBe(true);
  });

  it("fourBrainLongVeto/fourBrainShortVeto default to no penalty when omitted (backward-compatible, never fabricated)", () => {
    const withoutFlags = decideDirection(directionInput({ longEdge: src(0.12) }));
    const explicitFalse = decideDirection(directionInput({ longEdge: src(0.12), fourBrainLongVeto: false, fourBrainShortVeto: false }));
    expect(withoutFlags.longScore).toBeCloseTo(explicitFalse.longScore, 9);
  });

  it("an unknown/neutral market state still yields a valid decision", () => {
    const d = decideDirection(directionInput({ marketBias: "MIXED", longEdge: src(0.1) }));
    expect(["LONG", "SHORT", "BOTH", "FLAT"]).toContain(d.action);
    expect(checkDirectionInvariants(d).ok).toBe(true);
  });

  it("expectedDirectionalR reflects the chosen side's proven R (null for FLAT)", () => {
    const longD = decideDirection(directionInput({ longEdge: src(0.09), shortEdge: src(null) }));
    expect(longD.action).toBe("LONG");
    expect(longD.expectedDirectionalR).toBeCloseTo(0.09, 6);
    const flatD = decideDirection(directionInput({ longEdge: src(null), shortEdge: src(null) }));
    expect(flatD.expectedDirectionalR).toBeNull();
  });

  it("is a pure estimator — the returned object has no side-effecting fields (report-only)", () => {
    const d = decideDirection(directionInput());
    expect(typeof d.action).toBe("string");
    expect(d).not.toHaveProperty("order");
    expect(d).not.toHaveProperty("allocation");
  });
});

describe("edge standing: absence of evidence is not evidence of absence (2026-07-25)", () => {
  // Reproduces the real testnet state that made SHORT structurally unreachable: the edge-memory store
  // held exactly two slices — BULLISH×LONG (n=15, +0.051) and BEARISH×SHORT (n=4, −0.274) — so SHORT was
  // null in bullish regimes and negative in bearish ones. Measured result: SHORT n=0 across 1865
  // evaluated decisions while LONG went 126.
  it("keeps DIRECTION_EDGE_MIN_SAMPLES in lockstep with regime-edge-memory's EDGE_MIN_SAMPLES", () => {
    // Declared locally in direction-brain.ts (pure core must not import a file-backed store), so this
    // equality is what stops the two from silently drifting apart.
    expect(DIRECTION_EDGE_MIN_SAMPLES).toBe(EDGE_MIN_SAMPLES);
    expect(DIRECTION_EDGE_MIN_SAMPLES).toBe(30);
  });

  it("does NOT bar a side whose edge is simply unmeasured (n=0 → UNPROVEN, not PROVEN_BELOW)", () => {
    const d = decideDirection(
      directionInput({
        // strong non-edge evidence for SHORT, zero edge-memory data on either side
        longEdge: src(null),
        shortEdge: src(null),
        longEdgeN: 0,
        shortEdgeN: 0,
        kronosAgree: src(-1), // fully short-agreeing
        crowdingAlignLong: src(-1), // crowding favors short
        controllerBias: "SHORT",
        conviction: src(1),
      }),
    );
    // FAILS WITHOUT FIX: the old gate required `shortEdge !== null && shortEdge > hurdle`, so an
    // unmeasured side could never clear no matter how strong every other signal was.
    expect(d.action).toBe("SHORT");
    // 2026-07-26: wording sharpened — with shortEdge null this is the UNMEASURED case (no slice at
    // all), now stated distinctly from a slice that exists but is too thin to prove anything. Same
    // semantic as the old "SHORT unproven", just no longer conflating the two.
    expect(d.supportingSignals.join(" ")).toContain("SHORT edge UNMEASURED");
  });

  it("STILL bars a side proven below the hurdle on a sufficient sample", () => {
    const d = decideDirection(
      directionInput({
        longEdge: src(null),
        shortEdge: src(-0.274), // the real BEARISH×SHORT value...
        longEdgeN: 0,
        shortEdgeN: 40, // ...but now with enough samples to actually prove it
        kronosAgree: src(-1),
        crowdingAlignLong: src(-1),
        controllerBias: "SHORT",
        conviction: src(1),
      }),
    );
    expect(d.action).not.toBe("SHORT");
    expect(d.conflictingSignals.join(" ")).toContain("SHORT proven at/below hurdle");
  });

  it("treats a thin-sample negative edge as UNPROVEN, not as proof (n=4 must not disqualify)", () => {
    const d = decideDirection(
      directionInput({
        longEdge: src(null),
        shortEdge: src(-0.274),
        longEdgeN: 0,
        shortEdgeN: 4, // the REAL testnet sample size — far below the proof bar
        kronosAgree: src(-1),
        crowdingAlignLong: src(-1),
        controllerBias: "SHORT",
        conviction: src(1),
      }),
    );
    // 4 samples prove nothing either way; the side stays eligible and wins on the other evidence.
    expect(d.action).toBe("SHORT");
    expect(d.conflictingSignals.join(" ")).not.toContain("SHORT proven at/below hurdle");
  });

  // ── 2026-07-26 observability fixes ──────────────────────────────────────────────────────────────
  // Two suppressors were fully active yet completely absent from the decision payload, so an operator
  // reading the API could not tell why a side lost. Neither fix changes any score or any action.

  it("FAIL-WITHOUT: the leansShort=false 30% haircut is REPORTED, not applied silently", () => {
    const leaning = decideDirection(directionInput({ shortEdge: src(0.2), leansShort: true }));
    const discounted = decideDirection(directionInput({ shortEdge: src(0.2), leansShort: false }));
    // The discount itself is unchanged — exactly ×0.7, still soft, still not a zero.
    expect(discounted.shortScore).toBeCloseTo(leaning.shortScore * 0.7, 10);
    // ...and it now says so. Pre-fix this array was empty and the haircut was invisible.
    expect(discounted.conflictingSignals.some((s) => s.includes("SHORT discounted 30%"))).toBe(true);
    expect(leaning.conflictingSignals.some((s) => s.includes("SHORT discounted 30%"))).toBe(false);
  });

  it("FAIL-WITHOUT: the leansLong=false haircut is reported too (the LONG twin was equally silent)", () => {
    const leaning = decideDirection(directionInput({ longEdge: src(0.2), leansLong: true }));
    const discounted = decideDirection(directionInput({ longEdge: src(0.2), leansLong: false }));
    expect(discounted.longScore).toBeCloseTo(leaning.longScore * 0.7, 10);
    expect(discounted.conflictingSignals.some((s) => s.includes("LONG discounted 30%"))).toBe(true);
    expect(leaning.conflictingSignals.some((s) => s.includes("LONG discounted 30%"))).toBe(false);
  });

  it("FAIL-WITHOUT: a thin-sample edge is reported even when its side does NOT clear", () => {
    // The exact research/3101 shape: BULLISH_EXPANSION::LONG = -1.0553R over n=2. Catastrophically
    // negative, but n < 30 makes it UNPROVEN — and UNPROVEN used to be announced only when the side
    // CLEARED, so this decision reported nothing at all about it (conflictingSignals was []).
    const d = decideDirection(
      directionInput({
        longEdge: src(-1.0553),
        longEdgeN: 2,
        shortEdge: src(null),
        shortEdgeN: 0,
        longLaneEdge: src(null),
        shortLaneEdge: src(null),
        kronosAgree: src(null),
        crowdingAlignLong: src(null),
      }),
    );
    expect(d.action).toBe("FLAT"); // it does not clear — which is exactly when it used to go quiet
    const notes = d.supportingSignals.join(" ");
    expect(notes).toContain("LONG edge UNPROVEN");
    expect(notes).toContain("-1.055R");
    expect(notes).toContain(`n=2 < ${DIRECTION_EDGE_MIN_SAMPLES}`);
  });

  it("distinguishes 'no slice at all' from 'slice too thin to prove anything'", () => {
    const d = decideDirection(
      directionInput({ longEdge: src(0.08), longEdgeN: 3, shortEdge: src(null), shortEdgeN: 0 }),
    );
    const notes = d.supportingSignals.join(" ");
    expect(notes).toContain("SHORT edge UNMEASURED (no edge-memory slice for this regime)");
    expect(notes).toContain("LONG edge UNPROVEN"); // has a value, just not enough of it
    expect(notes).not.toContain("LONG edge UNMEASURED");
  });

  it("reporting is additive only — action, scores AND confidence match the pre-fix values exactly", () => {
    // Guards against an observability change quietly becoming a behaviour change. These constants were
    // taken by running HEAD's pre-fix decideDirection side-by-side with this one over the same inputs
    // (git show of the file into a temp module), not by copying whatever the new code happened to emit.
    //
    // confidence is the subtle one: it is damped by `conflicting.length > 0`, so routing the two new
    // regime-posture notes through conflictingSignals directly would have moved it. They go through
    // reportOnlyConflicts instead and are merged only at the return — hence confidence is unchanged.
    const d = decideDirection(directionInput({ longEdge: src(0.12), shortEdge: src(null) }));
    expect(d.action).toBe("LONG");
    expect(d.longScore).toBe(0.6300000000000001);
    expect(d.shortScore).toBe(0.25);
    expect(d.flatScore).toBe(0.35);
    expect(d.confidence).toBe(0.4971428571428572);
  });

  it("the posture haircut is visible in the payload yet does NOT damp confidence", () => {
    const leaning = decideDirection(directionInput({ shortEdge: src(0.2), leansShort: true }));
    const discounted = decideDirection(directionInput({ shortEdge: src(0.2), leansShort: false }));
    expect(discounted.conflictingSignals.some((s) => s.includes("SHORT discounted 30%"))).toBe(true);
    // Pre-fix baseline for the leansShort=false case, measured against HEAD: identical confidence.
    // (It does NOT equal the leansShort=true confidence, and must not — confidence also tracks score
    // separation, which the haircut genuinely moves. That is the pre-existing behaviour, untouched.)
    expect(discounted.confidence).toBe(0.5127380952380952);
    expect(leaning.confidence).toBe(0.4319047619047619);
  });

});

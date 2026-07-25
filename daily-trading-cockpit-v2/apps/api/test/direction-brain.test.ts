import { describe, it, expect } from "vitest";
import { decideDirection } from "../src/lib/direction-brain.js";
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

import { describe, it, expect } from "vitest";
import { decideExit } from "../src/lib/exit-brain.js";
import { checkExitInvariants } from "../src/lib/four-brain-invariants.js";
import { exitInput } from "./four-brain-fixtures.js";

describe("Exit Brain", () => {
  it("the hard stop OUTRANKS a would-be HOLD (breached hard stop → EXIT_NOW)", () => {
    // A clean position that would HOLD, but price has already breached the hard stop.
    const d = decideExit(exitInput({ currentPrice: 96.5, hardStopPrice: 97 })); // long, price below stop
    expect(d.action).toBe("EXIT_NOW");
    expect(d.exitFraction).toBe(1);
    // invariant: hard-exit-triggered must not HOLD
    expect(checkExitInvariants(d, { side: "LONG", hardStopPrice: 97, hardExitTriggered: true }).ok).toBe(true);
  });

  it("the kill switch OUTRANKS everything (killLatched → EXIT_NOW)", () => {
    const d = decideExit(exitInput({ killLatched: true, momentumDecay: false, thesisIntact: true }));
    expect(d.action).toBe("EXIT_NOW");
  });

  it("Exit Brain NEVER widens the hard stop (suggestedStop stays protective)", () => {
    const d = decideExit(exitInput({ unrealizedR: 0.6, momentumDecay: true, divergence: true })); // → MOVE_TO_BREAKEVEN/TIGHTEN
    if (d.suggestedStop != null) {
      expect(d.suggestedStop).toBeGreaterThanOrEqual(97); // never below the incumbent hard stop for a LONG
    }
    expect(checkExitInvariants(d, { side: "LONG", hardStopPrice: 97 }).ok).toBe(true);
  });

  it("high giveback risk can produce SCALE_OUT or TRAIL", () => {
    const d = decideExit(exitInput({ mfeR: 2.0, unrealizedR: 0.6, structureBreak: true, divergence: true }));
    expect(["SCALE_OUT", "TRAIL", "TIGHTEN_STOP"]).toContain(d.action);
    expect(d.reasons.some((r) => r.toLowerCase().includes("giveback"))).toBe(true);
  });

  it("strong remaining edge + intact thesis → HOLD", () => {
    const d = decideExit(exitInput({ unrealizedR: 0.3, mfeR: 0.4, thesisIntact: true, momentumDecay: false, divergence: false, structureBreak: false, orderFlowReversal: false }));
    expect(d.action).toBe("HOLD");
    expect(d.continuationProbability).toBeGreaterThan(0.6);
  });

  it("missing MFE/MAE never produces NaN", () => {
    const d = decideExit(exitInput({ mfeR: null, maeR: null, unrealizedR: null }));
    expect(d.edgeRemainingR === null || Number.isFinite(d.edgeRemainingR)).toBe(true);
    expect(Number.isFinite(d.reversalRisk)).toBe(true);
    expect(Number.isFinite(d.continuationProbability)).toBe(true);
    expect(Number.isFinite(d.exitFraction)).toBe(true);
    expect(checkExitInvariants(d).ok).toBe(true);
  });

  it("exitFraction is always within 0..1", () => {
    for (const o of [{}, { killLatched: true }, { mfeR: 3, unrealizedR: 0.5, divergence: true, structureBreak: true }, { unrealizedR: 5 }]) {
      const d = decideExit(exitInput(o));
      expect(d.exitFraction).toBeGreaterThanOrEqual(0);
      expect(d.exitFraction).toBeLessThanOrEqual(1);
    }
  });

  it("distinguishes premature-exit vs giveback vs remaining edge in its reasons", () => {
    const hold = decideExit(exitInput({ unrealizedR: 0.3, thesisIntact: true }));
    expect(hold.reasons.some((r) => r.includes("premature-exit") || r.includes("remaining edge"))).toBe(true);
  });

  it("review regression: a NaN currentPrice never leaks NaN into suggestedStop/suggestedTrailDistance", () => {
    // NaN mark price (fetch gap) with a TIGHTEN_STOP-selecting position; suggestedStop must be finite-or-null.
    const d = decideExit(exitInput({ currentPrice: Number.NaN, unrealizedR: 1.5, hardStopPrice: 90, momentumDecay: true, divergence: true }));
    expect(d.suggestedStop === null || Number.isFinite(d.suggestedStop)).toBe(true);
    expect(d.suggestedTrailDistance === null || Number.isFinite(d.suggestedTrailDistance)).toBe(true);
    const t = decideExit(exitInput({ currentPrice: Number.NaN, mfeR: 2, unrealizedR: 0.6, divergence: true })); // → TRAIL branch
    expect(t.suggestedTrailDistance === null || Number.isFinite(t.suggestedTrailDistance)).toBe(true);
  });
});

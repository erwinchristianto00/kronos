import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { judgeFourBrainReadiness, rollUpFourBrainReadiness } from "../src/lib/four-brain-readiness.js";

/**
 * Exit was the one brain left without a readiness verdict — four-brain-readiness.ts has supported it
 * since it was written and only Direction and Entry were wired, so the panel showed Exit's numbers
 * with nothing to judge them by.
 *
 * Its headline is exactly what such a verdict exists to interrogate. Measured on testnet 2026-07-28:
 *   MEASURED   n=554    meanDeltaR +0.0114  coverage 12.2%  (507 of 554 rows are TIES)
 *   SIMULATED  n=5960   meanDeltaR -0.0086  coverage 92%
 * The two tiers disagree in SIGN, and the flattering one is the thin slice.
 */
const SHADOW_SRC = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/routes/shadow.ts"), "utf-8");

describe("Exit Brain readiness on the live shape", () => {
  const measured = judgeFourBrainReadiness("EXIT", {
    scope: "MEASURED (real recorded paths)", effectiveN: 554, meanNetR: 0.0114, measuredBasis: "REAL",
  });
  const simulated = judgeFourBrainReadiness("EXIT", {
    scope: "SIMULATED (candle-walk)", effectiveN: 5960, meanNetR: -0.0086, measuredBasis: "SIMULATED",
  });

  /** +0.0114R does not clear the 0.03R hurdle — a policy that beats the actual exit by a third of the
   *  edge bar is not a policy you can act on. */
  it("the MEASURED tier is NOT_READY — it clears EVIDENCE but not EDGE", () => {
    expect(measured.verdict).toBe("NOT_READY");
    expect(measured.gates.find((g) => g.gate === "EVIDENCE")!.passed).toBe(true);
    expect(measured.gates.find((g) => g.gate === "EDGE")!.passed).toBe(false);
  });

  /** 10x the sample and 92% coverage, and it still cannot qualify the brain. */
  it("the SIMULATED tier can never qualify it, whatever its sample size", () => {
    expect(simulated.verdict).toBe("NOT_READY_SIMULATED_ONLY");
  });

  it("Exit is judged on EDGE and EVIDENCE only — regret and calibration do not apply", () => {
    expect(measured.gates.find((g) => g.gate === "SELECTION")!.passed).toBeNull();
    expect(measured.gates.find((g) => g.gate === "CALIBRATION")!.passed).toBeNull();
    expect(measured.gates.find((g) => g.gate === "EDGE")!.detail).toContain("policy vs actual");
  });

  /** The roll-up must not let a simulated tier launder a proven-bad measured one. */
  it("rolls up NOT_READY, not simulated-only", () => {
    expect(rollUpFourBrainReadiness([measured, simulated]).verdict).toBe("NOT_READY");
  });
});

describe("the exit-brain route actually computes it (source-level guard)", () => {
  /** FAILS WITHOUT THE FIX — the route returned the report with no verdict at all. */
  it("judges both tiers separately and never blends them", () => {
    const at = SHADOW_SRC.indexOf('app.get("/api/shadow/exit-brain"');
    expect(at).toBeGreaterThanOrEqual(0);
    const body = SHADOW_SRC.slice(at, at + 2200);
    expect(body).toContain("judgeFourBrainReadiness");
    expect(body).toContain('"measured"');
    expect(body).toContain('"simulated"');
    // EXACT pairing, not a loose proximity match: the first version of this guard used a
    // fuzzy regex that happily matched the SCOPE string "SIMULATED (candle-walk)" further down,
    // so flipping the simulated tier's basis to REAL — which would let a candle-walk qualify the
    // brain — passed cleanly. Assert the literal tuple.
    expect(body).toContain('{ key: "simulated", basis: "SIMULATED" }');
    expect(body).toContain('{ key: "measured", basis: "REAL" }');
    expect(body).not.toContain('{ key: "simulated", basis: "REAL" }');
  });

  it("cannot break the report if the verdict throws", () => {
    const at = SHADOW_SRC.indexOf('app.get("/api/shadow/exit-brain"');
    expect(SHADOW_SRC.slice(at, at + 2200)).toContain("catch");
  });
});

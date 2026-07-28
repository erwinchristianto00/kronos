import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { judgeFourBrainReadiness, rollUpFourBrainReadiness, exitBrainReadinessFromReport } from "../src/lib/four-brain-readiness.js";

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

describe("the route delegates to the pure derivation (source-level guard)", () => {
  it("calls exitBrainReadinessFromReport rather than re-deriving tiers inline", () => {
    const at = SHADOW_SRC.indexOf('app.get("/api/shadow/exit-brain"');
    expect(at).toBeGreaterThanOrEqual(0);
    const body = SHADOW_SRC.slice(at, at + 2200);
    expect(body).toContain("exitBrainReadinessFromReport");
    expect(body).toContain("readiness");
  });

  it("cannot break the report if the verdict throws", () => {
    const at = SHADOW_SRC.indexOf('app.get("/api/shadow/exit-brain"');
    expect(SHADOW_SRC.slice(at, at + 2200)).toContain("catch");
  });
});

/**
 * Live/3103 runs a build a week behind research and testnet: no measured/simulated split, one flat
 * `performance` block. Shipping the verdict there means the derivation must handle both shapes, and
 * the dangerous direction is obvious — a fallback loose enough to label candle-walk rows REAL would
 * let a simulation qualify the brain, which is the one thing the verdict exists to stop.
 *
 * Live's real numbers when this was written: n=12, meanDeltaR -0.0337, 11 of 12 rows ties.
 */
describe("both report shapes, because live is a week behind", () => {
  const TIERED = {
    measured: { n: 559, meanDeltaR: 0.0114 },
    simulated: { n: 6015, meanDeltaR: -0.0096 },
  };
  const UNTIERED = { performance: { n: 12, meanDeltaR: -0.0337 } };

  it("judges the two tiers separately on a current build", () => {
    const r = exitBrainReadinessFromReport(TIERED)!;
    expect(r.perScope).toHaveLength(2);
    expect(r.perScope.find((p) => p.scope.startsWith("MEASURED"))!.measuredBasis).toBe("REAL");
    expect(r.perScope.find((p) => p.scope.startsWith("SIMULATED"))!.measuredBasis).toBe("SIMULATED");
    expect(r.verdict).toBe("NOT_READY");
  });

  /** FAILS WITHOUT THE FALLBACK — live returned no verdict at all. */
  it("still returns a verdict on live's pre-tier shape", () => {
    const r = exitBrainReadinessFromReport(UNTIERED)!;
    expect(r).not.toBeNull();
    expect(r.perScope).toHaveLength(1);
    expect(r.verdict).toBe("INSUFFICIENT_EVIDENCE"); // n=12 is under the 20-sample floor
  });

  /** The fallback must say so, so nobody reads it as the same evidence as a current build. */
  it("labels the fallback scope as an untiered build", () => {
    expect(exitBrainReadinessFromReport(UNTIERED)!.perScope[0]!.scope).toContain("untiered");
  });

  /** THE GUARD. If either tier key is present we can classify the rows, so the flat `performance`
   *  block must NOT be swept in alongside them as REAL — on a current build it is the same rows
   *  counted twice, and the copy would carry no tier. Mutation checked: dropping the condition so the
   *  fallback always fires turns both of these red. */
  it("never falls back when a simulated tier is present", () => {
    const r = exitBrainReadinessFromReport({ simulated: { n: 6015, meanDeltaR: -0.0096 }, performance: { n: 6015, meanDeltaR: -0.0096 } })!;
    expect(r.perScope).toHaveLength(1);
    expect(r.perScope[0]!.measuredBasis).toBe("SIMULATED");
    expect(r.perScope.some((p) => p.scope.includes("untiered"))).toBe(false);
    expect(r.verdict).toBe("NOT_READY_SIMULATED_ONLY");
  });

  it("never falls back when a measured tier is present", () => {
    const r = exitBrainReadinessFromReport({ measured: { n: 559, meanDeltaR: 0.0114 }, performance: { n: 9999, meanDeltaR: 0.9 } })!;
    expect(r.perScope).toHaveLength(1);
    // the measured tier's 559, NOT the flat block's 9999 — the fallback did not fire
    expect(r.perScope[0]!.gates.find((g) => g.gate === "EVIDENCE")!.value).toBe(559);
    expect(r.perScope[0]!.measuredBasis).toBe("REAL");
  });

  it("returns null rather than a fake verdict when there is nothing to judge", () => {
    expect(exitBrainReadinessFromReport(null)).toBeNull();
    expect(exitBrainReadinessFromReport({})).toBeNull();
    expect(exitBrainReadinessFromReport({ performance: { n: "12" } })).toBeNull();
  });
});

/**
 * Stylized-facts gate (Market Digital Twin, Phase-1 foundation). A simulated/bootstrapped scenario must reproduce
 * crypto-market stylized facts BEFORE it is eligible for research experience; a FAILED scenario stays usable for
 * ADVERSARIAL testing only. Each check returns PASS / FAIL / INSUFFICIENT_DATA with the observed vs simulated value
 * and tolerance. Tolerances here are STRUCTURAL, direction-of-effect checks (e.g. "vol clustering must be positive")
 * — NOT thresholds fitted against any realism holdout. Pure + deterministic.
 */
import { autocorr, hillTailIndex, maxDrawdownDepth, std, mean } from "./calibration-metrics.js";

export interface StylizedCheck {
  status: "PASS" | "FAIL" | "INSUFFICIENT_DATA";
  observedValue: number | null;
  simulatedValue: number | null;
  tolerance: number | null;
}
export interface StylizedFactsGate {
  pass: boolean;
  checks: Record<string, StylizedCheck>;
  eligibility: "RESEARCH_ELIGIBLE" | "ADVERSARIAL_ONLY";
}

export interface StylizedInput {
  realReturns: number[];
  simReturns: number[];
}

const MIN_N = 100;

/** A check that the simulated series has a stylized property WITHIN tolerance of the real series' property. */
function within(realV: number | null, simV: number | null, tol: number): StylizedCheck {
  if (realV == null || simV == null) return { status: "INSUFFICIENT_DATA", observedValue: realV, simulatedValue: simV, tolerance: tol };
  return { status: Math.abs(realV - simV) <= tol ? "PASS" : "FAIL", observedValue: realV, simulatedValue: simV, tolerance: tol };
}
/** A check that the simulated value satisfies a sign/threshold property the market exhibits. */
function property(realV: number | null, simV: number | null, ok: (sim: number) => boolean): StylizedCheck {
  if (simV == null) return { status: "INSUFFICIENT_DATA", observedValue: realV, simulatedValue: simV, tolerance: null };
  return { status: ok(simV) ? "PASS" : "FAIL", observedValue: realV, simulatedValue: simV, tolerance: null };
}

export function evaluateStylizedFacts(input: StylizedInput): StylizedFactsGate {
  const { realReturns: r, simReturns: s } = input;
  const insufficient = Math.min(r.length, s.length) < MIN_N;
  const absR = r.map(Math.abs); const absS = s.map(Math.abs);

  const checks: Record<string, StylizedCheck> = {
    // fat tails: sim tail index should be finite and not far lighter than real (heavier=smaller alpha is fine)
    fatTails: within(hillTailIndex(r), hillTailIndex(s), 2.5),
    // volatility clustering: |return| autocorr(1) should be POSITIVE in the sim (a core crypto fact)
    volatilityClustering: property(autocorr(absR, 1), autocorr(absS, 1), (v) => v > 0),
    // low raw-return autocorrelation: |acf1| small
    lowRawAutocorrelation: property(autocorr(r, 1), autocorr(s, 1), (v) => Math.abs(v) < 0.2),
    // positive absolute-return autocorrelation (persistence)
    absoluteReturnPersistence: property(autocorr(absR, 5), autocorr(absS, 5), (v) => v > 0),
    // realistic drawdown depth: within tolerance of real
    drawdownDepth: within(maxDrawdownDepth(r), maxDrawdownDepth(s), 0.35),
    // volatility level within a band of real
    volatilityLevel: within(std(r), std(s), (std(r) ?? 0) * 1.5 + 1e-6),
    // returns roughly zero-mean (no injected drift artifact)
    zeroMeanReturns: property(mean(r), mean(s), (v) => Math.abs(v) < (std(s) ?? 1) * 0.5),
  };

  if (insufficient) for (const k of Object.keys(checks)) checks[k] = { ...checks[k]!, status: "INSUFFICIENT_DATA" };

  const decided = Object.values(checks).filter((c) => c.status !== "INSUFFICIENT_DATA");
  const pass = !insufficient && decided.length > 0 && decided.every((c) => c.status === "PASS");
  return { pass, checks, eligibility: pass ? "RESEARCH_ELIGIBLE" : "ADVERSARIAL_ONLY" };
}

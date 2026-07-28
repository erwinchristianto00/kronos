/**
 * FOUR-BRAIN READINESS (2026-07-28, PURE — no I/O, no imports of any store).
 *
 * WHY THIS EXISTS. CORTEX has had cortex-readiness.ts since it was built: a percentage, a written
 * definition of "ready", and a per-component breakdown. The four brains have had NOTHING. An
 * operator looking at "LONG n=305 · WR 21% · meanR -0.475R · regret +0.564R · calib-gap +0.526R"
 * had four raw columns and no verdict — no way to answer the only question that matters, which is
 * "is this thing good enough to act on yet?". Every number needed to answer it was already being
 * computed and displayed. Only the judgement was missing.
 *
 * FOUR GATES, and a brain is READY only when every applicable one passes.
 *
 *  1. EVIDENCE      — enough INDEPENDENT samples. Direction uses effectiveN (distinct horizon
 *                     blocks), never row count: 305 rows over 38 windows is 38 observations, and
 *                     this system has been burned repeatedly by reading the larger number.
 *  2. EDGE          — the brain beats the alternative it exists to beat. Direction/Entry: mean net
 *                     R above the hurdle. Exit: its policy beats the exit that actually happened.
 *  3. SELECTION     — it picks the BEST available option, not merely a profitable one. Measured by
 *                     regret: a brain can be net-positive in a trending market while consistently
 *                     choosing the worse side. Direction only — Entry passes regretR: null by
 *                     design, and Exit's deltaR already IS a regret measure.
 *  4. CALIBRATION   — it predicts what it delivers. A large positive calibration gap means
 *                     systematic overconfidence, which is a different defect from being wrong and
 *                     has to be reported separately: a brain that is wrong but knows it is usable
 *                     as a veto, one that is wrong and confident is not usable at all.
 *
 * THE RULE THAT OUTRANKS THE OTHERS: a brain measured only on SIMULATED outcomes can never be
 * READY, whatever its numbers say. Entry Brain currently shows ENTER_NOW at +0.766R on n=36 — all
 * Tier 2, a forward candle walk of trades that were never placed, against Tier 1 (real fills)
 * standing at exactly 0. Promoting on that would be promoting a backtest. `measuredBasis` is
 * therefore a first-class input and NOT_READY_SIMULATED_ONLY is its own verdict.
 */

export const FOUR_BRAIN_READY_MIN_EFFECTIVE_N = 20;

/** Thresholds are expressed in R against the same hurdle the Direction Brain scores on, so they
 *  scale with what the system considers an edge at all. A brain whose regret exceeds the hurdle is
 *  leaving more on the table than the edge it is trying to capture; a brain whose calibration gap
 *  exceeds it is mis-stating its own expectation by more than one whole edge. */
export const FOUR_BRAIN_READY_MAX_REGRET_R = 0.03;
export const FOUR_BRAIN_READY_MAX_CALIBRATION_GAP_R = 0.03;

export type FourBrainReadinessVerdict =
  | "READY"
  | "NOT_READY"
  | "INSUFFICIENT_EVIDENCE"
  | "NOT_READY_SIMULATED_ONLY";

export type FourBrainGateName = "EVIDENCE" | "EDGE" | "SELECTION" | "CALIBRATION";

export interface FourBrainGate {
  gate: FourBrainGateName;
  /** null when the gate does not apply to this brain (e.g. SELECTION for Entry). */
  passed: boolean | null;
  /** The measured value the gate was judged on; null when unmeasured. */
  value: number | null;
  /** Plain-language statement of what was required and what was seen. */
  detail: string;
}

export interface FourBrainReadiness {
  brain: "DIRECTION" | "ENTRY" | "EXIT";
  scope: string;
  verdict: FourBrainReadinessVerdict;
  /** One sentence an operator can act on without reading the gates. */
  summary: string;
  gates: FourBrainGate[];
  measuredBasis: "REAL" | "SIMULATED" | "NONE";
}

export interface FourBrainReadinessInput {
  scope: string;
  /** Independent samples — effectiveN for Direction, resolved real count for Entry/Exit. NEVER a row count. */
  effectiveN: number | null;
  /** Mean net R of what the brain chose. For Exit this is meanDeltaR (policy minus actual). */
  meanNetR: number | null;
  /** Direction only. null ⇒ gate not applicable. */
  meanRegretR?: number | null;
  /** Direction/Entry. null ⇒ gate not applicable. */
  meanCalibrationGapR?: number | null;
  /** REAL = resolved against fills that actually happened. SIMULATED = counterfactual walk only. */
  measuredBasis: "REAL" | "SIMULATED" | "NONE";
  /** The bar meanNetR must clear. Defaults to the Direction hurdle. */
  hurdleR?: number;
  minEffectiveN?: number;
}

const fmt = (v: number | null): string => (v === null ? "unmeasured" : `${v >= 0 ? "+" : ""}${v.toFixed(4)}R`);

/**
 * Judge one brain/scope. Pure: every input is already-computed telemetry.
 *
 * Order matters and is deliberate. Simulated-only is checked FIRST — a brain with no real outcomes
 * is not "insufficient" (which reads as "keep waiting, it is filling up"); it is measuring a
 * different thing entirely, and waiting will not convert a simulation into a fill.
 */
export function judgeFourBrainReadiness(
  brain: FourBrainReadiness["brain"],
  input: FourBrainReadinessInput,
): FourBrainReadiness {
  const minN = input.minEffectiveN ?? FOUR_BRAIN_READY_MIN_EFFECTIVE_N;
  const hurdle = input.hurdleR ?? 0.03;
  const gates: FourBrainGate[] = [];

  const n = input.effectiveN;
  const evidenceOk = n !== null && n >= minN;
  gates.push({
    gate: "EVIDENCE",
    passed: evidenceOk,
    value: n,
    detail:
      n === null
        ? `no independent samples recorded (need ≥ ${minN})`
        : `${n} independent samples, need ≥ ${minN}`,
  });

  const edgeOk = input.meanNetR !== null && input.meanNetR > hurdle;
  gates.push({
    gate: "EDGE",
    passed: input.meanNetR === null ? null : edgeOk,
    value: input.meanNetR,
    detail:
      brain === "EXIT"
        ? `policy vs actual exit ${fmt(input.meanNetR)}, need > ${hurdle}R`
        : `mean net ${fmt(input.meanNetR)}, need > ${hurdle}R`,
  });

  const regret = input.meanRegretR ?? null;
  const regretApplies = brain === "DIRECTION";
  const regretOk = regret !== null && regret <= FOUR_BRAIN_READY_MAX_REGRET_R;
  gates.push({
    gate: "SELECTION",
    passed: !regretApplies ? null : regret === null ? null : regretOk,
    value: regret,
    detail: !regretApplies
      ? "not applicable to this brain"
      : `regret ${fmt(regret)} (how much the best available option beat this one), need ≤ ${FOUR_BRAIN_READY_MAX_REGRET_R}R`,
  });

  const gap = input.meanCalibrationGapR ?? null;
  const gapApplies = brain !== "EXIT";
  const gapOk = gap !== null && Math.abs(gap) <= FOUR_BRAIN_READY_MAX_CALIBRATION_GAP_R;
  gates.push({
    gate: "CALIBRATION",
    passed: !gapApplies ? null : gap === null ? null : gapOk,
    value: gap,
    detail: !gapApplies
      ? "not applicable to this brain"
      : `expected minus realized ${fmt(gap)}, need |gap| ≤ ${FOUR_BRAIN_READY_MAX_CALIBRATION_GAP_R}R`,
  });

  const applicable = gates.filter((g) => g.passed !== null);
  let verdict: FourBrainReadinessVerdict;
  let summary: string;

  // EDGE UNMEASURED CAN NEVER BE READY (2026-07-28, caught on the first live read of this module).
  // The first version treated a null gate as "not applicable" and required only that the applicable
  // ones pass — so INTRADAY/SHORT, a bucket with ZERO decisions in the store's entire life, reported
  // READY: every quality gate was null for want of data, leaving EVIDENCE alone, which passed
  // because it was reading the HORIZON's effectiveN rather than the bucket's own. A readiness meter
  // that returns READY for a bucket holding nothing is the exact failure this file exists to end.
  // EDGE is the load-bearing gate: unmeasured there means "no idea", which is INSUFFICIENT_EVIDENCE.
  const edgeUnmeasured = input.meanNetR === null;

  if (input.measuredBasis !== "REAL") {
    verdict = "NOT_READY_SIMULATED_ONLY";
    summary =
      input.measuredBasis === "NONE"
        ? "no outcomes of any kind resolved yet — nothing has been measured"
        : "every number here comes from a counterfactual simulation, not a fill that happened; it cannot qualify this brain no matter how good it looks";
  } else if (!evidenceOk) {
    verdict = "INSUFFICIENT_EVIDENCE";
    summary = `only ${n ?? 0} independent samples — needs ≥ ${minN} before any verdict is meaningful`;
  } else if (edgeUnmeasured) {
    verdict = "INSUFFICIENT_EVIDENCE";
    summary = "no outcome has ever been recorded for this scope — nothing to judge";
  } else if (applicable.every((g) => g.passed === true)) {
    verdict = "READY";
    summary = "clears every gate on real measured outcomes";
  } else {
    verdict = "NOT_READY";
    const failed = applicable.filter((g) => g.passed === false).map((g) => g.gate);
    summary = `fails ${failed.join(" + ")} on real measured outcomes`;
  }

  return { brain, scope: input.scope, verdict, summary, gates, measuredBasis: input.measuredBasis };
}

/** Roll several scopes into one line. READY only when at least one scope is READY and none is NOT_READY —
 *  a brain that is good on one horizon and proven bad on another is not a brain you can act on. */
export function rollUpFourBrainReadiness(parts: readonly FourBrainReadiness[]): {
  verdict: FourBrainReadinessVerdict;
  summary: string;
} {
  if (parts.length === 0) return { verdict: "INSUFFICIENT_EVIDENCE", summary: "nothing measured" };
  if (parts.some((p) => p.verdict === "NOT_READY")) {
    const bad = parts.filter((p) => p.verdict === "NOT_READY").map((p) => p.scope);
    return { verdict: "NOT_READY", summary: `proven not ready on ${bad.join(", ")}` };
  }
  if (parts.some((p) => p.verdict === "READY")) {
    const good = parts.filter((p) => p.verdict === "READY").map((p) => p.scope);
    return { verdict: "READY", summary: `ready on ${good.join(", ")}` };
  }
  if (parts.every((p) => p.verdict === "NOT_READY_SIMULATED_ONLY")) {
    return { verdict: "NOT_READY_SIMULATED_ONLY", summary: "only simulated outcomes exist" };
  }
  return { verdict: "INSUFFICIENT_EVIDENCE", summary: "not enough independent evidence anywhere yet" };
}

/**
 * Derive the Exit Brain's readiness from whatever shape that instance's report happens to be in.
 *
 * This lives here, not inline in the route, for one reason: instances run different vintages of the
 * code and this is the only piece that has to reason about that. Live/3103 is a week behind research
 * and testnet, so shipping the verdict there means shipping a function whose behavior on BOTH shapes
 * is pinned by tests — not a bespoke edit to that instance's route file.
 *
 * Two shapes exist:
 *   - CURRENT: `measured` (real recorded paths) and `simulated` (candle-walk) as separate blocks.
 *     Judged separately, never blended; SIMULATED can never qualify the brain.
 *   - PRE-TIER: one flat `performance` block.
 *
 * Treating a flat `performance` as REAL is safe ONLY because the tier split and the candle-walk
 * source landed in the same change: a build with neither tier key also has no simulated ingestion, so
 * every evaluated row came from the dense recorder. The fallback is therefore gated on BOTH tier keys
 * being absent. If only one were missing we would be inventing a tier for data we cannot classify,
 * and labelling SIMULATED rows as REAL is the precise failure this verdict exists to prevent.
 *
 * Returns null when there is nothing to judge — the caller keeps serving its report either way.
 */
export function exitBrainReadinessFromReport(report: unknown): ({
  verdict: FourBrainReadinessVerdict;
  summary: string;
  perScope: FourBrainReadiness[];
}) | null {
  if (!report || typeof report !== "object") return null;
  const raw = report as Record<string, unknown>;
  const block = (key: string): Record<string, unknown> | null => {
    const b = raw[key] as Record<string, unknown> | undefined;
    return b && typeof b === "object" && typeof b.n === "number" ? b : null;
  };
  const measured = block("measured");
  const simulated = block("simulated");
  const scopes: Array<{ b: Record<string, unknown>; scope: string; basis: "REAL" | "SIMULATED" }> = [];
  if (measured) scopes.push({ b: measured, scope: "MEASURED (real recorded paths)", basis: "REAL" });
  if (simulated) scopes.push({ b: simulated, scope: "SIMULATED (candle-walk)", basis: "SIMULATED" });
  if (!measured && !simulated) {
    const flat = block("performance");
    if (flat) scopes.push({ b: flat, scope: "MEASURED (real recorded paths, untiered build)", basis: "REAL" });
  }
  if (scopes.length === 0) return null;
  const perScope = scopes.map(({ b, scope, basis }) =>
    judgeFourBrainReadiness("EXIT", {
      scope,
      effectiveN: b.n as number,
      meanNetR: typeof b.meanDeltaR === "number" ? b.meanDeltaR : null,
      measuredBasis: basis,
    }),
  );
  return { ...rollUpFourBrainReadiness(perScope), perScope };
}

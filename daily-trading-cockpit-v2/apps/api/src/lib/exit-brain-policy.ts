/**
 * EXIT BRAIN policy + counterfactual evaluator (2026-07-21, PURE + REPORT-ONLY).
 *
 * WHY THIS EXISTS: the CG_WIDE_FAST_LONG path-classification study (cg-wide-fast-long-path-
 * classification.ts + its backfill) measured that real closed trades captured only ~11% of their
 * peak MFE — exits hand back most of what the path actually offered. This module is the first
 * step toward an exit policy that can be SHADOW-SCORED against the real exits before anyone even
 * considers wiring it to execution: a transparent parametric HOLD/BANK rule set plus an honest
 * counterfactual evaluator that walks a trade's RECORDED path and asks "where would this policy
 * have banked, and would that have beaten the actual exit?".
 *
 * NAMING NOTE: this file is deliberately NOT lib/exit-brain.ts — that name is already taken by
 * the four-brain layer's Exit core (decideExit), which is a live-tick advisory brain consuming
 * decay/microstructure signals (momentumDecay, orderFlowReversal, structureBreak, …) that simply
 * do not exist in any RECORDED trade path, and which has no counterfactual evaluator. Building on
 * it would have meant fabricating its required inputs from data we do not have; this module is
 * standalone-pure instead, consuming only what recorded paths can actually provide (R-path
 * features). The two can be reconciled later if a dense path recorder starts capturing the Exit
 * core's inputs.
 *
 * INCUMBENT TO BEAT: the live MFE-giveback rule (current-guard-variant-matrix.ts `mfe_giveback`:
 * arm at MFE_GIVEBACK_ARM_R = 0.75R peak, bank at MFE_GIVEBACK_FRAC = 50% retrace of peak —
 * flat thresholds regardless of peak size or age). This policy differs in three documented ways:
 * it arms earlier (small winners fade before 0.75R ever prints), its retrace tolerance TIGHTENS
 * as the peak grows (a 2R winner should not be allowed to give half back), and it tightens with
 * age (a stale winner is banked rather than left to round-trip).
 *
 * HARD CONTRACT:
 *  - PURE: no I/O, no env reads, no Date.now, no imports beyond nothing. Deterministic.
 *  - REPORT-ONLY by construction: nothing here can touch an order; it only scores.
 *  - NO LOOKAHEAD: evaluateExitBrainCounterfactual walks ticks strictly in time order and the
 *    decision at tick i sees ONLY running state accumulated from ticks 0..i (asserted by tests:
 *    a peak that occurs AFTER the policy banks must not be credited).
 */

// ── params ───────────────────────────────────────────────────────────────────

export interface ExitBrainParams {
  /** The policy is inert (always HOLD, except STALE_WINNER) until the running peak has reached
   *  this many R. Below it there is nothing worth protecting — banking sub-arm noise would just
   *  churn fees. Deliberately LOWER than the incumbent's 0.75R arm: the path study showed most
   *  faded winners never reach 0.75R at all. */
  armPeakR: number;
  /** Retrace tolerance (fraction of peak given back) at the arm point for a young trade. */
  baseRetraceFrac: number;
  /** Hard floor on the retrace tolerance — tightening (peak- or age-driven) never goes below
   *  this, so ordinary bar-to-bar noise cannot trigger a bank on its own. */
  minRetraceFrac: number;
  /** How much the tolerance tightens per R of peak ABOVE the arm: threshold(peak) =
   *  baseRetraceFrac − retraceTightenPerPeakR × (peakR − armPeakR). DECREASING in peakR by
   *  construction — big winners are held to a tighter giveback than small ones (the task's
   *  f(peakR) rule). */
  retraceTightenPerPeakR: number;
  /** Age tightening starts only after this many hours — a young trade keeps the full tolerance. */
  ageGraceHours: number;
  /** Tolerance shaved per hour beyond the grace window (same clamp floor as above). */
  ageTightenPerHour: number;
  /** ROUND_TRIP_GUARD: once armed, if unrealized R has decayed to ≤ this, the winner has
   *  effectively round-tripped — bank the scraps instead of riding to the stop. */
  roundTripGuardR: number;
  /** STALE_WINNER: any position still positive after this many hours is banked (independent of
   *  arming). Losers are deliberately NOT banked by age here — cutting losers is the incumbent
   *  stop/kill machinery's job; this policy only protects winners. */
  staleWinnerMaxAgeHours: number;
  /** Haircut (R) subtracted from the policy's banked R in the counterfactual, so a caller can
   *  charge the hypothetical close its exit cost. Default 0 = raw comparison (both sides of the
   *  comparison then carry whatever costs the source data embeds — document per binding). */
  bankPenaltyR: number;
  /** Minimum recorded path ticks for an honest counterfactual. A sparse skeleton (e.g. the 4
   *  points our stores actually persist today: open, MFE-peak, MAE-trough, close) CANNOT be
   *  walked honestly — the intermediate retraces the policy triggers on are simply missing, so
   *  "policy never fired" would be an artifact of missing data, not a measurement. Such trades
   *  are classified INSUFFICIENT_PATH_DATA instead of being scored misleadingly. */
  minEvaluableTicks: number;
}

/** Min/max accepted for an EXIT_BRAIN_ARM_PEAK_R override. Below the floor the policy would arm on
 *  ordinary bar noise (banking scraps and churning fees — the exact failure armPeakR exists to
 *  prevent); above the ceiling it could never arm at all on any realistic path, silently turning
 *  the whole counterfactual into a no-op. An out-of-range or non-finite value falls back to the
 *  documented default rather than being clamped, so a typo can never quietly reshape the policy. */
const ARM_PEAK_R_MIN = 0.02;
const ARM_PEAK_R_MAX = 2;

/** Read the operator's armPeakR override, if any. Mirrors meta-label-gate.ts's envNum idiom, with
 *  an added range check because this single number decides whether the policy can ever arm. */
function armPeakROverride(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.EXIT_BRAIN_ARM_PEAK_R;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < ARM_PEAK_R_MIN || v > ARM_PEAK_R_MAX) return null;
  return v;
}

/** One exported tunable const (task requirement) so a later refit can adjust the policy without
 *  touching any logic. Every value is a documented judgment call, NOT fitted to any sample.
 *
 *  armPeakR EXCEPTION (2026-07-25): the default below stays at its original judgment-call value,
 *  but is now overridable via EXIT_BRAIN_ARM_PEAK_R. Reason: measured against the real retained
 *  path population on testnet (286 closed paths), peak R came in at median 0.052 / p90 0.178 /
 *  max 0.495 — only 3 paths (1.0%) ever reached 0.35R. The policy therefore never armed, every
 *  evaluated trade fell into the "held through the entire path" branch (deltaR pinned to 0), and
 *  the counterfactual reported 233/233 ties with meanDeltaR exactly 0.000 — structurally
 *  incapable of producing a signal either way. The 0.35 figure came from the CG_WIDE_FAST_LONG
 *  wide-stop study cited in this file's header, but the population actually being scored is
 *  dominated by fast small-R lanes. Rather than hardcode a sample-fitted number here (which would
 *  contradict the "NOT fitted to any sample" contract above), the threshold is made an explicit
 *  operator/research knob: the default remains the documented judgment call, and any retuning is
 *  a visible, instantly reversible env decision per instance. */
export const DEFAULT_EXIT_BRAIN_PARAMS: ExitBrainParams = {
  armPeakR: armPeakROverride() ?? 0.35,
  baseRetraceFrac: 0.55,
  minRetraceFrac: 0.22,
  retraceTightenPerPeakR: 0.18,
  ageGraceHours: 4,
  ageTightenPerHour: 0.015,
  roundTripGuardR: 0.05,
  staleWinnerMaxAgeHours: 48,
  bankPenaltyR: 0,
  minEvaluableTicks: 6,
};

// ── features ─────────────────────────────────────────────────────────────────

/** Per-observation-tick features of an OPEN position. All R values are in R = fraction of
 *  planned risk-at-stop (repo convention: stop ≙ −1R). */
export interface ExitBrainFeatures {
  /** Unrealized R at this tick. */
  currentR: number;
  /** Running MFE so far (R, ≥ 0 by convention — favorable excursion is floored at 0). */
  peakR: number;
  /** Running MAE so far (R, ≤ 0 by convention). */
  troughR: number;
  /** Hours since entry. */
  ageHours: number;
  /** (peakR − currentR) / peakR when peakR > 0, else 0. May exceed 1 when currentR < 0. */
  retraceFromPeakFrac: number;
  /** Distance to the hard stop in R (currentR − (−1) under the stop≙−1R convention); null when
   *  unknown. RECORDED-FOR-REFIT: not used by the v1 rules. */
  distToStopR: number | null;
  /** Distance to the TP in R; null when unknown. RECORDED-FOR-REFIT: not used by the v1 rules. */
  distToTpR: number | null;
  /** Optional context (refit dimensions, not v1 rule inputs). */
  regimeFamily?: string | null;
  atrPct?: number | null;
}

/** Retrace fraction of peak given back. 0 while the peak is non-positive (nothing to retrace);
 *  ≥ 0 otherwise and deliberately NOT capped at 1 (a +1R peak now at −0.5R has retraced 1.5). */
export function computeRetraceFromPeakFrac(currentR: number, peakR: number): number {
  if (!Number.isFinite(currentR) || !Number.isFinite(peakR) || peakR <= 0) return 0;
  return Math.max(0, (peakR - currentR) / peakR);
}

/** The effective retrace-tolerance threshold for a given running peak + age. Monotonically
 *  DECREASING in both peakR (above the arm) and ageHours (past the grace window), clamped to
 *  [minRetraceFrac, baseRetraceFrac]. Exported so tests + any future report can show the exact
 *  threshold the decision used. */
export function effectiveRetraceThreshold(peakR: number, ageHours: number, params: ExitBrainParams): number {
  const peakTighten = params.retraceTightenPerPeakR * Math.max(0, peakR - params.armPeakR);
  const ageTighten = params.ageTightenPerHour * Math.max(0, ageHours - params.ageGraceHours);
  const raw = params.baseRetraceFrac - peakTighten - ageTighten;
  return Math.min(params.baseRetraceFrac, Math.max(params.minRetraceFrac, raw));
}

// ── decision ─────────────────────────────────────────────────────────────────

export type ExitBrainAction = "HOLD" | "BANK";

export interface ExitBrainDecisionResult {
  action: ExitBrainAction;
  /** Bank urgency in [0, 1]: 0 = nowhere near banking, 1 = banking now. On an armed HOLD it is
   *  progress toward the retrace threshold (retraceFromPeakFrac / threshold, clamped). */
  score: number;
  /** Which documented rule decided — always one of the R* prefixes below (testable). */
  reason: string;
}

/**
 * TRANSPARENT parametric policy — every rule documented, checked in this exact precedence order:
 *
 *  R0 INVALID_FEATURES — any of currentR/peakR/troughR/ageHours non-finite → HOLD (fail-open:
 *     a scorer that cannot see must do nothing, mirroring the repo's null-in→null-out rule).
 *  R1 STALE_WINNER     — ageHours ≥ staleWinnerMaxAgeHours AND currentR > 0 → BANK. Checked
 *     BEFORE the arm gate on purpose: a 60-hour-old +0.2R crawler should be banked even though
 *     it never armed. Losers are never age-banked here (the incumbent stop owns them).
 *  R2 UNARMED          — peakR < armPeakR → HOLD. Nothing worth protecting yet.
 *  R3 ROUND_TRIP_GUARD — armed AND currentR ≤ roundTripGuardR → BANK. The winner has already
 *     round-tripped to ~flat; salvage what is left rather than riding into the stop.
 *  R4 RETRACE_BANK     — armed AND retraceFromPeakFrac ≥ effectiveRetraceThreshold(peakR,
 *     ageHours) → BANK. The core giveback rule: tolerance DECREASES as the peak grows and as
 *     the trade ages (see effectiveRetraceThreshold).
 *  R5 HOLD             — otherwise. Score reports progress toward R4's threshold.
 */
export function exitBrainDecision(features: ExitBrainFeatures, params: ExitBrainParams = DEFAULT_EXIT_BRAIN_PARAMS): ExitBrainDecisionResult {
  const { currentR, peakR, troughR, ageHours } = features;
  if (!Number.isFinite(currentR) || !Number.isFinite(peakR) || !Number.isFinite(troughR) || !Number.isFinite(ageHours)) {
    return { action: "HOLD", score: 0, reason: "R0_INVALID_FEATURES: non-finite input — fail-open HOLD" };
  }

  if (ageHours >= params.staleWinnerMaxAgeHours && currentR > 0) {
    return {
      action: "BANK",
      score: 1,
      reason: `R1_STALE_WINNER: still +${currentR.toFixed(2)}R after ${ageHours.toFixed(1)}h (max ${params.staleWinnerMaxAgeHours}h)`,
    };
  }

  if (peakR < params.armPeakR) {
    return {
      action: "HOLD",
      score: 0,
      reason: `R2_UNARMED: peak ${peakR.toFixed(2)}R below arm ${params.armPeakR}R`,
    };
  }

  if (currentR <= params.roundTripGuardR) {
    return {
      action: "BANK",
      score: 1,
      reason: `R3_ROUND_TRIP_GUARD: armed at peak ${peakR.toFixed(2)}R but decayed to ${currentR.toFixed(2)}R (guard ${params.roundTripGuardR}R)`,
    };
  }

  const threshold = effectiveRetraceThreshold(peakR, ageHours, params);
  const retrace = Number.isFinite(features.retraceFromPeakFrac)
    ? Math.max(0, features.retraceFromPeakFrac)
    : computeRetraceFromPeakFrac(currentR, peakR);
  if (retrace >= threshold) {
    return {
      action: "BANK",
      score: 1,
      reason: `R4_RETRACE_BANK: gave back ${(retrace * 100).toFixed(0)}% of ${peakR.toFixed(2)}R peak (threshold ${(threshold * 100).toFixed(0)}%)`,
    };
  }

  return {
    action: "HOLD",
    score: Math.min(0.999, retrace / threshold),
    reason: `R5_HOLD: retrace ${(retrace * 100).toFixed(0)}% below threshold ${(threshold * 100).toFixed(0)}%`,
  };
}

// ── counterfactual evaluation over a recorded path ──────────────────────────

/** One recorded observation of an open position's path. `currentR` is required; peakR/troughR are
 *  OPTIONAL as-of-this-tick refinements (intra-gap highs/lows a sparse sampler saw) and are folded
 *  into the running peak/trough — they must describe the path UP TO this tick only (recorder's
 *  contract; the evaluator itself never reads a later tick either way). */
export interface ExitBrainPathTick {
  tsMs: number;
  currentR: number;
  peakR?: number | null;
  troughR?: number | null;
}

export interface ExitBrainActualExit {
  /** The R the ACTUAL exit realized (as recorded by the source store — document gross vs net per
   *  binding; the policy side can be cost-adjusted via params.bankPenaltyR). */
  exitR: number;
  exitAtIso: string;
}

export type ExitBrainCounterfactualStatus = "EVALUATED" | "INSUFFICIENT_PATH_DATA" | "INVALID_INPUT";

export interface ExitBrainCounterfactualResult {
  status: ExitBrainCounterfactualStatus;
  /** Valid (finite ts + currentR) ticks found — recorded even on INSUFFICIENT_PATH_DATA so the
   *  shadow layer can report exactly how dense today's recorded paths actually are. */
  tickCount: number;
  /** R the policy would have realized: the banking tick's currentR − bankPenaltyR, or exactly the
   *  actual exitR when the policy held through the whole recorded path (it then inherits the real
   *  outcome — deltaR 0 by construction). Null when not evaluated. */
  policyExitR: number | null;
  actualExitR: number;
  /** policyExitR − actualExitR. Positive = the policy beat the real exit. Null when not evaluated. */
  deltaR: number | null;
  /** ISO timestamp of the tick the policy banked at; null when it held throughout / not evaluated. */
  bankedAt: string | null;
  bankedTickIndex: number | null;
  bankReason: string | null;
}

/**
 * Walks the recorded path IN TIME ORDER and returns where the policy would have banked, scored
 * against the actual exit. Honesty rules (tested):
 *  - NO LOOKAHEAD: running peak/trough are accumulated tick by tick; the decision at tick i uses
 *    only ticks 0..i. A peak that prints after an early bank is never credited to the policy.
 *  - The FIRST tick is treated as the entry observation (age 0). ageHours at tick i is measured
 *    from tick 0's timestamp.
 *  - If the policy never banks on the recorded path, its outcome IS the actual exit (deltaR = 0)
 *    — holding to the end means riding the real trade to its real close, nothing better or worse.
 *  - Fewer than params.minEvaluableTicks valid ticks → INSUFFICIENT_PATH_DATA, never a fabricated
 *    score (see the param's doc for why sparse skeletons cannot be walked honestly).
 */
export function evaluateExitBrainCounterfactual(
  pathTicks: ExitBrainPathTick[],
  actualExit: ExitBrainActualExit,
  params: ExitBrainParams = DEFAULT_EXIT_BRAIN_PARAMS,
): ExitBrainCounterfactualResult {
  if (!Number.isFinite(actualExit?.exitR)) {
    return {
      status: "INVALID_INPUT",
      tickCount: 0,
      policyExitR: null,
      actualExitR: Number.NaN,
      deltaR: null,
      bankedAt: null,
      bankedTickIndex: null,
      bankReason: null,
    };
  }

  const ticks = (Array.isArray(pathTicks) ? pathTicks : [])
    .filter((t) => t && Number.isFinite(t.tsMs) && Number.isFinite(t.currentR))
    .slice()
    .sort((a, b) => a.tsMs - b.tsMs);

  if (ticks.length < Math.max(2, params.minEvaluableTicks)) {
    return {
      status: "INSUFFICIENT_PATH_DATA",
      tickCount: ticks.length,
      policyExitR: null,
      actualExitR: actualExit.exitR,
      deltaR: null,
      bankedAt: null,
      bankedTickIndex: null,
      bankReason: null,
    };
  }

  const openMs = ticks[0]!.tsMs;
  // Repo convention: favorable excursion floored at 0, adverse capped at 0.
  let runningPeak = 0;
  let runningTrough = 0;

  for (let i = 0; i < ticks.length; i += 1) {
    const tick = ticks[i]!;
    runningPeak = Math.max(runningPeak, tick.currentR, Number.isFinite(tick.peakR ?? Number.NaN) ? (tick.peakR as number) : Number.NEGATIVE_INFINITY);
    runningTrough = Math.min(runningTrough, tick.currentR, Number.isFinite(tick.troughR ?? Number.NaN) ? (tick.troughR as number) : Number.POSITIVE_INFINITY);

    const features: ExitBrainFeatures = {
      currentR: tick.currentR,
      peakR: runningPeak,
      troughR: runningTrough,
      ageHours: (tick.tsMs - openMs) / 3_600_000,
      retraceFromPeakFrac: computeRetraceFromPeakFrac(tick.currentR, runningPeak),
      // Stop ≙ −1R by the R definition itself, so distance-to-stop is derivable; TP is unknown
      // to a pure R-path (recorded-for-refit, unused by v1 rules either way).
      distToStopR: tick.currentR + 1,
      distToTpR: null,
    };
    const decision = exitBrainDecision(features, params);
    if (decision.action === "BANK") {
      // 2026-07-22 review fix: a BANK that fires on the LAST tick is the same real-world outcome as
      // "held through to the end" (the last tick's currentR IS actualExitR, by construction — see
      // resolvedTradesFromShadowPositions/resolvedTradesFromRecordedPaths) — it is not a hypothetical
      // early exit, so it must not be charged bankPenaltyR either. Without this, two economically
      // identical trades (both simply ride to their real close) scored a deltaR bias of exactly
      // -bankPenaltyR purely on which internal rule happened to fire on the final tick vs never firing
      // at all — a spurious, threshold-position-dependent penalty the moment bankPenaltyR is tuned
      // away from its current dormant 0 default.
      // Timestamp-based, not array-index-based: a tick tied on tsMs with the real close tick (e.g. a
      // trough recorded at the exact stop-fill instant) is JUST AS terminal as the literal last array
      // entry — using `i === ticks.length - 1` would miss that tie and wrongly charge bankPenaltyR.
      const isTerminalTick = tick.tsMs === ticks[ticks.length - 1]!.tsMs;
      const policyExitR = isTerminalTick ? tick.currentR : tick.currentR - params.bankPenaltyR;
      return {
        status: "EVALUATED",
        tickCount: ticks.length,
        policyExitR,
        actualExitR: actualExit.exitR,
        deltaR: policyExitR - actualExit.exitR,
        // A terminal-tick BANK is economically "held through", never an actual mid-path bank — must
        // not be counted as one downstream (EvaluatedAggregate.banked et al).
        bankedAt: isTerminalTick ? null : new Date(tick.tsMs).toISOString(),
        bankedTickIndex: isTerminalTick ? null : i,
        bankReason: isTerminalTick ? null : decision.reason,
      };
    }
  }

  // Held through the entire recorded path → the policy's outcome is the real one.
  return {
    status: "EVALUATED",
    tickCount: ticks.length,
    policyExitR: actualExit.exitR,
    actualExitR: actualExit.exitR,
    deltaR: 0,
    bankedAt: null,
    bankedTickIndex: null,
    bankReason: null,
  };
}

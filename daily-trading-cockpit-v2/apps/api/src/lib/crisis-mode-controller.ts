/**
 * CRISIS MODE CONTROLLER (pure combination layer — the SAFETY-GATED action-trigger for geopolitical
 * escalation; report-only, no I/O, nothing executes by just existing).
 *
 * WHAT THIS IS: the layer that sits on top of two independently-built signals and decides whether
 * "crisis mode" (a bounded, temporary defensive posture) should be considered active:
 *   1. lib/geopolitical-escalation-classifier.ts's EscalationClassification.finalScore — the
 *      LLM-corroboration-ceilinged, quantitative-primary escalation read (see that module's header).
 *   2. TWO existing, already-deployed, deterministic market-shock detectors, used here PURELY as
 *      read-only confirmation inputs (this module does not run their cycles or touch their stores):
 *        - lib/btc-leadlag-snap-edge.ts's detectBtcShock() output (BtcShockAssessment: isShock,
 *          zScore, direction) — a self-normalizing "BTC just moved k-sigma relative to its own
 *          recent vol" read.
 *        - lib/regime-composite-short-edge.ts's regime axis score input (the same -1..+1 breadth
 *          composite that module's evaluateRegimeCompositeShortEntry() gates SHORT confirmation on
 *          via RCS_AXIS_SCORE_MAX) — a breadth read of how broadly bearish the market is right now.
 *
 * *** THE CORE SAFETY INVARIANT (read this before touching the code below) ***
 *   `active` can be true ONLY when BOTH of these hold:
 *     (a) escalationClassification.finalScore >= params.escalationThreshold (a high, deliberately
 *         conservative fixed default — see DEFAULT_CRISIS_MODE_PARAMS.escalationThreshold=75/100).
 *     (b) AT LEAST ONE of the two deterministic market-shock signals ALSO independently confirms an
 *         active bearish extreme RIGHT NOW (see the exact thresholds documented on
 *         CrisisModeParams.btcShockMinAbsZ / regimeAxisScoreMax below).
 *   Escalation score alone — no matter how extreme, even a fabricated/maxed-out 100 — is NEVER
 *   sufficient by itself. This is enforced as an explicit early-return in evaluateCrisisMode (gate
 *   (a) fails closed, then gate (b) fails closed on its own, each with its own INACTIVE_* reason),
 *   PLUS a redundant belt-and-suspenders re-assertion immediately before the only return statement
 *   that can ever produce active:true. See crisis-mode-controller.test.ts's
 *   "escalation alone is insufficient" test for the fail-without/pass-with regression proof.
 *
 * WHY LLM text alone (i.e. the escalation classifier without market confirmation) can never trigger
 * an action: an LLM misreading a headline, or a spike of low-quality wire-copy pushing the
 * quantitative score up, is a plausible failure mode this module must be structurally immune to.
 * Requiring an independent, already-proven, non-LLM, non-text deterministic detector to ALSO be
 * screaming right now means the worst a bad escalation read can do on its own is nothing.
 *
 * BOUNDED BLAST RADIUS, even in the worst case:
 *   - allocationTiltPct is HARD-CAPPED at params.maxTiltPct (default 15, i.e. 15 percentage points —
 *     same weightPct unit lib/regime-autopilot.ts's LaneAllocationEntry/setAllocations already use)
 *     regardless of how extreme finalScore or params get (see the tilt-cap regression test, which
 *     feeds deliberately out-of-range/garbage inputs and asserts the cap still holds).
 *   - exitToleranceOverride, when active, WIDENS (never narrows) exit-brain-policy.ts's
 *     ExitBrainParams retrace-tolerance vocabulary (baseRetraceFrac/minRetraceFrac/roundTripGuardR —
 *     same units, R-fraction-of-peak / R, ready to spread over DEFAULT_EXIT_BRAIN_PARAMS at the
 *     wiring layer) so MFE-giveback/profit-bank rules don't prematurely bank a winner mid-crisis —
 *     but every widened field is itself clamped to a documented safe range
 *     (maxBaseRetraceFrac/maxMinRetraceFrac/minRoundTripGuardR) so a garbage `params` object cannot
 *     produce a pathological (e.g. >1 or deeply negative) tolerance.
 *
 * FAIL-OPEN DIRECTION (mirrors exit-brain-policy.ts's R0_INVALID_FEATURES convention): any
 * non-finite/missing/invalid input on EITHER leg (finalScore, btcShock, regimeAxisScore) is treated
 * as "does not confirm" — NEVER as "confirms" and never as "confirms harder." A garbled or absent
 * reading can only push this function toward INACTIVE, never toward ACTIVE.
 *
 * PURE / NO ACTION-GATE ON THE FUNCTION ITSELF (documented deviation, same reasoning as
 * geopolitical-escalation-classifier.ts's own explicit deviation note): evaluateCrisisMode has zero
 * I/O — it is a pure combination step like that module's classifyEscalation, and is therefore always
 * safe to call; unlike an outbound network call, there is nothing here an ENABLED-default-false gate
 * would protect. What DOES need an explicit, default-false action gate is the wiring layer that
 * actually APPLIES allocationTiltPct to a real live allocation or exitToleranceOverride to a real
 * exit-brain-policy.ts binding — that gate is CRISIS_MODE_ACTION_ENABLED_FLAG /
 * isCrisisModeActionEnabled(), exported here for the wiring step to use, but never read internally
 * by evaluateCrisisMode (this module does not — and structurally cannot — take any action itself).
 *
 * KILL SWITCH: CRISIS_MODE_CONTROLLER_DISABLED (default unset = evaluateCrisisMode runs normally,
 * same default-running "_DISABLED" naming/wiring convention as GEOPOLITICAL_FEED_DISABLED /
 * FUNDING_CARRY_DISABLED — this is a pure computation, not an action, so it is safe-by-default like
 * those collector/measurement lanes). Setting it to "1" short-circuits straight to INACTIVE
 * regardless of any input, however extreme — the kill switch can only ever move this function
 * TOWARD the safe state, never away from it, consistent with the fail-open direction above.
 *
 * AUDIT-LOG EMISSION: this module stays pure and persists nothing itself (the audit log/persistence
 * belongs to the wiring step). Every call's return value carries everything a caller needs to emit a
 * structured audit entry whenever `active` flips: `reasoning` is the FULL evidence trail (the
 * escalation classifier's own reasoning[] lines verbatim, prepended, plus this function's own
 * market-signal-reading lines and final decision line), and `evidence` is the same information as
 * typed fields for callers that want to log/compare structured values instead of parsing strings.
 */

import type { BtcShockAssessment } from "./btc-leadlag-snap-edge.js";
import { DEFAULT_EXIT_BRAIN_PARAMS } from "./exit-brain-policy.js";
import type { EscalationClassification } from "./geopolitical-escalation-classifier.js";

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ── kill switch (pure-module convention: default-running; can only force INACTIVE) ─────────────

/** Default unset (evaluateCrisisMode runs normally). Set to "1" to force INACTIVE unconditionally —
 *  an operational safety valve, fail-open direction only (never forces ACTIVE). */
export const CRISIS_MODE_CONTROLLER_DISABLED_FLAG = "CRISIS_MODE_CONTROLLER_DISABLED";

// ── action gate for the (separate, out-of-scope-here) wiring layer ─────────────────────────────

/** Default-OFF action gate for whatever wiring-layer code actually APPLIES allocationTiltPct /
 *  exitToleranceOverride to a real live allocation or a real exit-brain-policy.ts binding.
 *  evaluateCrisisMode itself never reads this — it takes no action, so nothing here needs gating on
 *  its own account. Exported so the wiring step uses the exact same flag name/convention as every
 *  other *_EXEC_ENABLED / *_ENABLED action gate in this repo. */
export const CRISIS_MODE_ACTION_ENABLED_FLAG = "CRISIS_MODE_ACTION_ENABLED";

export function isCrisisModeActionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CRISIS_MODE_ACTION_ENABLED_FLAG] === "1";
}

// ── params (one named tunable-constants object, house style) ───────────────────────────────────

export interface CrisisModeParams {
  /** HARD RULE (a): escalationClassification.finalScore must be >= this before anything else is
   *  even considered. High and deliberately conservative — see
   *  geopolitical-escalation-classifier.ts's DEFAULT_ESCALATION_SCORE_PARAMS for how this 0-100
   *  number is built (event volume + high-severity CAMEO count + Goldstein tone, LLM-ceilinged). A
   *  documented judgment call, NOT fitted to any sample. */
  escalationThreshold: number;
  /** HARD RULE (b), BTC leg: the market-shock signal is confirmed only when btcShock.isShock is
   *  true, btcShock.direction is "SHORT" (a down-shock — crisis mode is a defensive/bearish
   *  posture, never a dip-buy trigger), AND |btcShock.zScore| >= this. Declared INDEPENDENTLY of
   *  btc-leadlag-snap-edge.ts's own BLS_SHOCK_K env-tunable threshold (deliberately not imported)
   *  so this module's own confirmation bar cannot silently drift if that lane's measurement
   *  threshold is retuned for its own purposes. */
  btcShockMinAbsZ: number;
  /** HARD RULE (b), RCS leg: confirmed only when regimeAxisScore <= this (more negative = more
   *  broadly bearish). Set MORE conservative (more negative) than
   *  regime-composite-short-edge.ts's own RCS_AXIS_SCORE_MAX (-0.35) on purpose — "confirm crisis
   *  mode" is a stronger claim than "confirm a routine SHORT entry," so this module keeps its own,
   *  independently stricter bar rather than merely importing the routine lane's. */
  regimeAxisScoreMax: number;
  /** HARD CAP, independent of (a)/(b): allocationTiltPct can never exceed this (percentage points,
   *  same weightPct unit as regime-autopilot.ts's LaneAllocationEntry), no matter how extreme the
   *  inputs or other params are. Bounded blast radius even in a worst-case/garbage-input scenario. */
  maxTiltPct: number;
  /** How much allocationTiltPct grows per point finalScore sits above escalationThreshold, before
   *  the maxTiltPct cap is applied. Named, not a magic number in the formula body. */
  tiltPctPerScorePoint: number;
  /** How much wider than DEFAULT_EXIT_BRAIN_PARAMS.baseRetraceFrac to make the tolerance when
   *  active, before the maxBaseRetraceFrac safety ceiling. */
  baseRetraceFracWidenBy: number;
  /** How much wider than DEFAULT_EXIT_BRAIN_PARAMS.minRetraceFrac to raise the tolerance FLOOR when
   *  active (moved up in lockstep so age/peak tightening in exitBrainDecision can never claw the
   *  widened tolerance back down to the ordinary floor mid-crisis), before maxMinRetraceFrac. */
  minRetraceFracWidenBy: number;
  /** How much to LOWER DEFAULT_EXIT_BRAIN_PARAMS.roundTripGuardR by when active — a smaller
   *  roundTripGuardR means a decaying winner must fall further before R3_ROUND_TRIP_GUARD force-
   *  banks it, i.e. WIDER tolerance — floored at minRoundTripGuardR. */
  roundTripGuardRLowerBy: number;
  /** Safety ceiling: the widened baseRetraceFrac can never exceed this, regardless of
   *  baseRetraceFracWidenBy or any other param. */
  maxBaseRetraceFrac: number;
  /** Safety ceiling: the widened minRetraceFrac floor can never exceed this. */
  maxMinRetraceFrac: number;
  /** Safety floor: the widened (lowered) roundTripGuardR can never drop below this. */
  minRoundTripGuardR: number;
}

/** One exported tunable-constants object (mirrors DEFAULT_EXIT_BRAIN_PARAMS / DEFAULT_ESCALATION_
 *  SCORE_PARAMS style) — every threshold used by evaluateCrisisMode lives here, named, documented
 *  above. No magic numbers appear in the function body. */
export const DEFAULT_CRISIS_MODE_PARAMS: CrisisModeParams = {
  escalationThreshold: 75,
  btcShockMinAbsZ: 3,
  regimeAxisScoreMax: -0.5,
  maxTiltPct: 15,
  tiltPctPerScorePoint: 0.6,
  baseRetraceFracWidenBy: 0.15,
  minRetraceFracWidenBy: 0.08,
  roundTripGuardRLowerBy: 0.03,
  maxBaseRetraceFrac: 0.85,
  maxMinRetraceFrac: 0.4,
  minRoundTripGuardR: -0.1,
};

// ── input types (named after the real fields of the two detectors this gates against) ──────────

export interface CrisisModeMarketShockSignals {
  /** btc-leadlag-snap-edge.ts's detectBtcShock() output for the CURRENT cycle — null when the
   *  caller couldn't evaluate a shock this cycle (e.g. insufficient BTC candle history). Only the
   *  fields this module actually reads are required (Pick, not the full BtcShockAssessment). */
  btcShock: Pick<BtcShockAssessment, "isShock" | "zScore" | "direction"> | null;
  /** The current regime axis score (regime-axis-timeline.ts's -1..+1 breadth composite) — the exact
   *  same input regime-composite-short-edge.ts's evaluateRegimeCompositeShortEntry gates SHORT
   *  confirmation on. Null when unavailable. */
  regimeAxisScore: number | null;
}

/** Widened exit-tolerance override, in exit-brain-policy.ts's OWN vocabulary/units (R-based
 *  fractions / R) — ready to spread directly over DEFAULT_EXIT_BRAIN_PARAMS at the wiring layer
 *  (e.g. `{ ...DEFAULT_EXIT_BRAIN_PARAMS, ...override }`). Every field is capped to a documented
 *  safe range (see CrisisModeParams) regardless of inputs. */
export interface CrisisExitToleranceOverride {
  baseRetraceFrac: number;
  minRetraceFrac: number;
  roundTripGuardR: number;
}

/** Structured, typed evidence — the same numbers `reasoning[]` describes in prose, for callers that
 *  want to log/compare values instead of parsing strings. Always populated, active or not (house
 *  rule: no black-box decisions). */
export interface CrisisModeEvidence {
  escalationFinalScore: number;
  escalationThreshold: number;
  escalationGatePassed: boolean;
  btcShockIsShock: boolean | null;
  btcShockDirection: "LONG" | "SHORT" | null;
  /** Absolute value is what's compared to btcShockMinAbsZ; the raw signed reading is kept here too. */
  btcShockZScore: number | null;
  btcShockConfirmed: boolean;
  regimeAxisScore: number | null;
  regimeAxisScoreMax: number;
  regimeAxisConfirmed: boolean;
  /** btcShockConfirmed || regimeAxisConfirmed — either leg alone is sufficient for HARD RULE (b). */
  marketConfirmationPassed: boolean;
}

export interface CrisisModeEvaluation {
  /** true ONLY when escalationGatePassed AND marketConfirmationPassed — see the header's HARD
   *  SAFETY INVARIANT. Never true from escalation alone. */
  active: boolean;
  /** One-line human-readable summary of the decision (short, for a dashboard chip / log line). */
  reason: string;
  /** Hard-capped at params.maxTiltPct always (see CrisisModeParams.maxTiltPct); exactly 0 when
   *  inactive. */
  allocationTiltPct: number;
  /** Non-null only when active; null (no override to apply) when inactive. */
  exitToleranceOverride: CrisisExitToleranceOverride | null;
  /** Full evidence trail for audit-log emission: escalationClassification.reasoning[] verbatim,
   *  prepended, followed by this function's own market-signal-reading lines and the final decision
   *  line. Sufficient for a wiring-layer caller to log a structured audit entry every time `active`
   *  flips, without this module tracking any persisted prior state itself. */
  reasoning: string[];
  evidence: CrisisModeEvidence;
}

function buildEvidence(
  escalationClassification: EscalationClassification,
  marketShockSignals: CrisisModeMarketShockSignals,
  params: CrisisModeParams,
): CrisisModeEvidence {
  const finalScoreRaw = escalationClassification?.finalScore;
  const finalScore = finite(finalScoreRaw) ? finalScoreRaw : Number.NaN;
  const escalationGatePassed = finite(finalScore) && finalScore >= params.escalationThreshold;

  const btcShock = marketShockSignals?.btcShock ?? null;
  const btcZ = btcShock && finite(btcShock.zScore) ? btcShock.zScore : null;
  const btcShockConfirmed =
    btcShock !== null &&
    btcShock.isShock === true &&
    btcShock.direction === "SHORT" &&
    btcZ !== null &&
    Math.abs(btcZ) >= params.btcShockMinAbsZ;

  const regimeAxisScoreRaw = marketShockSignals?.regimeAxisScore ?? null;
  const regimeAxisScore = finite(regimeAxisScoreRaw) ? regimeAxisScoreRaw : null;
  const regimeAxisConfirmed = regimeAxisScore !== null && regimeAxisScore <= params.regimeAxisScoreMax;

  return {
    escalationFinalScore: finalScore,
    escalationThreshold: params.escalationThreshold,
    escalationGatePassed,
    btcShockIsShock: btcShock ? btcShock.isShock : null,
    btcShockDirection: btcShock ? btcShock.direction : null,
    btcShockZScore: btcZ,
    btcShockConfirmed,
    regimeAxisScore,
    regimeAxisScoreMax: params.regimeAxisScoreMax,
    regimeAxisConfirmed,
    marketConfirmationPassed: btcShockConfirmed || regimeAxisConfirmed,
  };
}

function inactiveResult(reasonLine: string, evidence: CrisisModeEvidence, trail: string[]): CrisisModeEvaluation {
  return {
    active: false,
    reason: reasonLine,
    allocationTiltPct: 0,
    exitToleranceOverride: null,
    reasoning: [...trail, reasonLine],
    evidence,
  };
}

/**
 * PURE. Combines an escalation classification with two independent, already-deployed deterministic
 * market-shock readings and decides whether crisis mode should be considered active. See the module
 * header for the full safety-invariant writeup; the short version:
 *
 *   active = escalationClassification.finalScore >= params.escalationThreshold
 *            AND (btcShock confirms a SHORT-direction shock of |z| >= params.btcShockMinAbsZ
 *                 OR regimeAxisScore <= params.regimeAxisScoreMax)
 *
 * Escalation alone is NEVER sufficient (explicit early-return below, re-asserted defensively right
 * before the only active:true return). allocationTiltPct is always <= params.maxTiltPct.
 * exitToleranceOverride is null unless active, and every one of its fields is clamped to a
 * documented safe range. Fail-open on any non-finite/missing input (never confirms, never
 * activates). Honors CRISIS_MODE_CONTROLLER_DISABLED as a kill switch that can only force INACTIVE.
 */
export function evaluateCrisisMode(
  escalationClassification: EscalationClassification,
  marketShockSignals: CrisisModeMarketShockSignals,
  params: CrisisModeParams = DEFAULT_CRISIS_MODE_PARAMS,
  env: NodeJS.ProcessEnv = process.env,
): CrisisModeEvaluation {
  const evidence = buildEvidence(escalationClassification, marketShockSignals, params);

  const trail: string[] = [...(escalationClassification?.reasoning ?? [])];
  trail.push(
    `escalation finalScore=${finite(evidence.escalationFinalScore) ? evidence.escalationFinalScore.toFixed(1) : "NaN"} vs threshold=${params.escalationThreshold} -> gate ${evidence.escalationGatePassed ? "PASSED" : "FAILED"}`,
  );
  trail.push(
    `btcShock leg: isShock=${evidence.btcShockIsShock} direction=${evidence.btcShockDirection} |z|=${evidence.btcShockZScore !== null ? Math.abs(evidence.btcShockZScore).toFixed(2) : "n/a"} vs min ${params.btcShockMinAbsZ} -> ${evidence.btcShockConfirmed ? "CONFIRMED" : "not confirmed"}`,
  );
  trail.push(
    `regimeAxis leg: score=${evidence.regimeAxisScore !== null ? evidence.regimeAxisScore.toFixed(2) : "n/a"} vs ceiling ${params.regimeAxisScoreMax} -> ${evidence.regimeAxisConfirmed ? "CONFIRMED" : "not confirmed"}`,
  );

  if (env[CRISIS_MODE_CONTROLLER_DISABLED_FLAG] === "1") {
    return inactiveResult(
      `INACTIVE_KILL_SWITCH: ${CRISIS_MODE_CONTROLLER_DISABLED_FLAG}=1 forces crisis mode inactive regardless of inputs.`,
      evidence,
      trail,
    );
  }

  if (!evidence.escalationGatePassed) {
    return inactiveResult(
      "INACTIVE_ESCALATION_BELOW_THRESHOLD: finalScore has not reached escalationThreshold — nothing further is even considered.",
      evidence,
      trail,
    );
  }

  // *** HARD SAFETY RULE *** (see module header): escalation score, no matter how extreme, is NEVER
  // sufficient by itself. At least one independent, deterministic market-shock signal must ALSO
  // confirm an active bearish extreme right now, or this returns INACTIVE unconditionally.
  if (!evidence.marketConfirmationPassed) {
    return inactiveResult(
      `INACTIVE_NO_MARKET_CONFIRMATION: escalation gate passed (finalScore=${evidence.escalationFinalScore.toFixed(1)} >= ${params.escalationThreshold}) but NEITHER the BTC lead-lag shock leg NOR the RCS bearish-breadth axis leg independently confirms an active bearish extreme right now — escalation alone can NEVER activate crisis mode (hard invariant, tested explicitly in crisis-mode-controller.test.ts).`,
      evidence,
      trail,
    );
  }

  // Defensive belt-and-suspenders re-assertion, right before the ONLY return statement in this
  // function that can produce active:true. If this branch is ever reached it is a logic bug in the
  // two checks above, not a data problem — it fails CLOSED (toward inactive), never open.
  if (!(evidence.escalationGatePassed && evidence.marketConfirmationPassed)) {
    return inactiveResult(
      "INACTIVE_INTERNAL_INVARIANT_VIOLATION: reached the active branch without both required gates passing — failing closed. This indicates a bug above, not a data problem.",
      evidence,
      trail,
    );
  }

  const rawTilt = (evidence.escalationFinalScore - params.escalationThreshold) * params.tiltPctPerScorePoint;
  const allocationTiltPct = clamp(finite(rawTilt) ? rawTilt : 0, 0, params.maxTiltPct);

  const exitToleranceOverride: CrisisExitToleranceOverride = {
    baseRetraceFrac: clamp(
      DEFAULT_EXIT_BRAIN_PARAMS.baseRetraceFrac + params.baseRetraceFracWidenBy,
      DEFAULT_EXIT_BRAIN_PARAMS.baseRetraceFrac,
      params.maxBaseRetraceFrac,
    ),
    minRetraceFrac: clamp(
      DEFAULT_EXIT_BRAIN_PARAMS.minRetraceFrac + params.minRetraceFracWidenBy,
      DEFAULT_EXIT_BRAIN_PARAMS.minRetraceFrac,
      params.maxMinRetraceFrac,
    ),
    roundTripGuardR: clamp(
      DEFAULT_EXIT_BRAIN_PARAMS.roundTripGuardR - params.roundTripGuardRLowerBy,
      params.minRoundTripGuardR,
      DEFAULT_EXIT_BRAIN_PARAMS.roundTripGuardR,
    ),
  };

  const confirmationLegs = [
    evidence.btcShockConfirmed ? "BTC_LEADLAG_SHOCK" : null,
    evidence.regimeAxisConfirmed ? "RCS_BEARISH_AXIS" : null,
  ].filter((x): x is string => x !== null);

  const reasonLine =
    `ACTIVE: escalation finalScore=${evidence.escalationFinalScore.toFixed(1)} >= threshold=${params.escalationThreshold} AND market ` +
    `confirmation from [${confirmationLegs.join(", ")}] -> allocationTiltPct=${allocationTiltPct.toFixed(1)} (cap ${params.maxTiltPct}), exitToleranceOverride widened.`;
  trail.push(reasonLine);

  return {
    active: true,
    reason: reasonLine,
    allocationTiltPct,
    exitToleranceOverride,
    reasoning: trail,
    evidence,
  };
}

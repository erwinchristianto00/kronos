/**
 * Maps a 36H distribution prediction onto the basket's long/short leg split.
 *
 * SEPARATION OF CONCERNS
 * ----------------------
 *   CANONICAL ADMISSION -> WHEN a basket may open
 *   MOM36 ranking       -> WHO  (which symbols are strongest/weakest)
 *   this module         -> WHERE (is the next 36h up or down) and HOW STRONG
 *   existing exit       -> WHEN to leave
 *
 * MOM36 never decides direction here; it only orders candidates once the split is known.
 *
 * WHY THREE GATES AND NOT ONE NUMBER
 * ----------------------------------
 * Removing the hedge is the single most consequential thing this lane can do, and a high direction
 * probability alone does not justify it. P(up)=0.82 with an expected move of +4% and a -1% downside
 * tail is a different proposition from P(up)=0.82 with an expected move of +0.3% and a -7% tail —
 * the probability is identical and only one of them is worth un-hedging for. So an extreme rung
 * requires agreement from three independent readings:
 *
 *   DIRECTION  how confidently the distribution leans one way   (P_STRONG_UP - P_STRONG_DOWN)
 *   MAGNITUDE  how large the expected move is IN UNITS OF ITS OWN VOLATILITY (E[r] / vol)
 *   DOWNSIDE   how bad the adverse tail is in the same units    (Q10 / vol for longs)
 *
 * Normalising magnitude and downside by predicted volatility is deliberate: a +1% expected move is
 * decisive in a quiet tape and noise in a violent one, and the V2 label is itself volatility-
 * normalised, so the ladder speaks the same units the model was trained in.
 */

import type {
  DirectionPrediction,
  EnsemblePrediction,
  TrajectoryPrediction,
} from "./direction-model-runtime.js";

/**
 * What the ladder reads. V1/V2 supply the first four fields; V3 additionally supplies cross-horizon
 * agreement, calibrated confidence and cross-source agreement. Everything beyond the base four is
 * optional so one ladder serves every schema without branching on version.
 */
export interface LadderInput {
  directionScore: number;
  expectedReturn: number;
  q10: number;
  q90: number;
  expectedVol: number | null;
  /** V3: |sum(sign(p_up - p_down))| / n_horizons — 1 when all horizons lean the same way. */
  horizonAgreement?: number | null;
  /** V3: calibrated meta confidence in [0,1]. */
  confidence?: number | null;
  /** Fraction of external venues agreeing with the leaned direction, when known. */
  sourceAgreement?: number | null;
  /** V4: P(PERSISTENT_UP) - P(PERSISTENT_DOWN). The path-aware direction. */
  persistenceScore?: number | null;
  /** V4: total probability mass on the two reversal classes. */
  reversalRisk?: number | null;
  /** V4: most likely path class. */
  topPath?: string | null;
  /** V4: mean lean of 6h+12h and of 24h+36h. */
  earlyLean?: number | null;
  lateLean?: number | null;
}

/**
 * Adapts a V4 trajectory prediction.
 *
 * Direction comes from the PERSISTENCE score rather than the endpoint distribution. That is the
 * whole reason V4 exists: an endpoint probability cannot distinguish a trend that holds from a
 * sell-off that bottoms and bounces, and only the first is a reason to carry one-sided exposure
 * from the moment of formation.
 */
export function ladderInputFromTrajectory(
  pred: TrajectoryPrediction,
  sourceAgreement: number | null = null,
): LadderInput {
  return {
    directionScore: pred.persistenceScore,
    expectedReturn: pred.expectedReturn,
    q10: pred.q10,
    q90: pred.q90,
    expectedVol: pred.expectedVol,
    horizonAgreement: pred.horizonAgreement,
    confidence: pred.confidence,
    sourceAgreement,
    persistenceScore: pred.persistenceScore,
    reversalRisk: pred.reversalRisk,
    topPath: pred.topPath,
    earlyLean: pred.earlyLean,
    lateLean: pred.lateLean,
  };
}

/** Adapts a V1/V2 single-horizon prediction onto the ladder input. */
export function ladderInputFromPrediction(pred: DirectionPrediction): LadderInput {
  return {
    directionScore: pred.directionScore !== null ? pred.directionScore : 2 * pred.pUp - 1,
    expectedReturn: pred.expectedReturn,
    q10: pred.q10,
    q90: pred.q90,
    expectedVol: pred.expectedVol,
  };
}

/** Adapts a V3 ensemble prediction, carrying the extra agreement/confidence evidence. */
export function ladderInputFromEnsemble(
  pred: EnsemblePrediction,
  sourceAgreement: number | null = null,
): LadderInput {
  return {
    directionScore: pred.directionScore,
    expectedReturn: pred.expectedReturn,
    q10: pred.q10,
    q90: pred.q90,
    expectedVol: pred.expectedVol,
    horizonAgreement: pred.horizonAgreement,
    confidence: pred.confidence,
    sourceAgreement,
  };
}

export type AllocationState = "6L0S" | "5L1S" | "4L2S" | "3L3S" | "2L4S" | "1L5S" | "0L6S";

export interface AllocationDecision {
  longK: number;
  shortK: number;
  state: AllocationState;
  /** Signed [-1,1] blend of the three gates; sign is direction, magnitude is conviction. */
  conviction: number;
  /** The individual gate readings, so a decision can be explained after the fact. */
  gates: {
    direction: number | null;
    magnitude: number | null;
    downside: number | null;
    /** V4: why the path blocked (or did not block) an extreme rung. */
    pathVeto: string | null;
  };
  /** Set when a cap or guard moved the split away from what the gates alone implied. */
  clampedFrom: AllocationState | null;
  reason: string;
}

/** Total legs in a basket. Explicit so a future k-change cannot silently desync the table. */
export const DIRECTION_ALLOCATION_TOTAL_LEGS = 6;

/**
 * Maximum legs allowed on the dominant side.
 *
 * 6 permits the fully one-sided 6L0S / 0L6S states. Lowering it to 4 or 5 keeps a hedge leg on
 * every basket without a code change — the operator control for "I want the tilt but never a naked
 * directional book". Read from env at call time so it can be tightened by restart alone.
 */
export function maxDominantLegs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.DIRECTION_MODEL_MAX_DOMINANT_LEGS);
  if (!Number.isFinite(raw)) return DIRECTION_ALLOCATION_TOTAL_LEGS;
  return Math.max(3, Math.min(DIRECTION_ALLOCATION_TOTAL_LEGS, Math.trunc(raw)));
}

const STATE_BY_LONG_K: Record<number, AllocationState> = {
  6: "6L0S", 5: "5L1S", 4: "4L2S", 3: "3L3S", 2: "2L4S", 1: "1L5S", 0: "0L6S",
};

/**
 * Rungs, most-bullish first. `minDirection` is on the class-probability spread; `minMagnitude` and
 * `maxDownside` are in volatility units. A rung is taken only when ALL THREE clear — which is what
 * stops a single confident-but-small or confident-but-fragile reading from un-hedging the book.
 */
const LADDER: Array<{ longK: number; minDirection: number; minMagnitude: number; maxDownside: number }> = [
  { longK: 6, minDirection: 0.55, minMagnitude: 0.80, maxDownside: 0.50 },
  { longK: 5, minDirection: 0.35, minMagnitude: 0.50, maxDownside: 0.90 },
  { longK: 4, minDirection: 0.15, minMagnitude: 0.20, maxDownside: 1.50 },
];

/** Fallback volatility when the model has no vol head (V1 artifacts), so units stay comparable. */
const DEFAULT_VOL = 0.02;

function gatesFor(pred: LadderInput): {
  direction: number | null;
  magnitude: number | null;
  downside: number | null;
} {
  const vol = pred.expectedVol !== null && pred.expectedVol !== undefined && pred.expectedVol > 1e-9
    ? pred.expectedVol : DEFAULT_VOL;
  const direction = pred.directionScore;
  const magnitude = Number.isFinite(pred.expectedReturn) ? pred.expectedReturn / vol : null;
  // Downside is the adverse tail for the direction being considered, expressed as a positive
  // number of volatilities: for a long lean that is |Q10|, for a short lean it is Q90.
  const downside = direction >= 0
    ? (Number.isFinite(pred.q10) ? Math.max(0, -pred.q10) / vol : null)
    : (Number.isFinite(pred.q90) ? Math.max(0, pred.q90) / vol : null);
  return { direction, magnitude, downside };
}

/** Reversal mass above which the extreme, hedge-removing rungs are refused outright. */
const REVERSAL_RISK_CEILING = 0.25;

/**
 * Minimum |earlyLean| that counts as the early half actually leaning.
 *
 * Without a deadband the veto fires on noise: an earlyLean of 0.022 against a direction score of
 * -0.006 is two readings that are both essentially zero, and treating that as "the early leg
 * opposes the trade" makes the veto a coin flip rather than a signal. The bar is set where the lean
 * is a real minority of the probability range, not a rounding artefact.
 */
const EARLY_LEAN_DEADBAND = 0.10;

/**
 * Does the predicted PATH permit a one-sided book?
 *
 * Returns a reason string when it does not. Three separate refusals, each for a distinct failure the
 * endpoint view is blind to:
 *
 *   a reversal class is the most likely path — the endpoint may be positive precisely BECAUSE the
 *     market falls first and bounces, which is the worst possible moment to be one-sided at entry;
 *   reversal probability is materially large even if not the mode — contested, not confident;
 *   the early half of the path disagrees with the direction being taken — the position would be
 *     underwater before the thesis even begins.
 *
 * Absent trajectory evidence (V1/V2/V3 artifacts) returns null, so older models are unaffected.
 */
function pathVetoFor(pred: LadderInput, bullish: boolean, wantsExtreme: boolean): string | null {
  if (!wantsExtreme) return null;
  const top = pred.topPath ?? null;
  if (top === "UP_THEN_REVERSAL" || top === "DOWN_THEN_REVERSAL") {
    return `top path ${top}`;
  }
  const rr = pred.reversalRisk;
  if (rr !== null && rr !== undefined && rr > REVERSAL_RISK_CEILING) {
    return `reversal risk ${rr.toFixed(2)} > ${REVERSAL_RISK_CEILING}`;
  }
  const early = pred.earlyLean;
  if (early !== null && early !== undefined && Math.abs(early) >= EARLY_LEAN_DEADBAND) {
    if (bullish && early < 0) return `early leg leans down (${early.toFixed(3)})`;
    if (!bullish && early > 0) return `early leg leans up (${early.toFixed(3)})`;
  }
  return null;
}

export function allocationFor(
  pred: LadderInput,
  env: NodeJS.ProcessEnv = process.env,
): AllocationDecision {
  const gates = gatesFor(pred);
  const dir = gates.direction ?? 0;
  const mag = gates.magnitude;
  const dn = gates.downside;
  const bullish = dir >= 0;

  let longK = 3;
  let matched: typeof LADDER[number] | null = null;
  let pathVeto: string | null = null;
  if (mag !== null && dn !== null) {
    for (const rung of LADDER) {
      const directionOk = Math.abs(dir) >= rung.minDirection;
      // Magnitude must point the SAME way as direction; a confident "up" with a negative expected
      // return is an internally inconsistent reading and must not reach an extreme rung.
      const magnitudeOk = bullish ? mag >= rung.minMagnitude : mag <= -rung.minMagnitude;
      const downsideOk = dn <= rung.maxDownside;
      // V3 adds a fourth requirement for the two most extreme rungs: the horizons must actually
      // agree. "6/12 bearish then 24/36 bullish" and "all four bullish" can produce the same 36h
      // probability, and only the second is a reason to remove the hedge. When the evidence is
      // absent (V1/V2 artifacts) this is skipped rather than blocking, so older models behave as
      // they did before.
      const wantsExtreme = rung.longK >= 5;
      const agreement = pred.horizonAgreement;
      const agreementOk = !wantsExtreme || agreement === null || agreement === undefined
        || agreement >= 0.75;
      const conf = pred.confidence;
      const confidenceOk = !wantsExtreme || conf === null || conf === undefined || conf >= 0.35;
      const veto = pathVetoFor(pred, bullish, wantsExtreme);
      if (veto !== null) {
        pathVeto = veto;
        continue; // this rung is refused; a lower, hedged rung may still be taken
      }
      if (directionOk && magnitudeOk && downsideOk && agreementOk && confidenceOk) {
        matched = rung;
        longK = bullish ? rung.longK : DIRECTION_ALLOCATION_TOTAL_LEGS - rung.longK;
        break;
      }
    }
  }

  const uncapped = STATE_BY_LONG_K[longK];
  const cap = maxDominantLegs(env);
  const minLegs = DIRECTION_ALLOCATION_TOTAL_LEGS - cap;
  const cappedLongK = Math.max(minLegs, Math.min(cap, longK));
  const shortK = DIRECTION_ALLOCATION_TOTAL_LEGS - cappedLongK;
  const state = STATE_BY_LONG_K[cappedLongK];

  // Conviction is reported for observability only; the ladder itself is decided by the gates.
  const conviction = matched === null
    ? 0
    : Math.max(-1, Math.min(1, (Math.abs(dir) + Math.min(1, Math.abs(mag ?? 0))) / 2 * (bullish ? 1 : -1)));

  const agreeTxt = pred.horizonAgreement === null || pred.horizonAgreement === undefined
    ? "" : ` agree=${pred.horizonAgreement.toFixed(2)}`;
  const confTxt = pred.confidence === null || pred.confidence === undefined
    ? "" : ` conf=${pred.confidence.toFixed(2)}`;
  const pathTxt = pred.topPath ? ` path=${pred.topPath}` : "";
  const vetoTxt = pathVeto ? ` VETO(${pathVeto})` : "";
  const detail = `dir=${dir.toFixed(3)} mag=${mag === null ? "n/a" : mag.toFixed(2)}σ `
    + `downside=${dn === null ? "n/a" : dn.toFixed(2)}σ${agreeTxt}${confTxt}${pathTxt}${vetoTxt}`;
  return {
    longK: cappedLongK,
    shortK,
    state,
    conviction,
    gates: { ...gates, pathVeto },
    clampedFrom: state === uncapped ? null : uncapped,
    reason: state === uncapped
      ? (matched === null ? `no rung cleared (${detail}) -> 3L3S` : `${detail} -> ${state}`)
      : `${detail} -> ${uncapped}, capped to ${state} by DIRECTION_MODEL_MAX_DOMINANT_LEGS=${cap}`,
  };
}

/** The canonical fallback split used whenever the model cannot be trusted. */
export function canonicalAllocation(): AllocationDecision {
  return {
    longK: 3,
    shortK: 3,
    state: "3L3S",
    conviction: 0,
    gates: { direction: null, magnitude: null, downside: null, pathVeto: null },
    clampedFrom: null,
    reason: "canonical 3L3S fallback",
  };
}

/**
 * Whether the model is permitted to move the split at all.
 *
 * V2 did not pass its holdout acceptance gate (balanced accuracy below chance, expected-return
 * correlation CI including zero, directional hit-rate CI including 0.5). The operator's own
 * instruction for that outcome is to deploy the infrastructure with allocation held at canonical —
 * so this is the switch that separates "model runs and is observed" from "model steers money".
 * Off by default: a model must be explicitly promoted, never active by accident.
 */
export function isDirectionalAllocationActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DIRECTION_MODEL_ALLOCATION_ACTIVE === "1";
}

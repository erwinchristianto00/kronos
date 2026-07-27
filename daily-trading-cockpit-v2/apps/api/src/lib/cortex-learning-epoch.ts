/**
 * Forward-only CORTEX learning epoch. Historical artifacts stay on disk for audit, but only
 * decisions and positions opened on/after this boundary may train or promote the current model.
 */
export const CORTEX_LEARNING_EPOCH_ENV = "CORTEX_LEARNING_EPOCH_START_ISO";

export interface CortexLearningEpoch {
  id: "POST_LINEAGE_V2";
  startIso: string;
  startMs: number;
}

/** Why a configured epoch was refused. Surfaced in the readiness payload — never only logged. */
export interface CortexLearningEpochRejection {
  reason: "MALFORMED" | "IN_FUTURE";
  raw: string;
  /** Parsed boundary. null for MALFORMED, which by definition did not parse. */
  startMs: number | null;
  nowMs: number;
  /** How far ahead of now the boundary sits. null for MALFORMED. */
  aheadMs: number | null;
}

export interface CortexLearningEpochResolution {
  epoch: CortexLearningEpoch | null;
  rejection: CortexLearningEpochRejection | null;
}

/**
 * 2026-07-27: a FUTURE boundary is refused rather than applied.
 *
 * The filter below excludes every row before `startMs`, so a boundary set even slightly ahead of
 * the clock excludes *everything* — CORTEX trains on nothing while the meter reads a perfectly
 * innocent 0%, which is exactly what a deliberate soft reset also looks like. That state ran for
 * 75 minutes on both 3101 and 3102 (configured 05:02:54Z against a 03:47Z clock, a 2h timezone
 * slip) and was caught only because someone happened to compare the two by eye.
 *
 * Refusing is the safer of the two failure modes, and the reason is that it is LOUD: with no epoch
 * nothing is filtered, so readiness stays at its historical value instead of dropping to zero. An
 * operator who expected a reset sees the number that did NOT move and asks why. The opposite
 * failure — filtering everything — produces the number they were expecting, so nobody asks.
 *
 * Deliberately NOT clamped to now: clamping would silently rewrite the operator's stated boundary
 * into a different one, which is a second silent failure wearing the first one's clothes.
 *
 * Consequence worth stating: scheduling a boundary in advance ("start the new cohort at midnight")
 * is not supported — such a value is refused until the clock passes it. `rejection` is returned so
 * the caller can show that, rather than leaving the operator to infer it from an unchanged meter.
 */
export function resolveCortexLearningEpoch(
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): CortexLearningEpochResolution {
  const raw = (env[CORTEX_LEARNING_EPOCH_ENV] ?? "").trim();
  if (!raw) return { epoch: null, rejection: null };
  const startMs = Date.parse(raw);
  if (!Number.isFinite(startMs)) {
    return { epoch: null, rejection: { reason: "MALFORMED", raw, startMs: null, nowMs, aheadMs: null } };
  }
  if (startMs > nowMs) {
    return {
      epoch: null,
      rejection: { reason: "IN_FUTURE", raw, startMs, nowMs, aheadMs: startMs - nowMs },
    };
  }
  return {
    epoch: { id: "POST_LINEAGE_V2", startIso: new Date(startMs).toISOString(), startMs },
    rejection: null,
  };
}

export function cortexLearningEpoch(
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): CortexLearningEpoch | null {
  return resolveCortexLearningEpoch(env, nowMs).epoch;
}

export function filterCortexLearningEpochRows<
  TDecision extends { atMs: number },
  TOutcome extends { openedAtMs: number; resolvedAtMs: number },
>(
  decisions: TDecision[],
  outcomes: TOutcome[],
  epoch: CortexLearningEpoch | null,
): {
  decisions: TDecision[];
  outcomes: TOutcome[];
  decisionRowsExcluded: number;
  transitionalOutcomesExcluded: number;
} {
  if (!epoch) {
    return {
      decisions,
      outcomes,
      decisionRowsExcluded: 0,
      transitionalOutcomesExcluded: 0,
    };
  }
  const eligibleDecisions = decisions.filter((row) => row.atMs >= epoch.startMs);
  const eligibleOutcomes = outcomes.filter(
    (outcome) =>
      outcome.openedAtMs >= epoch.startMs
      && outcome.resolvedAtMs >= epoch.startMs,
  );
  return {
    decisions: eligibleDecisions,
    outcomes: eligibleOutcomes,
    decisionRowsExcluded: decisions.length - eligibleDecisions.length,
    transitionalOutcomesExcluded: outcomes.length - eligibleOutcomes.length,
  };
}

/**
 * CORTEX #218 — nightly refit runner (PURE core; the impure store/journal reads are injected). Ties the
 * pieces together, ONCE per night:
 *   decisions (journal) + outcomes (each lane's own resolved closes)
 *     → attributeOutcomes (strict, one-owning-decision, one-outcome-once)
 *     → per-ARCHETYPE logistic refit (write ONLY on ACCEPTED)
 *     → advance cumulativeResolved + resolvedByFamily via the monotonic watermark
 *     → a promotion-gate coverage report (capital coverage + regime coverage of RESOLVED outcomes).
 *
 * SAFETY (operator hard rules): this NEVER touches CORTEX_LIVE_BETA. Refitting updates the archetype
 * COEFFICIENTS only; at liveBeta=0 the learned channel carries zero weight in the operational allocation,
 * so learning proceeds while the live allocation stays the β=0 post-veto incumbent. The report is
 * report-only — promotion still requires the full pre-registered gate + explicit operator approval.
 */
import {
  refitArchetypeCoefficients,
  evaluationBeta,
  CORTEX_LIVE_BETA,
  CORTEX_FEATURE_SCHEMA_VERSION,
  type CortexArchetype,
  type CortexRefitStatus,
  type CortexTrainingExample,
} from "./cortex-brain.js";
import type { CortexBrainStore } from "./cortex-brain-store.js";
import {
  attributeOutcomes,
  cortexBlindCapitalPct,
  cortexRegimeFamilyCoverage,
  type CortexAttrRosterEntry,
  type CortexAttributedExample,
  type CortexDecisionRow,
  type CortexLaneAttributionStatus,
  type CortexLaneOutcome,
} from "./cortex-attribution.js";
import type { CortexOutcomeSkipReason } from "./cortex-outcome-source.js";

const ARCHETYPES: CortexArchetype[] = ["BREADTH", "NEUTRAL", "TACTICAL"];
/** ≥2 regime families of RESOLVED labeled outcomes is the coverage half of the promotion gate. */
export const CORTEX_GATE_MIN_REGIME_FAMILIES = 2;

export interface CortexRefitInput {
  decisions: CortexDecisionRow[];
  outcomes: CortexLaneOutcome[];
  roster: CortexAttrRosterEntry[];
  nowMs: number;
  nowIso: string;
  currentSchemaVersion?: number;
  ttlMsForLane?: (laneId: string) => number;
  minExamplesForActive?: number;
  /** Per-lane tally of outcomes the source layer could NOT normalize (surfaced, never silent). */
  skipsByLane?: Record<string, Partial<Record<CortexOutcomeSkipReason, number>>>;
  /** Prune the counted-observation ledger of ids older than this (should be ≤ the bindings' lookback so a
   *  still-attributable outcome is never pruned then re-counted). Defaults to nowMs − 60d. */
  pruneBeforeMs?: number;
  /** If true, apply ACCEPTED refits + advance counters + save. Default true; false = dry-run report. */
  apply?: boolean;
}

export interface CortexArchetypeRefit {
  archetype: CortexArchetype;
  examples: number;
  status: CortexRefitStatus | "NO_EXAMPLES";
  applied: boolean;
  nEff: number;
}

/** Label counts for examples that passed strict ownership attribution. This is observability only:
 * it explains what the learner saw without exposing a coefficient update as a trading decision. */
export interface CortexLaneReinforcementSummary {
  laneId: string;
  positive: number;
  noReward: number;
}

export interface CortexPromotionCoverage {
  cumulativeResolved: number;
  resolvedByFamily: Record<string, number>;
  regimeFamiliesWithOutcomes: number;
  regimeCoverageGateMet: boolean;
  /** Σ static weight of roster lanes NOT LEARNING_ACTIVE — the capital the brain would tilt blind. */
  blindCapitalPct: number;
  learningActiveLanes: number;
  /** Always 0 until the full gate + approval. Surfaced so the report can never imply β auto-rose. */
  liveBeta: number;
  /** SHADOW-only counterfactual β at the current sample (decision-alpha simulation only). */
  evaluationBeta: number;
}

export interface CortexRefitReport {
  at: string;
  examplesTotal: number;
  examplesNew: number;
  perLane: CortexLaneAttributionStatus[];
  archetypes: CortexArchetypeRefit[];
  reinforcementByLane: CortexLaneReinforcementSummary[];
  coverage: CortexPromotionCoverage;
  skipsByLane: Record<string, Partial<Record<CortexOutcomeSkipReason, number>>>;
  applied: boolean;
  /** The exact attributeOutcomes() output this run computed (2026-07-22 bug-hunt fix): exposed so
   *  callers that need the raw attributed examples (e.g. decision-alpha reporting) can reuse this
   *  run's result instead of re-running the full sort+per-lane-search+dedupe walk a second time on
   *  identical inputs — attributeOutcomes is real, non-trivial CPU work, not a cheap lookup. */
  examples: CortexAttributedExample[];
}

/**
 * Run one refit pass over already-read decisions + outcomes. Pure aside from the store mutations it makes
 * when apply !== false (applyRefit on ACCEPTED, recordResolvedOutcomes, save) — all of which are idempotent
 * and never touch liveBeta.
 */
export function runCortexRefit(store: CortexBrainStore, input: CortexRefitInput): CortexRefitReport {
  const apply = input.apply !== false;
  const currentSchemaVersion = input.currentSchemaVersion ?? CORTEX_FEATURE_SCHEMA_VERSION;

  const attr = attributeOutcomes(input.decisions, input.outcomes, {
    currentSchemaVersion,
    roster: input.roster,
    ttlMsForLane: input.ttlMsForLane,
    minExamplesForActive: input.minExamplesForActive,
  });

  // Count only outcomes not already in the persisted exact-once ledger (idempotent, out-of-order-safe —
  // NOT a scalar resolvedAt watermark, which under-counts on candle-time resolution). Dry-run counts via
  // the read-only membership check; the apply path folds them in below.
  const examplesNew = apply
    ? 0 // set from the store's return after recordResolvedOutcomes
    : attr.examples.filter((e) => !store.hasCountedObservation(e.laneId, e.observationId)).length;

  // Per-archetype refit on the FULL derivable example set (recency-decayed inside the refit). Write only on
  // ACCEPTED — a rejected fit leaves the last healthy coefficients untouched.
  const byArch = new Map<CortexArchetype, CortexTrainingExample[]>();
  const reinforcementByLane = new Map<string, CortexLaneReinforcementSummary>();
  for (const a of ARCHETYPES) byArch.set(a, []);
  for (const e of attr.examples) {
    byArch.get(e.archetype)?.push({ x: e.x, y: e.y, tMs: e.tMs, schemaVersion: e.schemaVersion });
    const summary = reinforcementByLane.get(e.laneId) ?? { laneId: e.laneId, positive: 0, noReward: 0 };
    if (e.y === 1) summary.positive += 1;
    else summary.noReward += 1;
    reinforcementByLane.set(e.laneId, summary);
  }

  const archetypes: CortexArchetypeRefit[] = [];
  for (const a of ARCHETYPES) {
    const ex = byArch.get(a)!;
    if (ex.length === 0) {
      archetypes.push({ archetype: a, examples: 0, status: "NO_EXAMPLES", applied: false, nEff: store.get().archetypes[a].nEff });
      continue;
    }
    const result = refitArchetypeCoefficients(ex, store.get().archetypes[a].w, { nowMs: input.nowMs });
    const applied = apply ? store.applyRefit(a, result, input.nowIso) : result.status === "ACCEPTED";
    archetypes.push({ archetype: a, examples: ex.length, status: result.status, applied, nEff: result.nEff });
  }

  let newlyCounted = examplesNew;
  if (apply) {
    const pruneBeforeMs = input.pruneBeforeMs ?? input.nowMs - 60 * 86_400_000;
    newlyCounted = store.recordResolvedOutcomes(
      attr.examples.map((e) => ({ laneId: e.laneId, observationId: e.observationId, regimeFamily: e.regimeFamily, resolvedAtMs: e.resolvedAtMs })),
      pruneBeforeMs,
      input.nowIso,
    );
    store.save();
  }

  const s = store.get();
  const learningActiveLanes = attr.perLane.filter((l) => l.status === "LEARNING_ACTIVE").length;
  const regimeFamiliesWithOutcomes = cortexRegimeFamilyCoverage(s.resolvedByFamily);
  const coverage: CortexPromotionCoverage = {
    cumulativeResolved: s.cumulativeResolved,
    resolvedByFamily: { ...s.resolvedByFamily },
    regimeFamiliesWithOutcomes,
    regimeCoverageGateMet: regimeFamiliesWithOutcomes >= CORTEX_GATE_MIN_REGIME_FAMILIES,
    blindCapitalPct: cortexBlindCapitalPct(attr.perLane),
    learningActiveLanes,
    liveBeta: CORTEX_LIVE_BETA,
    evaluationBeta: evaluationBeta(s.cumulativeResolved),
  };

  return {
    at: input.nowIso,
    examplesTotal: attr.examples.length,
    examplesNew: newlyCounted,
    perLane: attr.perLane,
    archetypes,
    reinforcementByLane: [...reinforcementByLane.values()].sort((a, b) => a.laneId.localeCompare(b.laneId)),
    coverage,
    skipsByLane: input.skipsByLane ?? {},
    applied: apply,
    examples: attr.examples,
  };
}

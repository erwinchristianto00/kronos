/**
 * Strict adapter from forward causal events to CORTEX training rows.
 *
 * It never performs a time-nearest join. Every emitted row has a persisted
 * paper decision/opportunity/outcome chain plus the exact CORTEX x that was
 * handed to paper admission. Any missing link is counted and rejected.
 */
import { CORTEX_FEATURE_DIM, CORTEX_FEATURE_SCHEMA_VERSION } from "../lib/cortex-brain.js";
import type { CortexDecisionRow, CortexLaneOutcome } from "../lib/cortex-attribution.js";
import { cortexOutcomeLaneMeta } from "../lib/cortex-outcome-source.js";
import { candidateLearningRows, normalizeExperience, type ExperienceRecord } from "./experience-engine.js";
import type {
  CanonicalPolicyContext,
  CausalIdentity,
  DecisionSnapshotEvent,
  ForwardEvent,
  OpportunityOpenEvent,
  OutcomeResolutionEvent,
} from "./forward-causal-collection.js";

export interface CortexExperienceBridgeResult {
  decisions: CortexDecisionRow[];
  outcomes: CortexLaneOutcome[];
  experiences: ExperienceRecord[];
  rejected: Record<string, number>;
}

/** Feature-only provenance for real CORTEX learning. Unlike the legacy paper-experience bridge,
 * this intentionally stops at admission: Executive Review supplies economics later. */
export interface CortexFeatureProvenance {
  readonly identity: CausalIdentity;
  readonly decisionEvent: DecisionSnapshotEvent;
  readonly opportunityEvent: OpportunityOpenEvent;
  readonly decision: CortexDecisionRow;
}
export interface CortexFeatureProvenanceResult {
  readonly rows: readonly CortexFeatureProvenance[];
  readonly rejected: Readonly<Record<string, number>>;
}

/** Reconstruct exact CORTEX features from the append-only decision/open pair only. This has no
 * paper outcome dependency and therefore cannot leak paper exit economics into a real Tier-1 label. */
export function buildCortexFeatureProvenance(
  events: readonly ForwardEvent[],
  expectedPolicy: CanonicalPolicyContext,
): CortexFeatureProvenanceResult {
  const decisions = new Map<string, DecisionSnapshotEvent>();
  const opens = new Map<string, OpportunityOpenEvent>();
  const duplicateDecisionIds = new Set<string>();
  const duplicateOpportunityIds = new Set<string>();
  const rejected: Record<string, number> = {};
  for (const event of events) {
    if (event.eventType === "DECISION_SNAPSHOT") {
      if (decisions.has(event.identity.decisionId)) { duplicateDecisionIds.add(event.identity.decisionId); bump(rejected, "duplicate_decision"); }
      else decisions.set(event.identity.decisionId, event);
    }
    if (event.eventType === "OPPORTUNITY_OPEN") {
      if (opens.has(event.identity.opportunityId)) { duplicateOpportunityIds.add(event.identity.opportunityId); bump(rejected, "duplicate_opportunity"); }
      else opens.set(event.identity.opportunityId, event);
    }
  }
  const rows: CortexFeatureProvenance[] = [];
  for (const open of opens.values()) {
    if (duplicateOpportunityIds.has(open.identity.opportunityId) || duplicateDecisionIds.has(open.decisionId)) {
      bump(rejected, "ambiguous_duplicate_provenance"); continue;
    }
    const decision = decisions.get(open.decisionId);
    if (!decision) { bump(rejected, "missing_decision_snapshot"); continue; }
    const sameIdentity =
      decision.identity.decisionId === open.identity.decisionId &&
      decision.identity.opportunityId === open.identity.opportunityId &&
      decision.identity.outcomeId === null && open.identity.outcomeId === null &&
      decision.identity.instanceId === open.identity.instanceId &&
      decision.identity.laneId === open.identity.laneId &&
      decision.identity.symbolOrBasketId === open.identity.symbolOrBasketId &&
      decision.identity.direction === open.identity.direction &&
      decision.identity.allocationSnapshotId === open.identity.allocationSnapshotId &&
      decision.identity.cortexDecisionId === open.identity.cortexDecisionId;
    if (!sameIdentity) { bump(rejected, "identity_mismatch"); continue; }
    if (!identityMatchesCurrentPolicy(decision.identity, expectedPolicy) || !identityMatchesCurrentPolicy(open.identity, expectedPolicy)) {
      bump(rejected, "stale_or_mismatched_policy_identity"); continue;
    }
    const cortex = decision.cortexTraining;
    if (
      cortex.status !== "PRESENT" || !cortex.decisionId || !finite(cortex.snapshotAtMs) ||
      cortex.decisionId !== decision.identity.cortexDecisionId ||
      cortex.featureSchemaVersion !== decision.identity.cortexFeatureSchemaVersion ||
      cortex.featureSchemaVersion !== CORTEX_FEATURE_SCHEMA_VERSION ||
      !Array.isArray(cortex.featureVector) || cortex.featureVector.length !== CORTEX_FEATURE_DIM || !cortex.featureVector.every(finite)
    ) { bump(rejected, "missing_or_incompatible_cortex_snapshot"); continue; }
    if (
      cortex.snapshotAtMs > decision.asOfMs || decision.asOfMs > open.openedAtMs ||
      Object.values(decision.features.sourceStatuses).some((status) => status === "ERROR")
    ) { bump(rejected, "invalid_feature_provenance_clock"); continue; }
    const meta = cortexOutcomeLaneMeta(decision.identity.laneId);
    if (!meta || (meta.direction !== "NEUTRAL" && meta.direction !== decision.identity.direction)) { bump(rejected, "lane_direction_mismatch"); continue; }
    rows.push({
      identity: decision.identity,
      decisionEvent: decision,
      opportunityEvent: open,
      decision: {
        decisionId: cortex.decisionId,
        atMs: decision.asOfMs,
        featureSchemaVersion: cortex.featureSchemaVersion,
        regimeFamily: cortex.regimeFamily ?? "UNKNOWN",
        lanes: new Map([[meta.laneId, {
          x: [...cortex.featureVector], eligible: cortex.eligible === true, direction: meta.direction,
          finalPct: finite(cortex.finalPct) ? cortex.finalPct : 0,
          evalFinalPct: finite(cortex.evalFinalPct) ? cortex.evalFinalPct : 0,
        }]]),
      },
    });
  }
  return { rows, rejected };
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const bump = (counts: Record<string, number>, reason: string): void => { counts[reason] = (counts[reason] ?? 0) + 1; };
const economicallyConsistent = (grossR: unknown, costR: unknown, netR: unknown): boolean =>
  finite(grossR) && finite(costR) && finite(netR) && Math.abs((grossR + costR) - netR) <= 1e-9;
// Exact match only. A V1/mismatched-policy identity must never produce a candidate-learning row
// even when its own embedded timestamps look internally consistent — this is what stops a stale
// or forged pre-cutover chain from being read as current-era evidence.
const identityMatchesCurrentPolicy = (identity: CausalIdentity, expected: CanonicalPolicyContext): boolean =>
  identity.decisionPolicyVersion === expected.decisionPolicyVersion &&
  identity.executionPolicyVersion === expected.executionPolicyVersion &&
  identity.evidencePolicyVersion === expected.evidencePolicyVersion &&
  identity.evidenceEra === expected.evidenceEra &&
  identity.policyDeploymentAt === expected.policyDeploymentAt;

/**
 * `expectedPolicy` is supplied by the runtime caller (see cortex-refit-runner-bindings.ts) rather
 * than read from process.env here — this module stays a pure function of its inputs so the exact
 * "current policy" it enforces is always visible at the call site, not hidden inside a helper.
 */
export function buildCortexExperienceBridge(
  events: readonly ForwardEvent[],
  expectedPolicy: CanonicalPolicyContext,
): CortexExperienceBridgeResult {
  const paperDecisions = new Map<string, DecisionSnapshotEvent>();
  const opportunities = new Map<string, OpportunityOpenEvent>();
  const outcomes: OutcomeResolutionEvent[] = [];
  for (const event of events) {
    if (event.eventType === "DECISION_SNAPSHOT" && !paperDecisions.has(event.identity.decisionId)) paperDecisions.set(event.identity.decisionId, event);
    if (event.eventType === "OPPORTUNITY_OPEN" && !opportunities.has(event.identity.opportunityId)) opportunities.set(event.identity.opportunityId, event);
    if (event.eventType === "OUTCOME_RESOLUTION") outcomes.push(event);
  }

  const decisionsByKey = new Map<string, CortexDecisionRow>();
  const cortexOutcomes: CortexLaneOutcome[] = [];
  const experiences: ExperienceRecord[] = [];
  const rejected: Record<string, number> = {};
  const consumedOutcomeIds = new Set<string>();

  for (const outcome of outcomes) {
    if (consumedOutcomeIds.has(outcome.outcomeId)) { bump(rejected, "duplicate_outcome"); continue; }
    consumedOutcomeIds.add(outcome.outcomeId);
    const opportunity = opportunities.get(outcome.opportunityId);
    const decision = paperDecisions.get(outcome.decisionId);
    if (!opportunity || !decision) { bump(rejected, "missing_direct_chain"); continue; }
    if (
      opportunity.decisionId !== decision.identity.decisionId ||
      outcome.decisionId !== decision.identity.decisionId ||
      outcome.opportunityId !== opportunity.identity.opportunityId ||
      outcome.identity.decisionId !== decision.identity.decisionId ||
      outcome.identity.opportunityId !== opportunity.identity.opportunityId
    ) { bump(rejected, "identity_mismatch"); continue; }
    // A V1 or otherwise stale-policy identity can be internally self-consistent (its own
    // decisionId/opportunityId links line up) while still carrying an old policy generation —
    // that must not become a candidate-learning row regardless of how valid its embedded
    // decision/open timestamps look against ITS OWN policyDeploymentAt.
    if (
      !identityMatchesCurrentPolicy(decision.identity, expectedPolicy) ||
      !identityMatchesCurrentPolicy(opportunity.identity, expectedPolicy) ||
      !identityMatchesCurrentPolicy(outcome.identity, expectedPolicy)
    ) { bump(rejected, "stale_or_mismatched_policy_identity"); continue; }
    // Pre-hardening journals do not carry a CORTEX snapshot. Treat them as
    // ineligible legacy evidence instead of allowing a malformed row to abort
    // an otherwise report-only refit pass.
    const cortex = decision.cortexTraining;
    if (
      !cortex || cortex.status !== "PRESENT" || !cortex.decisionId ||
      cortex.decisionId !== outcome.identity.cortexDecisionId ||
      cortex.featureSchemaVersion !== outcome.identity.cortexFeatureSchemaVersion ||
      cortex.featureSchemaVersion !== CORTEX_FEATURE_SCHEMA_VERSION ||
      !Array.isArray(cortex.featureVector) || cortex.featureVector.length !== CORTEX_FEATURE_DIM || !cortex.featureVector.every(finite)
    ) { bump(rejected, "missing_or_incompatible_cortex_snapshot"); continue; }
    if (
      !finite(decision.asOfMs) || decision.asOfMs > outcome.openedAtMs ||
      outcome.openedAtMs > outcome.closedAtMs || outcome.closedAtMs > outcome.resolvedAtMs ||
      outcome.outcomeQuality !== "RESOLVED_VALID" || !economicallyConsistent(outcome.grossR, outcome.costR, outcome.netR) ||
      Object.values(decision.features.sourceStatuses).some((status) => status === "ERROR")
    ) { bump(rejected, "causal_outcome_cost_or_quality_failure"); continue; }
    const meta = cortexOutcomeLaneMeta(outcome.identity.laneId);
    if (!meta || (meta.direction !== "NEUTRAL" && meta.direction !== outcome.identity.direction)) { bump(rejected, "lane_direction_mismatch"); continue; }

    const experience = normalizeExperience({
      experienceId: `cortex:${outcome.outcomeId}`,
      decisionId: cortex.decisionId,
      opportunityId: opportunity.identity.opportunityId,
      outcomeId: outcome.outcomeId,
      source: "OBSERVED_SHADOW_OUTCOME",
      provenance: "OBSERVED",
      decisionTimeMs: decision.asOfMs,
      openedTimeMs: outcome.openedAtMs,
      policyDeploymentAt: decision.identity.policyDeploymentAt,
      marketCloseTimeMs: outcome.closedAtMs,
      resolvedTimeMs: outcome.resolvedAtMs,
      laneId: outcome.identity.laneId,
      symbolOrBasketId: outcome.identity.symbolOrBasketId,
      direction: outcome.identity.direction === "LONG" || outcome.identity.direction === "SHORT"
        ? outcome.identity.direction
        : "FLAT",
      featureSchemaVersion: String(cortex.featureSchemaVersion),
      codeVersion: decision.codeVersion,
      featureVector: [...cortex.featureVector],
      sourceStatuses: decision.features.sourceStatuses,
      attributionStatus: "ATTRIBUTED",
      outcomeQuality: "RESOLVED_VALID",
      outcomeNetR: outcome.netR,
      labels: { entry: "ENTER_NOW", exit: "INCUMBENT_TP_SL", allocationMultiple: 1 },
      executionLabelKind: "PAPER_OUTCOME",
    });
    experiences.push(experience);
    if (candidateLearningRows([experience]).length === 0) { bump(rejected, "experience_ineligible"); continue; }

    const key = `${cortex.decisionId}\u001f${meta.laneId}`;
    if (!decisionsByKey.has(key)) {
      decisionsByKey.set(key, {
        decisionId: cortex.decisionId,
        atMs: decision.asOfMs,
        featureSchemaVersion: cortex.featureSchemaVersion,
        regimeFamily: cortex.regimeFamily ?? "UNKNOWN",
        lanes: new Map([[meta.laneId, {
          x: [...cortex.featureVector],
          eligible: cortex.eligible === true,
          direction: meta.direction,
          finalPct: finite(cortex.finalPct) ? cortex.finalPct : 0,
          evalFinalPct: finite(cortex.evalFinalPct) ? cortex.evalFinalPct : 0,
        }]]),
      });
    }
    cortexOutcomes.push({
      laneId: meta.laneId,
      archetype: meta.archetype,
      direction: meta.direction,
      observationId: outcome.outcomeId,
      openedAtMs: outcome.openedAtMs,
      resolvedAtMs: outcome.resolvedAtMs,
      netR: outcome.netR,
      decisionId: cortex.decisionId,
      opportunityId: outcome.opportunityId,
      outcomeId: outcome.outcomeId,
    });
  }
  return { decisions: [...decisionsByKey.values()], outcomes: cortexOutcomes, experiences, rejected };
}
